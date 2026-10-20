#!/usr/bin/env node
/* 前瞻派单算法（web/src/engine/dispatch.js · runDispatchSchedule）自检
   ==================================================================
   依据《三工序排产算法设计》§11「核验与小规模测试」，把该节要求的
   「排产结束后独立检查」与 8 个测试场景全部变成能失败的断言。

   A. 独立核验（真实数据集 data/dataset.json）
      不调用引擎自己的 validateSchedule，直接遍历 tasks 重算 8 项：
        1) 订单不早于下达时间（materialReadyAt，缺省 = 计划起点）
        2) 工序顺序正确（拉丝 → 捻股 → 合绳，且相邻工序时间不重叠）
        3) 机台兼容（用数据集原始设备台账 / 产能矩阵独立重算，不用 cap.isCapable）
        4) 同台换型与加工不重叠（含换型段 [start-setup, start]）
        5) 换型符合配置变化（同配置 0 换型；异配置换型分钟数 = 拉丝 60 / 捻股合绳 10×股数 夹紧到 1–5 h；
           每台机首个任务按 §1.3-2 保守计一次初始换型）
        6) 两段工序间隔 ≤ 4320 min，或该工序被显式标注为异常
        7) 交期结果与实际合绳完成一致（独立重算 准时/延期/未知 与延期小时，与引擎指标逐项对齐）
        8) 每工序最多分配一次（订单×工序唯一、任务号唯一）
      分别在「dispatch 原始输出」与「完整流水线（schedule() → R6 修复 → 局部优化）」上跑：
        · dispatch 原始输出：8 项全部 0 违规（严格模式，含换型公式与可追溯字段）；
        · 完整流水线：硬约束（1/2/4/6/8）0 违规；换型公式与可追溯字段的偏差作为诊断打印（见文末）。

   B. 核验器反向自检
      对同一份任务表人为注入 7 类违规（下达 / 兼容 / 工序顺序 / 重复分配 / 重叠 / 换型 / 72h），
      核验器必须逐类报红 —— 证明 A 段的「0 违规」不是恒真断言。

   C. §11 的 8 个场景（tools/fixtures/dispatch-case-*.json）
      每个场景一组 2–3 张订单 + 2–3 台设备的极小夹具，断言具体机台号、换型分钟数、
      预约关系与时间先后；每个场景都另有「夹具前提」断言，保证场景本身成立。
      夹具的机台初始状态（free_time / current_family）用 orderId = 「__BG__」的预置锁定任务设置。

   D. 已知缺陷复现（非断言，只打印证据）
      夹具 tools/fixtures/dispatch-defect-reservation.json：预约建立后被更慢的机台抢走（0 次兑现）；
      以及「本机不可行、下一台可行」的订单根本没被预约、最后被本机以延期风险落位。

   变异测试实测（在 /tmp 副本上故意改坏 dispatch.js 后逐条实跑；基线 92 通过 / 0 失败）
   ------------------------------------------------------------------
   变异 1｜删掉预约：§5.5 的 「if (alt) {」 改成 「if (false && alt) {」
         → 失败 19 条，目标断言 1.4（d 应在 D02）、4.1（K4-D 应在 D02）、7.1（预约 1 次）全部变红。
   变异 2｜setupMinutesFor 的换型时长恒返回 0
         → 失败 19 条，含 A4·setup（真实数据 745 条「异配置却 0 换型」）、1.5、2.2、B0。
   变异 3｜去掉 72 h 检查：evaluate() 的 gapOk 恒为 true
         → 失败 2 条，正是 5.3 / 5.4（K5-X 被改判为可以等 S02，间隔 4296 > 4320）。
   变异 4｜人为错开机台：dispatchAll() 内层派单按 forecastGapMin 推迟后续空闲机台
         → 失败 3 条，含 6.2 / 6.3（三台机从「同时 00:00 换型」变成 +0 / +10 / +10 min 错开）。
   变异 5｜忽略 DEFER：派单层永远按 AFTER_URGENT 取层
         → 失败 5 条，含 8.7 / 8.8（K8-Z 被当普通订单排进去、deferred 不再是 1）。
   变异 6｜换型判定恒为「同型号无需换型」
         → 失败 14 条，含 A4·setup（真实数据 645 条）、2.2、2.3。
   复现方式：cp -R web tools data /tmp/dsh-mut && 改 /tmp/dsh-mut/web/src/engine/dispatch.js
             && node /tmp/dsh-mut/tools/check_dispatch.mjs
   （基线对 web/src/engine/dispatch.js 修订 af7ba0df0f39… 实测 92 通过 / 0 失败，退出码 0。）

   用法：node tools/check_dispatch.mjs
   退出码：0 全部通过；1 存在失败项。 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { createScheduler } = await import(resolve(ROOT, 'web/src/engine/index.js'));
const { runDispatchSchedule, DISPATCH_DEFAULTS } = await import(resolve(ROOT, 'web/src/engine/dispatch.js'));

const MIN = 60000, HOUR = 3600000, LIMIT_MIN = 4320;
const T0 = new Date(2026, 0, 5, 0, 0).getTime();          // 夹具统一计划起点 2026-01-05T00:00（本地时区）
const PLAN_START = '2026-01-05T00:00';
const BG = '__BG__';                                       // 夹具里「只设置机台状态」的伪订单号
const CHAIN = ['drawing', 'stranding', 'closing'];
const PROCESS_CN = { drawing: '拉丝', stranding: '捻股', closing: '合绳' };

/* ------------------------------ 断言工具 ------------------------------ */
let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return true; }
  fail++; failures.push(name + (detail ? ' :: ' + detail : ''));
  return false;
};
const section = t => console.log('\n--- ' + t + ' ---');
const fmt = ms => {
  const d = new Date(ms), p = n => String(n).padStart(2, '0');
  return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
};
const fmtOff = ms => (ms >= 0 ? '+' : '') + Math.round(ms / MIN) + 'min';
function numOrNull(v) { return (v == null || v === '' || isNaN(Number(v))) ? null : Number(v); }
function toMs(v) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]).getTime();
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0).getTime();
  const d = new Date(s); return isNaN(d) ? null : d.getTime();
}
function dueOf(o) {
  const ms = toMs(o.preShipDate);
  if (ms == null) return null;
  if (/[T ]\d{2}:\d{2}/.test(String(o.preShipDate))) return ms;
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 0, 0).getTime();
}

/* --------------------------- 独立核验器（§11） ---------------------------
   直接遍历 tasks + 数据集原始表重算；不使用 validateSchedule，也不使用 cap.isCapable。
   strictSetup      是否校验换型公式（完整流水线会被后处理改坏，见末节诊断）
   checkTraceFields 是否校验 prevFinish / setupEnd 等可追溯字段的自洽性
   anomalies        dispatch 的异常清单（kind='gap' 用于「已显式标注」判定） */
