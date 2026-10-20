/* 规格解析、归一化与工艺映射推导
   订单规格形如： "22mm GT8ZH(8*K26WS+IWRC)" / "9-12mm GT8Z(8*K19S+IWRC)" / "44mm 6*36WS+IWRC"
   合绳矩阵规格形如："22mm GT8ZH(8*K26WS+IWRC)" / "6mm 6*19S+FC"
   捻股矩阵：品名 "光面股0064 1*3 B1"，规格 "0.64"（股径 mm）
*/
import { num, round } from '../core/util.js';

/* 与 tools/build_dataset.py 的 parse_spec 逐条对齐的常量（两条路径必须给出同一份解析结果，
   否则「内置快照」与「界面导入」会对同一张订单算出不同的股数/丝数，进而排出不同的计划）。 */
const RE_SPEC = /^([0-9]+(?:\.[0-9]+)?)mm\s+(.+)$/;
const RE_SPEC_LOOSE = /^([0-9.]+(?:[-~][0-9.]+)?)\s*mm\s*(.*)$/;
const RE_GRADE = /^(GT[0-9]+[A-Z]*)\((.*)\)$/;
/* 绳芯取值域：与 python 的 tag 顺序一致，命中即止 */
const CORE_TAGS = ['PIWRC', 'IWRC', 'PWSC', 'WSC', 'FC'];

/**
 * 解析订单规格。**必须与 tools/build_dataset.py 的 parse_spec 行为一致**（有回归测试逐字段比对）。
 * 关键规则（都是历史漂移点，改动前先看测试）：
 *   · 直径：`12mm 结构`（数字与 mm 之间无空格）；不匹配时退回宽松式，diameterRaw 记为区间原文；
 *   · 牌号：`GT数字字母(...)`，括号内为结构；lay 取牌号末位（'Z' | 'S'，规范值，展示层再转中文）；
 *   · 股数：结构里第一个 `*` **之前**的前导数字——`35W*K7` 的股数是 35（字母后缀是股型标记，不阻断解析）；
 *   · 股型：第一个 `*` 之后、第一个 `+` 之前的部分；
 *   · 绳芯：`+` 之后按 CORE_TAGS 顺序取第一个命中的标签；
 *   · parseOk 只取决于绳径是否解析出来（与 python 一致）。
 */
export function parseSpec(specRaw) {
  const out = { raw: String(specRaw ?? '').trim(), parseOk: false, diameterMm: null, diameterRaw: null,
    grade: null, lay: null, structure: null, strandCount: null, strandConstruction: null, core: null, note: null };
  const raw = out.raw;
  if (!raw) { out.note = '规格为空'; return out; }
  let rest = null;
  const m = RE_SPEC.exec(raw);
  if (m) { out.diameterMm = num(m[1]); rest = m[2].trim(); }
  else {
    const m2 = RE_SPEC_LOOSE.exec(raw);
    if (m2) {
      out.diameterRaw = m2[1];
      rest = String(m2[2] == null ? '' : m2[2]).trim();
      if (/[-~]/.test(out.diameterRaw)) out.note = '直径为区间，需人工确认取值';
    } else { out.diameterRaw = raw; rest = raw; }
  }
  const g = RE_GRADE.exec(rest);
  out.grade = g ? g[1] : null;
  const structure = g ? g[2].trim() : String(rest).trim();
  /* lay 用规范值 'Z' / 'S'，与数据快照一致；中文「右捻(Z)」由 layLabel() 在展示层生成。 */
  if (out.grade) { const last = out.grade.slice(-1); if (last === 'Z' || last === 'S') out.lay = last; }
  if (structure) {
    out.structure = structure;
    const ci = structure.indexOf('+');
    const head = ci >= 0 ? structure.slice(0, ci) : structure;
    const corePart = (ci >= 0 ? structure.slice(ci + 1) : '').trim();
    const si = head.indexOf('*');
    if (si >= 0) {
      const sc = /^([0-9]+)/.exec(head.slice(0, si).trim());
      if (sc) out.strandCount = num(sc[1]);
      out.strandConstruction = head.slice(si + 1).trim() || null;
    }
    const cu = corePart.toUpperCase();
    if (cu) { for (const tag of CORE_TAGS) { if (cu.indexOf(tag) >= 0) { out.core = tag; break; } } }
    if (out.diameterMm != null) out.parseOk = true;
  }
  if (!out.parseOk && !out.note) out.note = '规格无法解析为「直径mm 结构」格式';
  return out;
}

