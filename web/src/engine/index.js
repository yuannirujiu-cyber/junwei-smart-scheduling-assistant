/* 排产引擎门面（稳定对外 API）—— createScheduler(dataset, options)
   ------------------------------------------------------------------
   设计目标：把「拉丝→捻股→合绳 + 君威字段名」的专用实现，包装成一个可被
   其他工厂 / 其他赛题直接引用的独立模块：全部方法同步、语义稳定、绝不抛裸异常。

   最短用法：
     import { createScheduler } from './web/src/engine/index.js';
     const s = createScheduler(dataset);          // 数据集校验 + 工艺链解析
     const r = s.schedule();                      // 建模 → 排产 → R6 修复 → 局部优化 → 校验 → 指标
     console.log(s.metrics(r).deliveryRate, s.validate(r).canConfirm);

   方法：
     describe()                       数据与工艺链概览（processes / machines / specIndexStats / dataIssues）
     buildModel(settingsOverride)     构建可求解模型（jobs / blocked / chain / cap）
     schedule(settingsOverride)       排产，返回 tasks / unscheduled / stats（并缓存，供 validate/metrics/explain 复用）
     validate(scheduleResult)         风险分级（risks / counts / canConfirm / orderStats）
     metrics(scheduleResult, baseline)指标（准时率 / 延期 / 占用 / 换型 …）
     explain(taskId)                  单个任务的四段式解释（结论 / 证据 / 约束 / 入口）
     toRows(scheduleResult, opts)     导出用行数据（CSV / Excel / CLI 复用，不重复拼装）
     defaults()                       默认 settings（changeoverModel / qtyModel / 日历 …）

   错误与降级：
     - 数据集结构错误（缺表 / 类型错 / 主键重复 / 矩阵列不对齐）→ 抛带明细的 SchedulerInputError；
     - 业务数据缺口（缺数量 / 缺交期 / 规格不可解析 / 矩阵空值）→ 记为 warnings 与「阻断订单」，
       调度结果里显式列出，不静默丢单、不补默认值；
     - 任何一个方法内部出现意外异常 → 捕获并返回带 error 字段的降级结果，不向调用方抛裸异常。 */
import { validateDataset, formatValidationErrors, DATASET_SCHEMA, SCHEMA_VERSION } from './schema.js';
import { resolveProcessChain, chainToProcesses, DEFAULT_PROCESS_CHAIN } from './chain.js';
import { buildCapacity } from './capacity.js';
import { buildModel } from './model.js';
import { runSchedule, repairWaits, improveSchedule } from './scheduler.js';
import { runDispatchSchedule, readDispatchConfig, DISPATCH_DEFAULTS } from './dispatch.js';
import { MATERIAL_CATALOG } from './materials.js';
import { validateSchedule } from './validate.js';
import { computeMetrics } from './metrics.js';
import { explainTask } from './explain.js';
import { DEFAULT_CHANGEOVER_MODEL } from './spec.js';
import { DEFAULT_QTY_MODEL } from './mapping.js';
import { toDate, num, round, fmtDateTime, deepClone, HOUR } from '../core/util.js';

export const ENGINE_VERSION = '1.0.0';

/** 默认日历（两班倒、每班 12 小时）。引擎当前按 24 小时连续产能计算，日历字段是对外声明与后续扩展位。 */
export const DEFAULT_CALENDAR = {
  shiftsPerDay: 2, hoursPerShift: 12, startHour: 0,
  workdays: [1, 2, 3, 4, 5, 6, 7], breaks: [], weekendsOff: false,
  note: '两班倒，每班 12 小时，全天 24 小时连续生产（R2）；换班不切断工序',
};

/** 数据集 / 工艺链配置错误：带明细的可读错误（errors 数组含 path / expected / actual / message） */
export class SchedulerInputError extends Error {
  constructor(message, errors, code) {
    super(message);
    this.name = 'SchedulerInputError';
    this.code = code || 'INPUT_INVALID';
    this.errors = Array.isArray(errors) ? errors : [];
  }
}

/**
 * 创建排产门面（同步 API）
 * @param {object} dataset 数据集：{ meta, orders, machines, capacity, specIndex?, processChain? }
 * @param {object} [options] { validate=false 可跳过 schema 校验, processChain/processes 注入工艺链,
 *                             settings 覆盖默认设置, locks/frozen 预置任务, planStart, horizonDays, setupWeight, ... }
 * @returns 门面对象
 */