function verifyIndependently({ tasks, orders, ds, planStart, anomalies = [], strictSetup = true, checkTraceFields = true, intervalLimitMin = LIMIT_MIN }) {
  const V = [];
  const add = (rule, t, detail) => V.push({ rule, taskId: t.id, orderId: t.orderId, process: t.process, detail });

  /* 机台索引：完全来自数据集原始表 */
  const machineByUid = new Map();
  for (const p of CHAIN) (ds.machines[p] || []).forEach((m, i) => machineByUid.set(p + ':' + m.id, { process: p, id: String(m.id), idx: i, raw: m }));
  const matrixRowOf = (process, ctx) => {
    const cap = ds.capacity[process];
    if (!cap || !ctx || !ctx.row) return null;
    return (cap.rows || []).find(r => String(r.name == null ? '' : r.name) === String(ctx.row.name == null ? '' : ctx.row.name)
      && String(r.spec == null ? '' : r.spec) === String(ctx.row.spec == null ? '' : ctx.row.spec)) || null;
  };

  /* 1) 不早于下达时间 */
  const orderById = new Map((orders || []).map(o => [o.id, o]));
  for (const t of tasks) {
    const o = orderById.get(t.orderId);
    if (!o) continue;
    if (t.locked || t.frozen) continue;                 // 预置锁定/冻结任务是窗口前的在制品，不参与本项
    const ready = o.materialReadyAt ? toMs(o.materialReadyAt) : null;
    const release = Math.max(planStart, ready == null ? planStart : ready);
    if (!(t.start >= release)) add('release', t, '开工 ' + fmt(t.start) + ' 早于下达时间 ' + fmt(release));
  }

  /* 3) 机台兼容（独立重算）
     注：预置锁定任务不带 machineUid，这里按 工序:机台号 重新推导，避免把机台认成 undefined。 */
  const uidOf = t => t.machineUid || (t.process + ':' + t.machineId);
  for (const t of tasks) {
    const mi = machineByUid.get(uidOf(t));
    if (!mi) { add('compat', t, '机台 ' + uidOf(t) + ' 不在数据集设备台账中'); continue; }
    if (mi.process !== t.process) { add('compat', t, '机台工序 ' + mi.process + ' ≠ 任务工序 ' + t.process); continue; }
    if (t.process === 'drawing') {
      const d = numOrNull(t.specCtx && t.specCtx.wireSpecMm);
      if (d == null) { add('compat', t, '缺少原料规格 wireSpecMm'); continue; }
      if (mi.raw.specMin != null && d < mi.raw.specMin - 1e-9) add('compat', t, '原料 ' + d + 'mm 低于台账区间 ' + mi.raw.specMin + '–' + mi.raw.specMax);
      if (mi.raw.specMax != null && d > mi.raw.specMax + 1e-9) add('compat', t, '原料 ' + d + 'mm 高于台账区间 ' + mi.raw.specMin + '–' + mi.raw.specMax);
      continue;
    }
    const cap = ds.capacity[t.process];
    if (!cap) { add('compat', t, '数据集缺 ' + t.process + ' 产能矩阵'); continue; }
    const ids = (cap.machineIds && cap.machineIds.length) ? cap.machineIds.map(String) : (ds.machines[t.process] || []).map(m => String(m.id));
    const i = ids.indexOf(mi.id);
    if (i < 0) { add('compat', t, '机台不在矩阵 machineIds 中'); continue; }
    const row = matrixRowOf(t.process, t.specCtx);
    if (!row) { add('compat', t, '矩阵中找不到该规格行'); continue; }
    if (Array.isArray(row.caps)) {
      const capIds = row.caps.map(c => (typeof c === 'number' && Number.isInteger(c)) ? ids[c] : String(c));
      if (capIds.indexOf(mi.id) < 0) add('compat', t, 'caps 未包含该机台');
      continue;
    }
    if (Array.isArray(row.rates)) { const v = row.rates[i]; if (!(v > 0)) add('compat', t, '矩阵额定为空/0（视为不适配）'); continue; }
    const coef = (cap.coefficients || [])[i], tor = row.torsion;
    if (!(tor != null && coef != null && tor * coef > 0)) add('compat', t, '捻距×设备系数 无效');
  }

  /* 8) 每工序最多分配一次 */
  const seenOp = new Set(), seenId = new Set();
  for (const t of tasks) {
    if (seenId.has(t.id)) add('duplicate', t, '任务号重复：' + t.id);
    seenId.add(t.id);
    if (CHAIN.indexOf(t.process) < 0) add('duplicate', t, '未知工序 ' + t.process);
    /* 数据集之外的预置任务（夹具里 orderId = __BG__ 的机台状态锁定）只查任务号唯一 */
    if (!orderById.has(t.orderId)) continue;
    const k = t.orderId + '|' + t.process;
    if (seenOp.has(k)) add('duplicate', t, '同一订单同一工序被分配多次');
    seenOp.add(k);
  }

  /* 2) 工序顺序正确 */
  const byOrder = new Map();
  for (const t of tasks) { if (!byOrder.has(t.orderId)) byOrder.set(t.orderId, {}); byOrder.get(t.orderId)[t.process] = t; }
  for (const [oid, ch] of byOrder) {
    for (const [a, b] of [['drawing', 'stranding'], ['stranding', 'closing']]) {
      if (!ch[a] || !ch[b]) continue;
      if (ch[b].start < ch[a].end) add('sequence', ch[b], PROCESS_CN[b] + ' 开工 ' + fmt(ch[b].start) + ' 早于 ' + PROCESS_CN[a] + ' 完工 ' + fmt(ch[a].end));
      if (checkTraceFields && ch[b].prevFinish != null && ch[b].prevFinish !== ch[a].end) {
        add('sequence', ch[b], '字段 prevFinish=' + fmt(ch[b].prevFinish) + ' 与实际上工序完工 ' + fmt(ch[a].end) + ' 不一致');
      }
    }
  }

  /* 4) 同台换型与加工不重叠 */
  const byMachine = new Map();
  for (const t of tasks) { const u = uidOf(t); if (!byMachine.has(u)) byMachine.set(u, []); byMachine.get(u).push(t); }
  for (const [uid, arr] of byMachine) {
    for (const t of arr) {
      const setupMs = (t.setupHours || 0) * HOUR;
      if (!(t.end > t.start)) add('overlap', t, '加工区间非正：' + fmt(t.start) + ' → ' + fmt(t.end));
      if (setupMs > 0) {
        if (t.setupStart == null || t.setupStart !== t.start - setupMs) add('overlap', t, '换型段起点 ≠ 加工开工 − 换型时长');
        if (checkTraceFields && t.setupEnd != null && t.setupEnd !== t.start) add('overlap', t, '换型段终点 ≠ 加工开工（字段与实际不符）');
      } else if (t.setupStart != null) add('overlap', t, '换型 0 min 却给出了换型段');
    }
    const segs = arr.map(t => ({ s: t.start - (t.setupHours || 0) * HOUR, e: t.end, t })).sort((a, b) => a.s - b.s);
    for (let i = 1; i < segs.length; i++) {
      if (segs[i].s < segs[i - 1].e) add('overlap', segs[i].t, '与本机台 ' + segs[i - 1].t.id + ' 的占用段重叠（' + fmt(segs[i].s) + ' < ' + fmt(segs[i - 1].e) + '）');
    }
  }

  /* 5) 换型符合配置变化 */
  const famOf = t => {
    const c = t.specCtx || {};
    if (t.process === 'drawing') return [c.wireSpecMm == null ? '?' : c.wireSpecMm, c.outSpec == null ? (c.outDia == null ? '?' : c.outDia) : c.outSpec].join('|');
    return [c.count == null ? '?' : c.count, c.structure == null ? '?' : c.structure, c.diameter == null ? '?' : c.diameter].join('|');
  };
  const expectSetupMin = t => {
    if (t.process === 'drawing') return DISPATCH_DEFAULTS.drawingSetupMin;
    const n = numOrNull(t.specCtx && t.specCtx.count);
    const raw = n == null ? DISPATCH_DEFAULTS.unknownStrandSetupMin : DISPATCH_DEFAULTS.perStrandSetupMin * n;
    return Math.min(Math.max(raw, DISPATCH_DEFAULTS.r5MinHours * 60), DISPATCH_DEFAULTS.r5MaxHours * 60);
  };
  if (strictSetup) {
    for (const [, arr] of byMachine) {
      const list = arr.slice().sort((a, b) => a.start - b.start);
      let prevFam = null;
      for (const t of list) {
        const fam = famOf(t), mins = Math.round((t.setupHours || 0) * 60);
        if (t.locked || t.frozen) { prevFam = fam; continue; }   // 预置任务不判换型，但它的配置就是机台当前配置
        if (prevFam === null) {
          if (mins !== expectSetupMin(t)) add('setup', t, '机台首个任务应保守计初始换型 ' + expectSetupMin(t) + ' min，实为 ' + mins);
        } else if (prevFam === fam) {
          if (mins !== 0) add('setup', t, '同配置（' + fam + '）却换型 ' + mins + ' min');
        } else if (mins === 0) {
          add('setup', t, '异配置（' + prevFam + ' → ' + fam + '）却 0 换型');
        } else if (mins !== expectSetupMin(t)) {
          add('setup', t, '换型 ' + mins + ' min ≠ 公式值 ' + expectSetupMin(t) + ' min');
        }
        prevFam = fam;
      }
    }
  }

  /* 6) 72 h 工序间隔（或显式标注异常） */
  const gapMarked = new Set(anomalies.filter(a => a.kind === 'gap').map(a => a.orderId + '|' + a.process));
  for (const [oid, ch] of byOrder) {
    for (const [a, b] of [['drawing', 'stranding'], ['stranding', 'closing']]) {
      if (!ch[a] || !ch[b]) continue;
      const gap = (ch[b].start - ch[a].end) / MIN;
      if (gap <= intervalLimitMin) continue;
      const marked = (ch[b].riskTags || []).length > 0 || (ch[b].gapSlackMin != null && ch[b].gapSlackMin < 0) || gapMarked.has(oid + '|' + b);
      if (!marked) add('gap', ch[b], '间隔 ' + Math.round(gap) + ' min > ' + intervalLimitMin + ' min，且未显式标注为工艺间隔异常');
    }
  }
  return V;
}
const RULE_CN = { release: '订单不早于下达时间', compat: '机台兼容', sequence: '工序顺序', duplicate: '每工序最多分配一次', overlap: '同台换型与加工不重叠', setup: '换型符合配置变化', gap: '72h 工序间隔' };
const ruleCounts = V => { const c = {}; for (const v of V) c[v.rule] = (c[v.rule] || 0) + 1; return c; };
const showViolations = (V, n = 4) => {
  for (const v of V.slice(0, n)) console.log('      ' + RULE_CN[v.rule] + ' | ' + v.taskId + ' | ' + v.detail);
  if (V.length > n) console.log('      … 其余 ' + (V.length - n) + ' 条同类违规不再展开');
};

