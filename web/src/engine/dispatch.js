/* 同型号优先 + 下一台设备前瞻的派单算法（下称「前瞻派单」）
 * ---------------------------------------------------------------------------
 * 实现依据：路演/三工序排产算法设计.docx（初版｜拉丝 · 捻股 · 合绳）。
 * 条款编号按该文档标注，便于逐条对照（§3 换型 / §4 交期余量 / §5 派单核心 / §6-§8 三工序 / §9 事件驱动）。
 *
 * 与 scheduler.js 的关系：两套算法都保留，可在「排产设置 → 排程策略」里切换。
 *   · scheduler.js  —— 按订单逐个排：订单的三道工序依次找位置（换型感知间隙插入 + R6 惩罚）。
 *   · 本文件        —— 按机台派单：事件驱动推进时间，机台空闲时在就绪队列里做
 *                      「同型号优先 + 下一台设备前瞻」，安全等待落成**设备预约**。
 *
 * 与设计文档的三处显式偏离（都写在 docs/ALGORITHM.md 里，此处只列结论）：
 *   1. 加工时间用「实际需求量 ÷ 机台产速」，不用文档初版的固定 420/480/600 min
 *      —— 文档 §1.1 明确要求在有产速时替换；
 *   2. 捻股/合绳换型时间取 min(max(10×目标股数, R5 下限), R5 上限)，
 *      —— 文档 §3.2 只给 10n；R5 是赛题硬性区间 1–5 h，越界值被夹紧并单独计数；
 *   3. 机台按「队列末尾追加」放置（文档 §2.2 的 free_time 语义），不做间隙插入。
 */
import { HOUR, num, round } from "../core/util.js";
import { durationMin } from "./model.js";
import { createTimelines, tlOf, insertSeg, specOf } from "./scheduler.js";

const MS = 60000;                                   // 1 分钟
/** R6：工序间隔上限 4320 min（72 h），与设计文档 §1.3-7 一致 */
export const INTERVAL_LIMIT_MIN = 4320;

/** 设计文档 §1.1 / §3 / §4 的参数默认值（全部可被 settings.dispatch 覆盖） */
export const DISPATCH_DEFAULTS = {
  /* §4.1 三道工序的紧急余量阈值（分钟）：25 h / 18 h / 10 h */
  thresholdMin: { drawing: 1500, stranding: 1080, closing: 600 },
  /* §4.2 负余量处理模式：AFTER_URGENT（默认，文档指定）| DEFER */
  negativeMode: "AFTER_URGENT",
  /* §3.1 拉丝换型固定 1 小时 */
  drawingSetupMin: 60,
  /* §3.2 捻股 / 合绳换型 = 目标订单股数 × 10 分钟 */
  perStrandSetupMin: 10,
  /* R5（赛题硬性 1–5 h）：把 10n 夹进该区间；关闭后完全按文档取值 */
  clampToR5: true,
  r5MinHours: 1,
  r5MaxHours: 5,
  /* 股数解析不到时的最坏换型（文档 §2.1「不能默认 0 股」） */
  unknownStrandSetupMin: 300,
  /* §5.3 缺少可预约设备时的预测间隔（仅作风险提示，不作为等待依据） */
  forecastGapMin: { drawing: 10, stranding: 5, closing: 15 },
  intervalLimitMin: INTERVAL_LIMIT_MIN,
};

/** 合并设置：settings.dispatch > 默认值 */
export function readDispatchConfig(settings) {
  const s = (settings && settings.dispatch) || {};
  const cm = (settings && settings.changeoverModel) || {};
  return {
    thresholdMin: { ...DISPATCH_DEFAULTS.thresholdMin, ...(s.thresholdMin || {}) },
    negativeMode: s.negativeMode || DISPATCH_DEFAULTS.negativeMode,
    drawingSetupMin: num(s.drawingSetupMin) ?? DISPATCH_DEFAULTS.drawingSetupMin,
    perStrandSetupMin: num(s.perStrandSetupMin) ?? DISPATCH_DEFAULTS.perStrandSetupMin,
    clampToR5: s.clampToR5 !== false,
    r5MinHours: num(s.r5MinHours) ?? num(cm.minHours) ?? DISPATCH_DEFAULTS.r5MinHours,
    r5MaxHours: num(s.r5MaxHours) ?? num(cm.maxHours) ?? DISPATCH_DEFAULTS.r5MaxHours,
    unknownStrandSetupMin: num(s.unknownStrandSetupMin) ?? DISPATCH_DEFAULTS.unknownStrandSetupMin,
    forecastGapMin: { ...DISPATCH_DEFAULTS.forecastGapMin, ...(s.forecastGapMin || {}) },
    intervalLimitMin: num(s.intervalLimitMin) ?? DISPATCH_DEFAULTS.intervalLimitMin,
  };
}

