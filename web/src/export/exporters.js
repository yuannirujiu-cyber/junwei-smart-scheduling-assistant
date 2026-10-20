/* 导出动作：排产清单 / 执行工单 / 风险清单（XLSX）与甘特图（PNG）
   PRD 依据（D05 版本、确认与导出）：
   - 导出按钮不因存在风险而隐藏；诊断草稿允许导出，但必须在文件内显著标记；
   - 导出范围可选「全部范围 / 当前筛选」，默认全部；
   - 模拟参数模式（version.simulated）的导出持续标注「模拟结果，含未验证参数」。
   约定：导出函数只负责生成并触发下载，不吞异常——出错向上抛，由调用方给出失败反馈与重试入口。
*/
import { downloadBlob, toDate, fmtDate, fmtDateTime, round, groupBy, HOUR } from '../core/util.js';
import { PROCESSES, PROC_MAP, RULE_MAP } from '../engine/rules.js';
import { store, OPERATOR } from '../core/store.js';
import { computeRange } from '../components/gantt.js';
import { writeXlsx, sheetFromRows } from './xlsxWriter.js';

const SEV_LABEL = { block: '阻断', warn: '警告', info: '提示' };
const SEV_RANK = { block: 0, warn: 1, info: 2 };
const worse = (a, b) => (SEV_RANK[a] <= SEV_RANK[b] ? a : b);

/* ---------------- 通用辅助 ---------------- */
function nowStamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}
function statusText(v) {
  if (!v) return '—';
  const confirmed = v.status === 'confirmed';
  if (confirmed) {
    return '已确认' + (v.simulated ? '（模拟参数）' : '') +
      (v.confirmedAt ? ' · ' + fmtDateTime(v.confirmedAt) + (v.confirmedBy ? ' · ' + v.confirmedBy : '') : '');
  }
  if (v.dirty || v.status === 'stale') return '待重算（存在未重算的人工修改，未确认）';
  if (v.status === 'superseded') return '已替代';
  return v.validation?.canConfirm ? '草稿（校验无阻断，尚未确认）' : '草稿（存在阻断问题，未确认）';
}
function isDraft(v) { return !v || v.status !== 'confirmed'; }
function procName(p) { return PROC_MAP[p]?.name || p || '—'; }
function procOrder(p) { const i = PROCESSES.findIndex(x => x.key === p); return i < 0 ? 9 : i; }
const CHAIN = ['drawing', 'stranding', 'closing'];

/** 当前界面筛选（工序 / 关键字 / 仅风险），可由 opts.filter 覆盖，便于测试与脚本调用 */
function filterInfo(opts = {}) {
  const ui = (store && store.state && store.state.ui && store.state.ui.filters && store.state.ui.filters.workbench) || {};
  return Object.assign({ process: 'all', onlyRisk: false, keyword: '' }, ui, opts.filter || {});
}
function scopeText(opts = {}) {
  if ((opts.scope || 'all') !== 'filtered') return '全部范围（版本内全部已排工序）';
  const f = filterInfo(opts);
  const bits = ['工序：' + (f.process && f.process !== 'all' ? procName(f.process) : '全部')];
  if (f.keyword) bits.push('关键字：' + f.keyword);
  if (f.onlyRisk) bits.push('仅风险任务');
  return '当前筛选（' + bits.join(' · ') + '）';
}
/** 按导出范围取任务；scope='filtered' 时套用工作台筛选条件 */
function scopeTasks(version, opts = {}, base = null) {
  const tasks = (base || version?.tasks || []).filter(t => t && t.scheduled !== false);
  if ((opts.scope || 'all') !== 'filtered') return tasks.slice();
  const f = filterInfo(opts);
  const kw = String(f.keyword || '').trim().toLowerCase();
  const riskIds = new Set(((version?.validation?.risks) || []).map(r => r.taskId).filter(Boolean));
  return tasks.filter(t => {
    if (f.process && f.process !== 'all' && t.process !== f.process) return false;
    if (kw && !(String(t.orderId).toLowerCase().includes(kw) || String(t.machineId).includes(kw))) return false;
    if (f.onlyRisk && !riskIds.has(t.id)) return false;
    return true;
  });
}
/** 订单字典：原始订单 + 模型内已补齐的字段（due/duePolicy/priority 等） */
function orderIndex(version, snapshot) {
  const m = new Map();
  for (const o of (snapshot?.orders || [])) m.set(String(o.id), o);
  for (const o of (version?.model?.active || [])) m.set(String(o.id), Object.assign({}, m.get(String(o.id)) || {}, o));
  return m;
}
function dueOf(o) {
  if (!o) return null;
  if (o.due) return toDate(o.due) || o.due;
  return o.preShipDate ? toDate(o.preShipDate) || o.preShipDate : null;
}
function policyText(o) {
  if (!o) return '待确认';
  if (o.duePolicy === 'hard') return '硬交期（不允许延期）';
  if (o.duePolicy === 'soft') return '软交期（宽限 ≤' + (o.graceHours || 0) + ' 小时）';
  return '交期政策待确认';
}
function lockText(t) {
  if (t.frozen) return '执行冻结（已开工）';
  if (t.locked) return '已锁定';
  return '';
}
function riskIndex(version) {
  const taskLevel = new Map(), orderLevel = new Map();
  for (const r of (version?.validation?.risks || [])) {
    if (r.taskId) { const cur = taskLevel.get(r.taskId); taskLevel.set(r.taskId, cur ? worse(cur, r.level) : r.level); }
    if (r.orderId) { const cur = orderLevel.get(r.orderId); orderLevel.set(r.orderId, cur ? worse(cur, r.level) : r.level); }
  }
  return { taskLevel, orderLevel };
}
/** 每张订单的工序链（用版本内全部任务构建，避免筛选后前后序丢失） */
function chainsOf(version) {
  const m = new Map();
  for (const t of (version?.tasks || [])) {
    if (t.scheduled === false) continue;
    if (!m.has(t.orderId)) m.set(t.orderId, {});
    m.get(t.orderId)[t.process] = t;
  }
  return m;
}
/** 表头统一前言：版本、状态、数据快照、导出时间、范围、模拟标识、排除清单 */
function preamble(version, snapshot, opts, extra = []) {
  const excluded = version?.excludedOrders || [];
  const blocked = version?.blockedOrders || [];
  const counts = version?.validation?.counts || { block: 0, warn: 0, info: 0 };
  const rows = [
    ['版本号', version.id + '（' + (version.name || '未命名方案') + '）'],
    ['版本状态', statusText(version) + (isDraft(version) ? '｜草稿，不作为执行依据' : '')],
    ['数据快照', snapshot?.meta?.name || version.dataVersion || '—'],
    ['导出时间', fmtDateTime(new Date())],
    ['导出范围', scopeText(opts)],
    ['导出人', OPERATOR],
    ['计划起点 / 窗口', fmtDateTime(version.settings?.planStart) + ' · ' + (version.settings?.horizonDays ?? '—') + ' 天'],
    ['模拟结果标识', version.simulated ? '模拟结果，含未验证参数（演示参数模式，不作为正式执行依据）' : '无（未启用演示参数）'],
    ['风险概览', '阻断 ' + counts.block + ' 项 · 警告 ' + counts.warn + ' 项 · 提示 ' + counts.info + ' 项（导出不受风险影响，标记仅作提示）'],
    ['明确排除订单（' + excluded.length + ' 单）', excluded.length ? excluded.join('、') : '无'],
    ['数据不足阻断订单（' + blocked.length + ' 单）', blocked.length ? blocked.map(b => b.orderId).join('、') : '无'],
    ['未排产工序（' + ((version.unscheduled || []).length) + ' 条）', (version.unscheduled || []).length ? (version.unscheduled || []).map(u => u.orderId + '·' + procName(u.process)).join('、') : '无'],
  ];
  return rows.concat(extra);
}
function footerNote(version, extra = '') {
  const bits = [
    '文件由「君威智能排产助手」按版本 ' + version.id + ' 导出，时间为工厂本地时间（' + (version.settings?.timezone || 'Asia/Shanghai') + '）。',
    '风险判定依据 R1–R10；指标口径见 PRD 第 10 章与 engine/metrics.js。',
    '本文件为计划推算结果，未接 ERP/MES，不代表已下发生产。',
  ];
  if (version.simulated) bits.push('本版本使用演示参数，属模拟结果，含未验证参数。');
  if (extra) bits.push(extra);
  return bits.join('');
}

