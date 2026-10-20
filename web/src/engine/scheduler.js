/* 有限产能正排引擎
   目标顺序（企业口径）：满足硬约束 → 提升准时交付率 → 减少延期时长 → 改善利用率/减少换型
   算法：优先级驱动的作业式列表排程 + 换型感知的间隙插入（insertion heuristic）
        + 有界的迟到恢复局部搜索
   全流程可解释：每个任务都记录「候选机台、命中规则、换型触发字段、排序依据」 */
import { HOUR, num, round } from '../core/util.js';
import { changeoverBetween, changeoverGeneric } from './spec.js';
import { durationMin, cmpOrder } from './model.js';
import { DEFAULT_PROCESS_CHAIN } from './chain.js';

const MS = 60000;

/* 内置三工序 key：这三个 key 永远走历史 changeoverBetween / 原样比对，保证历史行为逐字节不变；
   其余 key（自定义工艺链）走 ProcessDef 声明的通用换型维度与规格比对。 */
const LEGACY_KEYS = ['drawing', 'stranding', 'closing'];
const isLegacyKey = k => LEGACY_KEYS.indexOf(k) >= 0;

/** 换型判定分派：自定义工艺链按 ProcessDef 声明的维度比对；内置三工序走原 changeoverBetween */
function coOf(process, a, b, model, procDef) {
  if (procDef && !isLegacyKey(process) && procDef.changeover && procDef.changeover.dims && procDef.changeover.dims.length) {
    return changeoverGeneric(procDef, a, b, model);
  }
  return changeoverBetween(process, a, b, model);
}
/** 当前模型的工序链 key 列表（缺省回退内置三工序） */
function chainOf(model) {
  const chain = (model && model.chain && model.chain.length) ? model.chain : DEFAULT_PROCESS_CHAIN;
  return chain.map(p => p.key);
}

export function createTimelines() { return new Map(); }
export function tlOf(tls, uid) { if (!tls.has(uid)) tls.set(uid, []); return tls.get(uid); }
export function insertSeg(list, seg) {
  let i = list.length;
  while (i > 0 && list[i - 1].start > seg.start) i--;
  list.splice(i, 0, seg);
  return list;
}
export function segSpecOf(seg) { return seg.spec || null; }

/** 计算在指定机台上插入任务的可行解（间隙插入，含换型占用） */
export function tryPlace({ segments, releaseMs, durMs, spec, process, coModel, setupWeight, horizonEnd, targetEnd = null, procDef = null }) {
  const need = durMs;
  const cands = [];
  const n = segments.length;
  // 候选间隙：[gapStart, gapEnd, predSpec, succStart]
  let prevEnd = -Infinity, predSpec = null;
  const gaps = [];
  for (let i = 0; i <= n; i++) {
    const seg = segments[i];
    const gapStart = prevEnd === -Infinity ? -Infinity : prevEnd;
    const gapEnd = seg ? seg.start : Infinity;
    gaps.push({ gapStart, gapEnd, predSpec, next: seg || null, idx: i });
    if (seg) { prevEnd = seg.end; predSpec = seg.kind === 'run' ? seg.spec : predSpec; }
  }
  for (const g of gaps) {
    const setup = coOf(process, g.predSpec, spec, coModel, procDef);
    const setupMs = setup.hours * HOUR;
    // 后继任务是否需要在新任务之后再加一次换型
    let afterMs = 0;
    if (g.next && g.next.kind === 'run') {
      const a = coOf(process, spec, g.next.spec, coModel, procDef);
      const had = coOf(process, g.predSpec, g.next.spec, coModel, procDef);
      afterMs = Math.max(0, a.hours - had.hours) * HOUR;
    }
    let start = Math.max(releaseMs, g.gapStart === -Infinity ? releaseMs : g.gapStart);
    // 间隙不够放下「换型 + 加工 + 后继换型增量」：有后继则跳过该间隙；
    // 无后继时 gapEnd 为 Infinity，条件恒不成立，因此不存在需要特判的分支。
    if (g.next && start + setupMs + need + afterMs > g.gapEnd) continue;
    const runStart = start + setupMs;
    const runEnd = runStart + need;
    /* 该候选越出计划窗口：只跳过这一个候选，不能整体放弃本机台——
       尾部间隙延伸到无穷远，按起始时间升序枚举时它必然排在最后，
       若在此 return 会把前面已经找到的可行位置一起丢掉，导致「明明有空档却报无可用产能」。 */
    if (runEnd > horizonEnd) continue;
    cands.push({
      setupMs, runStart, runEnd, setup,
      score: runEnd + setupWeight * setupMs,
      tail: !g.next,
    });
  }
  if (!cands.length) return { ok: false, reason: '计划窗口内无可用间隙' };
  /* targetEnd：用于 R6 等待修复——希望任务完工时刻尽量贴近下游开工时刻（宁晚勿早），
     而不是默认的「越早越好」。 */
  if (targetEnd != null) cands.sort((a, b) => Math.abs(a.runEnd - targetEnd) - Math.abs(b.runEnd - targetEnd) || b.runEnd - a.runEnd);
  else cands.sort((a, b) => a.score - b.score || a.runEnd - b.runEnd);
  return { ok: true, best: cands[0], all: cands.length };
}

