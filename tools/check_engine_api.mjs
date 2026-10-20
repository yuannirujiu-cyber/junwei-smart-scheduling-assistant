#!/usr/bin/env node
/* 引擎门面 / 数据契约 / 替代工艺链自检
   ------------------------------------------------------------------
   覆盖：
     A. 门面各方法在真实数据集上的行为与内部自洽（describe / defaults / buildModel /
        schedule / validate / metrics / explain / toRows），以及「方法全部同步、不抛裸异常」；
     B. 最小示例数据集 tools/fixtures/minimal-dataset.json 端到端；
     C. 数据契约与降级：缺表 / 缺列 / 空数据 / 数量 0 或缺失 / 规格不可解析 / 交期缺失 /
        矩阵空值（不适配语义）/ 矩阵行列不对齐 / 非法工艺链 —— 全部给出可读错误或降级结果；
     D. 替代工艺链：4 工序（dataset 注入）与 2 工序（options 注入）端到端跑通。
     每条断言都可在 /tmp 副本上通过注入缺陷变红（变异测试见交付说明）。
   用法：node tools/check_engine_api.mjs
   退出码：0 全部通过；1 存在失败项。 */
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const load = p => readFile(resolve(ROOT, p), 'utf8').then(JSON.parse);
const clone = o => JSON.parse(JSON.stringify(o));

const { createScheduler, SchedulerInputError, validateDataset, DEFAULT_PROCESS_CHAIN } =
  await import(resolve(ROOT, 'web/src/engine/index.js'));
const { PROCESSES } = await import(resolve(ROOT, 'web/src/engine/rules.js'));
const { chainToProcesses } = await import(resolve(ROOT, 'web/src/engine/chain.js'));

let pass = 0, fail = 0;
const failures = [];
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; return; }
  fail++; failures.push(name + (detail ? ' :: ' + detail : ''));
};
const section = t => console.log('\n--- ' + t + ' ---');
const hasCode = (list, code) => (list || []).some(x => x.code === code);
const errAt = (report, path) => (report.errors || []).find(e => e.path === path);
const warnCode = (report, code) => (report.warnings || []).filter(w => w.code === code);
const isPromise = v => v && typeof v.then === 'function';

const real = await load('data/dataset.json');
const minimal = await load('tools/fixtures/minimal-dataset.json');
const alt = await load('tools/fixtures/alt-chain-dataset.json');

/* ==================================================================
   A. 门面 · 真实数据集
   ================================================================== */
section('A. 门面 · 真实数据集');
let s = null;
try { s = createScheduler(real); ok('createScheduler(真实数据集) 不抛异常', true); }
catch (e) { ok('createScheduler(真实数据集) 不抛异常', false, String(e && e.message).slice(0, 120)); }