/** 捻向的展示文案（数据层只存 'Z' / 'S'，避免展示文案渗进数据与比较逻辑）。 */
export function layLabel(lay) {
  return lay === 'Z' ? '右捻(Z)' : lay === 'S' ? '左捻(S)' : (lay ? String(lay) : '');
}

/** 归一化键：与数据快照 specIndex 完全一致 */
export function normKey(specRaw) {
  const s = String(specRaw ?? '').trim();
  const m = /^(\d+(?:\.\d+)?)\s*mm\s+(.+)$/i.exec(s);
  if (!m) return null;
  let rest = m[2].trim();
  const g = RE_GRADE.exec(rest);
  if (g) rest = g[2];
  return m[1] + '|' + rest.replace(/\s+/g, '').toUpperCase();
}
export { normKey as normalizeKey };

/** 从股结构文本推断丝数（1+6=7、1*3=3、1+9+9=19、1+7+7/7+14=36） */
export function wireCountOf(strandConstruction) {
  if (!strandConstruction) return null;
  const t = strandConstruction.toUpperCase().replace(/^K/, '');
  const d = t.match(/^(\d+)WS?$/);
  if (d) return num(d[1]);
  if (/^[0-9+*\/xX]+$/.test(t)) {
    return t.split(/[+\/]/).reduce((acc, part) => {
      const p = part.replace(/^\d+\*/, '');
      const v = num(p);
      return acc + (v || 0);
    }, 0) || null;
  }
  return null;
}

/** 几何近似：股径 ≈ 绳径 × sin(π / 股数) */
export function strandDiameterFactor(strandCount) {
  const n = num(strandCount);
  if (!n || n < 2) return null;
  return round(Math.sin(Math.PI / n), 4);
}

/** 就近匹配捻股规格（股径） */
export function nearestStrandSpec(target, values) {
  const t = num(target);
  if (!t || !values?.length) return null;
  let best = null, bd = Infinity;
  for (const v of values) { const d = Math.abs(v - t); if (d < bd) { bd = d; best = v; } }
  return best == null ? null : { value: best, delta: round(bd, 4) };
}

/** 换型幅度评估：返回 { hours, reasons[], dims, tier } —— R3 / R4 / R5
    R5 明确「换型耗时 1–5 小时不等，随规格切换幅度变化」，
    因此用规格关键维度的相对变化率度量幅度，而不是固定取 5 小时。 */
/** 换型耗时模型默认值（可由 D00 排产设置覆盖，接入 changeoverBetween 的第 4 个参数）。
    R5 只规定「1–5 小时、随规格切换幅度变化」，因此这里把区间边界与幅度权重都做成可配置参数。 */
export const DEFAULT_CHANGEOVER_MODEL = {
  minHours: 1,          // 换型耗时下限（R5 下界）
  maxHours: 5,          // 换型耗时上限（R5 上界）
  magnitudeWeight: 4,   // 幅度权重：hours = min + weight × 最大相对变化率
  bothDimsBonus: 0.5,   // 两个维度同时切换的附加耗时
  structuralBonus: 0.5, // 结构/原料类切换的附加耗时
};