/* ---------------- 1. 排产清单 ---------------- */
const PLAN_COLUMNS = [
  { header: '订单号', key: 'orderId', width: 16 },
  { header: '产品名称', key: 'productName', width: 18 },
  { header: '规格', key: 'spec', width: 22 },
  { header: '工序', key: 'process', width: 8 },
  { header: '机台', key: 'machineId', width: 10 },
  { header: '机台名称', key: 'machineName', width: 16 },
  /* 《三工序排产算法设计》§10.1 要求的可追溯列：配置键 / 就绪时间 / 换型分钟数 /
     派单时交期余量 / 上工序结束 / 工序间隔 / 预约原因 / 风险标签 */
  { header: '配置键', key: 'configLabel', width: 30 },
  { header: '就绪时间', key: 'readyAt', width: 18, type: 'datetime' },
  { header: '数量', key: 'qty', width: 10, type: 'number' },
  { header: '单位', key: 'unit', width: 6 },
  { header: '加工开始', key: 'start', width: 18, type: 'datetime' },
  { header: '加工结束', key: 'end', width: 18, type: 'datetime' },
  { header: '换型开始', key: 'setupStart', width: 18, type: 'datetime' },
  { header: '换型耗时(h)', key: 'setupHours', width: 11, type: 'decimal' },
  { header: '换型分钟', key: 'setupMin', width: 10, type: 'number' },
  { header: '承诺交期', key: 'due', width: 18, type: 'datetime' },
  { header: '交期政策', key: 'policy', width: 20 },
  { header: '等待时长(h)', key: 'waitHours', width: 11, type: 'decimal' },
  { header: '上工序结束', key: 'prevFinish', width: 18, type: 'datetime' },
  { header: '工序间隔(min)', key: 'gapMin', width: 13, type: 'number' },
  { header: '派单交期余量(min)', key: 'slackMin', width: 16, type: 'number' },
  { header: '预约原因', key: 'reserveReason', width: 40 },
  { header: '风险标签', key: 'riskTags', width: 30 },
  { header: '风险', key: 'risk', width: 16 },
  { header: '锁定状态', key: 'lock', width: 14 },
];