if (s) {
  const d = s.describe();
  ok('describe().processes 为 3 道内置工序', d.processes.length === 3 && d.processes.map(p => p.key).join(',') === 'drawing,stranding,closing',
    d.processes.map(p => p.key).join(','));
  ok('describe() 工序设备数 47 / 51 / 11', d.processes.map(p => p.machineCount).join(',') === '47,51,11',
    d.processes.map(p => p.machineCount).join(','));
  ok('describe().machines.total = 109', d.machines.total === 109, String(d.machines.total));
  ok('describe().specIndexStats.available = true', d.specIndexStats.available === true, JSON.stringify(d.specIndexStats).slice(0, 80));
  ok('describe().dataIssues 报出 2 张缺交期订单', d.dataIssues.filter(x => x.code === 'DUE_MISSING').length === 2,
    JSON.stringify(d.dataIssues.map(x => x.code)));
  ok('describe().dataIssues 报出矩阵空值语义', d.dataIssues.some(x => x.code === 'MATRIX_NULL_CELL'),
    JSON.stringify(d.dataIssues.map(x => x.code)));
  ok('describe() 工序矩阵元信息可用', d.processes[1].matrix && d.processes[1].matrix.rows > 3000,
    JSON.stringify(d.processes[1].matrix));

  const def = s.defaults();
  ok('defaults() 含 changeoverModel 有效字段', def.changeoverModel.minHours === 1 && def.changeoverModel.maxHours === 5 && def.changeoverModel.magnitudeWeight === 4,
    JSON.stringify(def.changeoverModel));
  ok('defaults() 含 qtyModel', def.qtyModel.closingFactor === 1 && def.qtyModel.strandShrink === 1.02, JSON.stringify(def.qtyModel));
  ok('defaults() 含日历（两班倒 12 小时）', def.calendar.shiftsPerDay === 2 && def.calendar.hoursPerShift === 12, JSON.stringify(def.calendar));
  ok('defaults() 计划起点由数据推算（2026-08-03T00:00）', def.planStart === '2026-08-03T00:00', String(def.planStart));
  ok('defaults() 窗口由最晚交期推算（130 天）', def.horizonDays === 130, String(def.horizonDays));
  ok('describe() 标记内置链 legacyChain = true', d.engine.legacyChain === true, String(d.engine.legacyChain));
  ok('describe() 工艺链来源 = default', d.engine.chainSource === 'default', String(d.engine.chainSource));
  const def2 = s.defaults(); def2.changeoverModel.minHours = 99;
  ok('defaults() 返回独立副本（修改不影响下次调用）', s.defaults().changeoverModel.minHours === 1, String(s.defaults().changeoverModel.minHours));

  const model = s.buildModel();
  ok('buildModel() 返回 jobs / blocked / cap', Array.isArray(model.jobs) && Array.isArray(model.blocked) && !!model.cap,
    'jobs=' + model.jobs.length + ' blocked=' + model.blocked.length);
  ok('buildModel() 链上工序与工序链一致', model.chainKeys.join(',') === 'drawing,stranding,closing', model.chainKeys.join(','));
  ok('buildModel() 每单 ops 按链序 = 3 道', model.jobs.every(j => j.ops.map(o => o.process).join(',') === 'drawing,stranding,closing'),
    JSON.stringify(model.jobs[0] && model.jobs[0].ops.map(o => o.process)));

  const r = s.schedule();
  ok('schedule() 返回 tasks / unscheduled / stats', Array.isArray(r.tasks) && Array.isArray(r.unscheduled) && !!r.stats);
  ok('schedule() 任务数 > 800（真实数据 900+）', r.stats.taskCount > 800, String(r.stats.taskCount));
  ok('schedule() 任务数 = 已排任务条数', r.stats.taskCount === r.tasks.filter(t => t.scheduled).length,
    r.stats.taskCount + ' vs ' + r.tasks.filter(t => t.scheduled).length);
  const ids = r.tasks.map(t => t.id);
  ok('任务 id 唯一（无幽灵任务）', new Set(ids).size === ids.length, ids.length + ' 条 / 唯一 ' + new Set(ids).size);
  ok('schedule() 阻断订单数 = 模型 blocked 数', r.stats.blockedOrders === r.model.blocked.length,
    r.stats.blockedOrders + ' vs ' + r.model.blocked.length);

  const v = s.validate(r);
  ok('validate() 返回 risks / counts / canConfirm', Array.isArray(v.risks) && v.counts && typeof v.canConfirm === 'boolean');
  ok('validate() 分级计数自洽', v.counts.block + v.counts.warn + v.counts.info === v.risks.length,
    JSON.stringify(v.counts) + ' vs ' + v.risks.length);
  ok('validate() canConfirm = (阻断数 === 0)', v.canConfirm === (v.counts.block === 0), 'canConfirm=' + v.canConfirm + ' block=' + v.counts.block);
  ok('validate() 真实数据存在阻断（能力边界如实暴露）', v.counts.block >= 5, String(v.counts.block));
  ok('validate() 无「占用重叠」风险', !v.risks.some(x => x.type === '占用重叠'), JSON.stringify(v.risks.filter(x => x.type === '占用重叠').length));
  ok('validate() 不带参数沿用最近一次 schedule()', s.validate().counts.block === v.counts.block);

  const m = s.metrics(r);
  ok('metrics() 任务数与 stats 一致', m.taskCount === r.stats.taskCount, m.taskCount + ' vs ' + r.stats.taskCount);
  ok('metrics() 准时率 ∈ [0,100]', m.deliveryRate >= 0 && m.deliveryRate <= 100, String(m.deliveryRate));
  ok('metrics() 准时率分母自洽', m.onTimeOrders + m.lateOrders + m.unknownOrders === m.orderCount,
    m.onTimeOrders + '+' + m.lateOrders + '+' + m.unknownOrders + ' vs ' + m.orderCount);
  ok('metrics() 已排 + 未完整排产 = 纳入', m.scheduledOrders + m.unscheduledOrders === m.orderCount,
    m.scheduledOrders + '+' + m.unscheduledOrders + ' vs ' + m.orderCount);
  ok('metrics() 延期小时 ≥ 0 且与延期单数同号', m.lateHours >= 0 && ((m.lateOrders === 0) === (m.lateHours === 0)),
    m.lateOrders + ' 单 / ' + m.lateHours + ' 小时');
  ok('metrics() 加工利用率 ≤ 计划占用率', m.machineRunRate <= m.machineOccRate, m.machineRunRate + ' vs ' + m.machineOccRate);
  ok('metrics() 分工序键与工序链一致', Object.keys(m.byProcess).join(',') === 'drawing,stranding,closing', Object.keys(m.byProcess).join(','));
  ok('metrics() 不带参数可用', s.metrics().taskCount === m.taskCount);

  const task = r.tasks.find(t => t.scheduled);
  const ex = s.explain(task.id);
  ok('explain() 四段式：结论 / 证据 / 约束 / 入口', typeof ex.conclusion === 'string' && ex.conclusion.length > 10
    && ex.evidence.length > 0 && ex.constraints.length > 0 && Array.isArray(ex.actions), JSON.stringify({ ev: ex.evidence.length, c: ex.constraints.length }));
  ok('explain() 命中 R1 且带规则文本', ex.rules.includes('R1') && ex.ruleTexts.some(x => x.id === 'R1'), JSON.stringify(ex.rules));
  const exBad = s.explain('NOT-A-TASK');
  ok('explain(未知 id) 返回可读错误而非抛异常', typeof exBad.error === 'string' && exBad.error.includes('NOT-A-TASK') && exBad.evidence.length === 0,
    String(exBad.error));

  const rows = s.toRows(r);
  ok('toRows() 默认 kind = plan 且有列定义', rows.kind === 'plan' && rows.columns.length >= 15, rows.kind + '/' + rows.columns.length);
  ok('toRows(plan) 行数 = 已排任务数', rows.rows.length === r.stats.taskCount, rows.rows.length + ' vs ' + r.stats.taskCount);
  ok('toRows(plan) 行含任务号 / 订单号 / 起止时间', rows.rows.every(x => x.taskId && x.orderId && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x.start) && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(x.end)),
    JSON.stringify(rows.rows[0] && { t: rows.rows[0].taskId, s: rows.rows[0].start }));
  ok('toRows(plan) 按开始时间升序', rows.rows.every((x, i) => i === 0 || rows.rows[i - 1].startMs <= x.startMs));
  ok('toRows(risk) 行数 = 风险条数', s.toRows(r, { kind: 'risk' }).rows.length === v.risks.length,
    s.toRows(r, { kind: 'risk' }).rows.length + ' vs ' + v.risks.length);
  ok('toRows(load) 行数 = 设备负荷条数', s.toRows(r, { kind: 'load' }).rows.length === m.machineLoad.length,
    s.toRows(r, { kind: 'load' }).rows.length + ' vs ' + m.machineLoad.length);
  ok('toRows(unscheduled) 行数 = 未排工序数', s.toRows(r, { kind: 'unscheduled' }).rows.length === r.unscheduled.length,
    s.toRows(r, { kind: 'unscheduled' }).rows.length + ' vs ' + r.unscheduled.length);
  ok('toRows(未知 kind) 回退 plan 而不是抛异常', s.toRows(r, { kind: '不存在' }).kind === 'plan');

  ok('门面方法全部同步（返回 Promise 即失败）',
    [d, model, r, v, m, ex, rows, def].every(x => !isPromise(x)) && !isPromise(s.describe()));
  ok('门面不修改传入的数据集', JSON.stringify(real).length === JSON.stringify(await load('data/dataset.json')).length);
}