/* ============================ §3 换型 ============================ */

/** 配置键（§3.1 拉丝 = 原料型号 + 成品型号；§3.2 捻股/合绳 = 股数 + 结构 + 股径/绳径） */
export function familyOf(specCtx, process) {
  const c = specCtx || {};
  if (process === "drawing") {
    return [c.wireSpecMm == null ? "?" : c.wireSpecMm, c.outSpec == null ? (c.outDia == null ? "?" : c.outDia) : c.outSpec].join("|");
  }
  return [c.count == null ? "?" : c.count, c.structure == null ? "?" : c.structure, c.diameter == null ? "?" : c.diameter].join("|");
}

/** 可读的配置键（用于工序排产表与抽屉展示） */
export function familyLabel(specCtx, process) {
  const c = specCtx || {};
  if (process === "drawing") return "原料 " + (c.wireSpecMm ?? "?") + "mm → 成品 " + (c.outSpec ?? (c.outDia != null ? c.outDia + "mm" : "?"));
  return (c.count == null ? "?股" : c.count + "股") + " · " + (c.structure || "?") + " · " + (c.diameter == null ? "?" : c.diameter + "mm");
}

/**
 * 换型时长（分钟）。§3.1 拉丝固定 60 min；§3.2 捻股/合绳 = 目标订单股数 × 10 min。
 * 返回 raw（文档原值）与 minutes（实际采用值），被 R5 夹紧时 clamped=true —— 便于如实披露。
 */
export function setupMinutesFor(process, targetFamily, machineFamily, specCtx, cfg) {
  if (machineFamily == null) {
    /* §1.3-2：初始型号未知时保守计一次换型，不默认免费配置 */
    const b = setupBase(process, specCtx, cfg);
    return { minutes: b.minutes, raw: b.raw, clamped: b.clamped, first: true,
      reasons: b.reasons.concat(["首次上机（初始配置未知，保守计一次换型）"]) };
  }
  if (targetFamily === machineFamily) return { minutes: 0, raw: 0, clamped: false, first: false, reasons: [] };
  const base = setupBase(process, specCtx, cfg);
  return { minutes: base.minutes, raw: base.raw, clamped: base.clamped, first: false, reasons: base.reasons };
}

function setupBase(process, specCtx, cfg) {
  if (process === "drawing") {
    return { minutes: cfg.drawingSetupMin, raw: cfg.drawingSetupMin, clamped: false, reasons: ["拉丝换型固定 " + cfg.drawingSetupMin + " min（§3.1）"] };
  }
  const n = num(specCtx && specCtx.count);
  if (n == null) {
    return { minutes: cfg.unknownStrandSetupMin, raw: cfg.unknownStrandSetupMin, clamped: false,
      reasons: ["股数解析不到：按最坏换型 " + cfg.unknownStrandSetupMin + " min 计（§2.1 不允许默认 0 股）"] };
  }
  const raw = cfg.perStrandSetupMin * n;
  if (!cfg.clampToR5) return { minutes: raw, raw, clamped: false, reasons: [n + " 股 × " + cfg.perStrandSetupMin + " min = " + raw + " min（§3.2）"] };
  const lo = cfg.r5MinHours * 60, hi = cfg.r5MaxHours * 60;
  const minutes = Math.min(Math.max(raw, lo), hi);
  const clamped = minutes !== raw;
  return { minutes, raw, clamped,
    reasons: [n + " 股 × " + cfg.perStrandSetupMin + " min = " + raw + " min" + (clamped ? "，超出 R5（" + cfg.r5MinHours + "–" + cfg.r5MaxHours + " h）已夹紧为 " + minutes + " min" : "")] };
}

/* ====================== §4 交期余量 / 约束余量 ====================== */

/** 订单在 process 及其之后各工序的「名义加工时间」之和（用最快适配机台的产速） */
function remainingProcessMin(ctx, fromIdx) {
  let sum = 0;
  for (let i = fromIdx; i < ctx.ops.length; i++) {
    const op = ctx.ops[i];
    const dur = ctx.nominalMin[i];
    if (dur == null) return null;
    sum += dur;
  }
  return sum;
}

