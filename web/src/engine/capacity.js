/* 产能主数据索引：设备台账（规格区间 / 速度）+ 产能矩阵（含设备适配关系）
   默认三工序（drawing / stranding / closing）走原有索引与判定，行为与历史版本完全一致；
   自定义工艺链（dataset.processChain / options.processChain）走通用索引，支持任意道工序：
     capability.kind = 'specRange' → 设备台账的规格区间 + 速度（米/秒 → 米/分）
     capability.kind = 'matrix'    → 产能矩阵的 rates；无 rates 时用 行捻距 × 设备系数
   矩阵空值（null / 0）与缺失行一律视为「不适配」，绝不补零或补均值（PRD D01 校验规则）。 */
import { num, round } from '../core/util.js';
import { normKey } from './spec.js';
import { resolveProcessChain } from './chain.js';

export function buildCapacity(ds, options = {}) {
  const resolved = resolveProcessChain(ds, options);
  const chain = resolved.chain || [];
  const legacy = resolved.legacy;
  const procMap = Object.create(null);
  for (const p of chain) procMap[p.key] = p;
  const capRaw = ds?.capacity || {};

  const machines = {};
  if (legacy) {
    machines.drawing = (ds?.machines?.drawing || []).map(m => ({ ...m, process: 'drawing', idx: -1 }));
    machines.stranding = (ds?.machines?.stranding || []).map(m => ({ ...m, process: 'stranding', idx: -1 }));
    machines.closing = (ds?.machines?.closing || []).map(m => ({ ...m, process: 'closing', idx: -1 }));
    for (const k of Object.keys(machines)) machines[k].forEach((m, i) => { m.idx = i; m.uid = k + ':' + m.id; });
  } else {
    for (const p of chain) {
      machines[p.key] = collectMachines(ds?.machines, p);
      machines[p.key].forEach((m, i) => { m.idx = i; m.uid = p.key + ':' + m.id; });
    }
  }
  const chainKeys = chain.map(p => p.key);

  /* ---------- 通用矩阵索引（自定义工艺链） ---------- */
  const matrixByProcess = Object.create(null);
  if (!legacy) {
    for (const p of chain) {
      if ((p.capability || {}).kind !== 'matrix') continue;
      const mk = p.capability.matrix || p.key;
      matrixByProcess[p.key] = buildMatrixIndex(mk, capRaw[mk], machines[p.key] || [], p.key);
    }
  }

  /* ---------- 内置三工序索引（原实现，逐行保留） ---------- */
  let stIds = [], stCoef = [], stRows = new Map(), stNameIdx = new Map(), stSpecValues = [];
  let clIds = [], clRows = new Map(), clSpecIdx = new Map(), clRowList = [];
  if (legacy) {
    /* --- 捻股 --- */
    const st = capRaw.stranding || { machineIds: machines.stranding.map(m => m.id), coefficients: [], rows: [] };
    stIds = st.machineIds?.length ? st.machineIds : machines.stranding.map(m => m.id);
    stCoef = st.coefficients || [];
    stRows = new Map();          // key: 品名|规格 → row
    stNameIdx = new Map();       // 品名 → rows[]
    stSpecValues = [];
    const stSpecSeen = new Set();
    for (const r of (st.rows || [])) {
      const row = {
        name: String(r.name ?? ''), spec: String(r.spec ?? ''), torsion: num(r.torsion),
        caps: r.caps ? new Set(r.caps) : null,          // null = 全适配
        capCount: r.capCount ?? (r.caps ? r.caps.length : stIds.length),
        rates: r.rates || null, process: 'stranding',
      };
      row.key = row.name + '|' + row.spec;
      stRows.set(row.key, row);
      if (!stNameIdx.has(row.name)) stNameIdx.set(row.name, []);
      stNameIdx.get(row.name).push(row);
      const sv = num(row.spec);
      if (sv != null && !stSpecSeen.has(sv)) { stSpecSeen.add(sv); stSpecValues.push(sv); }
    }
    stSpecValues.sort((a, b) => a - b);

    /* --- 合绳 --- */
    const cl = capRaw.closing || { machineIds: machines.closing.map(m => m.id), rows: [] };
    clIds = cl.machineIds?.length ? cl.machineIds : machines.closing.map(m => m.id);
    clRows = new Map();
    clSpecIdx = new Map();       // 归一化键 → rows[]
    clRowList = [];
    for (const r of (cl.rows || [])) {
      const rates = (r.rates || []).map(v => (v == null ? null : num(v)));
      const caps = r.caps ? new Set(r.caps) : (r.rates ? new Set(rates.map((v, i) => v != null && v > 0 ? i : -1).filter(i => i >= 0)) : null);
      const row = { name: String(r.name ?? ''), spec: String(r.spec ?? ''), torsion: num(r.torsion),
        rates, caps, capCount: caps ? caps.size : clIds.length, process: 'closing' };
      row.key = row.name + '|' + row.spec;
      if (!clRows.has(row.key)) clRowList.push(row);
      clRows.set(row.key, row);
      clRows.set('spec:' + row.spec, row);
    }
    // 用前端统一的归一化键（绳径 + 结构）建索引，绕开数据快照 mappingKey 的口径差异
    for (const row of clRowList) {
      const k = normKey(row.spec);
      if (!k) continue;
      if (!clSpecIdx.has(k)) clSpecIdx.set(k, []);
      const arr = clSpecIdx.get(k);
      if (!arr.some(x => x.spec === row.spec)) arr.push(row);
    }
  }

  const api = {
    chain, chainKeys, procMap, legacy,
    firstKey: chainKeys[0] || null,
    lastKey: chainKeys.length ? chainKeys[chainKeys.length - 1] : null,
    machines, stIds, clIds, stCoef, stRows, stNameIdx, stSpecValues, clRows, clSpecIdx,
    matrixByProcess,

    clRowList, clSpecIdx,
    /** 按「绳径 + 结构」归一化键取合绳候选（快照 mappingKey 不可靠时以此为准） */
    closingCandidatesByKey(key) { return key ? (clSpecIdx.get(key) || []) : []; },
    /** 通用：按归一化键取某工序的矩阵候选行 */
    matrixCandidatesByKey(process, key) {
      const m = matrixByProcess[process];
      return (m && key) ? (m.byNorm.get(key) || []) : [];
    },
    /** 某工序矩阵的全部去重行（内置三工序回退到原有索引） */
    matrixRowsOf(process) {
      const m = matrixByProcess[process];
      if (m) return m.rows;
      if (process === 'stranding') return [...stRows.values()];
      if (process === 'closing') return clRowList;
      return [];
    },
    /** 矩阵元信息（设备列数 / 行数 / 规格数），内置三工序与通用链都可用 */
    matrixMeta(process) {
      const m = matrixByProcess[process];
      if (m) return { key: m.key, machineIds: m.machineIds.length, rows: m.rows.length, specs: new Set(m.rows.map(r => r.spec)).size };
      if (process === 'stranding') return { key: 'stranding', machineIds: stIds.length, rows: stRows.size, specs: new Set([...stRows.values()].map(r => r.spec)).size };
      if (process === 'closing') return { key: 'closing', machineIds: clIds.length, rows: clRowList.length, specs: new Set(clRowList.map(r => r.spec)).size };
      return null;
    },
    /** 通用：按 品名|规格 或 规格 查矩阵行 */
    findMatrixRow(process, name, spec) {
      const m = matrixByProcess[process];
      if (!m) return null;
      if (name != null && spec != null) { const r = m.byKey.get(String(name) + '|' + String(spec)); if (r) return r; }
      if (spec != null) { const arr = m.bySpec.get(String(spec)); if (arr && arr.length) return arr[0]; }
      return null;
    },
    machineById(process, id) { return (machines[process] || []).find(m => String(m.id) === String(id)) || null; },
    machineUid(process, id) { return process + ':' + id; },
    /** 停机/锁定记录未写工序时的兜底查找：显式工序优先，其后按链序（内置链与历史顺序一致） */
    machineByIdAny(id, process) {
      if (id == null) return null;
      const hit = (p) => (machines[p] || []).find(m => String(m.id) === String(id)) || null;
      if (process && machines[process]) { const m = hit(process); if (m) return m; }
      const prefer = legacy ? ['stranding', 'drawing', 'closing'] : chainKeys;
      for (const p of prefer) { const m = hit(p); if (m) return m; }
      for (const p of Object.keys(machines)) { if (prefer.includes(p)) continue; const m = hit(p); if (m) return m; }
      return null;
    },

    /** 设备—规格适配判定（R1，硬约束） */
    isCapable(process, machine, specCtx) {
      if (!machine) return false;
      const proc = procMap[process];
      if (!legacy && proc) return genericCapable(proc, machine, specCtx);
      if (process === 'drawing') {
        const d = num(specCtx.wireSpecMm);
        if (d == null) return false;
        const lo = machine.specMin, hi = machine.specMax;
        if (lo != null && d < lo - 1e-9) return false;
        if (hi != null && d > hi + 1e-9) return false;
        return true;
      }
      const row = specCtx.row;
      if (!row) return false;
      if (!row.caps) return true;                     // 全适配
      return row.caps.has(machine.idx);
    },

    /** 单位产出（米/分） */
    rateOf(process, machine, specCtx) {
      if (!machine) return null;
      const proc = procMap[process];
      if (!legacy && proc) return genericRateOf(proc, machine, specCtx, matrixByProcess[process]);
      if (process === 'drawing') {
        const v = num(machine.speedMps);
        return v && v > 0 ? round(v * 60, 4) : null;
      }
      const row = specCtx.row; if (!row) return null;
      if (process === 'stranding') {
        if (row.rates) { const v = num(row.rates[machine.idx]); return v && v > 0 ? v : null; }
        const c = num(stCoef[machine.idx]);
        if (row.torsion == null || c == null) return null;
        const v = round(row.torsion * c, 6);
        return v > 0 ? v : null;
      }
      if (process === 'closing') {
        const v = num(row.rates?.[machine.idx]);
        return v && v > 0 ? v : null;
      }
      return null;
    },

    /** 列出某规格可用的机台 + 各自单位产出 */
    capableMachines(process, specCtx) {
      const list = machines[process] || [];
      const out = [];
      for (const m of list) {
        if (!api.isCapable(process, m, specCtx)) continue;
        const rate = api.rateOf(process, m, specCtx);
        if (rate) out.push({ machine: m, rate });
      }
      return out;
    },

    findStrandRow(name, spec) {
      if (name != null && spec != null) {
        const r = stRows.get(name + '|' + String(spec));
        if (r) return r;
      }
      return null;
    },
    findClosingRowBySpec(spec, name) {
      if (name != null) { const r = clRows.get(name + '|' + spec); if (r) return r; }
      return clRows.get('spec:' + spec) || null;
    },
    /** 就近期望股径的捻股行（用于工艺映射自动建议，标注待确认） */
    strandRowsNear(diameter, tolerance = 0.05) {
      const t = num(diameter); if (t == null) return [];
      const res = [];
      for (const [, row] of stRows) { const sv = num(row.spec); if (sv != null && Math.abs(sv - t) <= tolerance) res.push(row); }
      return res;
    },
    strandRowsBySpec(spec) {
      const s = String(spec);
      const res = [];
      for (const [, row] of stRows) if (row.spec === s) res.push(row);
      return res;
    },
    stats() {
      const byProcess = {};
      for (const k of Object.keys(machines)) byProcess[k] = machines[k].length;
      const matrixRows = {};
      for (const k of Object.keys(matrixByProcess)) matrixRows[k] = matrixByProcess[k].rows.length;
      return {
        drawing: (machines.drawing || []).length, stranding: (machines.stranding || []).length, closing: (machines.closing || []).length,
        strandRows: stRows.size, closingRows: clRowList.length,   // clRows 里还有 'spec:' 别名键，用行数组长度才是真实去重行数
        closingSpecs: new Set(clRowList.map(r => r.spec)).size, strandSpecValues: stSpecValues.length,
        byProcess, matrixRows,
      };
    },
  };
  return api;
}