/* ==================================================================
   B. 最小示例数据集
   ================================================================== */
section('B. 最小示例数据集（3 工序）');
const vr = validateDataset(minimal);
ok('最小数据集 schema 校验 0 错误 0 警告', vr.ok && vr.errors.length === 0 && vr.warnings.length === 0,
  'errors=' + vr.errors.length + ' warnings=' + JSON.stringify(vr.warnings.map(w => w.code)));
const sm = createScheduler(minimal);
const dm = sm.describe();
ok('最小数据集工序 = 拉丝/捻股/合绳', dm.processes.map(p => p.key).join(',') === 'drawing,stranding,closing', dm.processes.map(p => p.key).join(','));
const rm = sm.schedule();
ok('最小数据集 4 单 × 3 工序 = 12 条任务', rm.stats.taskCount === 12, String(rm.stats.taskCount));
ok('最小数据集无阻断、可确认', rm.validation.counts.block === 0 && rm.validation.canConfirm === true,
  JSON.stringify(rm.validation.counts));
ok('最小数据集准时率 100%', rm.metrics.deliveryRate === 100, String(rm.metrics.deliveryRate));
const closingTask = rm.tasks.find(t => t.process === 'closing');
ok('最小数据集 explain(合绳任务) 含交付预测', (() => { const e = sm.explain(closingTask.id);
  return e.evidence.some(x => x.k === '交付预测') && e.constraints.some(x => x.rule === 'R6'); })(),
  JSON.stringify(sm.explain(closingTask.id).evidence.map(x => x.k)));
ok('最小数据集 toRows(plan) 12 行', sm.toRows(rm).rows.length === 12, String(sm.toRows(rm).rows.length));
ok('默认工艺链与 rules.js 的 PROCESSES 完全一致',
  JSON.stringify(chainToProcesses(DEFAULT_PROCESS_CHAIN).map(p => [p.key, p.name, p.short, p.cls, p.color, p.machinePrefix, p.desc]))
  === JSON.stringify(PROCESSES.map(p => [p.key, p.name, p.short, p.cls, p.color, p.machinePrefix, p.desc])),
  JSON.stringify(PROCESSES.map(p => p.key)));

/* ==================================================================
   C. 数据契约与降级（可读错误 / 可读降级，绝不抛裸异常）
   ================================================================== */