export function exportPlanXlsx(version, snapshot, opts = {}) {
  if (!version) throw new Error('尚未生成计划版本，无法导出排产清单');
  const orders = orderIndex(version, snapshot);
  const chains = chainsOf(version);
  const { taskLevel, orderLevel } = riskIndex(version);
  const tasks = scopeTasks(version, opts).sort((a, b) => a.start - b.start || procOrder(a.process) - procOrder(b.process) || String(a.machineId).localeCompare(String(b.machineId)));
  const rows = tasks.map(t => {
    const o = orders.get(String(t.orderId)) || { id: t.orderId };
    const chain = chains.get(t.orderId) || {};
    const i = CHAIN.indexOf(t.process);
    const prev = i > 0 ? chain[CHAIN[i - 1]] : null;
    const wait = (prev && prev.end != null && t.start != null) ? round((t.start - prev.end) / HOUR, 1) : null;
    const lv = taskLevel.get(t.id) || orderLevel.get(t.orderId) || null;
    return {
      orderId: t.orderId,
      productName: t.productName || o.productName || '',
      spec: t.specLabel || o.spec || '',
      process: procName(t.process),
      machineId: t.machineId,
      machineName: t.machineName || '',
      configLabel: t.configLabel || t.specLabel || '',
      readyAt: t.readyAt ?? null,
      qty: t.qty,
      unit: t.unit || '米',
      start: t.start, end: t.end, setupStart: t.setupStart,
      setupHours: t.setupHours || 0,
      setupMin: t.setupHours != null ? Math.round(t.setupHours * 60) : null,
      prevFinish: t.prevFinish ?? null,
      gapMin: t.gapMin ?? null,
      slackMin: t.slackMin ?? null,
      reserveReason: t.reserveReason || '',
      riskTags: Array.isArray(t.riskTags) && t.riskTags.length ? t.riskTags.join('；') : '',
      due: dueOf(o),
      policy: policyText(o),
      waitHours: wait,
      risk: lv ? ((taskLevel.get(t.id) ? '' : '订单级·') + SEV_LABEL[lv]) : '无',
      lock: lockText(t),
    };
  });

  const sheet = sheetFromRows('排产清单', PLAN_COLUMNS, rows, {
    title: '排产清单 · 版本 ' + version.id + (version.simulated ? ' ·【模拟结果，含未验证参数】' : ''),
    preamble: preamble(version, snapshot, opts, [
      ['本表口径', '等待时长 = 本工序加工开始 − 前序加工结束（连续小时，R6 上限 72 小时）；拉丝无前序，留空。'],
    ]),
    freeze: true, autoFilter: true,
    note: footerNote(version, '换型耗时来源：' + (version.simulated ? '演示参数模型（数据包未提供换型矩阵，R5）' : '数据包参数') + '。'),
  });

  /* 第二页：未排产与阻断（PRD：不把局部成功展示为全部订单完成） */
  const unRows = [];
  for (const u of (version.unscheduled || [])) {
    const o = orders.get(String(u.orderId)) || {};
    unRows.push({ kind: '未排产', orderId: u.orderId, productName: o.productName || '', spec: o.spec || '',
      process: procName(u.process), qty: u.qty ?? null, unit: u.unit || '米',
      reason: u.reason || '计划窗口内无可用产能', fix: '扩大计划窗口 / 补充设备 / 检查适配关系', rule: 'R1' });
  }
  for (const b of (version.blockedOrders || [])) {
    const o = orders.get(String(b.orderId)) || {};
    for (const g of (b.gaps || [])) {
      unRows.push({ kind: '数据不足', orderId: b.orderId, productName: o.productName || '', spec: o.spec || '',
        process: g.field || '工艺映射', qty: o.qtyMeters ?? null, unit: o.qtyMetersUnit || '米',
        reason: g.why || '字段缺失', fix: g.fix || '在订单中心补录', rule: g.rule || 'R7' });
    }
  }
  for (const id of (version.excludedOrders || [])) {
    const o = orders.get(String(id)) || {};
    unRows.push({ kind: '明确排除', orderId: id, productName: o.productName || '', spec: o.spec || '',
      process: '—', qty: o.qtyMeters ?? null, unit: o.qtyMetersUnit || '米',
      reason: '未纳入本次排产范围（人工排除）', fix: '如需纳入：在排产设置中恢复订单范围后重算', rule: '' });
  }
  const unSheet = sheetFromRows('未排产与阻断', [
    { header: '类型', key: 'kind', width: 10 },
    { header: '订单号', key: 'orderId', width: 16 },
    { header: '产品名称', key: 'productName', width: 18 },
    { header: '规格', key: 'spec', width: 22 },
    { header: '工序 / 环节', key: 'process', width: 14 },
    { header: '数量', key: 'qty', width: 10, type: 'number' },
    { header: '单位', key: 'unit', width: 6 },
    { header: '原因', key: 'reason', width: 42 },
    { header: '建议', key: 'fix', width: 34 },
    { header: '命中规则', key: 'rule', width: 10 },
  ], unRows, {
    title: '未排产、数据不足与排除订单',
    preamble: preamble(version, snapshot, opts),
    freeze: true, autoFilter: true,
    note: footerNote(version, '未排订单仍保留在准时交付率分母中（PRD 第 10 章）。'),
  });

  /* 第三页：指标汇总（与界面同源，标注口径） */
  const m = version.metrics || {};
  const bp = m.byProcess || {};
  const metricRows = [
    { __group: '交付与风险（口径：PRD 第 10 章）' },
    ['纳入排产订单数', m.orderCount ?? null, '单', '未结束且纳入范围的订单集合 U'],
    ['完整排产订单数', m.scheduledOrders ?? null, '单', '拉丝/捻股/合绳三序均已排入窗口'],
    ['未完整排产订单数', m.unscheduledOrders ?? null, '单', '保留在交付率分母中，单列「交期未知」'],
    ['数据不足阻断订单数', m.blockedOrders ?? null, '单', '工艺映射缺失，未进入排产'],
    ['明确排除订单数', m.excludedOrders ?? null, '单', '见首页排除清单'],
    ['预测准时交付率', m.deliveryRate ?? '—', '%', '完整排产且合绳完工 ≤ 承诺交期的订单 ÷ U 总数'],
    ['准时订单数', m.onTimeOrders ?? null, '单', ''],
    ['预计延期订单数', m.lateOrders ?? null, '单', '有最终完工时间且晚于承诺交期'],
    ['累计延期时长', m.lateHours ?? null, '小时', '逐单延期小时求和'],
    ['交期无法验证订单数', m.unknownOrders ?? null, '单', '未完整排产或缺交期，不当作准时'],
    ['硬交期风险订单数', m.hardRiskCount ?? null, '单', '预计违约 ' + (m.hardViolation ?? 0) + ' · 无法验证 ' + (m.hardUnverifiable ?? 0)],
    { __group: '产能与占用（计划推算，非实测）' },
    ['已排工序任务数', m.taskCount ?? null, '条', ''],
    ['累计换型耗时', m.totalSetupHours ?? null, '小时', 'R3–R5 换型判定后的占用'],
    ['设备计划占用率', m.machineOccRate ?? '—', '%', '(加工 + 换型) ÷ 窗口内可用时长'],
    ['设备加工利用率', m.machineRunRate ?? '—', '%', '加工 ÷ 窗口内可用时长'],
    ['计划最后完工', m.makespan ? fmtDateTime(m.makespan) : '—', '', '已排工序的最晚结束时间'],
    { __group: '分工序占用（小时）' },
    ...PROCESSES.map(p => [p.name + ' · 可用 / 加工 / 换型 / 占用率',
      (bp[p.key]?.availH ?? null), '小时',
      '加工 ' + (bp[p.key]?.runH ?? '—') + ' · 换型 ' + (bp[p.key]?.setupH ?? '—') + ' · 占用率 ' + (bp[p.key]?.occRate ?? '—') + '%' + (p.desc ? '（' + p.desc + '）' : '')]),
    { __group: '参数与依据' },
    ['模拟结果标识', version.simulated ? '模拟结果，含未验证参数' : '未使用演示参数', '', '演示参数模式不进入「正式已确认」状态'],
    ['换型耗时来源', version.simulated ? '演示参数模型（数据包未提供换型矩阵，R5）' : '数据包参数', '', ''],
    ['校验阻断 / 警告 / 提示', (version.validation?.counts?.block ?? 0) + ' / ' + (version.validation?.counts?.warn ?? 0) + ' / ' + (version.validation?.counts?.info ?? 0), '项', '阻断项未清零时不允许确认版本'],
    ['人工锁定 / 执行冻结', (version.tasks || []).filter(t => t.locked).length + ' / ' + (version.tasks || []).filter(t => t.frozen).length, '条', '锁定任务在重算时保持机台与起止时间'],
    ['数据快照', snapshot?.meta?.name || version.dataVersion || '—', '', ''],
  ];
  const metricSheet = sheetFromRows('指标汇总', [
    { header: '指标', key: 0, width: 30 },
    { header: '数值', key: 1, width: 16, type: 'decimal' },
    { header: '单位', key: 2, width: 8 },
    { header: '口径 / 依据', key: 3, width: 60 },
  ], metricRows, {
    title: '指标汇总（与界面同源）',
    preamble: preamble(version, snapshot, opts),
    freeze: true,
    note: footerNote(version, '指标随版本固化；重算或人工修改后需重新导出。'),
  });

  const blob = writeXlsx({ sheets: [sheet, unSheet, metricSheet], created: new Date(), title: '排产清单 ' + version.id });
  downloadBlob(blob, '排产清单_' + version.id + '_' + ((opts.scope || 'all') === 'filtered' ? '筛选' : '全部') + '_' + nowStamp() + '.xlsx');
  return true;
}