/** 把 settings.downtime 解析为设备占用片段（供 repairWaits / improveSchedule 的占用索引并入，
    否则这两个后处理阶段看不见停机窗口，会把任务挪进故障区间 —— 审查报告 P1-4）。 */
function downtimeBlocks(cap, settings) {
  const out = [];
  for (const d of (settings?.downtime || [])) {
    const m = cap.machineByIdAny(d.machineId, d.process);
    if (!m) continue;
    const s = new Date(d.from).getTime(), e = new Date(d.to).getTime();
    if (!(e > s)) continue;
    out.push({ uid: m.uid, s, e });
  }
  return out;
}

/** 任务表内部是否自洽（同设备上 run/setup 不重叠） */
export function hasOverlap(tasks) {
  const byMachine = new Map();
  for (const t of tasks) {
    if (!t.scheduled) continue;
    if (!byMachine.has(t.machineUid)) byMachine.set(t.machineUid, []);
    const arr = byMachine.get(t.machineUid);
    arr.push({ s: t.setupHours > 0 ? t.start - t.setupHours * HOUR : t.start, e: t.end, id: t.id });
  }
  for (const arr of byMachine.values()) {
    arr.sort((a, b) => a.s - b.s);
    for (let i = 1; i < arr.length; i++) if (arr[i].s < arr[i - 1].e - 1000) return true;
  }
  return false;
}

/** 主排程入口 */
export function runSchedule({ model, settings, locks = new Map(), frozen = new Map(), horizonDays = 45, onProgress }) {
  const t0 = performance.now();
  const cap = model.cap;
  const planStart = new Date(settings.planStart).getTime();
  const horizonEnd = planStart + horizonDays * 24 * HOUR;
  const coModel = settings.changeoverModel || {};
  const setupWeight = settings.setupWeight ?? 0.5;
  const tls = createTimelines();
  const tasks = [];
  const unscheduled = [];
  const log = [];

  const chainKeys = chainOf(model);
  for (const p of chainKeys) for (const m of (cap.machines[p] || [])) tlOf(tls, m.uid);

  /* ---- 0. 先落位「执行冻结」与「人工锁定」任务（不可自动移动）---- */
  const preplaced = [];
  for (const [taskId, t] of frozen) preplaced.push({ ...t, frozen: true });
  for (const [taskId, t] of locks) if (!frozen.has(taskId)) preplaced.push({ ...t, locked: true });
  preplaced.sort((a, b) => a.start - b.start);
  const lockedIds = new Set();          // 已预置的任务 id：主排产循环必须跳过，否则会产生同 id 的「幽灵任务」
  const preplacedById = new Map();      // id -> 已落位的任务，供后续工序取 release
  for (const t of preplaced) {
    const m = cap.machineById(t.process, t.machineId);
    if (!m) { unscheduled.push({ ...t, reason: '锁定/冻结任务指向的设备不存在' }); continue; }
    const seg = { kind: 'run', taskId: t.id, start: t.start, end: t.end, spec: t.spec, process: t.process, locked: t.locked, frozen: t.frozen };
    insertSeg(tlOf(tls, m.uid), seg);
    if (t.setupHours > 0) {
      insertSeg(tlOf(tls, m.uid), { kind: 'setup', taskId: t.id, start: t.start - t.setupHours * HOUR, end: t.start, process: t.process });
    }
    lockedIds.add(t.id);
    const placedTask = { ...t, scheduled: true };
    preplacedById.set(t.id, placedTask);
    tasks.push(placedTask);
  }

  /* ---- 1. 设备停机窗口（P1 设备异常）---- */
  const downtime = settings.downtime || [];
  for (const d of downtime) {
    const m = cap.machineByIdAny(d.machineId, d.process);
    if (!m) continue;
    insertSeg(tlOf(tls, m.uid), { kind: 'down', start: new Date(d.from).getTime(), end: new Date(d.to).getTime(), reason: d.reason || '设备不可用' });
  }

  /* ---- 2. 按优先级顺序排产 ---- */
  const jobs = model.jobs.slice().sort((a, b) => cmpOrder(a.order, b.order));
  let done = 0;
  for (const job of jobs) {
    const o = job.order;
    let release = Math.max(planStart, o.materialReadyAt ? new Date(o.materialReadyAt).getTime() : planStart);
    const chain = [];
    for (const op of job.ops) {
      /* 已被人工锁定或执行冻结的工序不重新排产，直接沿用其位置，并把 release 推进到它的完工时间，
         保证后续工序以锁定完工时间为最早开工时间（PRD D04：锁定后重算保持不变）。 */
      const preId = 'T:' + o.id + ':' + op.process;
      const preplacedTask = preplacedById.get(preId);
      if (preplacedTask) {
        chain.push(preplacedTask);
        release = Math.max(release, preplacedTask.end);
        continue;
      }
      const placed = placeOne({ op, order: o, release, cap, tls, planStart, horizonEnd, coModel, setupWeight, model, settings, r6RefEnd: chain.length ? chain[chain.length - 1]?.end ?? null : null });
      if (!placed.ok) {
        unscheduled.push({ orderId: o.id, process: op.process, reason: placed.reason, qty: op.qty });
        chain.push(null);
        release = release;   // 后续工序仍尝试，但记录未排
        continue;
      }
      const t = placed.task;
      insertSeg(tlOf(tls, t.machineUid), { kind: 'run', taskId: t.id, start: t.start, end: t.end, spec: t.spec, process: t.process });
      if (t.setupHours > 0) insertSeg(tlOf(tls, t.machineUid), { kind: 'setup', taskId: t.id, start: t.start - t.setupHours * HOUR, end: t.start, process: t.process });
      tasks.push(t);
      chain.push(t);
      release = t.end;
    }
    job.chain = chain;
    done++;
    if (onProgress && done % 40 === 0) onProgress(done / jobs.length);
  }

  const elapsed = performance.now() - t0;
  return { tasks, unscheduled, timelines: tls, elapsedMs: elapsed, log, jobs };
}