/* ---------------- 通用工艺链辅助 ---------------- */

/** 从 dataset.machines 收集某工序的设备：优先取同名分组，其次按 machinePrefixes 前缀跨组匹配 */
function collectMachines(groups, proc) {
  const out = [];
  const g = groups && groups[proc.key];
  if (Array.isArray(g)) for (const m of g) if (m && typeof m === 'object') out.push({ ...m });
  if (out.length) return out;
  const prefixes = (proc.machinePrefixes || []).map(String);
  if (!prefixes.length) return out;
  const seen = new Set();
  for (const arr of Object.values(groups || {})) {
    if (!Array.isArray(arr)) continue;
    for (const m of arr) {
      if (!m || typeof m !== 'object' || m.id == null) continue;
      const id = String(m.id);
      if (seen.has(id)) continue;
      if (prefixes.some(p => id.startsWith(p))) { seen.add(id); out.push({ ...m }); }
    }
  }
  return out;
}

/** 行列式产能矩阵 → 行索引（null / 0 视为不适配；caps 支持设备编号或下标） */
function buildMatrixIndex(matrixKey, raw, machineList, processKey) {
  const ids = (raw && Array.isArray(raw.machineIds) && raw.machineIds.length) ? raw.machineIds.map(String) : machineList.map(m => String(m.id));
  const coef = Array.isArray(raw?.coefficients) ? raw.coefficients : [];
  const rows = [], byKey = new Map(), bySpec = new Map(), byNorm = new Map();
  for (const r of ((raw && raw.rows) || [])) {
    if (!r || typeof r !== 'object') continue;
    const rates = Array.isArray(r.rates) ? r.rates.map(v => (v == null ? null : num(v))) : null;
    let caps = null;
    if (Array.isArray(r.caps)) caps = new Set(capsToIndex(r.caps, ids));
    else if (rates) caps = new Set(rates.map((v, i) => (v != null && v > 0 ? i : -1)).filter(i => i >= 0));
    const row = {
      name: String(r.name ?? ''), spec: String(r.spec ?? ''), torsion: num(r.torsion),
      caps, capCount: caps ? caps.size : ids.length, rates,
      process: processKey, matrix: matrixKey, machineIds: ids, coefficients: coef, raw: r,
    };
    row.key = row.name + '|' + row.spec;
    if (!byKey.has(row.key)) rows.push(row);
    byKey.set(row.key, row);
    const sv = bySpec.get(row.spec) || []; if (!sv.includes(row)) sv.push(row); bySpec.set(row.spec, sv);
    const nk = normKey(row.spec);
    if (nk) { const nv = byNorm.get(nk) || []; if (!nv.includes(row)) nv.push(row); byNorm.set(nk, nv); }
  }
  return { key: matrixKey, machineIds: ids, coefficients: coef, rows, byKey, bySpec, byNorm };
}