export function createScheduler(dataset, options = {}) {
  const opts = (options && typeof options === 'object' && !Array.isArray(options)) ? options : {};

  /* ---- 1. 工艺链解析（配置错误优先报告，便于与数据集错误区分）
     options.processChain > options.processes > dataset.processChain > dataset.meta.processChain > 默认三工序 ---- */
  const resolved = resolveProcessChain(dataset, opts);
  if (resolved.errors.length) {
    throw new SchedulerInputError(
      '工艺链配置无效：' + resolved.errors.length + ' 项错误\n'
      + resolved.errors.map(e => '  - ' + (e.path || 'processChain') + '：' + e.message).join('\n'),
      resolved.errors, 'CHAIN_INVALID');
  }

  /* ---- 2. 数据契约校验（默认开启）---- */
  const report = opts.validate === false
    ? { ok: true, errors: [], warnings: [], stats: {} }
    : validateDataset(dataset, { chainOptions: opts });
  if (report.errors.length) {
    throw new SchedulerInputError(
      '排产数据集校验未通过：' + report.errors.length + ' 项错误\n' + formatValidationErrors(report.errors),
      report.errors, 'DATASET_INVALID');
  }
  const chain = resolved.chain;
  const chainKeys = chain.map(p => p.key);

  /* ---- 3. 快照与产能索引 ---- */
  const orders = Array.isArray(dataset.orders) ? dataset.orders : [];
  const snapshot = {
    meta: dataset.meta || null,
    orders,
    machines: dataset.machines || {},
    capacity: dataset.capacity || {},
    specIndex: dataset.specIndex || null,
    processChain: Array.isArray(dataset.processChain) ? dataset.processChain
      : (Array.isArray(dataset.meta?.processChain) ? dataset.meta.processChain : null),
    simulationPresets: dataset.simulationPresets || null,
  };
  const cap = buildCapacity(snapshot, { processChain: chain });

  /* ---- 4. 数据问题清单（warnings + 数据集自述问题 + 工艺链提示）---- */
  const dataIssues = [];
  for (const w of report.warnings) dataIssues.push({ level: 'warn', code: w.code, path: w.path, message: w.message, actual: w.actual });
  for (const w of resolved.warnings) dataIssues.push({ level: 'warn', code: 'CHAIN_WARN', path: w.path || 'processChain', message: w.message });
  for (const m of (Array.isArray(dataset.meta?.issues) ? dataset.meta.issues : [])) {
    dataIssues.push({ level: 'info', code: 'META_ISSUE', path: 'meta.issues', message: String(m) });
  }

  /* ---- 5. 默认设置 ---- */
  const base = buildDefaults(snapshot, opts);
  const settingsNotes = [];
  let last = null;

  /** 取本次调用的排产结果：显式传入的对象优先，否则用最近一次 schedule() 的缓存 */
  function pickResult(scheduleResult) {
    if (scheduleResult && typeof scheduleResult === 'object' && !Array.isArray(scheduleResult)) return scheduleResult;
    return last;
  }

  /* ---------------- 门面方法 ---------------- */
  function describe() {
    return safe(() => {
      const byProcess = {};
      for (const k of chainKeys) byProcess[k] = (cap.machines[k] || []).length;
      let total = 0;
      for (const k of Object.keys(byProcess)) total += byProcess[k];
      return {
        engine: { version: ENGINE_VERSION, schemaVersion: SCHEMA_VERSION, chainSource: resolved.source, legacyChain: cap.legacy },
        dataset: {
          id: dataset.meta?.id || null, name: dataset.meta?.name || null,
          orderCount: orders.length,
          activeOrders: orders.filter(o => o.endCode !== '已结束').length,
          historyOrders: orders.filter(o => o.endCode === '已结束').length,
        },
        processes: chain.map(p => describeProcess(p, cap)),
        machines: { total, byProcess },
        specIndexStats: specIndexStats(dataset),
        dataIssues,
      };
    }, () => ({
      engine: { version: ENGINE_VERSION, schemaVersion: SCHEMA_VERSION, chainSource: resolved.source, legacyChain: cap.legacy },
      dataset: { id: null, name: null, orderCount: orders.length, activeOrders: 0, historyOrders: 0 },
      processes: [], machines: { total: 0, byProcess: {} }, specIndexStats: specIndexStats(dataset), dataIssues,
    }));
  }

  function buildModelSafe(settings) {
    try {
      return buildModel({ snapshot, settings, cap });
    } catch (e) {
      return fatalModel(e, settings);
    }
  }

  function schedule(settingsOverride) {
    return safe(() => {
      const settings = mergeSettings(base, settingsOverride, settingsNotes);
      const model = buildModelSafe(settings);
      if (model.fatal) return degradeSchedule(model, settings, model.fatal);
      const locks = normalizeTaskMap(settings.locks);
      const frozen = normalizeTaskMap(settings.frozen);
      const t0 = Date.now();
      const useDispatch = (settings.strategy || 'dispatch') !== 'order';
      const s1 = useDispatch
        ? runDispatchSchedule({ model, settings, locks, frozen, horizonDays: settings.horizonDays })
        : runSchedule({ model, settings, locks, frozen, horizonDays: settings.horizonDays });
      const s15 = repairWaits({ model, settings, tasks: s1.tasks, horizonDays: settings.horizonDays });
      const s2 = improveSchedule({ model, settings, tasks: s15.tasks, horizonDays: settings.horizonDays });
      const validation = validateSchedule({ model, tasks: s2.tasks, unscheduled: s1.unscheduled, settings, horizonDays: settings.horizonDays });
      const metrics = computeMetrics({ model, tasks: s2.tasks, unscheduled: s1.unscheduled, validation, settings,
        horizonDays: settings.horizonDays, baseline: settings.baseline || null });
      const elapsedMs = Date.now() - t0;
      const sched = s2.tasks.filter(t => t.scheduled);
      const result = {
        tasks: s2.tasks, unscheduled: s1.unscheduled, model, settings, validation, metrics,
        processKeys: chainKeys.slice(),
        elapsedMs,
        stats: {
          orderCount: model.active.length,
          jobCount: model.jobs.length,
          blockedOrders: model.blocked.length,
          excludedOrders: model.excluded.length,
          historyOrders: model.history.length,
          taskCount: sched.length,
          strategy: settings.strategy || 'dispatch',
          dispatch: s1.stats || null,
          unscheduledTasks: s1.unscheduled.length,
          scheduledOrders: metrics.scheduledOrders,
          unscheduledOrders: metrics.unscheduledOrders,
          makespan: metrics.makespan,
          totalSetupHours: metrics.totalSetupHours,
          deliveryRate: metrics.deliveryRate,
          lateOrders: metrics.lateOrders,
          lateHours: metrics.lateHours,
          machineOccRate: metrics.machineOccRate,
          machineRunRate: metrics.machineRunRate,
          risks: validation.counts,
          canConfirm: validation.canConfirm,
          firstPassMs: round(s1.elapsedMs, 1),
          totalMs: elapsedMs,
          repairedWaits: s15.fixed,
          movedTasks: s15.moved,
          improvedTasks: s2.improved,
        },
        warnings: settingsNotes.slice(),
      };
      last = result;
      return result;
    }, e => degradeSchedule(fatalModel(e, mergeSettings(base, settingsOverride, [])), mergeSettings(base, settingsOverride, []), '排产过程内部错误：' + errText(e)));
  }

  function validate(scheduleResult) {
    return safe(() => {
      const r = pickResult(scheduleResult);
      if (!r) return noScheduleValidation();
      if (!Array.isArray(r.tasks)) {
        return { risks: [{ id: 'R1', level: 'block', type: '输入无效', rule: 'R1', title: '传入的排产结果缺少 tasks 数组',
          why: 'validate(scheduleResult) 需要 schedule() 的返回值，或 { tasks, unscheduled, model }', fix: '先调用 schedule()', target: null }],
          counts: { block: 1, warn: 0, info: 0 }, canConfirm: false, orderStats: new Map(), error: '传入的排产结果缺少 tasks 数组' };
      }
      const model = r.model || last?.model;
      if (!model || model.fatal) {
        return { risks: [{ id: 'R1', level: 'block', type: '尚未排产', rule: 'R1', title: '尚未排产，无法校验',
          why: model?.fatal || '请先调用 schedule()，或把 schedule() 的返回值传给 validate()', fix: '调用 schedule()', target: null }],
          counts: { block: 1, warn: 0, info: 0 }, canConfirm: false, orderStats: new Map(), error: model?.fatal || '尚未排产' };
      }
      const settings = r.settings || base;
      return validateSchedule({ model, tasks: r.tasks || [], unscheduled: r.unscheduled || [], settings, horizonDays: settings.horizonDays });
    }, e => ({ risks: [{ id: 'R1', level: 'block', type: '校验降级', rule: 'R1', title: '校验过程内部错误，已降级',
        why: errText(e), fix: '检查输入数据', target: null }],
      counts: { block: 1, warn: 0, info: 0 }, canConfirm: false, orderStats: new Map(), error: errText(e) }));
  }

  function metrics(scheduleResult, baseline) {
    return safe(() => {
      const r = pickResult(scheduleResult);
      if (!r) return emptyMetrics('尚未排产：请先调用 schedule()');
      if (!Array.isArray(r.tasks)) return emptyMetrics('传入的排产结果缺少 tasks 数组：请传入 schedule() 的返回值');
      if (!r.model || r.model.fatal) return emptyMetrics(r.model?.fatal || '尚未排产：请先调用 schedule()');
      const settings = r.settings || base;
      return computeMetrics({ model: r.model, tasks: r.tasks || [], unscheduled: r.unscheduled || [],
        validation: r.validation || null, settings, horizonDays: settings.horizonDays, baseline: baseline || r.baseline || null });
    }, e => emptyMetrics('指标计算内部错误：' + errText(e)));
  }

  function explain(taskId) {
    return safe(() => {
      const r = last;
      const empty = { conclusion: '', evidence: [], constraints: [], actions: [], caveats: [], rules: [], ruleTexts: [] };
      if (!r || !r.model || r.model.fatal) return { ...empty, error: r?.model?.fatal || '尚未排产：请先调用 schedule()' };
      const task = (taskId && typeof taskId === 'object')
        ? taskId
        : r.tasks.find(t => String(t.id) === String(taskId));
      if (!task) return { ...empty, error: '未找到任务「' + taskId + '」：本次排产共 ' + r.tasks.length + ' 条任务，可用 toRows() 查看任务号' };
      return explainTask(task, { cap, version: { tasks: r.tasks }, settings: r.settings, model: r.model });
    }, e => ({ conclusion: '', evidence: [], constraints: [], actions: [], caveats: [], rules: [], ruleTexts: [], error: '解释生成内部错误：' + errText(e) }));
  }

  function toRows(scheduleResult, rowOpts = {}) {
    return safe(() => {
      const o = (rowOpts && typeof rowOpts === 'object') ? rowOpts : {};
      const kind = ['plan', 'unscheduled', 'risk', 'load'].includes(o.kind) ? o.kind : 'plan';
      const r = pickResult(scheduleResult);
      if (!r) return emptyRows(kind, '尚未排产：请先调用 schedule()');
      return buildRows(kind, r, o);
    }, e => emptyRows('plan', '导出数据生成内部错误：' + errText(e)));
  }

  function defaults() {
    return safe(() => deepClone(base), () => deepClone(base));
  }

  return {
    version: ENGINE_VERSION,
    dataset: { meta: dataset.meta || null, orderCount: orders.length },
    chain: chain.map(p => ({ ...p })),
    processKeys: chainKeys.slice(),
    cap,
    describe, buildModel: buildModelSafe, schedule, validate, metrics, explain, toRows, defaults,
  };
}

