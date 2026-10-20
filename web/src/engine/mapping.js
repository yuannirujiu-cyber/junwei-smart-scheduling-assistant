/* 工艺映射：订单成品规格 → 拉丝原料 / 捻股股型 / 合绳规格 + 各工序需求量
   PRD 5.2-5 / Q02：不从成品绳规格臆造物料结构。
   本模块的策略是「自动给出候选 + 明确标注来源」，未确认的一律标记 demo 参数，
   由 D00 的「演示参数模式」显式授权，所有导出文件持续标注。 */
import { num, round } from '../core/util.js';
import { parseSpec, normKey, wireCountOf } from './spec.js';

export const DEFAULT_QTY_MODEL = {
  closingFactor: 1.00,        // 合绳需求量 = 订单米数 × 1.00
  strandShrink: 1.02,         // 捻缩系数
  drawShrink: 1.02,           // 拉丝捻缩/损耗
  defaultWireCount: 19,       // 股结构未知时的丝数缺省值（演示参数）
};

/* 换型模型已统一到 engine/spec.js 的 DEFAULT_CHANGEOVER_MODEL（此处原有第二份同名定义，已删除）。 */
const REMOVED_CHANGEOVER_MODEL_PLACEHOLDER = {
  sameStructure: 1,   // 同结构换径
  structure: 3,       // 结构/原料切换
  both: 5,            // 双维度切换
  initial: 0,         // 首次上机（按初始规格，未知则不换型）
};

/** 股径几何推导：N 股贴合于直径 D 的绳，股径 d ≈ πD/(N+π) */
export function estimateStrandDiameter(ropeDia, strandCount) {
  const D = num(ropeDia), n = num(strandCount);
  if (D == null || !n || n < 2) return null;
  return round(Math.PI * D / (n + Math.PI), 4);
}
/** 单丝直径推导：股径 / sqrt(丝数) */
export function estimateWireDiameter(strandDia, wireCount) {
  const d = num(strandDia), w = num(wireCount);
  if (d == null || !w || w < 1) return null;
  return round(d / Math.sqrt(w), 4);
}

/**
 * 解析一张订单的完整工艺映射
 * @returns {{status, closing, stranding, wire, qty, evidence[], gaps[], substitutes[]}}
 */
