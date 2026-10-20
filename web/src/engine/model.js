/* 由「数据快照 + 排产设置」构建可求解的排产问题模型
   工艺链来自 cap.chain（默认内置三工序）；内置链走 resolveMapping（历史行为不变），
   自定义链走 resolveMappingGeneric，工序数可以是 2 / 3 / 4 …，任务链按工艺链顺序推进。 */
import { num, round, uniqBy } from '../core/util.js';
import { buildCapacity } from './capacity.js';
import { resolveMapping, resolveMappingGeneric, DEFAULT_QTY_MODEL } from './mapping.js';
import { dueBoundary, toDate } from '../core/util.js';
import { DEFAULT_PROCESS_CHAIN, isLegacyChain } from './chain.js';
import { resolveMaterials, checkOrderMaterials, MATERIAL_CATALOG } from './materials.js';

export const PRIORITY_ORDER = { '重点客户': 0, '重点订单': 1, '紧急': 0, '普通': 2 };
export function priorityRank(o) {
  if (o.rush) return -1;
  return PRIORITY_ORDER[o.priority] ?? 2;
}

/** 订单排序键（R1/R9）：优先级 → 预发货日 → 订单日期 → 订单号 */
export function orderSortKey(o) {
  const due = dueBoundary(o.preShipDate)?.getTime() ?? Infinity;
  const od = toDate(o.orderDate)?.getTime() ?? Infinity;
  return [priorityRank(o), due, od, String(o.id)];
}
export function cmpOrder(a, b) {
  const ka = orderSortKey(a), kb = orderSortKey(b);
  for (let i = 0; i < ka.length; i++) { if (ka[i] < kb[i]) return -1; if (ka[i] > kb[i]) return 1; }
  return 0;
}

export function buildModel({ snapshot, settings, cap }) {
  const c = cap || buildCapacity(snapshot);
  const chain = (c.chain && c.chain.length) ? c.chain : DEFAULT_PROCESS_CHAIN;
  const chainKeys = chain.map(p => p.key);
  const procMap = c.procMap || Object.fromEntries(chain.map(p => [p.key, p]));
  const legacy = c.legacy != null ? c.legacy : isLegacyChain(chain);
  const qtyModel = { ...DEFAULT_QTY_MODEL, ...(settings?.qtyModel || {}) };
  /* 材料门禁：人工在「材料库」里把某种原材料标记为「无」时，需要它的订单直接阻断，
     不进入排产（也就不会有后续加工步骤）。默认全部有货，因此不改变既有行为。 */
  const materials = resolveMaterials(settings?.materials, MATERIAL_CATALOG);
  const included = new Set(settings?.includedOrderIds || snapshot.orders.map(o => o.id));
  const excluded = snapshot.orders.filter(o => !included.has(o.id));
  const active = snapshot.orders.filter(o => included.has(o.id) && o.endCode !== '已结束');
  const history = snapshot.orders.filter(o => o.endCode === '已结束');

  const jobs = [], blocked = [], enrichedMap = new Map();
  for (const o of active) {
    const m = legacy
      ? resolveMapping(o, c, { qtyModel, specIndex: snapshot.specIndex, allowDemo: settings?.demoParams?.enabled })
      : resolveMappingGeneric(o, c, { qtyModel, chain, specIndex: snapshot.specIndex, allowDemo: settings?.demoParams?.enabled });
    const opSpecs = legacy ? legacyOpSpecs(m) : (m.ops || []);

    const order = {
      ...o,
      priority: o.priority ?? '普通',
      duePolicy: o.duePolicy ?? settings?.duePolicy?.[o.id] ?? 'unknown',
      graceHours: o.graceHours ?? (o.duePolicy === 'soft' ? 72 : 0),
      priorityLabel: o.priority ?? '普通',
      due: dueBoundary(o.preShipDate),
      dueRaw: o.preShipDate,
      sortKey: orderSortKey(o),
    };
    order.allowLatest = order.due && order.duePolicy === 'soft' ? new Date(order.due.getTime() + (order.graceHours || 0) * 3600000) : order.due;

    enrichedMap.set(o.id, order);
    const gaps = m.gaps.slice();
    /* R7：订单号 / 规格 / 数量 / 交期缺一不可。缺交期的订单必须真正阻断，
       否则会出现「D01 标为阻断、排产却照排并计入交付率分母」的自相矛盾（审查报告 P1-6）。 */
    if (!order.due) gaps.push({ field: '预发货日', why: '交期缺失，无法判定准时性（R7）', fix: '在订单中心补录预发货日，或从 ERP 重新导出', rule: 'R7' });
    /* MAT：缺料门禁（本产品扩展，不属于赛题 R1–R10）。
       判定只用订单自身的品名/规格/绳芯/涂层四个字段，因此订单一导入就能标红。 */
    const mc = checkOrderMaterials(o, materials);
    if (!mc.ok) {
      const names = mc.missing.map((x) => x.name).join('、');
      const why = mc.missing.map((x) => x.name + '（' + x.reason + '）').join('；');
      gaps.push({ field: '原材料', why: '缺料：' + names + ' 当前在材料库中标记为「无」，订单异常，不排产。判定依据：' + why,
        fix: '在「材料库」中把 ' + names + ' 恢复为「有」并登记库存，或核对该订单的材料判定', rule: 'MAT' });
    }
    const orderOps = chainKeys.map(p => opSpecs.find(x => x.process === p)).filter(Boolean);
    const missingProc = chain.filter(p => !orderOps.some(x => x.process === p.key));
    for (const p of missingProc) gaps.push({ field: p.name + '工序', why: '工艺映射不完整，该工序无法排产', fix: '补录工艺映射', rule: 'R1' });

    if (gaps.length) blocked.push({ order, mapping: m, gaps });
    else jobs.push({ order, mapping: m, ops: orderOps });
  }

  return { cap: c, chain, chainKeys, procMap, legacy, jobs, blocked, excluded, history, materials,
    active: active.map(o => enrichedMap.get(o.id) || o), qtyModel, settings };
}

/** 内置三工序的 ops 组装（保持历史字段与顺序） */
function legacyOpSpecs(m) {
  const opSpecs = [];
  /* count = 订单解析出的股数：设计文档 §3.2 的换型配置键要求 (股数, 结构, 股径/绳径)，
     文档 §2.1 规定捻股与合绳初版同取订单解析的 n。缺股数时保持 null，绝不默认 0 股。 */
  const n = m.parse && m.parse.strandCount != null ? m.parse.strandCount : null;
  if (m.closing) opSpecs.push({ process: 'closing', qty: m.qty.closing, specCtx: { row: m.closing.row, diameter: m.closing.diameter, structure: m.closing.structure, spec: m.closing.spec, count: n }, ref: m.closing });
  if (m.stranding) opSpecs.push({ process: 'stranding', qty: m.qty.stranding, specCtx: { row: m.stranding.row, diameter: m.stranding.diameter, structure: m.stranding.structure, spec: m.stranding.spec, count: n }, ref: m.stranding });
  if (m.wire) opSpecs.push({ process: 'drawing', qty: m.qty.drawing, specCtx: { wireSpecMm: m.wire.specMm, outSpec: m.closing?.spec, outDia: m.closing?.diameter ?? null, structure: m.closing?.structure, diameter: m.wire.specMm }, ref: m.wire });
  return opSpecs;
}

/** 计算某工序在指定机台上的加工时长（分钟，保守向上取整） */
export function durationMin(qty, rate) {
  const q = num(qty), r = num(rate);
  if (q == null || !r || r <= 0) return null;
  return Math.ceil(q / r);
}