section('C. 数据契约：错误分类可抓出');
{
  const c1 = clone(minimal); delete c1.orders;
  const r1 = validateDataset(c1);
  ok('C1 缺必填表 orders → 报 REQUIRED', !r1.ok && hasCode(r1.errors, 'REQUIRED') && errAt(r1, 'orders') != null,
    JSON.stringify(r1.errors.map(e => e.path + ':' + e.code)));
  const c2 = clone(minimal); delete c2.machines;
  ok('C2 缺必填表 machines → 报 REQUIRED', !validateDataset(c2).ok && hasCode(validateDataset(c2).errors, 'REQUIRED'));
  const c3 = clone(minimal); delete c3.capacity;
  ok('C3 缺必填表 capacity → 报 REQUIRED', !validateDataset(c3).ok && hasCode(validateDataset(c3).errors, 'REQUIRED'));

  const c4 = clone(minimal); c4.orders = { MIN: 1 };
  const r4 = validateDataset(c4);
  ok('C4 类型错（orders 应为数组）→ 路径 orders + 期望类型', !r4.ok && r4.errors.some(e => e.path === 'orders' && /array/.test(e.expected)),
    JSON.stringify(r4.errors.map(e => e.path + ':' + e.expected)));

  const c5 = clone(minimal); c5.orders[0].qtyMeters = '800';
  const r5 = validateDataset(c5);
  ok('C5 类型错（qtyMeters 应为 number）→ 路径 orders[0].qtyMeters', !r5.ok && r5.errors.some(e => e.path === 'orders[0].qtyMeters'),
    JSON.stringify(r5.errors.map(e => e.path)));

  const c6 = clone(minimal); c6.orders[0].qtyMeters = 0;
  const r6 = validateDataset(c6);
  ok('C6 数量小于等于 0 → 抓出并要求 > 0', !r6.ok && r6.errors.some(e => e.path === 'orders[0].qtyMeters' && e.expected.includes('> 0')),
    JSON.stringify(r6.errors.map(e => e.path + ':' + e.expected)));
  const c6b = clone(minimal); c6b.orders[0].qtyMeters = -5;
  ok('C6b 数量为负 → 同样抓出', !validateDataset(c6b).ok && validateDataset(c6b).errors.some(e => e.path === 'orders[0].qtyMeters'));

  const c7 = clone(minimal); c7.orders[0].id = 'MIN-2026-0002';
  const r7 = validateDataset(c7);
  ok('C7 订单号重复 → DUPLICATE_ORDER_ID', !r7.ok && hasCode(r7.errors, 'DUPLICATE_ORDER_ID'), JSON.stringify(r7.errors.map(e => e.code)));

  const c8 = clone(minimal); c8.machines.closing[1] = { name: '无名机台' };
  const r8 = validateDataset(c8);
  ok('C8 设备缺编号列 → MACHINE_ID_MISSING', !r8.ok && hasCode(r8.errors, 'MACHINE_ID_MISSING'), JSON.stringify(r8.errors.map(e => e.code)));

  const c9 = clone(minimal); c9.capacity.closing.rows[0].rates = [10];
  const r9 = validateDataset(c9);
  ok('C9 矩阵产出列数与设备列数不一致 → RATES_LENGTH', !r9.ok && hasCode(r9.errors, 'RATES_LENGTH'), JSON.stringify(r9.errors.map(e => e.code)));

  const c10 = clone(minimal); c10.machines.drawing[0].specMin = 0.5; c10.machines.drawing[0].specMax = 0.1;
  ok('C10 设备规格区间颠倒 → MACHINE_RANGE_INVERTED', !validateDataset(c10).ok && hasCode(validateDataset(c10).errors, 'MACHINE_RANGE_INVERTED'));

  const c11 = clone(minimal); c11.capacity.closing.machineIds = ['C01', 'C02'];
  c11.capacity.closing.rows[0].caps = ['C99'];
  const r11 = validateDataset(c11);
  ok('C11 caps 引用不存在的设备 → CAPS_UNKNOWN_MACHINE', !r11.ok && hasCode(r11.errors, 'CAPS_UNKNOWN_MACHINE'), JSON.stringify(r11.errors.map(e => e.code)));
}

section('C. 数据契约：空值 = 不适配（不得被当作可用产能）');
{
  const partial = clone(alt);
  let s2 = null, s2Err = '';
  try { s2 = createScheduler(partial); } catch (e) { s2Err = String(e && e.message).slice(0, 120); }
  ok('空值场景：createScheduler(替代链) 可用', !!s2, s2Err);
  if (s2) {
  const row20 = s2.cap.findMatrixRow('ropeClose', '压实钢丝绳', '20mm 6*36WS+IWRC');
  const capable = s2.cap.capableMachines('ropeClose', { row: row20 });
  ok('空值列（rates=[6,null]）只有 1 台适配设备', capable.length === 1 && capable[0].machine.id === '7301',
    capable.map(c => c.machine.id).join(','));
  ok('空值单元格不进入 caps（空值 ≠ 适配）', row20.caps instanceof Set && row20.caps.size === 1,
    row20.caps ? 'caps.size=' + row20.caps.size : 'caps=' + row20.caps);
  const r2 = s2.schedule();
  const ropeTasks20 = r2.tasks.filter(t => t.process === 'ropeClose' && t.spec && t.spec.diameter === 20);
  ok('20mm 合绳任务只落在非空设备 7301', ropeTasks20.length > 0 && ropeTasks20.every(t => t.machineId === '7301'),
    ropeTasks20.map(t => t.machineId).join(','));
  }

  const allNull = clone(alt);
  for (const row of allNull.capacity.coilWrap.rows) if (row.spec === '12mm 6*19S+FC') row.rates = [null, null];
  ok('整行空值 → schema 报 MATRIX_ROW_INADAPTABLE', hasCode(validateDataset(allNull).warnings, 'MATRIX_ROW_INADAPTABLE'),
    JSON.stringify(validateDataset(allNull).warnings.map(w => w.code)));
  let s3 = null, s3Err = '';
  try { s3 = createScheduler(allNull); } catch (e) { s3Err = String(e && e.message).slice(0, 120); }
  ok('整行空值：createScheduler 可用', !!s3, s3Err);
  if (s3) {
  const r3 = s3.schedule();
  const blockedIds = r3.model.blocked.map(b => b.order.id);
  ok('整行空值 → 相关订单被阻断（不是静默补零排产）', blockedIds.includes('ALT-2026-0001') && blockedIds.includes('ALT-2026-0004'),
    blockedIds.join(','));
  ok('整行空值 → 阻断原因含「设备适配」', r3.model.blocked.some(b => b.gaps.some(g => String(g.field).includes('设备适配'))),
    JSON.stringify(r3.model.blocked.flatMap(b => b.gaps.map(g => g.field))));
  ok('整行空值 → 该工序不产出任何任务', !r3.tasks.some(t => t.process === 'coilWrap' && t.machineId === '7401' && t.spec && t.spec.diameter === 12));
  }

  /* 内置三工序路径：合绳整行空值 → 不排产并记为未排工序 + 阻断风险 */
  const legacyNull = clone(minimal);
  legacyNull.capacity.closing.rows[0].rates = [null, null];
  const s4 = createScheduler(legacyNull);
  const rowNull = s4.cap.findClosingRowBySpec('12mm 6*19S+FC', '光面圆股钢丝绳');
  ok('内置链整行空值 → caps 为空集（空值不被当成适配）', rowNull.caps instanceof Set && rowNull.caps.size === 0,
    rowNull.caps ? 'caps.size=' + rowNull.caps.size : 'caps=' + rowNull.caps);
  ok('内置链整行空值 → 该行 0 台适配', s4.cap.capableMachines('closing', { row: rowNull }).length === 0);
  const r4 = s4.schedule();
  ok('内置链整行空值 → 出现未排工序', r4.unscheduled.some(u => u.process === 'closing'), JSON.stringify(r4.unscheduled.map(u => u.process)));
  ok('内置链整行空值 → 校验给出阻断', r4.validation.counts.block > 0, String(r4.validation.counts.block));
}