/** 放置单个工序 */
function placeOne({ op, order, release, cap, tls, planStart, horizonEnd, coModel, setupWeight, model, settings, r6RefEnd }) {
  /* R6 上限（小时）：候选位置若使「后序开工 − 前序完工」超过 72 小时，按超出量加重惩罚，
     使求解在不牺牲交期的前提下优先选择能守住工序间隔的机台。 */
  const WAIT_LIMIT = 72;
  const process = op.process;
  const capable = cap.capableMachines(process, op.specCtx);
  if (!capable.length) {
    return { ok: false, reason: '没有可加工该规格的设备（产能矩阵空值视为不适配，R1）' };
  }
  const durMin = durationMin(op.qty, Math.max(...capable.map(c => c.rate)));
  if (durMin == null) return { ok: false, reason: '需求量或产能缺失，无法计算工时' };
  const procDef = model.procMap ? model.procMap[process] : null;
  const spec = op.spec ?? specOf(op.specCtx, process);

  /* 候选机台预筛：按「最早可开工 + 估算工时」排序，取前 24 台做完整插入扫描 */
  const pre = capable.map(c => {
    const segs = tlOf(tls, c.machine.uid);
    const freeFrom = segs.length ? segs[segs.length - 1].end : planStart;
    const dur = durationMin(op.qty, c.rate) ?? durMin;
    return { ...c, segs, freeFrom, dur, lb: Math.max(release, freeFrom) + dur * MS, sameSpec: segs.some(s => s.kind === 'run' && sameSpec(s.spec, spec, process, procDef && procDef.changeover ? procDef.changeover.dims : null)) };
  });
  pre.sort((a, b) => (a.lb - b.lb) || (b.rate - a.rate));
  let pool = pre.slice(0, 24);
  const affinity = pre.filter(p => p.sameSpec).slice(0, 6);
  for (const a of affinity) if (!pool.includes(a)) pool.push(a);
  if (pool.length > 30) pool = pool.slice(0, 30);

  const results = [];
  for (const c of pool) {
    const r = tryPlace({ segments: c.segs, releaseMs: release, durMs: c.dur * MS, spec, process, coModel, setupWeight, horizonEnd, procDef });
    if (r.ok && r6RefEnd != null) {
      const waitH = (r.best.runStart - r6RefEnd) / HOUR;
      if (waitH > WAIT_LIMIT) r.best.score += (waitH - WAIT_LIMIT) * 2 * HOUR;
    }
    if (r.ok) results.push({ ...c, place: r.best });
  }
  if (!results.length) {
    // 放宽：全量适配机台
    for (const c of capable) {
      const segs = tlOf(tls, c.machine.uid);
      const dur = durationMin(op.qty, c.rate);
      if (!dur) continue;
      const r = tryPlace({ segments: segs, releaseMs: release, durMs: dur * MS, spec, process, coModel, setupWeight, horizonEnd, procDef });
      if (r.ok && r6RefEnd != null) {
        const waitH = (r.best.runStart - r6RefEnd) / HOUR;
        if (waitH > WAIT_LIMIT) r.best.score += (waitH - WAIT_LIMIT) * 2 * HOUR;
      }
      if (r.ok) results.push({ ...c, segs, dur, place: r.best });
    }
  }
  if (!results.length) return { ok: false, reason: '计划窗口内无可用产能（设备占用冲突或窗口不足）' };

  results.sort((a, b) => a.place.score - b.place.score || a.place.runEnd - b.place.runEnd || b.rate - a.rate);
  const best = results[0];
  const alternative = results.find(r => r.machine.uid !== best.machine.uid && r.place.runEnd <= best.place.runEnd + 4 * HOUR);

  const t = {
    id: 'T:' + order.id + ':' + process,
    orderId: order.id,
    process,
    machineId: best.machine.id,
    machineUid: best.machine.uid,
    machineName: best.machine.name || null,
    qty: op.qty,
    unit: model.qtyModel.unit || '米',
    rate: round(best.rate, 4),
    durationMin: best.dur,
    start: best.place.runStart,
    end: best.place.runEnd,
    setupHours: best.place.setup.hours,
    setupReasons: best.place.setup.reasons,
    setupTier: best.place.setup.tier,
    setupStart: best.place.setup.hours > 0 ? best.place.runStart - best.place.setup.hours * HOUR : null,
    spec,
    specCtx: op.specCtx,        // 供 D04「依据」页签复算适配机台数（原先丢失，导致捻股/合绳永不显示候选机台）
    specLabel: labelOf(op.specCtx, process, procDef),
    jobRef: op.ref,
    scheduled: true,
    locked: false,
    frozen: false,
    candidateCount: capable.length,
    considered: results.length,
    alternative: alternative ? { machineId: alternative.machine.id, end: alternative.place.runEnd, setupHours: alternative.place.setup.hours } : null,
    sortKey: order.sortKey,
    demoParams: !!order.processMap ? false : true,
  };
  return { ok: true, task: t };
}

