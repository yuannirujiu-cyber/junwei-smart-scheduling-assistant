/* 工艺链定义与解析 —— 可复用引擎的「工序」抽象层
   目标：把原先写死在 rules.js / capacity.js / scheduler.js 里的「拉丝 → 捻股 → 合绳」
   三道工序，抽象成可由 dataset 或 options 注入的工艺链定义，换工厂 / 换赛题时只改数据或配置。

   工艺链条目（ProcessDef）字段：
     key              工序唯一键（任务、产能矩阵、processMap、时间轴 uid 都用它）
     name / short     中文名与短名（界面与文案）
     cls / color      界面样式（可复用引擎不依赖，缺省为空）
     machinePrefixes  设备编号前缀数组，用于从 dataset.machines 里挑选设备
     capability       适配能力：{ kind:'specRange', specField, minField, maxField, speedField }
                                或 { kind:'matrix', matrix }
     changeover       换型判定维度：[{ field, label, unit, numeric }]
     qty              需求量推算：{ from, by, factor, factorModel }（from 指向下游工序 key 或 null=订单数量）
     waitLimitHours   相邻工序等待上限（R6，默认 72）
     desc             工序说明
   本文件不引用任何界面模块，可在 Node 中独立使用。 */
import { num } from '../core/util.js';

/** 内置默认工艺链（拉丝 → 捻股 → 合绳），保持与原 PROCESSES 完全一致的行为与文案 */
export const LEGACY_PROCESS_KEYS = ['drawing', 'stranding', 'closing'];

export const DEFAULT_PROCESS_CHAIN = [
  {
    key: 'drawing', name: '拉丝', short: '拉', cls: 'draw', color: 'var(--p-draw)',
    machinePrefixes: ['81'], desc: '把盘条钢材拉制成规定直径的钢丝',
    capability: { kind: 'specRange', specField: 'specMm', minField: 'specMin', maxField: 'specMax', speedField: 'speedMps' },
    changeover: { dims: [
      { field: 'wireSpec', label: '原料规格', unit: 'mm', numeric: true },
      { field: 'outDia', label: '成品绳径', unit: 'mm', numeric: true },
    ] },
    qty: { from: 'stranding', by: 'wireCount', factorModel: 'drawShrink' },
    waitLimitHours: 72,
  },
  {
    key: 'stranding', name: '捻股', short: '捻', cls: 'strand', color: 'var(--p-strand)',
    machinePrefixes: ['82'], desc: '把多根钢丝捻合成「股」，最耗时工序',
    capability: { kind: 'matrix', matrix: 'stranding' },
    changeover: { dims: [
      { field: 'structure', label: '结构' },
      { field: 'diameter', label: '股径', unit: 'mm', numeric: true },
    ] },
    qty: { from: 'closing', by: 'strandCount', factorModel: 'strandShrink' },
    waitLimitHours: 72,
  },
  {
    key: 'closing', name: '合绳', short: '合', cls: 'close', color: 'var(--p-close)',
    machinePrefixes: ['83'], desc: '把多股捻合成钢丝绳成品，靠近交付端',
    capability: { kind: 'matrix', matrix: 'closing' },
    changeover: { dims: [
      { field: 'structure', label: '结构' },
      { field: 'diameter', label: '绳径', unit: 'mm', numeric: true },
    ] },
    qty: { from: null, factorModel: 'closingFactor' },
    waitLimitHours: 72,
  },
];

const CAP_KINDS = ['specRange', 'matrix'];

/** 是否为内置三工序链（用于保留历史行为：真值走原有代码路径） */
export function isLegacyChain(chain) {
  if (!Array.isArray(chain) || chain.length !== LEGACY_PROCESS_KEYS.length) return false;
  return LEGACY_PROCESS_KEYS.every((k, i) => chain[i] && chain[i].key === k);
}

/** 工艺链 → 界面兼容的 PROCESSES 数组（key/name/short/cls/color/machinePrefix/desc） */
export function chainToProcesses(chain) {
  return (chain || []).map(p => ({
    key: p.key, name: p.name, short: p.short || String(p.name || p.key).slice(0, 1),
    cls: p.cls || '', color: p.color || '', machinePrefix: (p.machinePrefixes || [])[0] || '',
    machinePrefixes: (p.machinePrefixes || []).slice(),
    capability: p.capability, changeover: p.changeover, qty: p.qty,
    waitLimitHours: p.waitLimitHours ?? 72,
    desc: p.desc || '',
  }));
}

/** 工序 key 是否可用于对象键与 uid（避免 ':'、空白等会破坏 uid 拼接的字符） */
function keyIsSafe(k) {
  return typeof k === 'string' && k.length > 0 && !/[\s:,]/.test(k);
}

function inferCapability(raw, key, dataset) {
  const declared = raw && typeof raw.capability === 'object' && raw.capability ? raw.capability : null;
  if (declared && CAP_KINDS.includes(declared.kind)) return declared;
  const list = Array.isArray(dataset?.machines?.[key]) ? dataset.machines[key] : [];
  const looksRange = list.length > 0 && list.some(m => m && (m.specMin != null || m.specMax != null || m.speedMps != null));
  if (looksRange) return { kind: 'specRange', specField: 'specMm', minField: 'specMin', maxField: 'specMax', speedField: 'speedMps', inferred: true };
  return { kind: 'matrix', matrix: key, inferred: true };
}