export function resolveMapping(order, cap, opts = {}) {
  const qtyModel = { ...DEFAULT_QTY_MODEL, ...(opts.qtyModel || {}) };
  const parse = order.parsed || parseSpec(order.spec);
  const evidence = [], gaps = [], substitutes = [];
  const out = { orderId: order.id, parse, evidence, gaps, substitutes,
    closing: null, stranding: null, wire: null, qty: null, status: 'missing', demoUsed: false };

  /* ---- 1. 合绳规格（订单成品规格即合绳产出，键匹配即可靠）---- */
  let clRow = null, clCandidates = [];
  if (order.processMap?.closingSpec) {
    clRow = cap.findClosingRowBySpec(order.processMap.closingSpec, order.processMap.closingName);
    if (clRow) evidence.push({ k: '合绳规格', v: clRow.spec, src: '工艺映射表（人工确认）', rule: 'R1' });
  }
  if (!clRow) {
    const key = normKey(order.spec);
    clCandidates = cap.closingCandidatesByKey(key).slice();
    if (clCandidates.length === 1) {
      clRow = clCandidates[0];
      evidence.push({ k: '合绳规格', v: clRow.spec, src: '规格归一化自动关联', rule: 'R1' });
    } else if (clCandidates.length > 1) {
      clRow = pickClosingByProduct(clCandidates, order.productName);
      evidence.push({ k: '合绳规格', v: clRow.spec, src: '多候选，按品名相似度选择（待人工确认）', rule: 'R1' });
      out.demoUsed = true;
      substitutes.push({ field: '合绳规格', chosen: clRow.spec, options: clCandidates.map(r => r.spec), why: '数据库中存在多个同规格记录，已按品名择一' });
    }
  }
  if (!clRow) {
    gaps.push({ field: '合绳规格', why: '合绳产能矩阵中没有与「' + (order.spec || '—') + '」匹配的规格记录', fix: '在订单中心补录工艺映射，或替换/补充产能数据文件', rule: 'R1' });
  } else {
    out.closing = { row: clRow, spec: clRow.spec, name: clRow.name, diameter: num(parse.diameterMm), structure: parse.structure };
  }

  /* ---- 2. 捻股股型（无真实映射表，按股径就近 + 结构丝数择优）---- */
  let stRow = null;
  const strandDia = estimateStrandDiameter(parse.diameterMm, parse.strandCount);
  if (order.processMap?.strandName) {
    stRow = cap.findStrandRow(order.processMap.strandName, order.processMap.strandSpec);
    if (stRow) evidence.push({ k: '捻股股型', v: stRow.name + ' / 股径 ' + stRow.spec + 'mm', src: '工艺映射表（人工确认）', rule: 'R1' });
  }
  if (!stRow) {
    const want = num(order.processMap?.strandSpec) ?? strandDia;
    const near = want != null ? cap.strandRowsNear(want, Math.max(0.05, want * 0.08)) : [];
    const wireCount = wireCountOf(parse.strandConstruction);
    let ranked = near.map(r => {
      const rw = wireCountOf(constructionOfStrandName(r.name));
      let sc = Math.abs(num(r.spec) - want);
      if (wireCount && rw) sc += Math.abs(rw - wireCount) * 0.02;
      if (order.coating && r.name.includes('镀锌') === /镀锌/.test(order.coating)) sc -= 0.02;
      return { r, sc, rw };
    }).sort((a, b) => a.sc - b.sc);
    if (!ranked.length) {
      // 放宽到全局最近邻
      ranked = cap.strandRowsBySpec(cap.stSpecValues?.[0]) ? [] : [];
      const all = [];
      for (const [, row] of cap.stRows) { const sv = num(row.spec); if (sv != null) all.push({ r: row, sc: Math.abs(sv - (want ?? 0)) }); }
      all.sort((a, b) => a.sc - b.sc);
      ranked = all.slice(0, 1);
      if (ranked.length) {
        out.demoUsed = true;
        substitutes.push({ field: '捻股股型', chosen: ranked[0].r.name + ' / ' + ranked[0].r.spec + 'mm',
          options: [ranked[0].r.name], why: '产能矩阵中没有与推导股径 ' + (want ?? '—') + 'mm 接近的股型，取全局最近邻（演示参数）' });
      }
    }
    if (ranked.length) {
      stRow = ranked[0].r;
      const exact = near.includes(stRow);
      evidence.push({ k: '捻股股型', v: stRow.name + ' / 股径 ' + stRow.spec + 'mm',
        src: exact ? '按推导股径 ' + want + 'mm 就近关联' : '全局最近邻（演示参数）', rule: 'R1' });
      if (!exact) out.demoUsed = true;
      if (ranked.length > 1) substitutes.push({ field: '捻股股型', chosen: stRow.name,
        options: ranked.slice(0, 4).map(x => x.r.name + ' / ' + x.r.spec + 'mm'), why: '同为就近候选，按丝数/涂层相似度择优' });
    }
  }
  if (!stRow) gaps.push({ field: '捻股股型', why: '无法由订单规格推导出可用的股型记录', fix: '补录工艺映射表（成品规格 → 股型 / 股径）', rule: 'R1' });
  else out.stranding = { row: stRow, spec: stRow.spec, name: stRow.name, diameter: num(stRow.spec), structure: constructionOfStrandName(stRow.name) };

  /* ---- 3. 拉丝原料规格（单丝直径）---- */
  const wireCount = wireCountOf(out.stranding?.structure) || wireCountOf(parse.strandConstruction) || qtyModel.defaultWireCount;
  const strandDiaForWire = num(out.stranding?.spec) ?? strandDia;
  const wireDia = num(order.processMap?.wireSpecMm) ?? estimateWireDiameter(strandDiaForWire, wireCount);
  if (order.processMap?.wireSpecMm) evidence.push({ k: '拉丝原料规格', v: wireDia + 'mm', src: '工艺映射表（人工确认）', rule: 'R1' });
  else if (wireDia != null) { evidence.push({ k: '拉丝原料规格', v: wireDia + 'mm', src: '单丝直径推导 股径/' + wireCount + '^0.5（演示参数）', rule: 'R1' }); out.demoUsed = true; }
  if (wireDia == null) gaps.push({ field: '拉丝原料规格', why: '无法推导单丝直径', fix: '补录工艺映射', rule: 'R1' });
  else {
    out.wire = { specMm: wireDia, wireCount };
    const capable = cap.machines.drawing.filter(m => cap.isCapable('drawing', m, { wireSpecMm: wireDia }));
    if (!capable.length) gaps.push({ field: '拉丝设备适配', why: '没有拉丝机的规格区间可覆盖 ' + wireDia + 'mm', fix: '确认原料规格或补充设备台账', rule: 'R1' });
  }

  /* ---- 4. 各工序需求量 ---- */
  const base = num(order.qtyMeters);
  const nStrand = num(parse.strandCount) || 1;
  const closed = base != null ? round(base * qtyModel.closingFactor, 2) : null;
  const stranded = closed != null ? round(closed * nStrand * qtyModel.strandShrink, 2) : null;
  const drawn = stranded != null ? round(stranded * wireCount * qtyModel.drawShrink, 2) : null;
  out.qty = { closing: closed, stranding: stranded, drawing: drawn, unit: order.qtyMetersUnit || '米',
    formula: '合绳 ' + (closed ?? '—') + ' 米 = 订单米数×' + qtyModel.closingFactor +
      '；捻股 = 合绳×股数' + nStrand + '×捻缩' + qtyModel.strandShrink +
      '；拉丝 = 捻股×丝数' + wireCount + '×' + qtyModel.drawShrink };
  if (base == null) gaps.push({ field: '订单数量', why: '业务数量缺失或非正', fix: '补录业务数量与单位', rule: 'R7' });

  /* ---- 状态判定 ---- */
  if (gaps.length) out.status = 'missing';
  else if (out.demoUsed) out.status = 'derived';
  else out.status = 'confirmed';
  return out;
}