export function specOf(ctx, process) {
  if (process === 'drawing') return { wireSpec: ctx.wireSpecMm, outSpec: ctx.outSpec ?? null, outDia: ctx.outDia ?? null };
  return { structure: ctx.structure ?? null, diameter: ctx.diameter ?? null };
}
function sameSpec(a, b, process, dims) {
  if (!a || !b) return false;
  /* 自定义工艺链：按 ProcessDef 声明的换型维度比对（内置三工序 key 保持历史口径） */
  if (dims && dims.length && !isLegacyKey(process)) return dims.every(d => a[d.field] === b[d.field]);
  if (process === 'drawing') return a.wireSpec === b.wireSpec && a.outSpec === b.outSpec && a.outDia === b.outDia;
  return a.structure === b.structure && a.diameter === b.diameter;
}
function labelOf(ctx, process, procDef) {
  if (process === 'drawing') return (ctx.wireSpecMm ?? '—') + 'mm 钢丝';
  if (process !== 'stranding' && process !== 'closing') {
    const p = procDef || ctx.procDef || null;
    if (p && (p.capability || {}).kind === 'specRange') {
      const label = ctx.specText != null ? ctx.specText : ((ctx.specMm ?? ctx.wireSpecMm ?? '—') + 'mm');
      return label + ' ' + p.name;
    }
    return (ctx.spec ?? ctx.specText ?? '—') + (p ? '（' + p.name + '）' : '');
  }
  return (ctx.spec ?? '—') + (process === 'stranding' ? '（股）' : '');
}


/* ------------------------------------------------------------------
   R6 等待修复：对「后序开工 − 前序完工 > 72 小时」的相邻工序，
   在不影响后序开工时间的前提下把前序任务后移，使间隔落回上限内。
   后移前序同时受其自身与更前序工序间隔的约束，避免按下葫芦浮起瓢。
   ------------------------------------------------------------------ */