/* ==================================================================
   内部实现
   ================================================================== */

/**
 * 材料库默认值：以目录为底，叠加上一层保存下来的「有无 / 库存」。
 *
 * 两个约定的口径：
 *   · **默认 available = true**（用户明确要求「默认材料存在」）——
 *     只有显式传入 available === false 才算缺料，避免「忘了登记库存」被误判成缺料而阻断排产；
 *   · **默认 stock = safetyStock**（用户明确要求）——
 *     没填过库存时按安全库存起步，因此初始状态不会出现一排空的库存格，也不会误报「低于安全库存」。
 */
export function seedMaterials(saved) {
  const prev = Array.isArray(saved) ? saved : null;
  const byId = new Map((prev || []).map((m) => [m && m.id, m]));
  const base = (prev && prev.length) ? prev.map((m) => ({ ...m })) : MATERIAL_CATALOG.map((m) => ({ ...m }));
  return base.map((m) => {
    const old = byId.get(m.id) || {};
    const safety = old.safetyStock === undefined ? (m.safetyStock === undefined ? null : m.safetyStock) : old.safetyStock;
    const stock = old.stock === undefined ? (m.stock === undefined ? safety : m.stock) : old.stock;
    return {
      ...m,
      available: old.available === undefined ? (m.available === undefined ? true : !!m.available) : !!old.available,
      stock,
      safetyStock: safety,
    };
  });
}