function capsToIndex(caps, ids) {
  const out = [];
  for (const c of caps) {
    if (typeof c === 'number' && Number.isInteger(c)) { if (c >= 0 && c < ids.length) out.push(c); continue; }
    const idx = ids.indexOf(String(c));
    if (idx >= 0) out.push(idx);
  }
  return out;
}

function specMmOf(proc, specCtx) {
  const cap0 = proc.capability || {};
  return num(specCtx?.[cap0.specField || 'specMm'] ?? specCtx?.wireSpecMm ?? specCtx?.specMm);
}

function genericCapable(proc, machine, specCtx) {
  const cap0 = proc.capability || {};
  if (cap0.kind === 'specRange') {
    const d = specMmOf(proc, specCtx);
    if (d == null) return false;
    const lo = machine[cap0.minField || 'specMin'], hi = machine[cap0.maxField || 'specMax'];
    const loN = lo == null ? null : num(lo), hiN = hi == null ? null : num(hi);
    if (loN != null && d < loN - 1e-9) return false;
    if (hiN != null && d > hiN + 1e-9) return false;
    return true;
  }
  const row = specCtx?.row;
  if (!row) return false;
  if (!row.caps) return true;
  return row.caps.has(machine.idx);
}

function genericRateOf(proc, machine, specCtx, matrix) {
  const cap0 = proc.capability || {};
  if (cap0.kind === 'specRange') {
    const v = num(machine[cap0.speedField || 'speedMps']);
    return v && v > 0 ? round(v * 60, 4) : null;
  }
  const row = specCtx?.row;
  if (!row) return null;
  if (row.rates) { const v = num(row.rates[machine.idx]); return v && v > 0 ? v : null; }
  const c = num((matrix?.coefficients || [])[machine.idx]);
  if (row.torsion == null || c == null) return null;
  const v = round(row.torsion * c, 6);
  return v > 0 ? v : null;
}
