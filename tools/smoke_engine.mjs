#!/usr/bin/env node
/* 引擎端到端自检：在 Node 里跑通「数据快照 → 建模 → 排产 → 校验 → 指标」，并对结果做**可失败的阈值断言**。
   用法：node tools/smoke_engine.mjs [data/dataset.json|data/demo-dataset.json]

   背景（审查报告 §六）：本脚本原先只 print 一次运行结果、零断言，
   把 metrics 改成「准时率 8571.4%、准时 1200 / 纳入 14」它照样 exit 0。
   现在补充的断言覆盖：准时率范围与分母自洽、延期非负、任务数 > 0、任务 id 唯一、
   阻断数与 blockedOrders 自洽、排程耗时上限、机器占用率范围。
   断言失败 → 打印实测值并 exit 1。 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const argv = process.argv.slice(2);
const file = argv.find(a => !a.startsWith('--')) || 'data/dataset.json';
/* --strategy=dispatch|order 可显式指定排程策略，用于两套算法的对照实测；
   不传则用 engineDefaults 的默认值（即界面与 CLI 实际使用的那一套）。 */
const strategyArg = (argv.find(a => a.startsWith('--strategy=')) || '').split('=')[1] || null;
const ds = JSON.parse(await readFile(resolve(ROOT, file), 'utf8'));

/* 阈值：显式集中，便于审阅与调整（不写死"永远成立"的条件） */
const LIMIT = {
  firstPassMs: 60000,     // 首排（runSchedule）耗时上限
  totalMs: 180000,        // 端到端（含 R6 修复、局部优化、校验、指标）耗时上限
};

const { buildCapacity } = await import(resolve(ROOT, 'web/src/engine/capacity.js'));
const { buildModel } = await import(resolve(ROOT, 'web/src/engine/model.js'));
const { runSchedule, improveSchedule, repairWaits } = await import(resolve(ROOT, 'web/src/engine/scheduler.js'));
const { runDispatchSchedule } = await import(resolve(ROOT, 'web/src/engine/dispatch.js'));
const { validateSchedule } = await import(resolve(ROOT, 'web/src/engine/validate.js'));
const { computeMetrics } = await import(resolve(ROOT, 'web/src/engine/metrics.js'));

const snapshot = {
  meta: ds.meta, orders: ds.orders, machines: ds.machines, capacity: ds.capacity,
  specIndex: ds.specIndex, simulationPresets: ds.simulationPresets || null,
};
const pending = snapshot.orders.filter(o => o.endCode !== '已结束');
const cands = [];
for (const o of pending) { if (o.orderDate) cands.push(new Date(o.orderDate).getTime()); if (o.preShipDate) cands.push(new Date(o.preShipDate).getTime()); }
const d0 = new Date(Math.min.apply(null, cands));
const start = new Date(d0.getFullYear(), d0.getMonth(), d0.getDate());
const p2 = n => String(n).padStart(2, '0');
const planStart = start.getFullYear() + '-' + p2(start.getMonth() + 1) + '-' + p2(start.getDate()) + 'T00:00';
const lastDue = pending.map(o => o.preShipDate ? new Date(o.preShipDate).getTime() : null).filter(Boolean);
const horizonDays = Math.max(30, Math.min(200, Math.ceil((Math.max.apply(null, lastDue) - start.getTime()) / 86400000) + 21));
console.log('计划起点 ' + planStart + ' · 窗口 ' + horizonDays + ' 天');
const { engineDefaults } = await import(resolve(ROOT, 'web/src/engine/index.js'));
/* 设置必须来自 engineDefaults()：原先这里手写了一份早已删除的 changeoverModel
   （{sameStructure, structure, both, initial}），与界面/CLI 用的默认值不是同一份，
   属于典型的「两处默认值漂移」。现在只覆盖计划起点、窗口与演示参数。 */
const settings = {
  ...engineDefaults(snapshot, { planStart, horizonDays, demoParams: { enabled: true } }),
  setupWeight: 1.0,
};
if (strategyArg === 'order' || strategyArg === 'dispatch') settings.strategy = strategyArg;
console.log('排程策略 ' + settings.strategy + (strategyArg ? '（命令行指定）' : '（默认）'));

const t0 = performance.now();
const cap = buildCapacity(snapshot);
console.log('设备索引：', JSON.stringify(cap.stats()));
const model = buildModel({ snapshot, settings, cap });
console.log('订单：纳入 ' + model.active.length + ' · 可排 ' + model.jobs.length + ' · 阻断 ' + model.blocked.length + ' · 排除 ' + model.excluded.length + ' · 历史 ' + model.history.length);