function buildDefaults(snapshot, opts) {
  const orders = snapshot.orders || [];
  return {
    planStart: opts.planStart || defaultPlanStart(orders),
    horizonDays: num(opts.horizonDays) ?? defaultHorizonDays(orders, opts.planStart || defaultPlanStart(orders)),
    /* 换型权衡系数：score = 完工时刻 + setupWeight × 换型时长（都在毫秒量纲）。
       取 1.0 表示「愿意用 1 分钟完工推迟换 1 分钟换型」；实测在该值下换型总时长显著下降
       而准时率不变。此值必须与 web/src/core/store.js 的默认设置一致，
       否则同一个数据集在「界面」与「无头 CLI」会排出不同结果。 */
    setupWeight: num(opts.setupWeight) ?? 1.0,
    /* 排程策略：
         'dispatch' —— 《三工序排产算法设计》的同型号优先 + 下一台设备前瞻（按机台派单），
         'order'    —— 既有实现：按订单逐个排，三道工序依次做换型感知的间隙插入。
       两者共用同一套数据契约、校验与指标，可在「排产设置」里切换对比。 */
    strategy: opts.strategy === 'order' ? 'order' : 'dispatch',
    /* 材料库（本产品扩展）：目录 + 人工维护的「有无」。
       默认全部有货，因此装上这个门禁不会改变任何既有数据集的结果。 */
    materials: seedMaterials(opts.materials),
    /* 前瞻派单的可调参数（阈值 / 负余量模式 / 换型公式 / R5 夹紧），见 engine/dispatch.js */
    dispatch: { ...DISPATCH_DEFAULTS, ...(opts.dispatch || {}) },
    processIntervalMin: { drawing: 10, stranding: 5, closing: 10, ...(opts.processIntervalMin || {}) },
    changeoverModel: { ...DEFAULT_CHANGEOVER_MODEL, ...(opts.changeoverModel || {}) },
    qtyModel: { ...DEFAULT_QTY_MODEL, ...(opts.qtyModel || {}) },
    calendar: { ...DEFAULT_CALENDAR, ...(opts.calendar || {}) },
    demoParams: { enabled: !!(opts.demoParams?.enabled) },
    downtime: Array.isArray(opts.downtime) ? opts.downtime : [],
    duePolicy: (opts.duePolicy && typeof opts.duePolicy === 'object') ? opts.duePolicy : {},
    includedOrderIds: Array.isArray(opts.includedOrderIds) ? opts.includedOrderIds : null,
    locks: opts.locks || null,
    frozen: opts.frozen || null,
    baseline: opts.baseline || null,
  };
}