/* ==================================================================
   A. §11 独立核验 · 真实数据集
   ================================================================== */
section('A. §11 独立核验 · 真实数据集 data/dataset.json');
const real = JSON.parse(await readFile(resolve(ROOT, 'data/dataset.json'), 'utf8'));
const sReal = createScheduler(real);
const full = sReal.schedule({ strategy: 'dispatch' });
const settingsReal = { ...sReal.defaults(), strategy: 'dispatch' };
const modelReal = sReal.buildModel(settingsReal);
const raw = runDispatchSchedule({ model: modelReal, settings: settingsReal, horizonDays: settingsReal.horizonDays });
const planStartReal = new Date(settingsReal.planStart).getTime();
const rawTasks = raw.tasks.filter(t => t.scheduled);
const fullTasks = full.tasks.filter(t => t.scheduled);

ok('A1 真实数据集能构建模型（未阻断订单 > 250）', modelReal.jobs.length > 250, 'jobs=' + modelReal.jobs.length);
ok('A2 dispatch 原始输出订单×工序全覆盖（无未排工序）',
  raw.unscheduled.length === 0 && rawTasks.length === modelReal.jobs.length * modelReal.chainKeys.length,
  '任务 ' + rawTasks.length + ' / 期望 ' + (modelReal.jobs.length * modelReal.chainKeys.length) + ' / 未排 ' + raw.unscheduled.length);

const Vraw = verifyIndependently({ tasks: rawTasks, orders: real.orders, ds: real, planStart: planStartReal, anomalies: raw.anomalies, strictSetup: true, checkTraceFields: true });
const cr = ruleCounts(Vraw);
ok('A3 原始输出：8 项独立核验全部 0 违规', Vraw.length === 0, JSON.stringify(cr) + ' 例：' + (Vraw[0] ? Vraw[0].detail : ''));
if (Vraw.length) showViolations(Vraw);
for (const r of Object.keys(RULE_CN)) {
  ok('A4·' + r + ' 原始输出「' + RULE_CN[r] + '」无违规（' + rawTasks.length + ' 条任务）', !cr[r], (cr[r] || 0) + ' 条');
}
ok('A5 原始输出覆盖 3 道工序（核验非空转）',
  new Set(rawTasks.map(t => t.process)).size === 3 && rawTasks.length > 800,
  '任务 ' + rawTasks.length + ' / 工序 ' + [...new Set(rawTasks.map(t => t.process))].join(','));