section('C. 数据契约：业务缺口降级（不静默丢单）');
{
  const dup = clone(minimal); dup.orders[0].qtyMeters = null;
  const rd = validateDataset(dup);
  ok('数量缺失 → 警告 QTY_MISSING', hasCode(rd.warnings, 'QTY_MISSING'), JSON.stringify(rd.warnings.map(w => w.code)));
  const sd = createScheduler(dup);
  const rs = sd.schedule();
  ok('数量缺失 → 该订单进阻断清单', rs.model.blocked.some(b => b.order.id === 'MIN-2026-0001'), JSON.stringify(rs.model.blocked.map(b => b.order.id)));
  ok('数量缺失 → 阻断原因为「订单数量」', rs.model.blocked.some(b => b.gaps.some(g => g.field === '订单数量')),
    JSON.stringify(rs.model.blocked.flatMap(b => b.gaps.map(g => g.field))));

  const badSpec = clone(minimal); badSpec.orders[1].spec = '无从解析的规格'; badSpec.orders[1].processMap = null;
  const rb = validateDataset(badSpec);
  ok('规格不可解析 → 警告 SPEC_UNPARSED', hasCode(rb.warnings, 'SPEC_UNPARSED'), JSON.stringify(rb.warnings.map(w => w.code)));
  const sb = createScheduler(badSpec);
  const rsb = sb.schedule();
  ok('规格不可解析 → 该订单被阻断且给出可读原因', rsb.model.blocked.some(b => b.order.id === 'MIN-2026-0002'
    && b.gaps.some(g => g.why && g.why.length > 5)), JSON.stringify(rsb.model.blocked.map(b => b.order.id)));

  const noDue = clone(minimal); noDue.orders[2].preShipDate = null;
  const rn = validateDataset(noDue);
  ok('交期缺失 → 警告 DUE_MISSING', hasCode(rn.warnings, 'DUE_MISSING'));
  const sn = createScheduler(noDue);
  ok('交期缺失 → 该订单被阻断（R7）', sn.schedule().model.blocked.some(b => b.order.id === 'MIN-2026-0003'));

  const empty = clone(minimal); empty.orders = [];
  const re = validateDataset(empty);
  ok('空订单表 → 警告 EMPTY_ORDERS（合法但提示）', re.ok && hasCode(re.warnings, 'EMPTY_ORDERS'), JSON.stringify(re.warnings.map(w => w.code)));
  const se = createScheduler(empty);
  const rse = se.schedule();
  ok('空订单表 → schedule 返回 0 任务且不抛异常', rse.tasks.length === 0 && rse.stats.taskCount === 0);
  ok('空订单表 → 准时率为 null（不是 0 或 NaN）', rse.metrics.deliveryRate === null, String(rse.metrics.deliveryRate));
  ok('空订单表 → toRows 0 行且列定义仍在', se.toRows(rse).rows.length === 0 && se.toRows(rse).columns.length > 5);
  ok('空订单表 → explain 给出可读错误（未找到任务）', typeof se.explain('X').error === 'string' && se.explain('X').error.includes('未找到任务'),
    String(se.explain('X').error));
  const sFresh = createScheduler(minimal);
  ok('未排产时 explain 给出「尚未排产」提示', String(sFresh.explain('X').error).includes('尚未排产'), String(sFresh.explain('X').error));

  const noSpec = clone(minimal); delete noSpec.orders[0].spec;
  ok('订单缺 spec 列 → REQUIRED 路径 orders[0].spec', (() => { const r = validateDataset(noSpec);
    return !r.ok && r.errors.some(e => e.path === 'orders[0].spec'); })());
}