function defaultPlanStart(orders) {
  const cands = [];
  for (const o of orders) {
    if (!o || o.endCode === '已结束') continue;
    for (const f of ['orderDate', 'preShipDate']) {
      const d = toDate(o[f]);
      if (d) cands.push(d.getTime());
    }
  }
  const ms = cands.length ? Math.min(...cands) : Date.now();
  const d = new Date(ms);
  return stamp(new Date(d.getFullYear(), d.getMonth(), d.getDate()));
}

function defaultHorizonDays(orders, planStart) {
  const start = toDate(String(planStart).replace('T', ' '));
  const startMs = start ? start.getTime() : Date.now();
  const dues = [];
  for (const o of orders) {
    if (!o || o.endCode === '已结束') continue;
    const d = toDate(o.preShipDate);
    if (d) dues.push(d.getTime());
  }
  if (!dues.length) return 45;
  const span = Math.ceil((Math.max(...dues) - startMs) / 86400000) + 21;
  return Math.max(30, Math.min(200, span));
}

function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

/** 合并默认设置与本次覆盖：嵌套对象逐层合并；非法 planStart / horizonDays 回退默认并记录提示 */
function mergeSettings(base, override, notes) {
  const o = (override && typeof override === 'object' && !Array.isArray(override)) ? override : {};
  const out = { ...base, ...o };
  out.changeoverModel = { ...base.changeoverModel, ...(o.changeoverModel || {}) };
  out.processIntervalMin = { ...base.processIntervalMin, ...(o.processIntervalMin || {}) };
  out.qtyModel = { ...base.qtyModel, ...(o.qtyModel || {}) };
  out.calendar = { ...base.calendar, ...(o.calendar || {}) };
  out.demoParams = { ...base.demoParams, ...(o.demoParams || {}) };
  out.downtime = Array.isArray(o.downtime) ? o.downtime : base.downtime;
  out.duePolicy = (o.duePolicy && typeof o.duePolicy === 'object') ? o.duePolicy : base.duePolicy;
  out.includedOrderIds = Array.isArray(o.includedOrderIds) ? o.includedOrderIds : base.includedOrderIds;
  if (o.planStart != null && !toDate(o.planStart)) {
    if (notes) notes.push('planStart「' + o.planStart + '」无法解析，已回退默认 ' + base.planStart);
    out.planStart = base.planStart;
  }
  const h = num(o.horizonDays);   // 未提供时为 null，下面 h > 0 为 false → 保持 base.horizonDays
  if (o.horizonDays != null && (!(h > 0) || h > 3650)) {
    if (notes) notes.push('horizonDays「' + o.horizonDays + '」非法（需 0 < N ≤ 3650），已回退默认 ' + base.horizonDays);
    out.horizonDays = base.horizonDays;
  } else if (h > 0) out.horizonDays = Math.round(h);
  /* 未提供时必须**保持默认值**。
   注意：不能写成「else if (w >= 0)」——num(undefined) 是 null，而 null >= 0 为 true，
   会把默认值覆盖成 null，下游再退回到各自的兜底值，导致界面与 CLI 排出不同结果。 */
  if (o.setupWeight == null) {
    out.setupWeight = base.setupWeight;
  } else {
    const w = num(o.setupWeight);
    if (!(w >= 0)) {
      if (notes) notes.push('setupWeight「' + o.setupWeight + '」非法（需 ≥ 0），已回退默认 ' + base.setupWeight);
      out.setupWeight = base.setupWeight;
    } else out.setupWeight = w;
  }
  return out;
}