ok('A6 原始输出确有换型与预约（核验非空转）',
  rawTasks.filter(t => (t.setupHours || 0) > 0).length > 100 && raw.stats.reservations > 10,
  '换型 ' + rawTasks.filter(t => (t.setupHours || 0) > 0).length + ' 条 / 预约 ' + raw.stats.reservations + ' 次');

/* 7) 交期结果与实际合绳完成一致：独立重算 vs 引擎指标（在完整流水线的最终任务上） */
const finishOf = new Map();
for (const t of fullTasks) if (t.process === 'closing') finishOf.set(t.orderId, t.end);
let onTime = 0, late = 0, unknown = 0, lateMin = 0;
for (const o of modelReal.active) {
  const fin = finishOf.get(o.id), due = dueOf(o);
  if (fin == null || due == null) { unknown++; continue; }
  if (fin > due) { late++; lateMin += (fin - due) / MIN; } else onTime++;
}
const M = full.metrics;
ok('A7 交期结果与实际合绳完成一致（准时单数）', onTime === M.onTimeOrders, onTime + ' vs ' + M.onTimeOrders);
ok('A8 交期结果与实际合绳完成一致（延期单数）', late === M.lateOrders, late + ' vs ' + M.lateOrders);
ok('A9 交期结果与实际合绳完成一致（无法判定单数）', unknown === M.unknownOrders, unknown + ' vs ' + M.unknownOrders);
ok('A10 交期结果与实际合绳完成一致（延期小时）', Math.abs(lateMin / 60 - M.lateHours) < 0.06, (lateMin / 60).toFixed(1) + ' vs ' + M.lateHours);
ok('A11 交期重算覆盖全部纳入订单', onTime + late + unknown === modelReal.active.length, JSON.stringify({ onTime, late, unknown, active: modelReal.active.length }));

const Vfull = verifyIndependently({ tasks: fullTasks, orders: real.orders, ds: real, planStart: planStartReal, anomalies: full.anomalies || [], strictSetup: false, checkTraceFields: false });
const cf = ruleCounts(Vfull);
ok('A12 完整流水线：硬约束（下达/顺序/兼容/不重叠/72h/唯一）0 违规', Vfull.length === 0, JSON.stringify(cf) + ' 例：' + (Vfull[0] ? Vfull[0].detail : ''));
if (Vfull.length) showViolations(Vfull);

console.log('  [实测] 订单 ' + real.orders.length + ' · 纳入 ' + modelReal.active.length + ' · 未阻断 ' + modelReal.jobs.length + ' · 模型阻断 ' + modelReal.blocked.length
  + ' · 任务 ' + rawTasks.length + ' · 未排 ' + raw.unscheduled.length + ' · 准时率 ' + (M.deliveryRate == null ? '—' : M.deliveryRate + '%')
  + ' · 延期单 ' + M.lateOrders + ' · 预约 ' + raw.stats.reservations + '（兑现 ' + raw.stats.reservationHonored + '）'
  + ' · 含换型任务 ' + rawTasks.filter(t => (t.setupHours || 0) > 0).length + ' · 72h 异常标注 ' + raw.stats.gapViolations);

/* 诊断：完整流水线相对 dispatch 原始输出的偏差（已知缺陷，源在 scheduler.js 后处理，不属 dispatch.js） */
const VfullStrict = verifyIndependently({ tasks: fullTasks, orders: real.orders, ds: real, planStart: planStartReal, anomalies: full.anomalies || [], strictSetup: true, checkTraceFields: true });
const cfs = ruleCounts(VfullStrict);
console.log('  [诊断·非断言] 完整流水线严格核验偏差：' + JSON.stringify(cfs)
  + '（setup ' + (cfs.setup || 0) + ' 条来自 R6 修复/局部优化重放任务时把新机台当作「初始配置未知」给了 0 换型；'
  + 'sequence/overlap ' + ((cfs.sequence || 0) + (cfs.overlap || 0)) + ' 条为 prevFinish / setupEnd 字段未随任务移动更新；均不属 dispatch.js）');
const beforeOrderDate = fullTasks.filter(t => { const o = real.orders.find(x => x.id === t.orderId); const od = o && toMs(o.orderDate); return od != null && t.start < od; }).length;
console.log('  [诊断·非断言] 以 orderDate 为下达口径时有 ' + beforeOrderDate + ' 条任务早于订单日期（引擎下达口径 = materialReadyAt ?? 计划起点；本数据集无 materialReadyAt）');
const storeSrc = await readFile(resolve(ROOT, 'web/src/core/store.js'), 'utf8');
if (!/runDispatchSchedule/.test(storeSrc)) {
  console.log('  [诊断·非断言] 界面主路径 web/src/core/store.js 未引用 runDispatchSchedule：generate() 直接调用 runSchedule，'
    + 'settings.strategy 在 GUI 中不生效（本脚本走引擎门面 / 直接调用，核验的是 dispatch.js 本身）。');
}

/* ==================================================================
   B. 核验器反向自检（注入违规必须报红）
   ================================================================== */