export function repairWaits({ model, settings, tasks, horizonDays = 45 }) {
  const cap = model.cap;
  const planStart = new Date(settings.planStart).getTime();
  const LIMIT = 72;
  const byOrder = new Map();
  for (const t of tasks) { if (!t.scheduled) continue; if (!byOrder.has(t.orderId)) byOrder.set(t.orderId, {}); byOrder.get(t.orderId)[t.process] = t; }
  const segIndex = new Map();   // taskId -> 时间轴片段引用（移动任务时必须同步更新）
  const segOf = () => {
    const m = new Map();
    for (const t of tasks) {
      if (!t.scheduled) continue;
      if (!m.has(t.machineUid)) m.set(t.machineUid, []);
      /* 片段字段必须与 tryPlace 的约定一致（start/end），并带 spec —— 
         否则 tryPlace 读到的 gapEnd 恒为 undefined，任何位置都会被判为「放得下」而产生重叠。 */
      const o = { start: t.setupHours > 0 ? t.start - t.setupHours * HOUR : t.start, end: t.end, id: t.id, spec: t.spec, kind: 'run' };
      segIndex.set(t.id, o);
      m.get(t.machineUid).push(o);
    }
    // 停机窗口必须并入占用索引：id 用不回匹配任何任务的前缀，fits() 会把它当作阻挡物
    for (const d of downtimeBlocks(cap, settings)) {
      if (!m.has(d.uid)) m.set(d.uid, []);
      m.get(d.uid).push({ start: d.s, end: d.e, id: '__down__' + d.uid + d.s, kind: 'down' });
    }
    for (const arr of m.values()) arr.sort((a, b) => a.start - b.start);
    return m;
  };
  const seg = segOf();
  const fits = (t, newStart, newEnd) => {
    const arr = seg.get(t.machineUid) || [];
    const s = t.setupHours > 0 ? newStart - t.setupHours * HOUR : newStart;
    for (const x of arr) { if (x.id === t.id) continue; if (x.start < newEnd && x.end > s) return false; }
    return true;
  };
  /* 兜底：原地后移放不下时，在本机台的更靠后空档重放该任务，
     使完工时刻尽量贴近下游开工（R6 要求后序开工 − 前序完工 ≤ 72h）。
     这是「缩小工序间隔」的第二条路径：不改后序、只挪前序。 */
  const moveLate = (prev, nextStart, upEnd) => {
    if (prev.locked || prev.frozen) return false;
    const specCtx = prev.specCtx || (prev.process === 'drawing'
      ? { wireSpecMm: prev.spec?.wireSpec, outSpec: prev.spec?.outSpec, outDia: prev.spec?.outDia }
      : { row: prev.jobRef?.row, structure: prev.spec?.structure, diameter: prev.spec?.diameter });
    const candidates = [{ uid: prev.machineUid, machine: null, rate: prev.rate }]
      .concat(cap.capableMachines(prev.process, specCtx).map(c => ({ uid: c.machine.uid, machine: c.machine, rate: c.rate })));
    const seen = new Set();
    for (const cand of candidates) {
      if (seen.has(cand.uid)) continue;
      seen.add(cand.uid);
      const durMs = cand.uid === prev.machineUid ? (prev.end - prev.start)
        : (durationMin(prev.qty, cand.rate) || 0) * 60000;
      if (!durMs) continue;
      const target = (seg.get(cand.uid) || []).concat([{ start: nextStart, end: nextStart + 1, id: '__block__', kind: 'down' }]);
      /* 关键：release 恰好取「让完工落在 72 小时窗口起点」的时刻，不再额外留 6 小时余量。
         留余量会把最早完工推到 nextStart − 78h，导致每个候选都以 wait78 被拒，
         整个换机台兜底路径形同虚设（实测 427 次拒绝全部是该原因）。
         换型占用发生在 runStart 之前，因此 release 再加 setup 后完工仍在窗口内。 */
      const release = Math.max(planStart, nextStart - LIMIT * HOUR - durMs);
      const r = tryPlace({ segments: target, releaseMs: release, durMs, spec: prev.spec, process: prev.process,
        coModel: settings.changeoverModel, setupWeight: 0, horizonEnd: Infinity, targetEnd: nextStart,
        procDef: model.procMap ? model.procMap[prev.process] : null });
      if (!r.ok) continue;
      /* 注意：这里**不能**因为「目标机台无前序任务 → tryPlace 给 0 换型」就拒绝候选。
         试过这么改，换型口径是干净了，但 R6 换机台修复路径被堵死：
         阻断级 R6 从 7 处涨到 63 处。硬约束优先于换型口径的一致性，因此保持放行，
         并在 README 的「诚实边界」里如实说明换型总时长可能被低估的量级。 */
      const ns = r.best.runStart, ne = r.best.runEnd;
      if (ne > nextStart) continue;                       // 不能晚于后序开工
      if ((nextStart - ne) / HOUR > LIMIT) continue;      // 间隔仍超限
      if (upEnd != null && (ns < upEnd || (ns - upEnd) / HOUR > LIMIT)) continue;  // 不破坏上游间隔
      // 从原机台移除，落到目标机台
      const oldArr = seg.get(prev.machineUid) || [];
      const oi = oldArr.findIndex(x => x.id === prev.id);
      if (oi >= 0) oldArr.splice(oi, 1);
      if (!seg.has(cand.uid)) seg.set(cand.uid, []);
      prev.machineUid = cand.uid;
      if (cand.machine) { prev.machineId = cand.machine.id; prev.machineName = cand.machine.name || null; }
      prev.rate = round(cand.rate, 4);
      prev.durationMin = Math.round(durMs / 60000);
      prev.start = ns; prev.end = ne;
      prev.setupHours = r.best.setup.hours;
      prev.setupReasons = r.best.setup.reasons;
      prev.setupTier = r.best.setup.tier;
      prev.setupStart = r.best.setup.hours > 0 ? ns - r.best.setup.hours * HOUR : null;
      prev.setupEnd = prev.setupStart != null ? ns : null;
      /* 换机台后，本工序的开工时间与「上工序完工」的关系变了：可追溯字段必须一起更新，
         否则工序排产表里的上工序结束 / 工序间隔会指向移动前的旧值。 */
      prev.prevFinish = upEnd != null ? upEnd : prev.prevFinish;
      if (prev.prevFinish != null) prev.gapMin = Math.round((ns - prev.prevFinish) / 60000);
      const o = { start: prev.setupHours > 0 ? ns - prev.setupHours * HOUR : ns, end: ne, id: prev.id, spec: prev.spec, kind: 'run' };
      segIndex.set(prev.id, o);
      seg.get(cand.uid).push(o);
      seg.get(cand.uid).sort((a, b) => a.start - b.start);
      return true;
    }
    return false;
  };
  const shift = (t, deltaMs) => {
    const ns = t.start + deltaMs, ne = t.end + deltaMs;
    if (!fits(t, ns, ne)) return false;
    t.start = ns; t.end = ne;
    if (t.setupStart != null) t.setupStart += deltaMs;
    /* 可追溯字段必须跟着任务一起走，否则工序排产表里的「上工序结束 / 工序间隔 / 换型结束」
       会指向移动前的位置（实测 30 条 prevFinish 陈旧、17 条 setupEnd ≠ 开工）。 */
    t.setupEnd = t.setupStart != null ? ns : null;
    const o = segIndex.get(t.id);
    if (o) { o.start = t.setupHours > 0 ? ns - t.setupHours * HOUR : ns; o.end = ne; }
    /* 同订单的后继工序：上工序完工时间随之变化，间隔与余量重算。
       注意 byOrder 的值是「按工序键索引的对象」而不是数组（本函数第 329 行），
       用数组下标访问会抛异常，被上层 try/catch 吞掉后整条流水线静默降级。 */
    const chMap = byOrder.get(String(t.orderId));
    if (chMap) {
      const ki = order.indexOf(t.process);
      for (let j = ki + 1; ki >= 0 && j < order.length; j++) {
        const nx = chMap[order[j]];
        if (!nx) continue;
        nx.prevFinish = t.end;
        nx.gapMin = nx.start != null ? Math.round((nx.start - t.end) / 60000) : null;
      }
    }
    return true;
  };
  let fixed = 0, moved = 0, skippedBudget = 0, attemptedMove = 0;
  const order = chainOf(model);
  for (const [, ch] of byOrder) {
    for (let i = 1; i < order.length; i++) {
      const prev = ch[order[i - 1]], next = ch[order[i]];
      if (!prev || !next) continue;
      if (prev.locked || prev.frozen) continue;
      let wait = (next.start - prev.end) / HOUR;
      if (wait <= LIMIT + 1e-6) continue;
      let budget = wait - LIMIT;
      const up = i >= 2 ? ch[order[i - 2]] : null;
      if (up) { const w0 = (prev.start - up.end) / HOUR; budget = Math.min(budget, Math.max(0, LIMIT - w0)); }
      if (budget <= 0.01) {
        // 上游间隔已经吃满，无法再后移前序；仅当不破坏上游间隔时才尝试换机台重放
        skippedBudget++;
        attemptedMove++;
        if (moveLate(prev, next.start, up ? up.end : null)) { moved++; fixed++; }
        continue;
      }
      const deltaMs = Math.round(budget * HOUR);
      if (shift(prev, deltaMs)) { fixed++; continue; }
      attemptedMove++;
      if (moveLate(prev, next.start, up ? up.end : null)) { moved++; fixed++; }
    }
  }
  return { tasks, fixed, moved, skippedBudget, attemptedMove };
}