export function changeoverBetween(process, a, b, model) {
  if (!a || !b) return { hours: 0, reasons: [], dims: 0, first: true, tier: '首次上机（无前序任务）' };
  const dims = [];
  if (process === 'drawing') {
    // R3：成品和原料有一个不同，就要换型
    if (a.wireSpec !== b.wireSpec) {
      dims.push({ label: '原料规格 ' + shown(a.wireSpec) + ' → ' + shown(b.wireSpec) + ' mm', ratio: ratioOf(a.wireSpec, b.wireSpec) });
    }
    if (a.outDia != null && b.outDia != null) {
      if (a.outDia !== b.outDia) dims.push({ label: '成品绳径 ' + a.outDia + ' → ' + b.outDia + ' mm', ratio: ratioOf(a.outDia, b.outDia) });
    } else if (a.outSpec !== b.outSpec) {
      dims.push({ label: '成品规格 ' + shown(a.outSpec) + ' → ' + shown(b.outSpec), ratio: 1 });
    }
  } else {
    // R4：结构和（绳）股径有一个不同，就要换型
    if (a.structure !== b.structure) dims.push({ label: '结构 ' + shown(a.structure) + ' → ' + shown(b.structure), ratio: 1 });
    if (a.diameter !== b.diameter) {
      dims.push({ label: (process === 'closing' ? '绳径 ' : '股径 ') + shown(a.diameter) + ' → ' + shown(b.diameter) + ' mm', ratio: ratioOf(a.diameter, b.diameter) });
    }
  }
  return finish(dims, model);
}

/** 通用换型判定：按工艺链（ProcessDef）声明的维度比对规格对象。
    自定义工艺链走这条路径；内置三工序仍走 changeoverBetween，行为完全不变。
    dims 项：{ field, label, unit, numeric }，numeric=true 时用相对变化率度量幅度。 */
export function changeoverGeneric(proc, a, b, model) {
  if (!a || !b) return { hours: 0, reasons: [], dims: 0, first: true, tier: '首次上机（无前序任务）' };
  const dims = [];
  for (const d of ((proc && proc.changeover && proc.changeover.dims) || [])) {
    const va = a[d.field], vb = b[d.field];
    if (va === vb) continue;
    if (va == null && vb == null) continue;
    dims.push({
      label: (d.label || d.field) + ' ' + shown(va) + ' → ' + shown(vb) + (d.unit ? ' ' + d.unit : ''),
      ratio: d.numeric ? ratioOf(va, vb) : 1,
    });
  }
  return finish(dims, model);
}

function shown(v) { return v == null || v === '' ? '—' : String(v); }

/** 相对变化率：无法量化（结构类字段）时按满幅 1 处理，保守取大 */
function ratioOf(x, y) {
  const a = Number(x), b = Number(y);
  if (!isFinite(a) || !isFinite(b)) return 1;
  const m = Math.max(Math.abs(a), Math.abs(b));
  if (!(m > 0)) return 1;
  return Math.min(1, Math.abs(a - b) / m);
}

function finish(dims, model) {
  const M = Object.assign({}, DEFAULT_CHANGEOVER_MODEL, model || {});
  if (!dims.length) return { hours: 0, reasons: [], dims: 0, first: false, tier: '同规格连排，无需换型' };
  const maxRatio = Math.max.apply(null, dims.map(d => d.ratio));
  const structural = dims.some(d => d.label.indexOf('结构') === 0 || d.label.indexOf('原料') === 0);
  const raw = M.minHours + M.magnitudeWeight * maxRatio
    + (dims.length > 1 ? M.bothDimsBonus : 0) + (structural ? M.structuralBonus : 0);
  const lo = M.minHours, hi = Math.max(M.minHours, M.maxHours);
  const hours = Math.round(Math.min(hi, Math.max(lo, raw)) * 2) / 2;
  const mag = maxRatio >= 0.6 ? '大幅' : maxRatio >= 0.25 ? '中等幅度' : '小幅';
  return {
    hours,
    reasons: dims.map(d => d.label),
    dims: dims.length,
    first: false,
    tier: (dims.length > 1 ? '双维度切换' : '单维度切换') + ' · ' + mag + '（幅度 ' + Math.round(maxRatio * 100) + '%，模型 ' + lo + '~' + hi + 'h）',
  };
}

/** 首次上机：初始设备规格未知时 conservatively 记为不换型（D00 可切换口径） */
export function changeoverFromInitial(process, taskSpec, initial, model) {
  if (!initial) return { hours: 0, reasons: [], dims: 0, first: true, tier: '初始设备规格未知' };
  return changeoverBetween(process, initial, taskSpec, model);
}