section('B. 核验器反向自检（证明 A 段的 0 违规不是恒真断言）');
function lockTask(orderId, process, machineId, fromMin, toMin, specCtx, setupMin = 0) {
  return { id: 'L:' + orderId + ':' + process + ':' + machineId + ':' + fromMin, orderId, process, machineId,
    start: T0 + fromMin * MIN, end: T0 + toMin * MIN, setupHours: (setupMin || 0) / 60, specCtx, spec: null, qty: null };
}
const drawFam = mm => ({ wireSpecMm: mm, outSpec: '12mm 6*7+FC', outDia: 12 });
const strFam = dia => ({ count: 6, structure: '1*7', diameter: dia });
async function loadFixture(file) { return JSON.parse(await readFile(resolve(ROOT, 'tools/fixtures/' + file), 'utf8')); }
function runFixture(ds, locks, opts = {}) {
  const s = createScheduler(ds, { planStart: PLAN_START, horizonDays: 60, qtyModel: { closingFactor: 1, strandShrink: 1, drawShrink: 1 }, ...opts });
  const settings = s.defaults();
  const model = s.buildModel(settings);
  const out = runDispatchSchedule({ model, settings, locks: new Map(Object.entries(locks)), frozen: new Map(), horizonDays: settings.horizonDays });
  return { s, settings, model, out };
}
const mini = await loadFixture('dispatch-case-1-reserve-next.json');
const miniRun = runFixture(mini, { bg1: lockTask(BG, 'drawing', 'D01', -420, 0, drawFam(0.4)), bg2: lockTask(BG, 'drawing', 'D02', -410, 10, drawFam(0.4)) });
const baseTasks = miniRun.out.tasks.filter(t => t.scheduled).map(t => ({ ...t }));
const cloneTasks = () => baseTasks.map(t => ({ ...t }));
const expectRule = (name, tasks, rule) => {
  const V = verifyIndependently({ tasks, orders: mini.orders, ds: mini, planStart: T0, anomalies: [] });
  const hit = V.filter(v => v.rule === rule);
  ok(name, hit.length > 0, '未报出 ' + rule + '（实际 ' + JSON.stringify(ruleCounts(V)) + '）');
};
{
  const V0 = verifyIndependently({ tasks: cloneTasks(), orders: mini.orders, ds: mini, planStart: T0, anomalies: [] });
  ok('B0 未注入时核验器 0 违规（基准）', V0.length === 0, JSON.stringify(V0.slice(0, 4)));
}
{
  const ts = cloneTasks(), t = ts.find(x => x.process === 'drawing' && x.orderId === 'K1-C');
  t.start = T0 - 10 * MIN; t.end = t.start + 420 * MIN;
  expectRule('B1 注入「早于下达时间」→ 报 release', ts, 'release');
}
{
  const ts = cloneTasks(), t = ts.find(x => x.process === 'drawing' && x.orderId === 'K1-D');
  t.specCtx = { ...t.specCtx, wireSpecMm: 9.9 };
  expectRule('B2 注入「超出设备规格区间」→ 报 compat', ts, 'compat');
}
{
  const ts = cloneTasks(), d = ts.find(x => x.process === 'drawing' && x.orderId === 'K1-D'), st = ts.find(x => x.process === 'stranding' && x.orderId === 'K1-D');
  st.start = d.end - 30 * MIN; st.end = st.start + 36 * MIN;
  expectRule('B3 注入「工序倒序」→ 报 sequence', ts, 'sequence');
}
{
  const ts = cloneTasks();
  ts.push({ ...ts.find(x => x.process === 'drawing' && x.orderId === 'K1-C'), id: 'T:DUP' });
  expectRule('B4 注入「同工序重复分配」→ 报 duplicate', ts, 'duplicate');
}
{
  const ts = cloneTasks(), st = ts.find(x => x.process === 'stranding' && x.orderId === 'K1-C');
  st.start = T0 + 10 * MIN; st.setupStart = st.start - (st.setupHours || 0) * HOUR; st.end = st.start + 36 * MIN;
  expectRule('B5 注入「同台占用重叠」→ 报 overlap', ts, 'overlap');
}
{
  const ts = cloneTasks(), d = ts.find(x => x.process === 'drawing' && x.orderId === 'K1-D');
  d.setupHours = 0; d.setupStart = null; d.setupEnd = null;
  expectRule('B6 注入「异配置 0 换型」→ 报 setup', ts, 'setup');
}
{
  const ts = cloneTasks(), st = ts.find(x => x.process === 'stranding' && x.orderId === 'K1-D');
  st.start = (st.prevFinish || T0) + 5000 * MIN; st.end = st.start + 36 * MIN; st.gapSlackMin = null; st.riskTags = [];
  expectRule('B7 注入「72 h 超限且未标注」→ 报 gap', ts, 'gap');
}

/* ==================================================================
   C. §11 的 8 个场景（tools/fixtures/dispatch-case-*.json）
   ================================================================== */
const tasksOf = (out, o, p) => out.tasks.filter(t => t.orderId === o && t.process === p);
const taskOf = (out, o, p) => tasksOf(out, o, p)[0] || null;
const suMin = t => t ? Math.round((t.setupHours || 0) * 60) : NaN;
const desc = t => t ? (t.machineId + '@' + fmt(t.start) + ' 换型' + suMin(t) + 'min') : '（无任务）';
const anomaliesOf = (out, o, kind) => (out.anomalies || []).filter(a => a.orderId === o && (!kind || a.kind === kind));

/* ---------- 场景 1：同型号优先 + 紧急异型号预约下一台 ---------- */
section('场景 1（§11-1）同型号 c + 紧急异型号 d，d 多等 10 min 仍可行 → 当前机台做 c，d 预约下一台');
{
  const ds = await loadFixture('dispatch-case-1-reserve-next.json');
  const { out } = runFixture(ds, { bg1: lockTask(BG, 'drawing', 'D01', -420, 0, drawFam(0.4)), bg2: lockTask(BG, 'drawing', 'D02', -410, 10, drawFam(0.4)) });
  const c = taskOf(out, 'K1-C', 'drawing'), d = taskOf(out, 'K1-D', 'drawing');
  ok('1.0 夹具前提：D01/D02 当前配置都等于 c 的配置（d 在任一台都要 60 min 换型）',
    out.tasks.filter(t => t.orderId === BG && t.process === 'drawing').every(t => (t.setupHours || 0) === 0));
  ok('1.1 夹具前提：d 立即换型方案预计完成 +642 min ≤ 交期 +660 min（可行）', 642 <= 660);
  ok('1.2 夹具前提：d 等 D02 方案预计完成 +652 min ≤ 交期 +660 min（多等 10 min 仍可行）', 652 <= 660);
  ok('1.3 同型号 c 在 D01 于 00:00 开工且无需换型', !!c && c.machineId === 'D01' && c.start === T0 && suMin(c) === 0, desc(c));
  ok('1.4 紧急异型号 d 被排到下一台 D02（没有占用 D01 换型）', !!d && d.machineId === 'D02', desc(d));
  ok('1.5 d 在 D02 仍需 60 min 换型：换型段 00:10–01:10、加工 01:10 开工', !!d && suMin(d) === 60 && d.setupStart === T0 + 10 * MIN && d.start === T0 + 70 * MIN, desc(d));
  ok('1.6 d 的拉丝只有一条任务（无重复分配）', tasksOf(out, 'K1-D', 'drawing').length === 1, String(tasksOf(out, 'K1-D', 'drawing').length));
  ok('1.7 预约 1 次且已兑现 1 次', out.stats.reservations === 1 && out.stats.reservationHonored === 1, JSON.stringify(out.stats));
  ok('1.8 d 的预约原因指向 D02', !!d && /D02/.test(d.reserveReason || ''), d ? String(d.reserveReason).slice(0, 70) : '-');
  ok('1.9 时间先后：c 先开工、d 后开工', !!c && !!d && c.start < d.start, (c ? fmt(c.start) : '-') + ' / ' + (d ? fmt(d.start) : '-'));
}