/* ---------------- 2. 执行工单 ---------------- */
export function exportWorkOrdersXlsx(version, snapshot, opts = {}) {
  if (!version) throw new Error('尚未生成计划版本，无法导出工单');
  const orders = orderIndex(version, snapshot);
  const chains = chainsOf(version);
  const { taskLevel, orderLevel } = riskIndex(version);
  const tasks = scopeTasks(version, opts).sort((a, b) =>
    procOrder(a.process) - procOrder(b.process) ||
    String(a.machineId).localeCompare(String(b.machineId)) ||
    a.start - b.start);

  const groups = groupBy(tasks, t => t.process + '|' + t.machineId);
  const rows = [];
  for (const p of PROCESSES) {
    const keys = [...groups.keys()].filter(k => k.startsWith(p.key + '|')).sort();
    for (const k of keys) {
      const list = groups.get(k);
      const mid = k.split('|')[1];
      const mn = list[0]?.machineName ? ' ' + list[0].machineName : '';
      const hours = round(list.reduce((s, t) => s + (t.end - t.start) / HOUR, 0), 1);
      rows.push({ __group: procName(p.key) + ' · ' + mid + mn + ' · ' + list.length + ' 条任务 / 加工 ' + hours + ' 小时' });
      list.forEach((t, i) => {
        const o = orders.get(String(t.orderId)) || { id: t.orderId };
        const chain = chains.get(t.orderId) || {};
        const idx = CHAIN.indexOf(t.process);
        const prev = idx > 0 ? chain[CHAIN[idx - 1]] : null;
        const next = idx >= 0 && idx < 2 ? chain[CHAIN[idx + 1]] : null;
        const lv = taskLevel.get(t.id) || orderLevel.get(t.orderId) || null;
        rows.push({
          seq: i + 1,
          orderId: t.orderId,
          spec: t.specLabel || o.spec || '',
          qty: t.qty,
          unit: t.unit || '米',
          start: t.start, end: t.end,
          prevProcess: prev ? procName(prev.process) : '—',
          prevEnd: prev ? prev.end : null,
          nextProcess: next ? procName(next.process) : '—',
          nextStart: next ? next.start : null,
          setupHours: t.setupHours || 0,
          setupNote: (t.setupReasons || []).join('；'),
          lock: lockText(t),
          risk: lv ? SEV_LABEL[lv] : '无',
          machineId: mid,
          process: procName(t.process),
        });
      });
    }
  }

  const draft = isDraft(version);
  const sheet = sheetFromRows('执行工单', [
    { header: '序号', key: 'seq', width: 6, type: 'number' },
    { header: '工序', key: 'process', width: 8 },
    { header: '机台', key: 'machineId', width: 10 },
    { header: '订单号', key: 'orderId', width: 16 },
    { header: '规格', key: 'spec', width: 22 },
    { header: '数量', key: 'qty', width: 10, type: 'number' },
    { header: '单位', key: 'unit', width: 6 },
    { header: '计划开工', key: 'start', width: 18, type: 'datetime' },
    { header: '计划完工', key: 'end', width: 18, type: 'datetime' },
    { header: '前序工序', key: 'prevProcess', width: 10 },
    { header: '前序完工', key: 'prevEnd', width: 18, type: 'datetime' },
    { header: '后序工序', key: 'nextProcess', width: 10 },
    { header: '后序开工', key: 'nextStart', width: 18, type: 'datetime' },
    { header: '换型耗时(h)', key: 'setupHours', width: 11, type: 'decimal' },
    { header: '换型触发字段', key: 'setupNote', width: 34 },
    { header: '锁定状态', key: 'lock', width: 14 },
    { header: '风险', key: 'risk', width: 10 },
  ], rows, {
    title: '执行工单 · 版本 ' + version.id + (draft ? ' ·【草稿，不作为执行依据】' : '') + (version.simulated ? ' ·【模拟结果，含未验证参数】' : ''),
    preamble: preamble(version, snapshot, opts, [
      [draft ? '草稿，不作为执行依据' : '可执行性说明', draft
        ? '版本 ' + version.id + ' 尚未确认（' + statusText(version) + '），本工单仅供内部评审与排产核对，不得直接下发车间。'
        : '版本 ' + version.id + ' 已确认，可作为本产品内的执行参考；未接 ERP/MES，不代表已下发生产。'],
      ['工单口径', '按「工序 + 机台」分组，组内按计划开工时间排序；前序/后序为同一订单工序链上的相邻工序。'],
      ['未排产提示', (version.unscheduled || []).length ? '本版本有 ' + (version.unscheduled || []).length + ' 条工序未排入窗口，未列入本工单，详见排产清单「未排产与阻断」页。' : '全部纳入订单的工序均已排入计划窗口。'],
    ]),
    freeze: true, autoFilter: true,
    note: footerNote(version, '换型说明记录触发字段（R3：原料/成品规格；R4：结构/股径）。'),
  });

  const blob = writeXlsx({ sheets: [sheet], created: new Date(), title: '执行工单 ' + version.id });
  downloadBlob(blob, '执行工单_' + version.id + '_' + ((opts.scope || 'all') === 'filtered' ? '筛选' : '全部') + '_' + nowStamp() + '.xlsx');
  return true;
}