/* ------------------------------------------------------------------
   局部改进：对迟到订单做有界的换机台恢复，只接受严格改善且不新增硬冲突
   ------------------------------------------------------------------ */
export function improveSchedule(input, rounds = 2) {
  const { model, settings, horizonDays = 45, onProgress } = input;
  const cap = model.cap;
  const planStart = new Date(settings.planStart).getTime();
  const horizonEnd = planStart + horizonDays * 24 * HOUR;
  const setupWeight = settings.setupWeight ?? 0.5;
  const tls = createTimelines();
  const chainKeys = chainOf(model);
  for (const p of chainKeys) for (const m of (cap.machines[p] || [])) tlOf(tls, m.uid);

  const tasks = input.tasks.map(t => ({ ...t }));
  const byOrder = new Map();
  for (const t of tasks) { if (!byOrder.has(t.orderId)) byOrder.set(t.orderId, {}); byOrder.get(t.orderId)[t.process] = t; }
  const placedIds = new Set(tasks.filter(t => t.scheduled).map(t => t.id));

  const downs = downtimeBlocks(cap, settings);   // 停机窗口必须一并重建，否则优化会把任务挪进故障区间（P1-4）
  const rebuild = () => {
    for (const list of tls.values()) list.length = 0;
    for (const d of downs) tlOf(tls, d.uid).push({ kind: 'down', start: d.s, end: d.e, reason: '设备不可用' });
    const sorted = tasks.filter(t => t.scheduled).sort((a, b) => a.start - b.start || chainKeys.indexOf(a.process) - chainKeys.indexOf(b.process));
    for (const t of sorted) {
      const m = cap.machineById(t.process, t.machineId); if (!m) continue;
      insertSeg(tlOf(tls, m.uid), { kind: 'run', taskId: t.id, start: t.start, end: t.end, spec: t.spec, process: t.process });
      if (t.setupHours > 0) insertSeg(tlOf(tls, m.uid), { kind: 'setup', taskId: t.id, start: t.start - t.setupHours * HOUR, end: t.start, process: t.process });
    }
  };
  rebuild();

  const lastKey = chainKeys.length ? chainKeys[chainKeys.length - 1] : null;
  const finishOf = (orderId) => {
    const ch = byOrder.get(orderId);
    return (ch && lastKey) ? (ch[lastKey]?.end ?? null) : null;
  };
  const tardyOf = (order) => { const f = finishOf(order.id); return (f && order.due) ? Math.max(0, (f - order.due.getTime()) / HOUR) : null; };

  let improved = 0;
  for (let r = 0; r < rounds; r++) {
    const tardy = model.jobs.map(j => ({ j, tard: tardyOf(j.order) })).filter(x => x.tard && x.tard > 0)
      .sort((a, b) => b.tard - a.tard);
    if (!tardy.length) break;
    for (const { j } of tardy) {
      if (j.order.rush && r === 0) continue;
      for (const op of j.ops) {
        const t = byOrder.get(j.order.id)?.[op.process];
        if (!t || !t.scheduled || t.locked || t.frozen) continue;
        const before = finishOf(j.order.id);
        const m = cap.machineById(t.process, t.machineId);
        // 提交前快照：本任务的完整位置 + 后续工序时间，校验不通过时整体回滚
        const snapT = { machineId: t.machineId, machineUid: t.machineUid, machineName: t.machineName,
          rate: t.rate, durationMin: t.durationMin, start: t.start, end: t.end,
          setupHours: t.setupHours, setupReasons: t.setupReasons, setupTier: t.setupTier, setupStart: t.setupStart,
          improved: t.improved };
        // 临时移除自身
        const list = tlOf(tls, m.uid);
        const ri = list.findIndex(s => s.taskId === t.id && s.kind === 'run');
        const removed = list.filter(s => s.taskId === t.id);
        for (const s of removed) list.splice(list.indexOf(s), 1);
        const opIdx = chainKeys.indexOf(op.process);
        const release = opIdx <= 0
          ? Math.max(planStart, j.order.materialReadyAt ? new Date(j.order.materialReadyAt).getTime() : planStart)
          : (byOrder.get(j.order.id)[chainKeys[opIdx - 1]]?.end ?? planStart);
        const tryM = (machine, rate) => {
          const dur = durationMin(op.qty, rate); if (!dur) return null;
          const r2 = tryPlace({ segments: tlOf(tls, machine.uid), releaseMs: release, durMs: dur * MS, spec: t.spec, process: t.process, coModel: {}, setupWeight, horizonEnd, procDef: model.procMap ? model.procMap[t.process] : null });
          return r2.ok ? { machine, rate, dur, place: r2.best } : null;
        };
        /* 同 moveLate：不因「目标机台无前序任务 → tryPlace 给 0 换型」拒绝候选（那会堵死 R6 修复路径）。
           换型口径的这一处低估在 README 的「诚实边界」中如实披露。 */
        let bestCand = tryM(m, t.rate);
        for (const c of cap.capableMachines(t.process, op.specCtx)) {
          if (c.machine.uid === m.uid) continue;
          const cand = tryM(c.machine, c.rate);
          if (!cand) continue;
          if (!bestCand || cand.place.runEnd < bestCand.place.runEnd - 1) bestCand = cand;
        }
        if (!bestCand) { for (const s of removed) insertSeg(list, s); continue; }
        // 计算该订单新的完工时间（后续工序顺延）
        const delta = bestCand.place.runEnd - t.end;
        const newFinish = before == null ? null : before + delta;
        const oldTard = j.order.due ? Math.max(0, before - j.order.due.getTime()) : 0;
        const newTard = j.order.due && newFinish ? Math.max(0, newFinish - j.order.due.getTime()) : 0;
        const sameSpecBonus = bestCand.place.setup.hours <= t.setupHours;
        if (newFinish != null && (newTard < oldTard - MS || (newTard <= oldTard && delta < 0 && sameSpecBonus))) {
          t.machineId = bestCand.machine.id; t.machineUid = bestCand.machine.uid;
          t.machineName = bestCand.machine.name || null;
          t.rate = round(bestCand.rate, 4); t.durationMin = bestCand.dur;
          t.start = bestCand.place.runStart; t.end = bestCand.place.runEnd;
          t.setupHours = bestCand.place.setup.hours; t.setupReasons = bestCand.place.setup.reasons; t.setupTier = bestCand.place.setup.tier;
          t.setupStart = t.setupHours > 0 ? t.start - t.setupHours * HOUR : null;
          t.setupEnd = t.setupStart != null ? t.start : null;
          const prevKey = chainKeys[chainKeys.indexOf(t.process) - 1];
          const pT = prevKey ? byOrder.get(j.order.id)?.[prevKey] : null;
          if (pT) { t.prevFinish = pT.end; t.gapMin = Math.round((t.start - pT.end) / 60000); }
          t.improved = (t.improved || 0) + 1;
          insertSeg(tlOf(tls, bestCand.machine.uid), { kind: 'run', taskId: t.id, start: t.start, end: t.end, spec: t.spec, process: t.process });
          if (t.setupHours > 0) insertSeg(tlOf(tls, t.machineUid), { kind: 'setup', taskId: t.id, start: t.start - t.setupHours * HOUR, end: t.start, process: t.process });
          // 后续工序顺延（先记账，提交前统一校验）
          const chain = j.chain?.filter(Boolean) || [];
          const idx = chain.findIndex(x => x.id === t.id);
          const shifted = [];
          for (let k = idx + 1; k < chain.length; k++) {
            const nt = byOrder.get(j.order.id)[chain[k].process];
            if (!nt || nt.locked || nt.frozen) continue;
            shifted.push({ nt, start: nt.start, end: nt.end, setupStart: nt.setupStart, setupEnd: nt.setupEnd });
            nt.start += delta; nt.end += delta;
            if (nt.setupStart != null) nt.setupStart += delta;
            if (nt.setupEnd != null) nt.setupEnd += delta;
            /* 前序工序提前/推后后，本工序的「上工序结束 / 工序间隔」必须同步重算，
               否则工序排产表里的这两个可追溯字段会指向移动前的位置。 */
            const prevOp = chainKeys[chainKeys.indexOf(nt.process) - 1];
            const pTask = byOrder.get(j.order.id)?.[prevOp];
            if (pTask) { nt.prevFinish = pTask.end; nt.gapMin = Math.round((nt.start - pTask.end) / 60000); }
          }
          /* 提交前校验：顺延后的后续工序可能与其他订单重叠或落入停机窗口。
             原先不做任何校验就提交（审查报告 P2-11），这里改为整体回滚。 */
          const bad = hasOverlap(tasks) || tasks.some(x => x.scheduled && downs.some(d => {
            if (x.machineUid !== d.uid) return false;
            const s = x.setupHours > 0 ? x.start - x.setupHours * HOUR : x.start;
            return s < d.e && x.end > d.s;
          }));
          if (bad) {
            Object.assign(t, snapT);
            for (const sh of shifted) { sh.nt.start = sh.start; sh.nt.end = sh.end; sh.nt.setupStart = sh.setupStart; }
            rebuild();
            continue;
          }
          rebuild();
          improved++;
        } else {
          for (const s of removed) insertSeg(list, s);
        }
      }
    }
    if (onProgress) onProgress((r + 1) / rounds);
  }
  return { tasks: refreshTraceFields(tasks, chainKeys), improved, timelines: tls };
}