section('C. 数据契约：非法工艺链与非法设置');
{
  const c1 = clone(minimal); c1.processChain = [{ key: 'a', capability: { kind: 'matrix', matrix: 'closing' } }, { key: 'a', capability: { kind: 'matrix', matrix: 'closing' } }];
  let threw1 = null;
  try { createScheduler(c1); } catch (e) { threw1 = e; }
  ok('工艺链 key 重复 → SchedulerInputError CHAIN_INVALID', threw1 && threw1.name === 'SchedulerInputError' && threw1.code === 'CHAIN_INVALID'
    && /重复/.test(threw1.message), threw1 && threw1.message.slice(0, 90));

  const c2 = clone(minimal); c2.processChain = [{ key: 'only', capability: { kind: 'matrix', matrix: 'not-exist' } }];
  let threw2 = null;
  try { createScheduler(c2); } catch (e) { threw2 = e; }
  ok('工艺链引用不存在的矩阵 → CHAIN_INVALID 且指名矩阵', threw2 && threw2.code === 'CHAIN_INVALID' && /not-exist/.test(threw2.message),
    threw2 && threw2.message.slice(0, 90));

  const c3 = clone(minimal); c3.processChain = 'not-an-array';
  let threw3 = null;
  try { createScheduler(c3); } catch (e) { threw3 = e; }
  ok('工艺链不是数组 → CHAIN_INVALID（不是 TypeError）', threw3 && threw3.code === 'CHAIN_INVALID', threw3 && threw3.name);

  let threw4 = null;
  try { createScheduler(null); } catch (e) { threw4 = e; }
  ok('createScheduler(null) → 带明细的可读错误', threw4 && threw4.name === 'SchedulerInputError' && /对象/.test(threw4.message), threw4 && threw4.message.slice(0, 80));

  const s5 = createScheduler(minimal, { validate: false });
  const r5 = s5.schedule({ planStart: '不是日期', horizonDays: -3, setupWeight: -1 });
  ok('非法 planStart / horizonDays / setupWeight → 回退默认并给出提示', r5.tasks.length === 12 && r5.warnings.length === 3,
    JSON.stringify(r5.warnings));

  const s6 = createScheduler(minimal);
  const broken = s6.validate({ tasks: null });
  ok('validate({tasks:null}) → 可读错误而非抛异常', typeof broken.error === 'string' && broken.canConfirm === false, String(broken.error));
  const broken2 = s6.metrics({ tasks: null });
  ok('metrics({tasks:null}) → 降级且 error 可读', broken2.error && broken2.deliveryRate === null && broken2.taskCount === 0, String(broken2.error));
  ok('未排产时 validate() 不抛异常且阻断确认', s6.validate().canConfirm === false);
  ok('toRows(null) 返回空行 + 可读 error', (() => { const x = s6.toRows(null); return x.rows.length === 0 && typeof x.error === 'string'; })());
  let poisonThrew = false, poisonOut = null;
  try { poisonOut = s6.toRows({ tasks: [null], unscheduled: [null], model: null }); } catch (e) { poisonThrew = true; }
  ok('污染输入（tasks:[null]）→ 降级为空行 + error，不抛裸异常',
    !poisonThrew && poisonOut && poisonOut.rows.length === 0 && typeof poisonOut.error === 'string',
    poisonThrew ? '抛出了异常' : String(poisonOut && poisonOut.error));
  let exPoison = null, exThrew = false;
  try { exPoison = createScheduler(minimal).explain({ id: 'POISON' }); } catch (e) { exThrew = true; }
  ok('explain(不完整任务对象) 不抛异常且四段结构完整',
    !exThrew && exPoison && Array.isArray(exPoison.evidence) && Array.isArray(exPoison.constraints) && typeof exPoison.conclusion === 'string',
    exThrew ? '抛出了异常' : JSON.stringify(exPoison && Object.keys(exPoison)));
}

/* ==================================================================
   D. 替代工艺链：4 工序（dataset 注入）
   ================================================================== */
section('D. 替代工艺链 · 4 工序（dataset.processChain）');
const va = validateDataset(alt);
ok('替代链数据集可校验（仅空值语义警告）', va.ok && va.warnings.every(w => w.code === 'MATRIX_NULL_CELL'),
  JSON.stringify(va.warnings.map(w => w.code)));