/** 归一化 + 校验工艺链定义：返回 { chain, errors, warnings }，任何非法输入都转成可读中文条目而不是抛异常 */
export function normalizeProcessChain(raw, dataset) {
  const errors = [], warnings = [];
  if (!Array.isArray(raw)) {
    errors.push({ path: 'processChain', message: '工艺链必须是数组（实际 ' + typeName(raw) + '）' });
    return { chain: [], errors, warnings };
  }
  if (!raw.length) {
    errors.push({ path: 'processChain', message: '工艺链至少要包含 1 道工序' });
    return { chain: [], errors, warnings };
  }
  const seen = new Set();
  const chain = [];
  raw.forEach((item, i) => {
    const at = 'processChain[' + i + ']';
    if (!item || typeof item !== 'object' || Array.isArray(item)) { errors.push({ path: at, message: '工序定义必须是对象（实际 ' + typeName(item) + '）' }); return; }
    if (!keyIsSafe(item.key)) { errors.push({ path: at + '.key', message: '工序 key 必须是非空字符串，且不能包含空白、冒号或逗号（实际 ' + JSON.stringify(item.key) + '）' }); return; }
    if (seen.has(item.key)) { errors.push({ path: at + '.key', message: '工序 key「' + item.key + '」重复，工艺链内必须唯一' }); return; }
    seen.add(item.key);
    if (item.name != null && typeof item.name !== 'string') warnings.push({ path: at + '.name', message: '工序名不是字符串，已回退为 key「' + item.key + '」' });
    const machinePrefixes = Array.isArray(item.machinePrefixes) ? item.machinePrefixes.filter(x => x != null).map(String)
      : item.machinePrefix != null ? [String(item.machinePrefix)] : [];
    if (item.machinePrefixes != null && !Array.isArray(item.machinePrefixes)) warnings.push({ path: at + '.machinePrefixes', message: 'machinePrefixes 不是数组，已按空数组处理' });
    const capability = inferCapability(item, item.key, dataset);
    if (!CAP_KINDS.includes(capability.kind)) { errors.push({ path: at + '.capability.kind', message: 'capability.kind 只能是 specRange 或 matrix（实际 ' + JSON.stringify(capability.kind) + '）' }); return; }
    if (capability.kind === 'matrix') {
      const matrixKey = capability.matrix || item.key;
      const hasCapacityTable = !!(dataset && dataset.capacity && typeof dataset.capacity === 'object' && !Array.isArray(dataset.capacity));
      const hasMatrix = !!(hasCapacityTable && dataset.capacity[matrixKey]);
      /* 整张 capacity 表缺失交给数据集校验报「缺必填表」，这里只报「表在但矩阵键不存在」 */
      if (hasCapacityTable && !hasMatrix) errors.push({ path: at + '.capability.matrix', message: '产能矩阵「' + matrixKey + '」在 dataset.capacity 中不存在（工序 ' + item.key + '）' });
    }
    const changeover = (item.changeover && Array.isArray(item.changeover.dims) && item.changeover.dims.length)
      ? { dims: item.changeover.dims.map(d => ({ field: String(d.field), label: d.label != null ? String(d.label) : String(d.field), unit: d.unit != null ? String(d.unit) : '', numeric: !!d.numeric })) }
      : { dims: defaultDims(capability.kind), inferred: true };
    const qty = (item.qty && typeof item.qty === 'object') ? { ...item.qty } : {};
    const waitLimitHours = num(item.waitLimitHours);
    chain.push({
      key: item.key,
      name: typeof item.name === 'string' && item.name ? item.name : item.key,
      short: typeof item.short === 'string' && item.short ? item.short : String(item.name || item.key).slice(0, 1),
      cls: typeof item.cls === 'string' ? item.cls : '',
      color: typeof item.color === 'string' ? item.color : '',
      machinePrefixes, capability, changeover, qty,
      waitLimitHours: waitLimitHours != null && waitLimitHours > 0 ? waitLimitHours : 72,
      desc: typeof item.desc === 'string' ? item.desc : '',
    });
  });
  return { chain, errors, warnings };
}

function defaultDims(kind) {
  if (kind === 'specRange') return [{ field: 'wireSpec', label: '规格', unit: 'mm', numeric: true }];
  return [{ field: 'structure', label: '结构' }, { field: 'diameter', label: '直径', unit: 'mm', numeric: true }];
}

function typeName(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '数组';
  return typeof v;
}

/**
 * 解析最终工艺链：优先级 options.processChain > options.processes > dataset.processChain > dataset.meta.processChain > 内置默认链
 * @returns {{chain, errors, warnings, source, legacy}}
 */
export function resolveProcessChain(dataset, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  let raw = null, source = 'default';
  /* 显式给出（即使类型不对）就按其解析，好让「工艺链必须是数组」这类错误落到工艺链而不是数据集上 */
  if (opts.processChain !== undefined && opts.processChain !== null) { raw = opts.processChain; source = 'options.processChain'; }
  else if (opts.processes !== undefined && opts.processes !== null) { raw = opts.processes; source = 'options.processes'; }
  else if (dataset?.processChain !== undefined && dataset.processChain !== null) { raw = dataset.processChain; source = 'dataset.processChain'; }
  else if (dataset?.meta?.processChain !== undefined && dataset.meta.processChain !== null) { raw = dataset.meta.processChain; source = 'dataset.meta.processChain'; }
  if (raw == null) { raw = DEFAULT_PROCESS_CHAIN; source = 'default'; }
  const { chain, errors, warnings } = normalizeProcessChain(raw, dataset);
  return { chain, errors, warnings, source, legacy: isLegacyChain(chain) };
}

export function chainIndexOf(chain, key) {
  return (chain || []).findIndex(p => p.key === key);
}
export function chainLastKey(chain) {
  return chain && chain.length ? chain[chain.length - 1].key : null;
}
export function chainNameMap(chain) {
  const m = Object.create(null);
  for (const p of (chain || [])) m[p.key] = p.name || p.key;
  return m;
}