/* ---------- 场景 2：多等 10 min 就违约 → 立即换型 ---------- */
section('场景 2（§11-2）同样情况，d 多等 10 min 就违约，但立即换型可行 → 当前机台换型');
{
  const ds = await loadFixture('dispatch-case-2-changeover-now.json');
  const { out } = runFixture(ds, { bg1: lockTask(BG, 'drawing', 'D01', -420, 0, drawFam(0.4)), bg2: lockTask(BG, 'drawing', 'D02', -410, 10, drawFam(0.4)) });
  const c = taskOf(out, 'K2-C', 'drawing'), d = taskOf(out, 'K2-D', 'drawing');
  ok('2.0 夹具前提：d 立即换型预计完成 +642 min ≤ 交期 +642 min（刚好可行）', 642 <= 642);
  ok('2.1 夹具前提：d 等 D02 预计完成 +652 min > 交期 +642 min（等待即违约）', 652 > 642);
  ok('2.2 d 在 D01 立即换型：换型段 00:00 起、加工 01:00 开工', !!d && d.machineId === 'D01' && d.setupStart === T0 && d.start === T0 + 60 * MIN && suMin(d) === 60, desc(d));
  ok('2.3 d 加工 01:00–08:00 结束', !!d && d.end === T0 + 480 * MIN, d ? fmt(d.end) : '-');
  ok('2.4 没有产生任何预约（等待方案不可行）', out.stats.reservations === 0 && out.stats.reservationHonored === 0, JSON.stringify(out.stats));
  ok('2.5 记录了「强制换型」决策', out.stats.forcedSetups >= 1, JSON.stringify(out.stats));
  ok('2.6 同型号 c 未被丢单：改由 D02 于 00:10 加工且无需换型', !!c && c.machineId === 'D02' && c.start === T0 + 10 * MIN && suMin(c) === 0, desc(c));
}

/* ---------- 场景 3：下一台机器不兼容 ---------- */
section('场景 3（§11-3）下一台机器不兼容 → 不能因平均间隔 10 min 就让订单等它');
{
  const ds = await loadFixture('dispatch-case-3-next-incompatible.json');
  const { out } = runFixture(ds, { bg1: lockTask(BG, 'drawing', 'D01', -420, 0, drawFam(0.4)), bg2: lockTask(BG, 'drawing', 'D02', -400, 10, drawFam(0.4)), bg3: lockTask(BG, 'drawing', 'D03', -340, 500, drawFam(0.5)) });
  const c = taskOf(out, 'K3-C', 'drawing'), d = taskOf(out, 'K3-D', 'drawing');
  const d02 = ds.machines.drawing.find(m => m.id === 'D02');
  ok('3.0 夹具前提：D02 台账区间 ' + d02.specMin + '–' + d02.specMax + 'mm 不含 d 的原料 0.5mm，但含 c 的 0.4mm',
    !(0.5 >= d02.specMin && 0.5 <= d02.specMax) && (0.4 >= d02.specMin && 0.4 <= d02.specMax));
  ok('3.1 夹具前提：兼容的 D03 要 +500 min 才空闲，预计完成 +1142 min > 交期 +660 min（不可行）', 500 + 60 + 420 + 162 > 660);
  ok('3.2 紧急异型号 d 在 D01 立即换型（+60 min 开工）', !!d && d.machineId === 'D01' && d.start === T0 + 60 * MIN && suMin(d) === 60, desc(d));
  ok('3.3 d 未被推给不兼容的 D02', !tasksOf(out, 'K3-D', 'drawing').some(t => t.machineId === 'D02'), JSON.stringify(tasksOf(out, 'K3-D', 'drawing').map(t => t.machineId)));
  ok('3.4 d 未被推给虽兼容但太晚的 D03', !tasksOf(out, 'K3-D', 'drawing').some(t => t.machineId === 'D03'), JSON.stringify(tasksOf(out, 'K3-D', 'drawing').map(t => t.machineId)));
  ok('3.5 没有预约（不存在可行的下一台）', out.stats.reservations === 0, JSON.stringify(out.stats));
  ok('3.6 同型号 c 在兼容的 D02 于 00:10 加工且无需换型', !!c && c.machineId === 'D02' && c.start === T0 + 10 * MIN && suMin(c) === 0, desc(c));
}

/* ---------- 场景 4：下一台同型号，晚空闲也更早完成 ---------- */
section('场景 4（§11-4）下一台同型号、当前不同型号 → 下一台即使晚空闲，也因省 60 min 更早完成');
{
  const ds = await loadFixture('dispatch-case-4-next-same-family.json');
  const { out } = runFixture(ds, { bg1: lockTask(BG, 'drawing', 'D01', -420, 0, drawFam(0.4)), bg2: lockTask(BG, 'drawing', 'D02', -370, 50, drawFam(0.5)) });
  const c = taskOf(out, 'K4-C', 'drawing'), d = taskOf(out, 'K4-D', 'drawing');
  ok('4.0 夹具前提：立即换型预计完成 +642 min；等 D02 预计完成 +632 min（省 60 min 换型抵消晚 50 min 空闲）',
    (50 + 0 + 420 + 162) < (60 + 420 + 162));
  ok('4.1 d 被预约到 D02（没有在 D01 换型）', !!d && d.machineId === 'D02', desc(d));
  ok('4.2 d 在 D02 无需换型：00:50 开工、07:50 完工', !!d && suMin(d) === 0 && d.start === T0 + 50 * MIN && d.end === T0 + 470 * MIN, desc(d) + ' → ' + (d ? fmt(d.end) : '-'));
  ok('4.3 d 的完工早于「D01 立即换型」方案的加工完工 +480 min', !!d && d.end < T0 + 480 * MIN, d ? fmtOff(d.end - T0) : '-');
  ok('4.4 同型号 c 在 D01 于 00:00 开工且无需换型', !!c && c.machineId === 'D01' && c.start === T0 && suMin(c) === 0, desc(c));
  ok('4.5 预约 1 次且已兑现 1 次', out.stats.reservations === 1 && out.stats.reservationHonored === 1, JSON.stringify(out.stats));
}

