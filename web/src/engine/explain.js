/* 排程结论解释（PRD D04「依据」页签）
   结构固定为：结论 → 具体约束 → 证据 → 可操作入口
   全部由结构化计算结果驱动，不做语言模型的自由发挥 */
import { HOUR, fmtDateTime, fmtDur, round } from '../core/util.js';
import { procName, RULE_MAP } from './rules.js';

const P = { drawing: '拉丝', stranding: '捻股', closing: '合绳' };
const LEGACY_KEYS = ['drawing', 'stranding', 'closing'];

export function explainTask(task, ctx) {
  const { cap, version, settings, model } = ctx;
  /* 工序链：内置三工序走原文案；自定义链按 ProcessDef 的 name 与前后工序解释 */
  const chain = (model?.chain && model.chain.length) ? model.chain : null;
  const chainKeys = chain ? chain.map(p => p.key) : LEGACY_KEYS;
  const procOf = k => (chain ? chain.find(p => p.key === k) : null);
  const pname = k => (procOf(k) || {}).name || P[k] || k;
  const lastKey = chainKeys[chainKeys.length - 1] || 'closing';
  const firstKey = chainKeys[0] || 'drawing';
  const myIdx = chainKeys.indexOf(task.process);
  const prevP = myIdx > 0 ? chainKeys[myIdx - 1] : null;
  const nextP = (myIdx >= 0 && myIdx < chainKeys.length - 1) ? chainKeys[myIdx + 1] : null;
  const order = model?.active?.find(o => o.id === task.orderId)
    || model?.orders?.find?.(o => o.id === task.orderId) || null;
  const m = cap.machineById(task.process, task.machineId);
  const rules = new Set(['R1']);
  const evidence = [];
  const constraints = [];
  const actions = [];

  /* ---- 结论 ---- */
  const conclusion = '订单 ' + task.orderId + ' 的' + pname(task.process) + '任务安排在设备 ' + task.machineId +
    (m?.name ? '（' + m.name + '）' : '') + '，加工 ' + fmtDateTime(task.start) + ' → ' + fmtDateTime(task.end) +
    '，用时 ' + fmtDur(task.durationMin / 60) + '。';

  /* ---- 设备适配（R1）---- */
  const cands = cap.capableMachines(task.process, specCtxOf(task, order));
  const capKind = (procOf(task.process) || {}).capability?.kind;
  evidence.push({ k: '设备适配', v: task.process === 'drawing'
      ? '拉丝机规格区间 ' + (m?.specRangeRaw || '—') + 'mm 覆盖原料 ' + (task.spec?.wireSpec ?? '—') + 'mm'
      : capKind === 'specRange'
        ? pname(task.process) + '设备规格区间 ' + (m?.specRangeRaw || ((m?.specMin ?? '—') + '-' + (m?.specMax ?? '—'))) + 'mm 覆盖 ' + (task.spec?.wireSpec ?? task.spec?.spec ?? '—') + 'mm'
        : '产能矩阵中「' + (task.specLabel || '—') + '」在设备 ' + task.machineId + ' 列有产出值',
    src: (task.process === 'drawing' || capKind === 'specRange') ? pname(task.process) + '设备台账' : '产品额定（平均值）矩阵', rule: 'R1' });
  if (cands.length) evidence.push({ k: '可选机台', v: '共 ' + cands.length + ' 台适配设备，本次评估了 ' + (task.considered ?? '—') + ' 个可行位置', src: '求解过程', rule: 'R1' });
  constraints.push({ rule: 'R1', text: '先按设备型号筛出可加工该规格的机台（矩阵空值=不适配），再选具体机台。' });

  /* ---- 工时（数量 ÷ 单位产出）---- */
  evidence.push({ k: '工时计算', v: task.qty + ' ' + task.unit + ' ÷ ' + task.rate + ' 米/分 = ' + task.durationMin + ' 分钟（向上取整）', src: 'PRD 9.1 口径', rule: null });
  if (task.jobRef?.row) {
    evidence.push({ k: '产能来源', v: task.process === 'stranding'
        ? '捻距均值 ' + (task.jobRef.row.torsion ?? '—') + ' × 设备系数 = ' + task.rate + ' 米/分'
        : task.rate + ' 米/分', src: '产品额定（平均值）', rule: null });
  }

  /* ---- 换型（R3/R4/R5）---- */
  if (task.setupHours > 0) {
    const setupRule = (capKind === 'specRange') ? 'R3' : 'R4';
    rules.add('R5'); rules.add(setupRule);
    evidence.push({ k: '换型占用', v: fmtDur(task.setupHours) + '（' + (task.setupTier || '') + '），起始 ' + fmtDateTime(task.setupStart), src: '演示参数模型（数据包未提供换型耗时矩阵）', rule: setupRule });
    const dimNames = ((procOf(task.process) || {}).changeover?.dims || []).map(d => d.label).join('、');
    constraints.push({ rule: setupRule,
      text: task.process === 'drawing' ? '拉丝：成品和原料有一个不同就要换型。'
        : (task.process === 'stranding' || task.process === 'closing') ? '捻股/合绳：结构和（绳）股径有一个不同就要换型。'
        : pname(task.process) + '：' + (dimNames || '规格维度') + '有一个不同就要换型。' });
    constraints.push({ rule: 'R5', text: '换型耗时 1–5 小时，随规格切换幅度变化。' });
    for (const r of (task.setupReasons || [])) evidence.push({ k: '换型触发字段', v: r, src: '相邻任务规格比对', rule: task.process === 'drawing' ? 'R3' : 'R4' });
  } else {
    evidence.push({ k: '换型', v: '与前一任务规格一致，无需换型', src: '相邻任务规格比对', rule: task.process === 'drawing' ? 'R3' : 'R4' });
  }

  /* ---- 排序依据（R9）---- */
  if (order) {
    rules.add('R9');
    evidence.push({ k: '排序依据', v: '优先级「' + (order.priorityLabel || '普通') + '」→ 预发货日 ' + (order.preShipDate || '—') +
      ' → 订单日期 ' + (order.orderDate || '—') + ' → 订单号 ' + order.id, src: 'R1/R9 稳定排序', rule: 'R9' });
    constraints.push({ rule: 'R9', text: '重点客户、重点订单优先生产；同级按订单日期与订单号稳定排序。' });
    actions.push({ label: '查看订单详情', act: 'openOrder', orderId: order.id });
  }

  /* ---- 交期（R8）---- */
  if (order?.due) {
    const tard = Math.max(0, (task.end - order.due.getTime()) / HOUR);
    rules.add('R8');
    evidence.push({ k: '交期政策', v: order.duePolicy === 'hard' ? '硬交期（不允许延期）' : order.duePolicy === 'soft'
        ? '软交期（允许 ≤' + (order.graceHours || 72) + ' 小时宽限）' : '交期政策待确认（不默认宽限）',
      src: order.duePolicySource || '订单中心补录 / 演示设定', rule: 'R8' });
    if (task.process === lastKey) {
      evidence.push({ k: '交付预测', v: '预计' + pname(task.process) + '完工 ' + fmtDateTime(task.end) + '，承诺交期 ' + fmtDateTime(order.due) +
        (tard > 0 ? '，预计延期 ' + round(tard, 1) + ' 小时' : '，预计准时'), src: 'PRD 4.2 交付预测代理指标', rule: 'R8' });
    }
  }

  /* ---- 前序/工序间隔（R6）---- */
  const chainTasks = version?.tasks?.filter(t => t.orderId === task.orderId && t.scheduled) || [];
  const prev = prevP ? chainTasks.find(t => t.process === prevP) : null;
  const next = nextP ? chainTasks.find(t => t.process === nextP) : null;
  if (prev) {
    const wait = (task.start - prev.end) / HOUR;
    rules.add('R6');
    evidence.push({ k: '前序工序', v: pname(prevP) + ' 于 ' + fmtDateTime(prev.end) + ' 完工（设备 ' + prev.machineId + '），本工序等待 ' + round(wait, 1) + ' 小时', src: '工序链', rule: 'R6' });
    if (wait > 72) constraints.push({ rule: 'R6', text: '等待 ' + round(wait, 1) + ' 小时已超过 72 小时上限，属阻断项。' });
    else constraints.push({ rule: 'R6', text: '相邻工序等待须 ≤ 72 小时；当前 ' + round(wait, 1) + ' 小时，满足。' });
  }
  if (next) evidence.push({ k: '后序工序', v: pname(nextP) + ' 计划于 ' + fmtDateTime(next.start) + ' 开始（设备 ' + next.machineId + '）', src: '工序链', rule: 'R6' });
  if (!next && nextP) evidence.push({ k: '后序工序', v: '尚未安排，交期无法验证', src: '求解结果', rule: null });

  /* ---- 锁定/冻结 ---- */
  if (task.locked) { evidence.push({ k: '人工锁定', v: '该任务已由计划员锁定设备与起止时间，重算时保持不变', src: 'D04 人工干预', rule: null }); actions.push({ label: '解除锁定', act: 'unlock' }); }
  else actions.push({ label: '锁定该任务', act: 'lock' });
  if (task.frozen) evidence.push({ k: '执行冻结', v: '该工序已开工/完工，不可自动移动', src: '在制状态', rule: null });
  if (task.improved) evidence.push({ k: '局部优化', v: '该任务在迟到恢复阶段被调整过 ' + task.improved + ' 次', src: '求解过程', rule: null });
  if (task.alternative) {
    evidence.push({ k: '可比方案', v: '设备 ' + task.alternative.machineId + ' 也可完成，完工时间相差 ' +
      round((task.alternative.end - task.end) / HOUR, 1) + ' 小时，换型 ' + fmtDur(task.alternative.setupHours),
      src: '求解过程的次优候选', rule: null });
    actions.push({ label: '查看设备占用', act: 'locateMachine', process: task.process, machineId: task.machineId });
  }
  if (task.candidateCount != null) evidence.push({ k: '候选机台数', v: task.candidateCount + ' 台', src: '产能矩阵/设备台账', rule: 'R1' });

  /* ---- 学习型提示：不做无证据的因果断言 ---- */
  const caveats = [];
  if (!task.jobRef?.row && task.process !== 'drawing') caveats.push('该任务的产能来源为近似匹配结果，需要核实。');
  if (task.process === firstKey && order && !order.processMap) caveats.push(pname(firstKey) + '规格由推导得到（演示参数），需与工艺部门确认。');

  return {
    conclusion, evidence, constraints, actions, caveats,
    rules: [...rules].filter(Boolean),
    ruleTexts: [...rules].filter(Boolean).map(id => ({ id, ...RULE_MAP[id] })),
  };
}

/** 取任务的产能上下文：优先用求解时记录的原对象，回退时保留 row（否则 isCapable 会因缺 row 直接判不适配）。 */
export function specCtxOf(task, order) {
  if (task.specCtx) return task.specCtx;
  if (task.process === 'drawing') return { wireSpecMm: task.spec?.wireSpec, outSpec: task.spec?.outSpec, outDia: task.spec?.outDia };
  if (task.jobRef?.row) return { row: task.jobRef.row, structure: task.spec?.structure, diameter: task.spec?.diameter };
  return { structure: task.spec?.structure, diameter: task.spec?.diameter };
}

/** 一行式结论，用于甘特悬停与列表 */
export function shortReason(task) {
  const bits = [];
  if (task.setupHours > 0) bits.push('换型 ' + task.setupHours + 'h');
  if (task.locked) bits.push('已锁定');
  if (task.improved) bits.push('已优化');
  return bits.join(' · ') || '按交期优先顺序排入';
}