let sa = null;
try { sa = createScheduler(alt); ok('4 工序：createScheduler 不抛异常', true); }
catch (e) { ok('4 工序：createScheduler 不抛异常', false, String(e && e.message).slice(0, 140)); }
if (sa) {
const da = sa.describe();
ok('4 工序：describe 顺序 = 拉丝→捻股→合绳→涂塑', da.processes.map(p => p.key).join(',') === 'wireDraw,strandTwist,ropeClose,coilWrap',
  da.processes.map(p => p.key).join(','));
ok('4 工序：legacyChain = false（走通用路径）', da.engine.legacyChain === false, String(da.engine.legacyChain));
ok('4 工序：specRange 工序识别设备规格区间', da.processes[0].specRange.max === 0.6, JSON.stringify(da.processes[0].specRange));
ok('4 工序：矩阵工序均带矩阵元信息', da.processes.slice(1).every(p => p.matrix && p.matrix.rows > 0), JSON.stringify(da.processes.map(p => p.matrix)));
const ra = sa.schedule();
ok('4 工序：5 单 × 4 工序 = 20 条任务', ra.stats.taskCount === 20, String(ra.stats.taskCount));
ok('4 工序：每单 4 道工序且按链序', sa.buildModel().jobs.every(j => j.ops.map(o => o.process).join(',') === 'wireDraw,strandTwist,ropeClose,coilWrap'));
ok('4 工序：无阻断、可确认', ra.validation.counts.block === 0 && ra.validation.canConfirm === true, JSON.stringify(ra.validation.counts));
ok('4 工序：指标按 4 道工序分组', Object.keys(ra.metrics.byProcess).join(',') === 'wireDraw,strandTwist,ropeClose,coilWrap',
  Object.keys(ra.metrics.byProcess).join(','));
ok('4 工序：explain(捻股任务) 有前序与后序证据', (() => {
  const t = ra.tasks.find(x => x.process === 'strandTwist');
  const e = sa.explain(t.id);
  return e.evidence.some(x => x.k === '前序工序') && e.evidence.some(x => x.k === '后序工序') && e.conclusion.includes('捻股');
})(), JSON.stringify(sa.explain(ra.tasks.find(x => x.process === 'strandTwist').id).evidence.map(x => x.k)));
ok('4 工序：换型被计入（有跨规格切换）', ra.metrics.totalSetupHours > 0, String(ra.metrics.totalSetupHours));
ok('4 工序：toRows(plan) 20 行且工序名来自工艺链', sa.toRows(ra).rows.length === 20
  && sa.toRows(ra).rows.every(x => x.processName && x.processName !== x.process), JSON.stringify(sa.toRows(ra).rows[0].processName));
ok('4 工序：R6 等待约束按链上相邻工序检查', ra.tasks.every(t => {
  const ch = ra.model.jobs.find(j => j.order.id === t.orderId);
  return !!ch;
}));
/* R6 必须覆盖链上每一对相邻工序（含最后两道），而不是只看前两对 */
{
  const key4 = 'coilWrap';
  const base = ra.tasks.find(t => t.process === key4);
  const shifted = {
    tasks: ra.tasks.map(t => ({ ...t })), unscheduled: ra.unscheduled, model: ra.model, settings: ra.settings,
  };
  const H = 3600000;
  for (const t of shifted.tasks) {
    if (t.orderId === base.orderId && t.process === key4) {
      t.start += 100 * H; t.end += 100 * H;
      if (t.setupStart != null) t.setupStart += 100 * H;
    }
  }
  const vShift = sa.validate(shifted);
  ok('4 工序：把最后一道工序移后 100h → 报「工序间隔超限」阻断',
    vShift.risks.some(x => x.type === '工序间隔超限' && x.orderId === base.orderId),
    JSON.stringify(vShift.risks.map(x => x.type)));
}
}

/* ==================================================================
   D. 替代工艺链：2 工序（options.processChain 注入）
   ================================================================== */
section('D. 替代工艺链 · 2 工序（options.processChain）');
const twoChain = alt.processChain.slice(1, 3);   // 捻股 → 合绳（真正两道工序）
let s2 = null;
try { s2 = createScheduler(alt, { processChain: twoChain }); ok('2 工序：createScheduler 不抛异常', true); }
catch (e) { ok('2 工序：createScheduler 不抛异常', false, String(e && e.message).slice(0, 140)); }
if (s2) {
const d2 = s2.describe();
ok('2 工序：describe 只有两道工序', d2.processes.map(p => p.key).join(',') === 'strandTwist,ropeClose', d2.processes.map(p => p.key).join(','));
ok('2 工序：注入来源标记为 options.processChain', d2.engine.chainSource === 'options.processChain', d2.engine.chainSource);
const r2 = s2.schedule();
ok('2 工序：5 单 × 2 工序 = 10 条任务', r2.stats.taskCount === 10, String(r2.stats.taskCount));
ok('2 工序：任务只含链上工序', r2.tasks.every(t => t.process === 'strandTwist' || t.process === 'ropeClose'),
  [...new Set(r2.tasks.map(t => t.process))].join(','));
ok('2 工序：可确认且指标可用', r2.validation.canConfirm === true && r2.metrics.deliveryRate > 0,
  JSON.stringify(r2.validation.counts) + ' / ' + r2.metrics.deliveryRate);
ok('2 工序：toRows(load) 只列两道工序设备', s2.toRows(r2, { kind: 'load' }).rows.every(x => x.process === 'strandTwist' || x.process === 'ropeClose'));
ok('2 工序：metrics.byProcess 只有两键', Object.keys(r2.metrics.byProcess).join(',') === 'strandTwist,ropeClose',
  Object.keys(r2.metrics.byProcess).join(','));
}

/* dataset 内注入的另一种方式：processChain 放进 meta */
const viaMeta = clone(alt);
viaMeta.processChain = undefined; delete viaMeta.processChain;
viaMeta.meta.processChain = twoChain;
let s3 = null;
try { s3 = createScheduler(viaMeta); } catch (e) { s3 = null; }
ok('2 工序：dataset.meta.processChain 同样生效', !!s3 && s3.describe().processes.map(p => p.key).join(',') === 'strandTwist,ropeClose'
  && s3.describe().engine.chainSource === 'dataset.meta.processChain' && s3.schedule().stats.taskCount === 10,
  s3 ? s3.describe().engine.chainSource : 'createScheduler 抛异常');

/* ==================================================================
   E. 无头 CLI（tools/schedule-cli.mjs）
   ================================================================== */