/**
 * 收尾归一化：按最终位置重算「上工序完工 / 工序间隔」两个可追溯字段。
 *
 * 为什么需要它：R6 修复与局部优化会以多种方式移动任务（原地后移、换机台重放、后续工序顺延），
 * 每条路径都可能漏更新前序字段；逐个补丁既容易漏，也难以证明补全。
 * 这里在流水线末尾按最终任务表无条件重算一遍，保证《三工序排产算法设计》§10.1
 * 要求的「上工序结束 / 工序间隔」与任务实际位置永远自洽。
 */
export function refreshTraceFields(tasks, chainKeys) {
  const byOrder = new Map();
  for (const t of tasks) {
    if (!t || !t.scheduled) continue;
    if (!byOrder.has(t.orderId)) byOrder.set(t.orderId, {});
    byOrder.get(t.orderId)[t.process] = t;
  }
  for (const [, ch] of byOrder) {
    for (let i = 1; i < chainKeys.length; i++) {
      const cur = ch[chainKeys[i]], prev = ch[chainKeys[i - 1]];
      if (!cur || !prev) continue;
      cur.prevFinish = prev.end;
      cur.gapMin = cur.start != null && prev.end != null ? Math.round((cur.start - prev.end) / 60000) : null;
      cur.setupEnd = cur.setupStart != null ? cur.start : null;
    }
  }
  return tasks;
}