/* ==================================================================
   通用工艺链映射（自定义工序数 / 自定义工序 key 时使用）
   内置三工序仍走上面的 resolveMapping —— 行为与历史版本完全一致。
   通用路径的解析优先级（可解释、不臆造）：
     1) order.processMap[工序key].spec / .name / .specMm —— 人工确认，最高优先
     2) 订单规格归一化键与该工序产能矩阵行匹配；唯一命中才自动关联，多命中取首行并标注待确认
     3) 该工序矩阵只有一个规格时取唯一候选（标注演示参数）
     specRange 工序：读 processMap[key].specMm；工序声明 specFrom:'orderDiameter' 时用订单直径推导
   需求量：从末道工序（产出 = 订单数量）沿链逆推，factor / by / factorModel 见 chain.js 的 qty 定义。
   ================================================================== */

export function resolveMappingGeneric(order, cap, opts = {}) {
  const chain = opts.chain || cap?.chain || [];
  const qtyModel = { ...DEFAULT_QTY_MODEL, ...(opts.qtyModel || {}) };
  const parse = order.parsed || parseSpec(order.spec);
  const evidence = [], gaps = [], substitutes = [];
  const out = { orderId: order.id, parse, evidence, gaps, substitutes,
    perProcess: Object.create(null), ops: [], status: 'missing', demoUsed: false };
  const pmOf = k => (order.processMap && typeof order.processMap === 'object'
    && order.processMap[k] && typeof order.processMap[k] === 'object') ? order.processMap[k] : null;
  const orderKey = normKey(order.spec);

  /* ---- 1. 逐工序解析加工规格 ---- */
  for (const proc of chain) {
    const cap0 = proc.capability || { kind: 'matrix' };
    const pm = pmOf(proc.key);
    const entry = { process: proc.key, name: proc.name, row: null, spec: null, specMm: null, label: null, source: null, qty: null };
    if (cap0.kind === 'specRange') {
      let mm = num(pm?.specMm);
      if (mm == null && pm?.spec != null) mm = num(pm.spec);
      let src = '工艺映射表（人工确认）';
      if (mm == null && proc.specFrom === 'orderDiameter') { mm = num(parse.diameterMm); src = '由订单成品直径推导（演示参数）'; out.demoUsed = true; }
      if (mm == null) {
        gaps.push({ field: proc.name + '规格', why: '工序「' + proc.name + '」按设备规格区间加工，但订单未给出该工序的加工规格',
          fix: '在订单工艺映射中补录 processMap.' + proc.key + '.specMm', rule: 'R1' });
      } else {
        entry.specMm = mm; entry.spec = mm; entry.label = mm + 'mm'; entry.source = src;
        evidence.push({ k: proc.name + '规格', v: mm + 'mm', src, rule: 'R1' });
      }
    } else {
      let row = null, src = null;
      if (pm?.spec != null) {
        row = cap.findMatrixRow(proc.key, pm.name, pm.spec);
        if (row) { src = '工艺映射表（人工确认）'; evidence.push({ k: proc.name + '规格', v: row.spec, src, rule: 'R1' }); }
      }
      if (!row && orderKey) {
        const cands = cap.matrixCandidatesByKey(proc.key, orderKey).slice();
        if (cands.length === 1) {
          row = cands[0]; src = '规格归一化自动关联';
          evidence.push({ k: proc.name + '规格', v: row.spec, src, rule: 'R1' });
        } else if (cands.length > 1) {
          row = cands[0]; src = '多候选，按矩阵首行选择（待人工确认）'; out.demoUsed = true;
          substitutes.push({ field: proc.name + '规格', chosen: row.spec, options: cands.map(r => r.spec), why: '数据库中存在多个同规格记录' });
          evidence.push({ k: proc.name + '规格', v: row.spec, src, rule: 'R1' });
        }
      }
      if (!row) {
        const rows = cap.matrixRowsOf(proc.key);
        const specs = [...new Set(rows.map(r => r.spec))];
        if (rows.length && specs.length === 1) {
          row = rows[0]; src = '矩阵只有一个规格，取唯一候选（演示参数）'; out.demoUsed = true;
          substitutes.push({ field: proc.name + '规格', chosen: row.spec, options: [row.spec], why: '该工序矩阵只有一个规格，无法按订单规格区分' });
          evidence.push({ k: proc.name + '规格', v: row.spec, src, rule: 'R1' });
        }
      }
      if (!row) {
        gaps.push({ field: proc.name + '规格', why: '产能矩阵「' + (cap0.matrix || proc.key) + '」没有与「' + (order.spec || '—') + '」匹配的记录，也无法由订单规格自动关联',
          fix: '补录 processMap.' + proc.key + '.spec，或替换/补充产能数据文件', rule: 'R1' });
      } else {
        entry.row = row; entry.spec = row.spec; entry.label = row.spec; entry.source = src;
      }
    }
    out.perProcess[proc.key] = entry;
  }

  /* ---- 2. 需求量：末道工序 = 订单数量，向前逆推 ---- */
  const base = num(order.qtyMeters);
  /* 丝数优先取订单结构，其次取「股型行名」里的结构（如「光面股0064 1*7 B1」→ 8 丝），最后才用缺省值 */
  let wireCount = wireCountOf(parse.strandConstruction);
  if (wireCount == null) {
    for (const proc of chain) {
      const e2 = out.perProcess[proc.key];
      if (e2 && e2.row && e2.row.name) { const w = wireCountOf(constructionOfStrandName(e2.row.name)); if (w) { wireCount = w; break; } }
    }
  }
  if (wireCount == null) wireCount = qtyModel.defaultWireCount;
  const strandCount = num(parse.strandCount) || 1;
  for (let i = chain.length - 1; i >= 0; i--) {
    const proc = chain[i];
    const entry = out.perProcess[proc.key];
    const q = proc.qty || {};
    const fromQty = (q.from && out.perProcess[q.from]) ? out.perProcess[q.from].qty : base;
    const by = q.by === 'wireCount' ? wireCount : q.by === 'strandCount' ? strandCount : 1;
    const factor = num(q.factor) ?? (q.factorModel != null ? (num(qtyModel[q.factorModel]) ?? 1) : 1);
    if (fromQty == null) continue;
    entry.qty = round(fromQty * factor * by, 2);
  }
  if (base == null || base <= 0) gaps.push({ field: '订单数量', why: '业务数量缺失或非正', fix: '补录业务数量与单位', rule: 'R7' });
  for (const proc of chain) {
    const entry = out.perProcess[proc.key];
    if (entry.qty != null && entry.qty <= 0) {
      gaps.push({ field: proc.name + '数量', why: '工序「' + proc.name + '」推算需求量为 ' + entry.qty + '，无法加工', fix: '核对数量模型与订单数量', rule: 'R7' });
    }
  }

  /* ---- 3. 设备适配检查 + 组装可求解 ops（链序） ---- */
  if (!gaps.length) {
    for (const proc of chain) {
      const entry = out.perProcess[proc.key];
      const specCtx = buildSpecCtx(proc, entry, parse);
      if (!cap.capableMachines(proc.key, specCtx).length) {
        gaps.push({ field: proc.name + '设备适配', why: '没有设备可按「' + entry.label + '」加工（产能矩阵空值/零值视为不适配，R1）',
          fix: '确认该工序规格，或补充设备台账 / 产能矩阵', rule: 'R1' });
      }
      out.ops.push({ process: proc.key, qty: entry.qty, specCtx, spec: specObjOf(proc, entry, parse),
        ref: entry.row ? { row: entry.row, spec: entry.spec, name: entry.row.name } : { specMm: entry.specMm } });
    }
  }

  if (gaps.length) { out.status = 'missing'; out.ops = []; }
  else if (out.demoUsed) out.status = 'derived';
  else out.status = 'confirmed';
  return out;
}