section('E. 无头 CLI（退出码 / 输出文件 / 参数校验）');
{
  const cliPath = resolve(ROOT, 'tools/schedule-cli.mjs');
  const cli = (args) => spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', cwd: ROOT });

  const h = cli(['--help']);
  ok('CLI --help 退出码 0 且含用法说明', h.status === 0 && /用法/.test(h.stdout) && /退出码/.test(h.stdout), 'exit=' + h.status);

  const cMin = cli(['--data', 'tools/fixtures/minimal-dataset.json']);
  ok('CLI 无阻断数据 → 退出码 0', cMin.status === 0, 'exit=' + cMin.status + ' ' + String(cMin.stdout).split('\n')[0]);
  ok('CLI 打印准时率 / 占用率 / 换型 / 风险计数', /准时率/.test(cMin.stdout) && /占用率/.test(cMin.stdout)
    && /换型/.test(cMin.stdout) && /风险/.test(cMin.stdout));

  const cReal = cli(['--data', 'data/dataset.json', '--horizon', '60', '--json']);
  ok('CLI 真实数据存在阻断 → 退出码 1', cReal.status === 1, 'exit=' + cReal.status);
  let cj = null;
  try { cj = JSON.parse(cReal.stdout); } catch (e) { cj = null; }
  ok('CLI --json 输出可解析且含指标 / 风险 / 统计',
    !!cj && typeof cj.metrics.deliveryRate === 'number' && cj.risks.counts.block > 0 && cj.stats.taskCount > 800,
    JSON.stringify(cj && { d: cj.metrics.deliveryRate, b: cj.risks.counts.block, t: cj.stats.taskCount }));

  const cBad = cli(['--data', 'data/dataset.json', '--horizon', '0']);
  ok('CLI 非法 --horizon → 退出码 2 且中文提示', cBad.status === 2 && /--horizon/.test(cBad.stderr), 'exit=' + cBad.status);
  const cUnknown = cli(['--data', 'data/dataset.json', '--nope']);
  ok('CLI 未知参数 → 退出码 2', cUnknown.status === 2, 'exit=' + cUnknown.status);
  ok('CLI 缺 --data → 退出码 2', cli([]).status === 2);

  const cDataDir = cli(['--data', 'tools/fixtures/minimal-dataset.json', '--out', 'data/cli-should-not-exist']);
  ok('CLI 拒绝写入 data/ → 退出码 2', cDataDir.status === 2 && /拒绝写入 data/.test(cDataDir.stderr), 'exit=' + cDataDir.status);
  ok('CLI 拒绝后未创建 data/ 子目录', !existsSync(resolve(ROOT, 'data/cli-should-not-exist')));

  const outDir = mkdtempSync(join(tmpdir(), 'jw-cli-'));
  const badPath = join(tmpdir(), 'jw-bad-dataset.json');
  const missPath = join(tmpdir(), 'jw-missing-table.json');
  try {
    const cOut = cli(['--data', 'tools/fixtures/alt-chain-dataset.json', '--out', outDir]);
    const planPath = join(outDir, 'plan.csv');
    const metricsPath = join(outDir, 'metrics.json');
    const wroteBoth = existsSync(planPath) && existsSync(metricsPath);
    ok('CLI --out 退出码 0 且写出 plan.csv / metrics.json',
      cOut.status === 0 && wroteBoth, 'exit=' + cOut.status + ' wrote=' + wroteBoth);
    const planLines = wroteBoth ? readFileSync(planPath, 'utf8').split('\r\n').filter(x => x.length) : [];
    ok('CLI plan.csv 行数 = 表头 + 20 条任务', planLines.length === 21, String(planLines.length));
    ok('CLI plan.csv 表头含 任务号 / 订单号 / 工序',
      planLines.length > 0 && /任务号/.test(planLines[0]) && /订单号/.test(planLines[0]) && /工序/.test(planLines[0]),
      String(planLines[0] || '').slice(0, 40));
    let mj = null;
    try { mj = wroteBoth ? JSON.parse(readFileSync(metricsPath, 'utf8')) : null; } catch (e) { mj = null; }
    ok('CLI metrics.json 含 stats / risks / metrics 且任务数一致',
      !!mj && !!mj.stats && !!mj.risks && !!mj.metrics && mj.metrics.taskCount === 20 && mj.stats.taskCount === 20,
      JSON.stringify(mj ? { m: mj.metrics && mj.metrics.taskCount, s: mj.stats && mj.stats.taskCount } : { mj: null }));

    writeFileSync(badPath, '{oops', 'utf8');
    const cBadJson = cli(['--data', badPath]);
    ok('CLI 数据集解析失败 → 退出码 2 且说明原因', cBadJson.status === 2 && /解析失败/.test(cBadJson.stderr), 'exit=' + cBadJson.status);

    writeFileSync(missPath, JSON.stringify({ machines: minimal.machines, capacity: minimal.capacity }), 'utf8');
    const cMiss = cli(['--data', missPath]);
    ok('CLI 缺表 → 退出码 2 且打印字段路径 orders', cMiss.status === 2 && /orders/.test(cMiss.stderr), 'exit=' + cMiss.status + ' ' + String(cMiss.stderr).split('\n')[0]);
  } finally {
    rmSync(outDir, { recursive: true, force: true });
    rmSync(badPath, { force: true });
    rmSync(missPath, { force: true });
  }
}

/* ==================================================================
   汇总
   ================================================================== */
console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
for (const f of failures) console.log('  FAIL: ' + f);
process.exit(fail ? 1 : 0);