function normalizeTaskMap(v) {
  if (!v) return new Map();
  if (v instanceof Map) return v;
  if (typeof v === 'object') return new Map(Object.entries(v));
  return new Map();
}

function describeProcess(p, cap) {
  const list = cap.machines[p.key] || [];
  const cap0 = p.capability || {};
  const out = {
    key: p.key, name: p.name, short: p.short,
    machinePrefixes: (p.machinePrefixes || []).slice(),
    machineCount: list.length,
    capability: cap0,
    changeover: p.changeover || null,
    qty: p.qty || null,
    waitLimitHours: p.waitLimitHours ?? 72,
  };
  if (cap0.kind === 'matrix') {
    out.matrix = cap.matrixMeta(p.key) || { key: cap0.matrix || p.key, machineIds: 0, rows: 0, specs: 0 };
  } else {
    const ranges = list.map(m => [num(m.specMin), num(m.specMax)]).filter(x => x[0] != null || x[1] != null);
    out.specRange = ranges.length
      ? { machines: list.length, min: Math.min(...ranges.map(r => (r[0] ?? r[1]))), max: Math.max(...ranges.map(r => (r[1] ?? r[0]))) }
      : { machines: list.length, min: null, max: null };
  }
  return out;
}

function specIndexStats(dataset) {
  const si = dataset.specIndex;
  if (!si || typeof si !== 'object') return { available: false, note: '数据集未提供 specIndex（引擎用产能矩阵的归一化键自行关联）' };
  const closingKeys = Array.isArray(si.closingKeys)
    ? si.closingKeys.length
    : (si.closing && typeof si.closing === 'object' ? Object.keys(si.closing).length : 0);
  return { available: true, closingKeys, orderMatchStats: si.orderMatchStats || null };
}

function fatalModel(e, settings) {
  return { cap: null, chain: DEFAULT_PROCESS_CHAIN, chainKeys: DEFAULT_PROCESS_CHAIN.map(p => p.key), procMap: {},
    legacy: true, jobs: [], blocked: [], excluded: [], history: [], active: [], qtyModel: settings?.qtyModel || {},
    settings, fatal: errText(e) };
}

function degradeSchedule(model, settings, message) {
  return {
    tasks: [], unscheduled: [], model, settings,
    validation: { risks: [], counts: { block: 0, warn: 0, info: 0 }, canConfirm: false, orderStats: new Map() },
    metrics: emptyMetrics(message),
    processKeys: model.chainKeys || [], elapsedMs: 0,
    stats: { orderCount: model.active.length, jobCount: 0, blockedOrders: 0, excludedOrders: 0, historyOrders: 0,
      taskCount: 0, unscheduledTasks: 0, scheduledOrders: 0, unscheduledOrders: 0, makespan: null, totalSetupHours: 0,
      deliveryRate: null, lateOrders: 0, lateHours: 0, machineOccRate: null, machineRunRate: null,
      risks: { block: 0, warn: 0, info: 0 }, canConfirm: false, firstPassMs: 0, totalMs: 0, repairedWaits: 0, movedTasks: 0, improvedTasks: 0 },
    warnings: [message], error: message,
  };
}

function emptyMetrics(message) {
  return { orderCount: 0, scheduledOrders: 0, unscheduledOrders: 0, blockedOrders: 0, excludedOrders: 0, historyOrders: 0,
    deliveryRate: null, onTimeOrders: 0, lateOrders: 0, unknownOrders: 0, lateHours: 0, lateOrderList: [],
    hardRiskCount: 0, hardViolation: 0, hardUnverifiable: 0, taskCount: 0, totalSetupHours: 0,
    machineOccRate: null, machineRunRate: null, machineLoad: [], byProcess: {}, makespan: null,
    planStart: null, windowHours: 0, windowFrom: null, windowTo: null, windowLabel: '—', fullWindowHours: 0,
    delta: null, error: message };
}