/* ---------- 场景 5：交期宽松但 72 h 期限即将到达 ---------- */
section('场景 5（§11-5）捻股交期宽松，但 72 h 工序间隔即将到达 → 按工序间隔限制派单');
{
  const ds = await loadFixture('dispatch-case-5-gap-72h.json');
  const { out } = runFixture(ds, {
    xDraw: lockTask('K5-X', 'drawing', 'D01', -4620, -4200, drawFam(0.6)),
    yDraw: lockTask('K5-Y', 'drawing', 'D02', -520, -100, drawFam(0.4)),
    s01: lockTask(BG, 'stranding', 'S01', -36, 0, strFam(0.4)),
    s02: lockTask(BG, 'stranding', 'S02', -100, 200, strFam(0.4))
  });
  const x = taskOf(out, 'K5-X', 'stranding'), y = taskOf(out, 'K5-Y', 'stranding');
  const xDraw = taskOf(out, 'K5-X', 'drawing');
  ok('5.0 夹具前提：K5-X 拉丝完工 −4200 min，72 h 开工期限 = +120 min', !!xDraw && xDraw.end === T0 - 4200 * MIN, xDraw ? fmt(xDraw.end) : '-');
  ok('5.1 夹具前提：S01 立即换型方案 +60 min 开工 → 间隔 4260 ≤ 4320（可行）', (T0 + 60 * MIN - (T0 - 4200 * MIN)) / MIN === 4260);
  ok('5.2 夹具前提：S02 方案 +260 min 开工 → 间隔 4460 > 4320（不可行）', (T0 + 260 * MIN - (T0 - 4200 * MIN)) / MIN === 4460);
  ok('5.3 K5-X 捻股在 S01 立即换型：换型段 00:00–01:00、加工 01:00 开工', !!x && x.machineId === 'S01' && x.setupStart === T0 && x.start === T0 + 60 * MIN && suMin(x) === 60, desc(x));
  ok('5.4 K5-X 工序间隔 4260 min ≤ 4320 min，余量 60 min', !!x && x.gapMin === 4260 && x.gapSlackMin === 60, x ? ('gap=' + x.gapMin + ' 余量=' + x.gapSlackMin) : '-');
  ok('5.5 K5-X 未被推给虽兼容但会破坏 72 h 的 S02', !tasksOf(out, 'K5-X', 'stranding').some(t => t.machineId === 'S02'), JSON.stringify(tasksOf(out, 'K5-X', 'stranding').map(t => t.machineId)));
  ok('5.6 没有工序间隔异常记录（既未静默放宽，也未误报）', out.stats.gapViolations === 0 && anomaliesOf(out, 'K5-X', 'gap').length === 0, JSON.stringify(out.stats));
  const yDraw = taskOf(out, 'K5-Y', 'drawing');
  ok('5.7 同型号 K5-Y 仍被排产且其自身工序间隔 ≤ 4320', !!y && !!yDraw && (y.start - yDraw.end) / MIN <= LIMIT_MIN,
    desc(y) + ' / 间隔 ' + (y && yDraw ? Math.round((y.start - yDraw.end) / MIN) : '-') + ' min');
}

/* ---------- 场景 6：空白工厂 + 多台同时空闲 ---------- */
section('场景 6（§11-6）从空白工厂开始、多台同时空闲 → 同一时刻联合分配，不人为错开 10/5/15 min');
{
  const ds = await loadFixture('dispatch-case-6-blank-factory.json');
  const { out } = runFixture(ds, {});
  const draws = out.tasks.filter(t => t.process === 'drawing' && t.scheduled);
  ok('6.1 三台拉丝机全部被派单：3 条任务 / 3 张订单 / 3 台机',
    draws.length === 3 && new Set(draws.map(t => t.machineId)).size === 3 && new Set(draws.map(t => t.orderId)).size === 3,
    JSON.stringify(draws.map(t => t.orderId + '@' + t.machineId)));
  ok('6.2 三台机换型段同时在 00:00 开始（联合分配，没有 10/5/15 min 错开）',
    draws.every(t => t.setupStart === T0), JSON.stringify(draws.map(t => fmtOff((t.setupStart == null ? t.start : t.setupStart) - T0))));
  ok('6.3 三台机加工同时在 01:00 开工', draws.every(t => t.start === T0 + 60 * MIN), JSON.stringify(draws.map(t => fmtOff(t.start - T0))));
  ok('6.4 空白工厂按 §1.3-2 保守计一次初始换型 60 min',
    draws.every(t => suMin(t) === 60 && t.setupTier === '首次上机'), JSON.stringify(draws.map(t => suMin(t) + '/' + t.setupTier)));
  ok('6.5 没有任何拉丝任务被错开到 +5 / +10 / +15 min',
    !draws.some(t => [5, 10, 15].includes(Math.round((t.start - T0) / MIN))),
    JSON.stringify(draws.map(t => Math.round((t.start - T0) / MIN))));
  ok('6.6 每台拉丝机的第一个占用段都在 00:00（机台没有空转等待）',
    ds.machines.drawing.every(m => {
      const list = out.tasks.filter(t => t.machineUid === 'drawing:' + m.id).sort((a, b) => a.start - b.start);
      const first = list[0];
      return !!first && (first.setupStart != null ? first.setupStart : first.start) === T0;
    }));
}

/* ---------- 场景 7：两个紧急订单争抢同一未来设备 ---------- */
section('场景 7（§11-7）两个紧急订单争抢同一未来设备 → 预约不重复，无法保护的订单进风险清单');
{
  const ds = await loadFixture('dispatch-case-7-two-urgent-one-reservation.json');
  const { out } = runFixture(ds, { bg1: lockTask(BG, 'drawing', 'D01', -420, 0, drawFam(0.4)), bg2: lockTask(BG, 'drawing', 'D02', -410, 10, drawFam(0.5)) });
  const d1 = taskOf(out, 'K7-D1', 'drawing'), d2 = taskOf(out, 'K7-D2', 'drawing');
  ok('7.0 夹具前提：K7-D1 / K7-D2 初始余量分别 +18 / +38 min，同处紧急层（0 ≤ S < 1500）', 18 >= 0 && 18 < 1500 && 38 >= 0 && 38 < 1500);
  ok('7.1 只建立 1 次预约（同一未来设备不被重复预约）', out.stats.reservations === 1, JSON.stringify(out.stats));
  ok('7.2 预约已兑现 1 次', out.stats.reservationHonored === 1, JSON.stringify(out.stats));
  ok('7.3 K7-D1 被预约到 D02：00:10 开工、无需换型', !!d1 && d1.machineId === 'D02' && d1.start === T0 + 10 * MIN && suMin(d1) === 0, desc(d1));
  ok('7.4 K7-D1 的预约原因指向 D02', !!d1 && /D02/.test(d1.reserveReason || ''), d1 ? String(d1.reserveReason).slice(0, 60) : '-');
  ok('7.5 抢不到的 K7-D2 未被排到 D02（未来设备没有被重复占用）', !!d2 && d2.machineId !== 'D02', desc(d2));
  ok('7.6 K7-D2 没有得到预约保护（预约原因为空）', !!d2 && !d2.reserveReason, d2 ? String(d2.reserveReason) : 'null');
  ok('7.7 K7-D2 进入风险清单：存在 late 异常记录，且任务带风险标签',
    anomaliesOf(out, 'K7-D2', 'late').length > 0 && !!d2 && (d2.riskTags || []).length > 0,
    JSON.stringify(anomaliesOf(out, 'K7-D2').map(a => a.kind)) + ' / ' + JSON.stringify(d2 ? d2.riskTags : null));
  ok('7.8 K7-D2 落位时余量已转负（处理中出现负余量，仍按 AFTER_URGENT 落位并标红）',
    !!d2 && d2.slackMin < 0 && out.stats.lateRiskPlaced >= 1, (d2 ? 'slack=' + d2.slackMin : '-') + ' / lateRiskPlaced=' + out.stats.lateRiskPlaced);
  ok('7.9 K7-D2 在 D01 换型 60 min 后于 09:00 开工（不丢单，但显式标记延期）',
    !!d2 && d2.machineId === 'D01' && suMin(d2) === 60 && d2.start === T0 + 480 * MIN, desc(d2));
}