/** 工序规格上下文：供 capacity.isCapable / rateOf 使用 */
function buildSpecCtx(proc, entry, parse) {
  const cap0 = proc.capability || {};
  if (cap0.kind === 'specRange') {
    return { specMm: entry.specMm, wireSpecMm: entry.specMm, outSpec: null, outDia: num(parse.diameterMm),
      structure: parse.structure, diameter: num(parse.diameterMm), row: null, specText: entry.label };
  }
  return { row: entry.row, spec: entry.spec, structure: parse.structure,
    diameter: num(entry.spec) ?? num(parse.diameterMm), specText: entry.spec };
}

/** 换型比对用的规格对象：字段名对应工艺链 changeover.dims */
function specObjOf(proc, entry, parse) {
  const cap0 = proc.capability || {};
  if (cap0.kind === 'specRange') {
    return { wireSpec: entry.specMm, specMm: entry.specMm, outDia: num(parse.diameterMm),
      structure: parse.structure, diameter: num(parse.diameterMm), label: entry.label };
  }
  return { structure: parse.structure, diameter: num(entry.spec) ?? num(parse.diameterMm),
    spec: entry.spec, name: entry.row ? entry.row.name : null, label: entry.label };
}

function constructionOfStrandName(name) {
  const m = /\s(\S+)\s+B\d+\s*$/.exec(String(name || ''));
  return m ? m[1] : null;
}
function pickClosingByProduct(cands, productName) {
  if (!productName) return cands[0];
  const score = r => {
    let s = 0;
    if (r.name === productName) s += 10;
    if (productName.includes(r.name) || r.name.includes(productName)) s += 6;
    for (const k of ['压实', '圆股', '注塑', '涂塑', '不锈', '镀锌', '光面'])
      if (productName.includes(k) && r.name.includes(k)) s += 2;
    return s;
  };
  return cands.slice().sort((a, b) => score(b) - score(a))[0];
}