const useDispatch = (settings.strategy || 'dispatch') !== 'order';
const s1 = useDispatch
  ? runDispatchSchedule({ model, settings, horizonDays: settings.horizonDays })
  : runSchedule({ model, settings, horizonDays: settings.horizonDays });
const v0 = validateSchedule({ model, tasks: s1.tasks, unscheduled: s1.unscheduled, settings, horizonDays: settings.horizonDays });
const m0 = computeMetrics({ model, tasks: s1.tasks, unscheduled: s1.unscheduled, validation: v0, settings, horizonDays: settings.horizonDays });
console.log('（未做局部优化时）准时率 ' + m0.deliveryRate + '% · 延期 ' + m0.lateOrders + ' 单 · 累计延期 ' + m0.lateHours + ' 小时 · 换型 ' + m0.totalSetupHours + ' h');
const s15 = repairWaits({ model, settings, tasks: s1.tasks, horizonDays: settings.horizonDays });
const s2 = improveSchedule({ model, settings, tasks: s15.tasks, horizonDays: settings.horizonDays });
console.log('排产：任务 ' + s2.tasks.length + ' 条 · 未排 ' + s1.unscheduled.length + ' 条 · 首排 ' + Math.round(s1.elapsedMs) + ' ms · R6 修复 ' + s15.fixed + ' 处 · 局部优化 ' + s2.improved + ' 处');

const validation = validateSchedule({ model, tasks: s2.tasks, unscheduled: s1.unscheduled, settings, horizonDays: settings.horizonDays });
const metrics = computeMetrics({ model, tasks: s2.tasks, unscheduled: s1.unscheduled, validation, settings, horizonDays: settings.horizonDays });
const totalMs = performance.now() - t0;

console.log('---');
console.log('预测准时交付率   ' + metrics.deliveryRate + '%  （准时 ' + metrics.onTimeOrders + ' / 纳入 ' + metrics.orderCount + '）');
console.log('预计延期订单     ' + metrics.lateOrders + ' 单，累计延期 ' + metrics.lateHours + ' 小时');
console.log('硬交期风险       ' + metrics.hardRiskCount + ' 单（预计违约 ' + metrics.hardViolation + ' / 无法验证 ' + metrics.hardUnverifiable + '）');
console.log('未完整排产       ' + metrics.unscheduledOrders + ' 单；阻断订单 ' + metrics.blockedOrders + ' 单');
console.log('设备计划占用率   ' + metrics.machineOccRate + '%；加工利用率 ' + metrics.machineRunRate + '%');
console.log('换型总时长       ' + metrics.totalSetupHours + ' 小时；任务 ' + metrics.taskCount + ' 条');
console.log('风险            阻断 ' + validation.counts.block + ' / 警告 ' + validation.counts.warn + ' / 提示 ' + validation.counts.info + '，canConfirm=' + validation.canConfirm);
const byProc = Object.entries(metrics.byProcess).map(([k, v]) => k + ':' + v.machines + '台 occ ' + v.occRate + '%').join(' | ');
console.log('分工序占用       ' + byProc);
console.log('总耗时           ' + Math.round(totalMs) + ' ms');

/* ---------------- 断言（可失败） ---------------- */
const results = [];
const ok = (name, pass, detail = '') => results.push({ name, pass: !!pass, detail });
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const inPct = v => isNum(v) && v >= 0 && v <= 100;

/* 1) 排产产出非空 */
ok('排产任务数 > 0', s2.tasks.length > 0, '任务 ' + s2.tasks.length + ' 条');

/* 2) 任务 id 唯一（P0-3：锁定/冻结任务被预置后不得再被正常排产排一遍） */
const taskIds = s2.tasks.map(t => t.id);
const dupIds = [...new Set(taskIds.filter((id, i) => taskIds.indexOf(id) !== i))];
ok('任务 id 唯一（无重复任务）', dupIds.length === 0 && new Set(taskIds).size === taskIds.length,
  '任务 ' + taskIds.length + ' 条 / 唯一 ' + new Set(taskIds).size + ' 个' + (dupIds.length ? ' / 重复 ' + dupIds.slice(0, 3).join('、') : ''));

/* 3) 任务数与指标口径一致 */
ok('指标任务数与排产任务数一致', metrics.taskCount === s2.tasks.filter(t => t.scheduled).length,
  '指标 ' + metrics.taskCount + ' vs 实际 ' + s2.tasks.filter(t => t.scheduled).length);