/* ---------- 场景 8：负余量（AFTER_URGENT / DEFER） ---------- */
section('场景 8（§11-8）初始或处理中出现负余量 → 分别核验 AFTER_URGENT 与 DEFER');
{
  const ds = await loadFixture('dispatch-case-8-negative-slack.json');
  ok('8.0 夹具前提：K8-Z 初始余量 S = 100 − (462 加工 + 180 最坏换型) = −542 min < 0', 100 - (462 + 180) === -542);
  ok('8.1 夹具前提：默认 negativeMode = AFTER_URGENT', DISPATCH_DEFAULTS.negativeMode === 'AFTER_URGENT', String(DISPATCH_DEFAULTS.negativeMode));
  const { out: au } = runFixture(ds, {});
  const z = taskOf(au, 'K8-Z', 'drawing'), n = taskOf(au, 'K8-N', 'drawing');
  ok('8.2 [AFTER_URGENT] 负余量订单 K8-Z 仍被派单（不丢单）', !!z && z.machineId === 'D01', desc(z));
  ok('8.3 [AFTER_URGENT] K8-Z 记录的余量 = −542 min', !!z && z.slackMin === -542, z ? String(z.slackMin) : '-');
  ok('8.4 [AFTER_URGENT] K8-Z 带延期风险标签且进入 late 异常清单',
    !!z && (z.riskTags || []).length > 0 && anomaliesOf(au, 'K8-Z', 'late').length > 0, JSON.stringify(z ? z.riskTags : null));
  ok('8.5 [AFTER_URGENT] 没有暂缓任何订单', au.stats.deferred === 0, JSON.stringify(au.stats));
  ok('8.6 [AFTER_URGENT] 宽松订单 K8-N 未被丢单：等 K8-Z 让出 D01 后换型、09:00 开工', !!n && n.start === T0 + 540 * MIN && suMin(n) === 60, desc(n));
  const { out: df } = runFixture(ds, {}, { dispatch: { negativeMode: 'DEFER' } });
  const z2 = taskOf(df, 'K8-Z', 'drawing'), n2 = taskOf(df, 'K8-N', 'drawing');
  ok('8.7 [DEFER] 负余量订单 K8-Z 完全没有任务（暂缓，不参与派单）', !z2 && tasksOf(df, 'K8-Z', 'drawing').length === 0, desc(z2));
  ok('8.8 [DEFER] 暂缓计数 = 1', df.stats.deferred === 1, JSON.stringify(df.stats));
  ok('8.9 [DEFER] 异常输出保留 K8-Z 的编号与暂缓原因',
    df.unscheduled.some(u => u.orderId === 'K8-Z' && /DEFER/.test(u.reason || '') && /负余量/.test(u.reason || '')),
    JSON.stringify(df.unscheduled.map(u => u.orderId + ':' + u.reason)));
  ok('8.10 [DEFER] 机台不空转：K8-N 物料齐套后换型 60 min、04:20 开工', !!n2 && n2.start === T0 + 260 * MIN && suMin(n2) === 60, desc(n2));
  ok('8.11 [DEFER] 负余量订单没有被当成普通订单排进去（无任何 K8-Z 工序任务）', df.tasks.every(t => t.orderId !== 'K8-Z'), String(df.tasks.filter(t => t.orderId === 'K8-Z').length));
}

/* ==================================================================
   D. 已修复缺陷的回归锁
   ------------------------------------------------------------------
   这两个场景原本用来复现 dispatch.js 的两个真实缺陷，现在缺陷已修，
   因此改成**断言**：一旦实现回退，这里会立刻变红。

   D1 §5.1 要求候选订单「尚未被其他设备或预约占用」。
      旧实现只排除 done / deferred → 后自由的那台更慢的机台会把已被预约的订单抢走，
      预约被静默删除（reservationHonored = 0），完工从 01:18 推迟到 04:18。
   D2 §5.5 的 d 必须是「优先层中约束余量最小的订单」。
      旧实现先做 use = 本机完全可行者优先，于是「本机做不了、但下一台能做」的订单
      根本进不了 d，也就不会被预约出去，最后被同一台机在更晚时刻以「延期风险」落位。
   ================================================================== */
section('D. 已修复缺陷的回归锁（断言；回退即变红）');
{
  const dsD = await loadFixture('dispatch-defect-reservation.json');
  const locksD = () => ({
    bgS01: lockTask(BG, 'stranding', 'S01', -36, 0, strFam(0.4)),
    bgS02: lockTask(BG, 'stranding', 'S02', -136, 60, strFam(0.6)),
    rcDraw: lockTask('RC', 'drawing', 'D01', -600, -180, drawFam(0.4)),
    rdDraw: lockTask('RD', 'drawing', 'D02', -420, -60, drawFam(0.6)),
  });
  const tight = JSON.parse(JSON.stringify(dsD));                                  // RD 交期 03:20（等 S02 本可准时）
  const loose = JSON.parse(JSON.stringify(dsD));                                  // RD 交期 06:40（等 S02 与立即都可行）
  loose.orders.find(o => o.id === 'RD').preShipDate = '2026-01-05T06:40';
  for (const [tag, ds2, wantTardy] of [['D1 交期 06:40（等待可行）', loose, false], ['D2 交期 03:20（本机不可行、S02 可行）', tight, false]]) {
    const { out } = runFixture(ds2, locksD());
    const d = taskOf(out, 'RD', 'stranding');
    console.log('  [' + tag + '] 预约 ' + out.stats.reservations + ' 次 / 兑现 ' + out.stats.reservationHonored + ' 次；'
      + 'RD 实际落在 ' + (d ? d.machineId + ' ' + fmt(d.start) + '–' + fmt(d.end) + '（换型 ' + suMin(d) + ' min' + ((d.riskTags || []).length ? '，已标延期' : '') + '）' : '无任务'));
    ok(tag + '：预约被兑现（reservationHonored ≥ 1）', out.stats.reservationHonored >= 1, 'honored=' + out.stats.reservationHonored);
    ok(tag + '：RD 落在被预约的机台 S02，而不是去抢它的 S01', !!d && d.machineId === 'S02', desc(d));
    ok(tag + '：RD 在 S02 于 01:00 开工、01:18 完工（预约方案被真正执行）',
      !!d && d.start === T0 + 60 * MIN && d.end === T0 + 78 * MIN, desc(d));
    ok(tag + '：RD 没有被标成延期', !!d && !wantTardy ? !(d.riskTags || []).length : true, JSON.stringify(d ? d.riskTags : null));
  }
}

/* ==================================================================
   汇总
   ================================================================== */
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
for (const f of failures) console.log('  FAIL: ' + f);
process.exit(fail ? 1 : 0);