/** 从 fromIdx 起各工序的最坏换型之和（§4.1：下游一律预留最坏换型） */
function remainingWorstSetupMin(ctx, fromIdx, cfg) {
  let sum = 0;
  for (let i = fromIdx; i < ctx.ops.length; i++) {
    sum += worstSetupMin(ctx.ops[i].process, ctx.ops[i].specCtx, cfg);
  }
  return sum;
}

function worstSetupMin(process, specCtx, cfg) {
  if (process === "drawing") return cfg.drawingSetupMin;
  const n = num(specCtx && specCtx.count);
  if (n == null) return cfg.unknownStrandSetupMin;
  const raw = cfg.perStrandSetupMin * n;
  if (!cfg.clampToR5) return raw;
  return Math.min(Math.max(raw, cfg.r5MinHours * 60), cfg.r5MaxHours * 60);
}

/**
 * 交期余量 S（§4.1）：在这组加工与换型假设下还能额外等待多久。
 * S < 0 表示已无等待空间；S 不含未知的下游排队时间，因此不能单独用来「证明」最终保证交期。
 */
function slackMin(ctx, idx, nowMs, cfg) {
  if (!ctx.dueMs) return Infinity;
  const rem = remainingProcessMin(ctx, idx);
  if (rem == null) return Infinity;
  return (ctx.dueMs - nowMs) / MS - rem - remainingWorstSetupMin(ctx, idx, cfg);
}

/** 工序间隔余量 G（§5.4）：G = 上工序完工 + 4320 − 本工序实际开工。对拉丝不使用。 */
function gapSlackMin(A, prevFinishMs, cfg) {
  if (prevFinishMs == null) return Infinity;
  return (prevFinishMs + cfg.intervalLimitMin * MS - A) / MS;
}

/** 层内排序键：约束余量最小者优先，同余量按更早交期、更早下达、订单号（§5.1） */
function compareCandidate(a, b) {
  if (a.key !== b.key) return a.key - b.key;
  const ca = a.c || a.ctx, cb = b.c || b.ctx;
  const da = ca.dueMs ?? Infinity, db = cb.dueMs ?? Infinity;
  if (da !== db) return da - db;
  if (ca.release !== cb.release) return ca.release - cb.release;
  return ca.order.id < cb.order.id ? -1 : ca.order.id > cb.order.id ? 1 : 0;
}

export { compareCandidate, slackMin, gapSlackMin, worstSetupMin, remainingProcessMin, remainingWorstSetupMin };

/* ==================== §9 事件驱动模拟 + §5 统一派单核心 ==================== */

/** 名义加工时间（分钟）：取最快适配机台的产速，用于余量估计与下游预留 */
function nominalDurationMin(cap, op) {
  const capable = cap.capableMachines(op.process, op.specCtx);
  let best = null;
  for (const c of capable) { const d = durationMin(op.qty, c.rate); if (d != null && (best == null || d < best)) best = d; }
  return best;
}

/** 下游工序最坏预留（§5.2：当前工序只计本机实际换型，下游一律预留最坏换型 + 名义加工） */
function downstreamWorstMs(ctx, idx, cfg) {
  let sum = 0;
  for (let i = idx + 1; i < ctx.ops.length; i++) {
    const op = ctx.ops[i];
    const p = ctx.nominalMin[i];
    if (p == null) return Number.MAX_SAFE_INTEGER / 4;
    sum += p + worstSetupMin(op.process, op.specCtx, cfg);
  }
  return sum * MS;
}