function noScheduleValidation() {
  return { risks: [{ id: 'R1', level: 'block', type: '尚未排产', rule: 'R1', title: '尚未排产，无法校验',
      why: '请先调用 schedule()，或把 schedule() 的返回值传给 validate()', fix: '调用 schedule()', target: null }],
    counts: { block: 1, warn: 0, info: 0 }, canConfirm: false, orderStats: new Map(), error: '尚未排产' };
}

/* ---------------- toRows：导出用行数据（唯一拼装处） ---------------- */
const ROW_COLUMNS = {
  plan: [
    { key: 'taskId', header: '任务号' }, { key: 'orderId', header: '订单号' }, { key: 'productName', header: '品名' },
    { key: 'process', header: '工序键' }, { key: 'processName', header: '工序' },
    { key: 'machineId', header: '设备编号' }, { key: 'machineName', header: '设备名称' },
    { key: 'qty', header: '数量', type: 'number' }, { key: 'unit', header: '单位' },
    { key: 'rate', header: '单位产出(米/分)', type: 'decimal' }, { key: 'durationMin', header: '加工分钟', type: 'number' },
    { key: 'setupHours', header: '换型(小时)', type: 'decimal' }, { key: 'setupTier', header: '换型档位' },
    { key: 'specLabel', header: '加工规格' },
    /* 《三工序排产算法设计》§10.1 的可追溯列（前瞻派单填值；按订单排程留空） */
    { key: 'configLabel', header: '配置键' },
    { key: 'readyAt', header: '就绪时间', type: 'datetime' },
    { key: 'prevFinish', header: '上工序结束', type: 'datetime' },
    { key: 'gapMin', header: '工序间隔(min)', type: 'number' },
    { key: 'slackMin', header: '派单交期余量(min)', type: 'number' },
    { key: 'reserveReason', header: '预约原因' },
    { key: 'start', header: '开始', type: 'datetime' }, { key: 'end', header: '结束', type: 'datetime' },
    { key: 'due', header: '交期' }, { key: 'duePolicy', header: '交期政策' },
    { key: 'orderTardyHours', header: '订单延期(小时)', type: 'decimal' },
    { key: 'state', header: '状态' }, { key: 'setupReasons', header: '换型触发字段' },
    { key: 'riskTags', header: '风险标签' },
  ],
  unscheduled: [
    { key: 'orderId', header: '订单号' }, { key: 'process', header: '工序键' }, { key: 'processName', header: '工序' },
    { key: 'qty', header: '数量', type: 'number' }, { key: 'reason', header: '未排原因' },
  ],
  risk: [
    { key: 'id', header: '风险号' }, { key: 'level', header: '级别' }, { key: 'type', header: '类型' },
    { key: 'rule', header: '规则' }, { key: 'orderId', header: '订单号' }, { key: 'machineId', header: '设备' },
    { key: 'title', header: '标题' }, { key: 'why', header: '原因' }, { key: 'fix', header: '修复建议' },
  ],
  load: [
    { key: 'process', header: '工序键' }, { key: 'processName', header: '工序' }, { key: 'machineId', header: '设备编号' },
    { key: 'availH', header: '可用(小时)', type: 'decimal' }, { key: 'runH', header: '加工(小时)', type: 'decimal' },
    { key: 'setupH', header: '换型(小时)', type: 'decimal' }, { key: 'idleH', header: '空闲(小时)', type: 'decimal' },
    { key: 'occRate', header: '占用率(%)', type: 'decimal' }, { key: 'runRate', header: '加工利用率(%)', type: 'decimal' },
  ],
};