/* ---------------- 3. 风险清单 ---------------- */
export function exportRisksXlsx(version, opts = {}) {
  if (!version) throw new Error('尚未生成计划版本，无法导出风险清单');
  const taskById = new Map((version.tasks || []).map(t => [t.id, t]));
  const risks = (version.validation?.risks || []).slice().sort((a, b) =>
    (SEV_RANK[a.level] ?? 3) - (SEV_RANK[b.level] ?? 3) || String(a.id).localeCompare(String(b.id), 'zh-Hans-CN', { numeric: true }));
  const rows = risks.map(r => {
    const t = r.taskId ? taskById.get(r.taskId) : null;
    const rule = r.rule ? RULE_MAP[r.rule] : null;
    const target = r.target
      ? (r.target.kind === 'task' ? '任务 ' + r.target.taskId
        : r.target.kind === 'order' ? '订单 ' + r.target.orderId
          : r.target.kind === 'machine' ? '设备 ' + r.target.machineId : r.target.kind)
      : '—';
    return {
      id: r.id,
      level: SEV_LABEL[r.level] || r.level,
      type: r.type || '',
      rule: r.rule || '',
      ruleTitle: rule ? rule.title : '',
      ruleSource: rule ? rule.source : '',
      orderId: r.orderId || '',
      process: t ? procName(t.process) : '',
      machineId: r.machineId || (t ? t.machineId : ''),
      title: r.title || '',
      why: r.why || '',
      fix: r.fix || '',
      target,
    };
  });
  const counts = version.validation?.counts || { block: 0, warn: 0, info: 0 };
  const sheet = sheetFromRows('风险清单', [
    { header: '编号', key: 'id', width: 8 },
    { header: '级别', key: 'level', width: 8 },
    { header: '类型', key: 'type', width: 16 },
    { header: '命中规则', key: 'rule', width: 10 },
    { header: '规则要点', key: 'ruleTitle', width: 30 },
    { header: '依据来源', key: 'ruleSource', width: 16 },
    { header: '订单号', key: 'orderId', width: 16 },
    { header: '工序', key: 'process', width: 8 },
    { header: '机台', key: 'machineId', width: 10 },
    { header: '问题', key: 'title', width: 40 },
    { header: '原因', key: 'why', width: 56 },
    { header: '建议', key: 'fix', width: 40 },
    { header: '关联对象', key: 'target', width: 16 },
  ], rows, {
    title: '风险清单 · 版本 ' + version.id + (version.simulated ? ' ·【模拟结果，含未验证参数】' : ''),
    preamble: preamble(version, null, opts, [
      ['风险统计', '阻断 ' + counts.block + ' 项 · 警告 ' + counts.warn + ' 项 · 提示 ' + counts.info + ' 项'],
      ['导出说明', '按 PRD：导出不因存在风险而隐藏或阻断；草稿与模拟参数版本照常导出，但必须在文件内标记。'],
      ['级别定义', '阻断＝必须处理（未清零不允许确认版本）；警告＝需评估或已知晓；提示＝优化建议。'],
    ]),
    freeze: true, autoFilter: true,
    note: footerNote(version, '风险项与界面风险面板同源（engine/validate.js），导出后不再变化。'),
  });
  const blob = writeXlsx({ sheets: [sheet], created: new Date(), title: '风险清单 ' + version.id });
  downloadBlob(blob, '风险清单_' + version.id + '_' + nowStamp() + '.xlsx');
  return true;
}

/* ---------------- 4. 甘特图 PNG ---------------- */
const C = {
  ink: '#0f172a', ink2: '#334155', ink3: '#64748b', ink4: '#94a3b8',
  line: '#e3e8f0', line2: '#d3dae6', panel: '#ffffff', panel2: '#f8fafc', panel3: '#f1f5f9',
  brand: '#2563eb', ok: '#059669', warn: '#ea580c', block: '#dc2626', violet: '#7c3aed',
  change: '#c4b5fd', changeBg: '#ede9fe',
};
const PROC_FILL = { drawing: '#2563eb', stranding: '#d97706', closing: '#0d9488' };
const FONT = '"PingFang SC","Microsoft YaHei","Noto Sans CJK SC",system-ui,sans-serif';
const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

function domValue(hostEl, act) {
  try { return hostEl?.querySelector?.('[data-act="' + act + '"].on')?.dataset?.v || null; } catch (e) { return null; }
}
function hatch(ctx, color, bg, size = 6) {
  const tile = document.createElement('canvas');
  tile.width = size; tile.height = size;
  const g = tile.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, size, size);
  g.strokeStyle = color; g.lineWidth = 2;
  g.beginPath();
  g.moveTo(-1, size + 1); g.lineTo(size + 1, -1);
  g.moveTo(-1, 1); g.lineTo(1, -1);
  g.moveTo(size - 1, size + 1); g.lineTo(size + 1, size - 1);
  g.stroke();
  return ctx.createPattern(tile, 'repeat');
}
function clip(ctx, s, maxW) {
  let str = String(s ?? '');
  if (maxW == null || ctx.measureText(str).width <= maxW) return str;
  while (str.length > 1 && ctx.measureText(str + '…').width > maxW) str = str.slice(0, -1);
  return str + '…';
}