export function runDispatchSchedule({ model, settings, locks = new Map(), frozen = new Map(), horizonDays = 131, onProgress }) {
  const t0 = performance.now();
  const cap = model.cap;
  const planStart = new Date(settings.planStart).getTime();
  const horizonEnd = planStart + horizonDays * 24 * HOUR;
  const cfg = readDispatchConfig(settings);
  const tls = createTimelines();
  const tasks = [], unscheduled = [], log = [];
  const stats = { clampedSetups: 0, reservations: 0, reservationHonored: 0, deferred: 0, lateRiskPlaced: 0, gapViolations: 0, forcedSetups: 0, idleNoCandidate: 0 };

  /* ---- 机台状态（§2.2：machine_id / stage / free_time / current_family / current_order）---- */
  const ms = new Map();
  for (const p of model.chainKeys) for (const m of (cap.machines[p] || [])) {
    ms.set(m.uid, { m, process: p, freeTime: planStart, family: null, orderId: null });
    tlOf(tls, m.uid);
  }
  const reservations = new Map();   // machineUid -> { orderId, process, at, reason }

  /* ---- 停机窗口（设备异常）---- */
  for (const d of (settings.downtime || [])) {
    const m = cap.machineByIdAny(d.machineId, d.process);
    if (!m) continue;
    const s = ms.get(m.uid); if (!s) continue;
    const from = new Date(d.from).getTime(), to = new Date(d.to).getTime();
    insertSeg(tlOf(tls, m.uid), { kind: "down", start: from, end: to, reason: d.reason || "设备不可用" });
    if (to > s.freeTime) s.freeTime = to;
  }

  /* ---- 订单上下文 ---- */
  const ctxById = new Map();
  for (const job of model.jobs) {
    const order = job.order;
    const release = Math.max(planStart, order.materialReadyAt ? new Date(order.materialReadyAt).getTime() : planStart);
    const ctx = {
      job, order, ops: job.ops, release, idx: 0, ready: release, prevFinish: null,
      done: false, deferred: false, deferReason: null, opTask: new Array(job.ops.length).fill(null),
      nominalMin: job.ops.map(op => nominalDurationMin(cap, op)),
      /* 交期余量用「允许的最晚交期」：硬交期/未标注 = 交期本身，软交期 = 交期 + 宽限（R8） */
      dueMs: (order.allowLatest || order.due) ? (order.allowLatest || order.due).getTime() : null,
      lateRisk: false, gapRisk: null, reserveReason: null,
    };
    ctxById.set(order.id, ctx);
  }

  /* 「未排（unscheduled）」与「已排但违反约束（anomalies）」必须分开：
     前者是没排进去的工序，后者是排进去了但触碰了 72 h / 交期的工序。
     混在一起会让校验把它们当成「工艺映射不完整」，凭空多出一批假阻断（实测 51 vs 10）。 */
  const anomalies = [];
  const recorded = new Set();
  function recordAnomaly(orderId, process, reason, kind) {
    const k = kind + "|" + orderId + "|" + process;
    if (recorded.has(k)) return false;
    recorded.add(k);
    anomalies.push({ orderId, process, reason, kind });
    return true;
  }
  /** 登记一次未排/异常原因（同一订单同一工序只记一次，避免每次都追加一条） */
  function recordOnce(orderId, process, reason, extra) {
    const k = orderId + "|" + process;
    if (recorded.has(k)) return false;
    recorded.add(k);
    unscheduled.push({ orderId, process, reason, qty: null, ...(extra || {}) });
    return true;
  }
  /** 该订单在本工序持有的预约（§5.1 的占用判定，§5.5 的转移判定）。 */
  function reservationFor(orderId, process) {
    for (const [uid, r] of reservations) {
      if (r.orderId === orderId && r.process === process) return { uid, r };
    }
    return null;
  }
  const currentOp = (c) => (c.idx < c.ops.length ? c.ops[c.idx] : null);
  const advance = (c) => { while (c.idx < c.ops.length && c.opTask[c.idx]) c.idx++; if (c.idx >= c.ops.length) c.done = true; };

  /* ---- 预置「执行冻结」与「人工锁定」任务（不可自动移动）---- */
  const pre = [];
  for (const [, t] of frozen) pre.push({ ...t, frozen: true });
  for (const [id, t] of locks) if (!frozen.has(id)) pre.push({ ...t, locked: true });
  pre.sort((a, b) => a.start - b.start);
  for (const t of pre) {
    const m = cap.machineById(t.process, t.machineId);
    if (!m) { unscheduled.push({ ...t, reason: "锁定/冻结任务指向的设备不存在" }); continue; }
    const s = ms.get(m.uid); if (!s) continue;
    insertSeg(tlOf(tls, s.m.uid), { kind: "run", taskId: t.id, start: t.start, end: t.end, spec: t.spec, process: t.process, locked: t.locked, frozen: t.frozen });
    if (t.setupHours > 0) insertSeg(tlOf(tls, s.m.uid), { kind: "setup", taskId: t.id, start: t.start - t.setupHours * HOUR, end: t.start, process: t.process });
    if (t.end > s.freeTime) s.freeTime = t.end;
    /* 补 machineUid：外部调用方可能只给 {process, machineId}，
       缺 uid 会让 repairWaits 的占用索引把它归到 "undefined" 机台桶，碰撞检查直接漏掉它。 */
    t.machineUid = s.m.uid;
    s.family = familyOf(t.specCtx, t.process);
    s.orderId = t.orderId;
    const c = ctxById.get(t.orderId);
    if (c) {
      const i = c.ops.findIndex(o => o.process === t.process);
      if (i >= 0 && !c.opTask[i]) { c.opTask[i] = { ...t, scheduled: true }; c.prevFinish = t.end; if (t.end > c.ready) c.ready = t.end; advance(c); }
    }
    tasks.push({ ...t, scheduled: true });
  }

  /* ---- 派单：把 c 的第 idx 道工序放到机台 s 上（§9 每次实际派单）---- */
  function assign(s, c, idx, t, ev, meta) {
    const op = ev.op;
    const start = ev.A, end = ev.C;
    const setupStart = ev.su.minutes > 0 ? ev.A - ev.su.minutes * MS : null;
    const task = {
      id: "T:" + c.order.id + ":" + op.process,
      orderId: c.order.id, process: op.process,
      machineId: s.m.id, machineUid: s.m.uid, machineName: s.m.name || null,
      qty: op.qty, unit: model.qtyModel.unit || "米", rate: round(ev.rate, 4), durationMin: ev.dur,
      start, end, setupHours: ev.su.minutes / 60, setupReasons: ev.su.reasons, setupTier: ev.su.first ? "首次上机" : ev.su.minutes > 0 ? "规格切换" : "同型号无需换型",
      setupStart, setupEnd: setupStart != null ? ev.A : null,
      /* 设计文档 §10.1 要求的可追溯字段 */
      configKey: ev.targetFamily, configLabel: familyLabel(op.specCtx, op.process),
      readyAt: c.ready, slackMin: round(ev.S, 1), gapSlackMin: ev.G === Infinity ? null : round(ev.G, 1),
      prevFinish: c.prevFinish, gapMin: c.prevFinish == null ? null : round((ev.A - c.prevFinish) / MS, 1),
      reserveReason: meta && meta.reserveReason || null, riskTags: ev.riskTags || [],
      setupRawMin: ev.su.raw, setupClamped: !!ev.su.clamped,
      /* spec 必须与旧调度器同形：内置工艺链的 op 上没有 spec 字段，
         规格在 op.specCtx 里（人工调整表单等消费方按 {structure, diameter} 读它）。
         直接写 op.spec ?? null 会让这些消费方拿到空规格，适配机台算成 0 台。 */
      spec: op.specCtx ? specOf(op.specCtx, op.process) : (op.spec ?? null), specCtx: op.specCtx, jobRef: op.ref,
      specLabel: familyLabel(op.specCtx, op.process),
      scheduled: true, locked: false, frozen: false,
      candidateCount: ev.candidateCount, considered: ev.considered,
      sortKey: c.order.sortKey, demoParams: !c.order.processMap,
    };
    /* 预约转移：本机抢走了别的机台的预约，旧预约必须显式撤销，否则那台机台会一直空等。 */
    if (ev.transferFrom) {
      reservations.delete(ev.transferFrom);
      stats.reservationTransfers = (stats.reservationTransfers || 0) + 1;
      ev.transferFrom = null;
    }
    insertSeg(tlOf(tls, s.m.uid), { kind: "run", taskId: task.id, start, end, spec: task.spec, process: op.process });
    if (ev.su.minutes > 0) insertSeg(tlOf(tls, s.m.uid), { kind: "setup", taskId: task.id, start: setupStart, end: ev.A, process: op.process });
    s.freeTime = end; s.family = ev.targetFamily; s.orderId = c.order.id;
    c.opTask[idx] = task; c.prevFinish = end; c.ready = end;
    if (meta && meta.reserveReason) c.reserveReason = meta.reserveReason;
    if (ev.su.clamped) stats.clampedSetups++;
    if (ev.lateRisk) { c.lateRisk = true; stats.lateRiskPlaced++; }
    if (ev.gapRisk) { c.gapRisk = ev.gapRisk; stats.gapViolations++; }
    if (meta && meta.forced) stats.forcedSetups++;
    tasks.push(task);
    advance(c);
    const n = tasks.length;
    if (onProgress && n % 60 === 0) onProgress(n / Math.max(1, model.jobs.length * model.chainKeys.length));
    return true;
  }

  /* ---- 单机评估（不改状态）：§5.2 立即方案 + §5.4 可行性 ---- */
  function evaluate(s, c, idx, t) {
    const op = c.ops[idx];
    const rate = cap.rateOf(op.process, s.m, op.specCtx);
    const dur = durationMin(op.qty, rate);
    if (dur == null || !(dur >= 0)) return null;
    const targetFamily = familyOf(op.specCtx, op.process);
    const su = setupMinutesFor(op.process, targetFamily, s.family, op.specCtx, cfg);
    const B = Math.max(t, c.ready, s.freeTime);
    const A = B + su.minutes * MS;
    const C = A + dur * MS;
    const E = C + downstreamWorstMs(c, idx, cfg);
    const S = slackMin(c, idx, t, cfg);
    const G = op.process === "drawing" ? Infinity : gapSlackMin(A, c.prevFinish, cfg);
    const gapOk = op.process === "drawing" || c.prevFinish == null || G >= 0;
    const dueOk = c.dueMs == null || E <= c.dueMs;
    const inWindow = C <= horizonEnd;
    const riskTags = [];
    if (!dueOk) riskTags.push("预计完成晚于交期（延期 " + Math.round((E - c.dueMs) / MS) + " min）");
    if (!gapOk) riskTags.push("工序间隔超过 " + Math.round(cfg.intervalLimitMin / 60) + " h（工艺间隔异常）");
    return { op, process: op.process, rate, dur, su, targetFamily, B, A, C, E, S, G,
      gapOk, dueOk, inWindow, feasible: gapOk && dueOk && inWindow, placeable: inWindow, riskTags };
  }

  /* ---- §5.5 派单决策 ---- */
  function dispatchMachine(s, t) {
    const threshold = cfg.thresholdMin[s.process] ?? 600;
    const cands = [];
    let capableCount = 0;
    for (const c of ctxById.values()) {
      if (c.done || c.deferred) continue;
      const op = currentOp(c);
      if (!op || op.process !== s.process) continue;
      if (c.ready > t) continue;
      if (!cap.isCapable(op.process, s.m, op.specCtx)) continue;
      capableCount++;
      const ev = evaluate(s, c, c.idx, t);
      if (!ev) continue;
      /* §5.1：候选必须是「尚未被其他设备或预约占用」的订单 —— 否则预约会被先空闲的机台抢走而形同虚设。
         §5.5 同时规定：**只有找到更早且仍满足约束的可行方案，才允许转移预约**。
         因此这里不是一刀切排除，而是要求「本机方案严格更早且完全可行」才允许抢走预约。 */
      const held = reservationFor(c.order.id, op.process);
      if (held && held.uid !== s.m.uid) {
        const other = ms.get(held.uid);
        const evOther = other ? evaluate(other, c, c.idx, t) : null;
        if (!ev.feasible || !evOther || ev.E >= evOther.E) continue;
        ev.transferFrom = held.uid;
      }
      cands.push({ c, idx: c.idx, ev, S: ev.S, key: Math.min(ev.S, ev.G) });
    }
    if (!cands.length) { stats.idleNoCandidate++; return false; }

    /* §4.2 分类：紧急可行 / 普通可行 / 负余量风险 */
    const neg = cands.filter(x => x.S < 0);
    const urg = cands.filter(x => x.S >= 0 && x.S < threshold);
    const nor = cands.filter(x => x.S >= threshold);
    /* AFTER_URGENT（文档默认）：紧急可行 → 负余量 → 普通；DEFER：负余量暂缓，不参与普通派单 */
    const layers = cfg.negativeMode === "DEFER" ? [urg, nor] : [urg, neg, nor];
    let layer = null;
    for (const L of layers) if (L.length) { layer = L; break; }
    if (!layer) {
      if (cfg.negativeMode === "DEFER" && neg.length) {
        for (const x of neg) { x.c.deferred = true; x.c.deferReason = "负余量（S=" + round(x.S, 1) + " min）按 DEFER 模式暂缓"; stats.deferred++; }
      }
      return false;
    }
    /* §5.1：层内按约束余量排序；d = 该层最紧急订单（不预先按「本机是否可行」过滤）。
       这一点很关键：如果先把「本机不可行」的候选滤掉，那么「本机做不了、下一台能做」的订单
       根本进不了 d，也就永远不会被预约到下一台 —— 而 §5.5 第 2 行的本意正是把它预约出去。
       本机不可行的处理留给下面的 placeMarked()（落位并显式标注，不静默放宽，也不丢单）。 */
    layer.sort(compareCandidate);
    const use = layer;
    const negLayer = layer === neg;
    const d = use[0];
    /* §5.1 c：当前机台同型号（无需换型）且方案完全可行的最紧急订单 */
    const sameFam = layer.filter(x => s.family != null && x.ev.targetFamily === s.family && x.ev.feasible);
    sameFam.sort(compareCandidate);
    const c = sameFam[0] || null;
    const dSameFamily = s.family != null && d.ev.targetFamily === s.family;
    for (const x of use) { x.ev.candidateCount = capableCount; x.ev.considered = layer.length; }

    /** 落位并在需要时显式标注异常（工序间隔 / 延期） */
    function placeMarked(x, meta) {
      if (!x.ev.placeable) {
        recordOnce(x.c.order.id, x.ev.process, "计划窗口内无可用产能（设备占用或窗口不足）", { qty: x.ev.op.qty });
        return false;
      }
      x.ev.lateRisk = !x.ev.dueOk;
      if (!x.ev.gapOk) {
        x.ev.gapRisk = x.ev.riskTags.join("；");
        x.c.gapRisk = x.ev.gapRisk;
        recordAnomaly(x.c.order.id, x.ev.process, "工序间隔异常（已排产但超过 72 h，按「不静默放宽」显式标注）", "gap");
      }
      if (!x.ev.dueOk) recordAnomaly(x.c.order.id, x.ev.process, "预计完成晚于交期（已排产并标记延期风险）", "late");
      return assign(s, x.c, x.idx, t, x.ev, meta || { slackMin: x.S });
    }

    /* 负余量层（AFTER_URGENT）：允许派单，但延期必须明确标记 */
    if (negLayer) return placeMarked(d, { slackMin: d.S });

    /* d 在本机做不了时，若同层还有别的「完全可行」候选，就让本机先做它。
       否则一台机台会被一个当下根本落不下去的订单占住，整条线跟着停摆
       （实测：不做这个退让，R6 阻断级风险会从 7 处涨到 28 处）。
       d 本身仍会被登记为「无法保护」，不会静默丢掉。 */
    const nextFeasible = () => layer.find(x => x.ev.feasible) || null;

    /* §5.5 第 1 行：d 同型号 → 加工 d */
    if (dSameFamily && d.ev.feasible) return placeMarked(d, { slackMin: d.S });
    /* §5.5 第 1 行后半：没有可行的同型号订单 c → 加工 d（不可行则标注） */
    if (!c) {
      if (d.ev.feasible) return placeMarked(d, { slackMin: d.S });
      const altFeas = nextFeasible();
      if (altFeas && altFeas !== d) {
        /* 只是「本机这一轮先让给别人」，订单本身仍会被排进去 ——
           因此记进 anomalies（已排/待排但让行），不能记进 unscheduled（那会被当成未排工序）。 */
        recordAnomaly(d.c.order.id, d.ev.process, "本机方案不可行，本轮先让同层其他可行订单占用本机：" + (d.ev.riskTags.join("；") || "不可行"), "yield");
        return placeMarked(altFeas, { slackMin: altFeas.S });
      }
      return placeMarked(d, { slackMin: d.S });
    }

    /* §5.3 下一台设备前瞻：在其他兼容、未被预约的设备里找 d 的最早可行方案 */
    let alt = null;
    for (const s2 of ms.values()) {
      if (s2.process !== s.process || s2.m.uid === s.m.uid) continue;
      if (reservations.has(s2.m.uid)) continue;
      if (!cap.isCapable(d.ev.process, s2.m, d.ev.op.specCtx)) continue;
      const ev2 = evaluate(s2, d.c, d.idx, t);
      if (!ev2 || !ev2.feasible) continue;
      if (!alt || ev2.E < alt.ev.E) alt = { s: s2, ev: ev2 };
    }

    /* §5.5 第 2 行：c 可行且 d 有可行下一台方案 → 当前加工 c，把 d 预约到下一台 */
    if (alt) {
      /* 措辞必须与事实一致：等待方案并不总是「更早完成」，它只是仍然可行。
         设计文档 §5「在可以安全等待时保持同型号加工」——安全 = 仍满足交期与 72 h，
         而不是「一定更快」。所以这里如实区分两种情形。 */
      const deltaMin = Math.round((alt.ev.E - d.ev.E) / MS);
      const cmp = deltaMin <= 0
        ? "更早完成 " + Math.abs(deltaMin) + " min"
        : "晚 " + deltaMin + " min，但仍在交期内且满足 72 h（安全等待）";
      const reason = "同型号优先：本机 " + s.m.id + " 保持 " + (s.family != null ? "当前配置" : "空闲")
        + " 加工 " + c.c.order.id + "；" + d.c.order.id + " 预约到 " + alt.s.m.id
        + "（预计 " + fmtMin(alt.ev.E) + " 完成，较本机立刻换型的 " + fmtMin(d.ev.E) + " " + cmp + "）";
      reservations.set(alt.s.m.uid, { orderId: d.c.order.id, process: s.process, at: alt.s.freeTime, reason });
      stats.reservations++;
      d.c.reserveReason = reason;
      return assign(s, c.c, c.idx, t, c.ev, { reserveReason: null });
    }
    /* §5.5 第 3 行：d 等待会违约或超 72 h，但当前方案可行 → 立即换型加工 d */
    if (d.ev.feasible) return assign(s, d.c, d.idx, t, d.ev, { slackMin: d.S, forced: true });
    /* §5.5 第 4 行：立即与等待方案都不可行 → 记录风险。
       若 d 连计划窗口都出不去，本机不能白白空转：退回层内下一个可落位候选，
       并把 d 登记为「无法保护」，而不是让整台机台陪着一起等。 */
    if (d.ev.feasible) return placeMarked(d, { slackMin: d.S, forced: true });
    const altFeas2 = nextFeasible();
    if (altFeas2 && altFeas2 !== d) {
      recordAnomaly(d.c.order.id, d.ev.process, "立即与等待方案都不可行，本轮先让同层其他可行订单占用本机：" + (d.ev.riskTags.join("；") || "不可行"), "yield");
      return placeMarked(altFeas2, { slackMin: altFeas2.S });
    }
    if (d.ev.placeable) return placeMarked(d, { slackMin: d.S, forced: true });
    recordOnce(d.c.order.id, d.ev.process, "立即与等待方案都不可行：" + (d.ev.riskTags.join("；") || "超出计划窗口"), { qty: d.ev.op.qty });
    const fallback = layer.find(x => x !== d && x.ev.placeable);
    if (fallback) return placeMarked(fallback, { slackMin: fallback.S });
    return false;
  }

  /* ---- §9 事件循环 ---- */
  function nextEventTime(t) {
    let best = Infinity;
    for (const s of ms.values()) if (s.freeTime > t && s.freeTime < best) best = s.freeTime;
    for (const c of ctxById.values()) { if (c.done || c.deferred) continue; if (currentOp(c) && c.ready > t && c.ready < best) best = c.ready; }
    return best;
  }
  function dispatchAll(t) {
    let changed = true, rounds = 0;
    while (changed && rounds++ < 4000) {
      changed = false;
      /* a) 先兑现到期且仍有效的预约（§5.5「预约设备空闲后优先兑现」） */
      for (const s of ms.values()) {
        if (s.freeTime > t) continue;
        const r = reservations.get(s.m.uid);
        if (!r) continue;
        const c = ctxById.get(r.orderId);
        const op = c && !c.done && !c.deferred ? currentOp(c) : null;
        if (!c || !op || op.process !== r.process || c.ready > t) { reservations.delete(s.m.uid); changed = true; continue; }
        const ev = evaluate(s, c, c.idx, t);
        reservations.delete(s.m.uid); changed = true;
        if (!ev || !ev.placeable) continue;
        stats.reservationHonored++;
        assign(s, c, c.idx, t, ev, { reserveReason: r.reason, slackMin: ev.S });
      }
      /* b) 逐台空闲机台派单 */
      for (const s of ms.values()) {
        if (s.freeTime > t) continue;
        if (reservations.has(s.m.uid)) continue;
        if (dispatchMachine(s, t)) changed = true;
      }
      /* c) 未就绪的机台不空转：由 nextEventTime 推进时间 */
    }
  }

  let t = planStart, guard = 0;
  while (guard++ < 500000) {
    dispatchAll(t);
    const nt = nextEventTime(t);
    if (!isFinite(nt) || nt > horizonEnd) break;
    t = nt;
  }

  /* ---- 收尾：未完成、暂缓、负余量的订单都要如实列出，不无限循环（§9 末）---- */
  for (const c of ctxById.values()) {
    if (c.done) continue;
    const op = currentOp(c);
    const why = c.deferred ? c.deferReason
      : c.gapRisk ? "工序间隔异常：" + c.gapRisk
      : !op ? "工艺链不完整"
      : c.dueMs != null && c.dueMs < t ? "交期已过且无可行机台"
      : "计划窗口内无可用产能（设备占用或窗口不足）";
    recordOnce(c.order.id, op ? op.process : "-", why, { qty: op ? op.qty : null, deferred: !!c.deferred });
  }

  const elapsedMs = performance.now() - t0;
  const jobChains = new Map();
  for (const c of ctxById.values()) {
    c.job.chain = c.opTask;
    jobChains.set(c.order.id, c.opTask);
  }
  return { tasks, unscheduled, anomalies, timelines: tls, elapsedMs, log, jobs: model.jobs, stats, ctxById };
}

function fmtMin(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return p(d.getMonth() + 1) + "-" + p(d.getDate()) + " " + p(d.getHours()) + ":" + p(d.getMinutes());
}