function buildRows(kind, r, opts) {
  const model = r.model;
  const chain = model.chain || DEFAULT_PROCESS_CHAIN;
  const procMap = model.procMap || Object.fromEntries(chain.map(p => [p.key, p]));
  const chainIdx = k => chain.findIndex(p => p.key === k);
  const lastKey = chain.length ? chain[chain.length - 1].key : null;
  const orderOf = new Map((model.active || []).map(o => [String(o.id), o]));
  const excludeBlocked = opts.excludeBlockedOrders === true;
  const rows = [];

  if (kind === 'plan') {
    const sched = (r.tasks || []).filter(t => t.scheduled);
    sched.sort((a, b) => a.start - b.start || chainIdx(a.process) - chainIdx(b.process) || String(a.orderId).localeCompare(String(b.orderId)));
    for (const t of sched) {
      const o = orderOf.get(String(t.orderId)) || null;
      if (excludeBlocked && o && model.blocked.some(b => String(b.order.id) === String(t.orderId))) continue;
      const due = o?.due instanceof Date ? o.due : null;
      const tardy = (due && t.process === lastKey) ? Math.max(0, (t.end - due.getTime()) / HOUR) : null;
      rows.push({
        taskId: t.id, orderId: t.orderId, productName: o?.productName ?? '',
        process: t.process, processName: procMap[t.process]?.name || t.process,
        machineId: t.machineId, machineName: t.machineName ?? '',
        qty: t.qty, unit: t.unit, rate: t.rate, durationMin: t.durationMin,
        setupHours: t.setupHours || 0, setupTier: t.setupTier || '', specLabel: t.specLabel || '',
        start: fmtDateTime(t.start), end: fmtDateTime(t.end), startMs: t.start, endMs: t.end,
        due: due ? fmtDateTime(due) : '', duePolicy: duePolicyText(o?.duePolicy),
        orderTardyHours: tardy == null ? '' : round(tardy, 2),
        state: t.frozen ? '执行冻结' : t.locked ? '已锁定' : '计划',
        setupReasons: (t.setupReasons || []).join('；'),
        /* 前瞻派单的可追溯字段（按订单排程没有这些字段 → 留空，不编造） */
        configLabel: t.configLabel || '',
        readyAt: t.readyAt != null ? fmtDateTime(t.readyAt) : '',
        prevFinish: t.prevFinish != null ? fmtDateTime(t.prevFinish) : '',
        gapMin: t.gapMin ?? '',
        slackMin: t.slackMin ?? '',
        reserveReason: t.reserveReason || '',
        riskTags: (t.riskTags || []).join('；'),
      });
    }
  } else if (kind === 'unscheduled') {
    for (const u of (r.unscheduled || [])) {
      rows.push({ orderId: u.orderId, process: u.process, processName: procMap[u.process]?.name || u.process,
        qty: u.qty ?? '', reason: u.reason || '' });
    }
  } else if (kind === 'risk') {
    for (const x of (r.validation?.risks || [])) {
      rows.push({ id: x.id, level: x.level, type: x.type, rule: x.rule || '', orderId: x.orderId || '',
        machineId: x.machineId || '', title: x.title || '', why: x.why || '', fix: x.fix || '' });
    }
  } else if (kind === 'load') {
    for (const m of (r.metrics?.machineLoad || [])) {
      rows.push({ ...m, processName: procMap[m.process]?.name || m.process });
    }
  }

  const meta = {
    kind, generatedAt: stamp(new Date()), planStart: r.settings?.planStart ?? null, horizonDays: r.settings?.horizonDays ?? null,
    processKeys: (model.chainKeys || []).slice(),
    taskCount: (r.tasks || []).filter(t => t.scheduled).length, rowCount: rows.length,
    title: kind === 'plan' ? '排产清单' : kind === 'unscheduled' ? '未排工序' : kind === 'risk' ? '风险清单' : '设备负荷',
  };
  return { kind, columns: ROW_COLUMNS[kind].map(c => ({ ...c })), rows, meta };
}

function emptyRows(kind, message) {
  const k = ROW_COLUMNS[kind] ? kind : 'plan';
  return { kind: k, columns: ROW_COLUMNS[k].map(c => ({ ...c })), rows: [],
    meta: { kind: k, generatedAt: stamp(new Date()), taskCount: 0, rowCount: 0 }, error: message };
}

function duePolicyText(p) {
  if (p === 'hard') return '硬交期（不允许延期）';
  if (p === 'soft') return '软交期（允许宽限）';
  if (p === 'unknown') return '交期政策待确认';
  return p || '';
}

function errText(e) {
  if (!e) return '未知错误';
  const name = e.name || 'Error';
  const msg = e.message || String(e);
  return name + ': ' + msg;
}

/** 任何门面方法都不允许把裸异常抛给调用方：捕获后返回降级结果并带上 error 字段 */
function safe(fn, fallback) {
  try { return fn(); }
  catch (e) {
    const out = (typeof fallback === 'function') ? fallback(e) : { ...(fallback || {}) };
    if (out && typeof out === 'object') {
      out.error = '引擎内部错误（已降级，不抛出）：' + errText(e);
      out.errorName = e?.name || 'Error';
    }
    return out;
  }
}

/* 导出 schema 与工艺链相关能力，外部可单独做数据体检或复用默认工艺链 */
export { validateDataset, formatValidationErrors, DATASET_SCHEMA, SCHEMA_VERSION, chainToProcesses };
export { DEFAULT_PROCESS_CHAIN };
/** 默认排产设置（供 store 与 CLI 复用同一份默认值，避免两处漂移）。 */
export function engineDefaults(dataset, options) {
  return buildDefaults(dataset || { orders: [] }, options || {});
}