function drawGanttCanvas(hostEl, version, opts = {}) {
  const settings = version.settings || {};
  const view = opts.view || domValue(hostEl, 'view') || 'machine';
  const zoomKey = opts.zoom || domValue(hostEl, 'zoom') || 'day';
  const tasks = scopeTasks(version, opts);
  if (!tasks.length) throw new Error('当前范围内没有已排产任务，无法导出甘特图');
  let planStart = toDate(settings.planStart) ? toDate(settings.planStart).getTime() : null;
  if (planStart == null) planStart = Math.min(...tasks.map(t => t.start));
  const range = computeRange(version, { planStart }, { maxDays: 60 });
  const totalH = Math.max(1, (range.to - range.from) / HOUR);
  const basePx = { hour: 34, day: 7.5, week: 2.2 }[zoomKey] || 7.5;
  const maxW = { hour: 5200, day: 3000, week: 1600 }[zoomKey] || 3000;
  const pxPerHour = Math.min(maxW / totalH, Math.max(Math.min(maxW, 720) / totalH, basePx));
  const chartW = Math.max(320, Math.round(totalH * pxPerHour));
  const x = ms => Math.round((ms - range.from) / HOUR * pxPerHour);

  /* ---- 行模型 ---- */
  const MAX_ROWS = 60;
  const rows = [];
  let truncated = 0;
  if (view === 'order') {
    const byOrder = groupBy(tasks, t => t.orderId);
    const actives = (version.model?.active || []).filter(o => byOrder.has(String(o.id)));
    const extra = [...byOrder.keys()].filter(id => !actives.some(o => String(o.id) === String(id)));
    const list = actives.concat(extra.map(id => ({ id })));
    for (const o of list) {
      if (rows.length >= MAX_ROWS) { truncated++; continue; }
      rows.push({ kind: 'order', order: o, tasks: byOrder.get(String(o.id)) || [] });
    }
  } else {
    let cap = null;
    try { cap = (store && store.cap) || null; } catch (e) { cap = null; }   // 数据未就绪时退化为「仅统计有任务的机台」
    for (const p of PROCESSES) {
      const machines = cap?.machines?.[p.key] || null;
      const byMachine = groupBy(tasks.filter(t => t.process === p.key), t => t.machineUid || (t.process + ':' + t.machineId));
      if (!byMachine.size) continue;
      const total = machines ? machines.length : byMachine.size;
      rows.push({ kind: 'group', process: p.key, label: p.name, active: byMachine.size, total });
      for (const [uid, list] of byMachine) {
        if (rows.length >= MAX_ROWS + 3) { truncated += list.length; continue; }
        const mid = uid.split(':')[1] || list[0].machineId;
        rows.push({ kind: 'machine', process: p.key, machineId: mid, machineName: list[0].machineName || '', tasks: list.slice().sort((a, b) => a.start - b.start) });
      }
    }
  }
  if (!rows.length) throw new Error('当前范围内没有可绘制的行，无法导出甘特图');

  /* ---- 画布尺寸 ---- */
  const PAD = 22, LABEL_W = 210, ROW_H = 22, GRP_H = 26, HEAD_H = 118, AXIS_H = 34, LEGEND_ROW = 19;
  const legend = [
    { k: 'sw', color: PROC_FILL.drawing, label: '拉丝' },
    { k: 'sw', color: PROC_FILL.stranding, label: '捻股' },
    { k: 'sw', color: PROC_FILL.closing, label: '合绳' },
    { k: 'change', label: '换型占用（R3–R5）' },
    { k: 'down', label: '设备停机' },
    { k: 'risk', color: C.block, label: '阻断风险（斜纹+红框）' },
    { k: 'risk', color: C.warn, label: '警告风险（斜纹+橙框）' },
    { k: 'due', label: '承诺交期' },
    { k: 'lock', label: '已锁定 / 执行冻结' },
    { k: 'wait', label: '工序等待（前后序之间）' },
    { k: 'unsched', label: '未安排工序' },
  ];
  const legendRows = Math.ceil(legend.length / 4);
  const contentH = rows.reduce((s, r) => s + (r.kind === 'group' ? GRP_H : ROW_H), 0);
  const legendH = legendRows * LEGEND_ROW + 12;
  const footH = 40;
  const width = PAD * 2 + LABEL_W + chartW;
  const height = PAD + HEAD_H + AXIS_H + contentH + legendH + footH + PAD;

  const canvas = document.createElement('canvas');
  const scale = (width * 2) * (height * 2) <= 16e6 ? 2 : 1;
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext && canvas.getContext('2d');
  if (!ctx) throw new Error('当前浏览器不支持 Canvas 2D，无法生成甘特图');
  ctx.scale(scale, scale);

  const font = (size, weight) => (weight ? weight + ' ' : '') + size + 'px ' + FONT;
  const text = (s, px, py, o = {}) => {
    ctx.font = font(o.size || 11.5, o.weight || '');
    ctx.fillStyle = o.color || C.ink2;
    ctx.textAlign = o.align || 'left';
    ctx.textBaseline = o.baseline || 'middle';
    ctx.fillText(clip(ctx, s, o.maxW), px, py);
  };
  const box = (px, py, w, h, fill, stroke, lw = 1) => {
    if (fill) { ctx.fillStyle = fill; ctx.fillRect(px, py, w, h); }
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = lw; ctx.strokeRect(px + 0.5, py + 0.5, w - 1, h - 1); }
  };
  const lockGlyph = (px, py) => {
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.arc(px + 3.5, py, 2, Math.PI, 0); ctx.stroke();
    ctx.fillStyle = '#ffffff'; ctx.fillRect(px, py, 7, 6);
  };

  ctx.fillStyle = C.panel; ctx.fillRect(0, 0, width, height);

  /* ---- 抬头：标题 / 版本 / 导出时间 / 时间范围 / 风险与模拟标识 ---- */
  const riskCounts = version.validation?.counts || { block: 0, warn: 0, info: 0 };
  text('排产甘特图 · ' + (view === 'order' ? '订单视角' : '设备视角'), PAD, PAD + 14, { size: 17, weight: '700', color: C.ink });
  if (version.simulated) {
    ctx.font = font(11.5, '700');
    const w = ctx.measureText('模拟结果，含未验证参数').width + 18;
    box(width - PAD - w, PAD + 3, w, 22, '#fff7ed', C.warn);
    text('模拟结果，含未验证参数', width - PAD - w / 2, PAD + 14, { size: 11.5, weight: '700', color: C.warn, align: 'center' });
  }
  text('版本 ' + version.id + '（' + (version.name || '未命名方案') + '） · ' + statusText(version), PAD, PAD + 40, { size: 12.5, weight: '600', color: C.ink2, maxW: width - PAD * 2 - 240 });
  text('导出时间 ' + fmtDateTime(new Date()) + ' · 时间范围 ' + fmtDate(range.from) + ' ~ ' + fmtDate(range.to) + ' · ' + (zoomKey === 'hour' ? '小时' : zoomKey === 'week' ? '周' : '日') + '尺度', PAD, PAD + 60, { size: 11.5, color: C.ink3, maxW: width - PAD * 2 });
  text('范围：' + scopeText(opts) + ' · 数据快照：' + (version.dataVersion || version.snapshotId || '—') + ' · 导出人：' + OPERATOR, PAD, PAD + 78, { size: 11.5, color: C.ink3, maxW: width - PAD * 2 });
  text('已知风险：阻断 ' + riskCounts.block + ' 项 · 警告 ' + riskCounts.warn + ' 项 · 提示 ' + riskCounts.info + ' 项（导出不受风险影响，标记仅作提示）' +
    '　·　行数 ' + rows.length + (truncated ? '（另有 ' + truncated + ' 行未绘制，完整清单请导出 XLSX）' : '') +
    '　·　时间刻度 ' + (Math.round(pxPerHour * 100) / 100) + ' px/小时',
    PAD, PAD + 96, { size: 11.5, color: riskCounts.block ? C.block : C.ink3, maxW: width - PAD * 2 });
  ctx.strokeStyle = C.line; ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(PAD, PAD + HEAD_H - 10.5); ctx.lineTo(width - PAD, PAD + HEAD_H - 10.5); ctx.stroke();

  const headTop = PAD + HEAD_H;
  const bodyTop = headTop + AXIS_H;
  const trackX = PAD + LABEL_W;

  /* ---- 时间轴：按天分格，周末淡底，日尺度下再分白/晚班 ---- */
  const dayList = [];
  for (let d = new Date(range.from); d.getTime() < range.to; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) dayList.push(new Date(d));
  const dayW = 24 * pxPerHour;
  const showEvery = dayW >= 34 ? 1 : dayW >= 18 ? 2 : 7;
  box(trackX, headTop, chartW, AXIS_H, C.panel2, C.line);
  ctx.save();
  // 裁剪区必须含左侧标签列（PAD..trackX），否则机台/订单名会被一起裁掉；右侧仍以图表宽度为界
  ctx.beginPath(); ctx.rect(PAD, headTop, LABEL_W + chartW, AXIS_H + contentH); ctx.clip();
  dayList.forEach((d, i) => {
    const dx = trackX + x(d.getTime());
    const dw = Math.max(1, Math.round(24 * pxPerHour));
    const we = d.getDay() === 0 || d.getDay() === 6;
    if (we) box(dx, headTop, dw, AXIS_H + contentH, C.panel3, null);
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(dx + 0.5, headTop); ctx.lineTo(dx + 0.5, headTop + AXIS_H + contentH); ctx.stroke();
    if (i % showEvery === 0) {
      text((d.getMonth() + 1) + '/' + d.getDate(), dx + 5, headTop + 12, { size: 11, weight: '600', color: C.ink2 });
      text(WD[d.getDay()], dx + 5, headTop + 25, { size: 10, color: C.ink4 });
    }
    if (zoomKey === 'hour' && dayW > 40) {
      const hx = dx + dw / 2;
      ctx.strokeStyle = C.line2; ctx.beginPath(); ctx.moveTo(hx + 0.5, headTop); ctx.lineTo(hx + 0.5, headTop + AXIS_H + contentH); ctx.stroke();
      text('白班', dx + 4, headTop + 25, { size: 10, color: C.ink3 });
      text('晚班', hx + 4, headTop + 25, { size: 10, color: C.ink3 });
    }
  });
  /* ---- 交期标线（订单视角）---- */
  const downs = (settings.downtime || []).filter(d => d && d.from && d.to);
  const downByMachine = new Map();
  for (const d of downs) {
    const key = String(d.machineId);
    if (!downByMachine.has(key)) downByMachine.set(key, []);
    downByMachine.get(key).push({ s: new Date(d.from).getTime(), e: new Date(d.to).getTime(), reason: d.reason || '' });
  }
  const inRange = (s, e) => e >= range.from && s <= range.to;

  /* ---- 行绘制 ---- */
  let y = bodyTop;
  for (const r of rows) {
    const h = r.kind === 'group' ? GRP_H : ROW_H;
    box(PAD, y, LABEL_W, h, r.kind === 'group' ? '#e8eefc' : C.panel, C.line);
    if (r.kind === 'group') {
      // 注意：rules.js 的 color 是 CSS 变量（var(--p-draw)），canvas 无法解析，必须用具体色值
      text(r.label, PAD + 10, y + h / 2, { size: 11.5, weight: '700', color: PROC_FILL[r.process] || C.ink2 });
      text(r.active + '/' + r.total + ' 台有任务', PAD + LABEL_W - 10, y + h / 2, { size: 10.5, color: C.ink3, align: 'right' });
    } else if (r.kind === 'machine') {
      text(r.machineId, PAD + 10, y + h / 2, { size: 11.5, weight: '600', color: C.ink, maxW: 60 });
      text(r.machineName || '', PAD + 74, y + h / 2, { size: 10.5, color: C.ink3, maxW: LABEL_W - 84 });
    } else {
      const o = r.order;
      text(o.id, PAD + 10, y + h / 2, { size: 11.5, weight: '600', color: C.ink, maxW: 118 });
      text(o.spec || '', PAD + 124, y + h / 2, { size: 10.5, color: C.ink3, maxW: 80 });
    }
    /* 停机区间 */
    if (r.kind === 'machine') {
      for (const d of (downByMachine.get(String(r.machineId)) || [])) {
        if (!inRange(d.s, d.e)) continue;
        const s = Math.max(d.s, range.from), e = Math.min(d.e, range.to);
        const px = trackX + x(s), pw = Math.max(2, Math.round((e - s) / HOUR * pxPerHour));
        ctx.fillStyle = hatch(ctx, '#94a3b8', '#cbd5e1', 6);
        ctx.fillRect(px, y + 4, pw, h - 8);
        if (pw > 44) text('停机', px + 4, y + h / 2, { size: 9.5, color: '#334155' });
      }
    }
    /* 任务条 */
    const list = r.tasks || [];
    for (const t of list) {
      const bx = trackX + x(t.start);
      const bw = Math.max(2, Math.round((t.end - t.start) / HOUR * pxPerHour));
      /* 换型占用 */
      if (t.setupHours > 0 && t.setupStart != null) {
        const sx = trackX + x(t.setupStart);
        const sw = Math.max(2, bx - sx);
        ctx.fillStyle = hatch(ctx, C.change, C.changeBg, 5);
        ctx.fillRect(sx, y + 5, sw, h - 12);
        ctx.strokeStyle = C.change; ctx.lineWidth = 1; ctx.strokeRect(sx + 0.5, y + 5.5, sw - 1, h - 13);
      }
      box(bx, y + 3, bw, h - 6, PROC_FILL[t.process] || C.brand, t.locked ? C.violet : null, 1.5);
      if (t.locked && bw > 40) lockGlyph(bx + 5, y + h / 2 - 1);
      if (bw > 46) text(t.orderId, bx + (t.locked && bw > 40 ? 16 : 5), y + h / 2, { size: 9.5, color: '#ffffff', maxW: bw - 10 });
      /* 前后序等待（订单视角） */
      if (r.kind === 'order') {
        const chain = {};
        for (const ct of list) chain[ct.process] = ct;
        for (let i = 1; i < CHAIN.length; i++) {
          const a = chain[CHAIN[i - 1]], b = chain[CHAIN[i]];
          if (!a || !b || b.start <= a.end) continue;
          const wx = trackX + x(a.end), ww = Math.max(2, Math.round((b.start - a.end) / HOUR * pxPerHour));
          const bad = (b.start - a.end) / HOUR > 72;
          ctx.fillStyle = bad ? C.block : C.line2;
          ctx.fillRect(wx, y + h / 2 - 1, ww, 2);
        }
      }
    }
    /* 交期标线（订单视角） */
    if (r.kind === 'order') {
      const o = r.order;
      const due = dueOf(o);
      const dueMs = due ? (due instanceof Date ? due.getTime() : new Date(due).getTime()) : null;
      if (dueMs && dueMs >= range.from && dueMs <= range.to) {
        const dx = trackX + x(dueMs);
        ctx.strokeStyle = C.block; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.moveTo(dx + 0.5, y + 1); ctx.lineTo(dx + 0.5, y + h - 1); ctx.stroke();
      }
    }
    ctx.strokeStyle = C.line; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(PAD + 0.5, y + h + 0.5); ctx.lineTo(PAD + LABEL_W + chartW, y + h + 0.5); ctx.stroke();
    y += h;
  }
  ctx.restore();

  /* ---- 图例 ---- */
  const ly0 = bodyTop + contentH + 14;
  ctx.strokeStyle = C.line; ctx.beginPath(); ctx.moveTo(PAD, ly0 - 6.5); ctx.lineTo(width - PAD, ly0 - 6.5); ctx.stroke();
  legend.forEach((it, i) => {
    const cx = PAD + (i % 4) * 232;
    const cy = ly0 + Math.floor(i / 4) * LEGEND_ROW + 6;
    const sw = 16, sh = 10;
    if (it.k === 'sw') box(cx, cy - sh / 2, sw, sh, it.color, 'rgba(0,0,0,.14)');
    else if (it.k === 'change') { ctx.fillStyle = hatch(ctx, C.change, C.changeBg, 5); ctx.fillRect(cx, cy - sh / 2, sw, sh); box(cx, cy - sh / 2, sw, sh, null, C.change); }
    else if (it.k === 'down') { ctx.fillStyle = hatch(ctx, '#94a3b8', '#cbd5e1', 5); ctx.fillRect(cx, cy - sh / 2, sw, sh); box(cx, cy - sh / 2, sw, sh, null, '#94a3b8'); }
    else if (it.k === 'risk') { ctx.fillStyle = hatch(ctx, it.color, '#ffffff', 4); ctx.fillRect(cx, cy - sh / 2, sw, sh); box(cx, cy - sh / 2, sw, sh, null, it.color, 1.5); }
    else if (it.k === 'due') { ctx.strokeStyle = C.block; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(cx + sw / 2, cy - 7); ctx.lineTo(cx + sw / 2, cy + 7); ctx.stroke(); }
    else if (it.k === 'lock') { box(cx, cy - sh / 2, sw, sh, PROC_FILL.drawing, C.violet, 1.5); lockGlyph(cx + 5, cy - 1); }
    else if (it.k === 'wait') { ctx.fillStyle = C.line2; ctx.fillRect(cx, cy - 1, sw, 2); }
    else if (it.k === 'unsched') { ctx.fillStyle = hatch(ctx, '#cbd5e1', '#f1f5f9', 4); ctx.fillRect(cx, cy - sh / 2, sw, sh); box(cx, cy - sh / 2, sw, sh, null, C.line2); }
    text(it.label, cx + sw + 6, cy, { size: 11, color: C.ink2 });
  });

  /* ---- 页脚 ---- */
  const fy = height - PAD - 12;
  text('本图为计划推算结果，非实测；时间为工厂本地时间（' + (settings.timezone || 'Asia/Shanghai') + '）。风险判定依据 R1–R10；设备行仅绘制有任务的机台。',
    PAD, fy, { size: 10.5, color: C.ink4, maxW: width - PAD * 2 });
  if (version.simulated) text('模拟结果，含未验证参数（演示参数模式）：不得作为正式执行依据。', PAD, fy - 15, { size: 10.5, weight: '700', color: C.warn });
  else text('版本状态：' + statusText(version) + (isDraft(version) ? ' —— 草稿，不作为执行依据。' : ''), PAD, fy - 15, { size: 10.5, color: C.ink3 });

  /* ---- 风险斜纹叠加（按任务）---- */
  const { taskLevel } = riskIndex(version);
  if (taskLevel.size) {
    ctx.save();
    ctx.beginPath(); ctx.rect(trackX, bodyTop, chartW, contentH); ctx.clip();
    let yy = bodyTop;
    for (const r of rows) {
      const h = r.kind === 'group' ? GRP_H : ROW_H;
      for (const t of (r.tasks || [])) {
        const lv = taskLevel.get(t.id);
        if (!lv) continue;
        const bx = trackX + x(t.start), bw = Math.max(2, Math.round((t.end - t.start) / HOUR * pxPerHour));
        ctx.fillStyle = hatch(ctx, lv === 'block' ? C.block : C.warn, 'rgba(255,255,255,0)', 5);
        ctx.fillRect(bx, yy + 3, bw, h - 6);
        ctx.strokeStyle = lv === 'block' ? C.block : C.warn;
        ctx.lineWidth = 2;
        ctx.strokeRect(bx + 1, yy + 4, Math.max(1, bw - 2), h - 8);
      }
      yy += h;
    }
    ctx.restore();
  }

  return canvas;
}
function canvasToPng(canvas) {
  return new Promise(resolve => {
    try {
      if (canvas.toBlob) { canvas.toBlob(b => resolve(b), 'image/png'); return; }
      const url = canvas.toDataURL('image/png');
      const bin = atob(url.split(',')[1]);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      resolve(new Blob([arr], { type: 'image/png' }));
    } catch (e) { console.error('[exportGanttPNG] 画布转 PNG 失败：', e); resolve(null); }
  });
}

/** 导出甘特图 PNG：叠加标题、版本、导出时间、时间范围、完整图例与模拟标识；失败返回 false */
export async function exportGanttPNG(hostEl, version, opts = {}) {
  try {
    if (!version) throw new Error('尚未生成计划版本，无法导出甘特图');
    const canvas = drawGanttCanvas(hostEl, version, opts);
    const blob = await canvasToPng(canvas);
    if (!blob) throw new Error('画布无法转换为 PNG');
    const view = (opts.view || domValue(hostEl, 'view') || 'machine') === 'order' ? '订单视角' : '设备视角';
    downloadBlob(blob, '排产甘特图_' + version.id + '_' + view + '_' + ((opts.scope || 'all') === 'filtered' ? '筛选' : '全部') + '_' + nowStamp() + '.png');
    return true;
  } catch (e) {
    console.error('[exportGanttPNG] 导出失败：', e);
    return false;
  }
}