/* 4) 准时率 ∈ [0,100] */
ok('准时率 ∈ [0,100]', inPct(metrics.deliveryRate), '实测 ' + metrics.deliveryRate + '%');

/* 5) 分母自洽：准时 + 延期 + 未完整排产（交期未知）= 纳入订单数 */
const denom = metrics.onTimeOrders + metrics.lateOrders + metrics.unknownOrders;
ok('准时率分母自洽（准时+延期+未知 = 纳入）', denom === metrics.orderCount,
  metrics.onTimeOrders + ' + ' + metrics.lateOrders + ' + ' + metrics.unknownOrders + ' = ' + denom + ' vs 纳入 ' + metrics.orderCount);

/* 6) 已排 + 未完整排产 = 纳入 */
ok('已排 + 未完整排产 = 纳入', metrics.scheduledOrders + metrics.unscheduledOrders === metrics.orderCount,
  metrics.scheduledOrders + ' + ' + metrics.unscheduledOrders + ' vs ' + metrics.orderCount);

/* 7) 延期小时数非负且有限 */
ok('累计延期小时 ≥ 0', isNum(metrics.lateHours) && metrics.lateHours >= 0, '实测 ' + metrics.lateHours + ' 小时');
ok('延期小时与延期单数一致', (metrics.lateOrders === 0) === (metrics.lateHours === 0),
  '延期 ' + metrics.lateOrders + ' 单 / ' + metrics.lateHours + ' 小时');

/* 8) 阻断数与 blockedOrders 自洽 */
ok('阻断订单数与模型一致', metrics.blockedOrders === model.blocked.length,
  '指标 ' + metrics.blockedOrders + ' vs 模型 ' + model.blocked.length);
const gapOrders = model.blocked.filter(b => (b.gaps || []).length).map(b => b.order.id);
const dataRiskOrders = new Set(validation.risks.filter(r => r.type === '数据不足').map(r => r.orderId));
const noRisk = gapOrders.filter(id => !dataRiskOrders.has(id));
ok('每张工艺映射缺口订单都有对应阻断风险', gapOrders.length > 0 && noRisk.length === 0,
  '缺口订单 ' + gapOrders.length + ' 张 / 未产出阻断 ' + noRisk.length + ' 张');
ok('风险分级计数自洽', validation.counts.block + validation.counts.warn + validation.counts.info === validation.risks.length
  && validation.canConfirm === (validation.counts.block === 0),
  'block+warn+info=' + (validation.counts.block + validation.counts.warn + validation.counts.info) + ' vs risks=' + validation.risks.length + '，canConfirm=' + validation.canConfirm);

/* 9) 排程耗时上限 */
ok('首排耗时 ≤ ' + LIMIT.firstPassMs + ' ms', isNum(s1.elapsedMs) && s1.elapsedMs <= LIMIT.firstPassMs, '实测 ' + Math.round(s1.elapsedMs) + ' ms');
ok('端到端耗时 ≤ ' + LIMIT.totalMs + ' ms', totalMs <= LIMIT.totalMs, '实测 ' + Math.round(totalMs) + ' ms');

/* 10) 机器占用率 ∈ [0,100] */
ok('设备计划占用率 ∈ [0,100]', inPct(metrics.machineOccRate), '实测 ' + metrics.machineOccRate + '%');
ok('设备加工利用率 ∈ [0,100]', inPct(metrics.machineRunRate), '实测 ' + metrics.machineRunRate + '%');
ok('加工利用率 ≤ 计划占用率', isNum(metrics.machineOccRate) && isNum(metrics.machineRunRate) && metrics.machineRunRate <= metrics.machineOccRate,
  metrics.machineRunRate + '% vs ' + metrics.machineOccRate + '%');
for (const [k, v] of Object.entries(metrics.byProcess)) {
  ok('分工序占用率 ∈ [0,100] · ' + k, v.occRate == null || inPct(v.occRate), '实测 ' + v.occRate + '%');
}

/* ---------------- 汇总 ---------------- */
const failed = results.filter(r => !r.pass);
console.log('');
console.log('通过 ' + (results.length - failed.length) + ' / 失败 ' + failed.length);
for (const r of failed) console.log('  FAIL: ' + r.name + (r.detail ? ' :: ' + r.detail : ''));
process.exit(failed.length ? 1 : 0);