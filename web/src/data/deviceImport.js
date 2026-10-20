/* 设备 / 产能文件解析
   对象是《产品额定（平均值）.xlsx》的三张表：
     拉丝           —— 设备台账（设备编号 / 类型 / 规格区间 / 拉丝速度 / 班产量）
     捻股           —— 品名 × 规格 × 各设备「每分钟平均产出米数」矩阵
     合绳（绳子+绳芯）—— 同结构
   产出与 data/dataset.json 完全相同的 machines / capacity 结构，
   交给 store.applyDeviceData 替换快照的设备与产能。

   约定：矩阵空值或非正值一律视为「不适配」，写成 null，绝不补 0 或补均值。 */

const SHEET_ALIASES = {
  drawing: ['拉丝'],
  stranding: ['捻股'],
  closing: ['合绳（绳子+绳芯）', '合绳(绳子+绳芯)', '合绳', '合绳（绳子+绳芯）'],
};
const norm = s => String(s == null ? '' : s).replace(/\s+/g, '').replace(/[（(]/g, '(').replace(/[）)]/g, ')').trim();

export function findDeviceSheets(parsed) {
  const out = { drawing: null, stranding: null, closing: null };
  for (const sheet of (parsed?.sheets || [])) {
    const n = norm(sheet.name);
    for (const key of Object.keys(SHEET_ALIASES)) {
      if (out[key]) continue;
      if (SHEET_ALIASES[key].some(a => norm(a) === n)) out[key] = sheet;
    }
  }
  return out;
}

/** 判断一份工作簿是否「看起来像」设备/产能文件（用于上传时给出可读提示） */
export function looksLikeDeviceWorkbook(parsed) {
  const s = findDeviceSheets(parsed);
  return !!(s.drawing || (s.stranding && s.closing));
}

function headerIndex(header) {
  const idx = {};
  header.forEach((h, i) => { const k = norm(h); if (k && idx[k] === undefined) idx[k] = i; });
  const find = (...names) => { for (const n of names) { const k = norm(n); if (idx[k] !== undefined) return idx[k]; } return -1; };
  return { idx, find };
}

function parseNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ''));
  return isNaN(n) ? null : n;
}

/** 规格区间 "0.4-0.75" / "0.25~0.6" → [min, max] */
export function parseSpecRange(raw) {
  if (raw == null || raw === '') return { specMin: null, specMax: null };
  const m = String(raw).match(/(\d+(?:\.\d+)?)\s*[-~—]\s*(\d+(?:\.\d+)?)/);
  if (!m) return { specMin: null, specMax: null };
  return { specMin: parseFloat(m[1]), specMax: parseFloat(m[2]) };
}

function parseDrawing(sheet, issues) {
  const rows = sheet.rows || [];
  if (!rows.length) { issues.push('「' + sheet.name + '」表为空'); return []; }
  const { find } = headerIndex(rows[0]);
  const cId = find('设备编号');
  const cName = find('设备名称');
  const cType = find('设备类型');
  const cRange = find('规格区间');
  const cSpeed = find('拉丝速度');
  const cDay = find('白班产量');
  const cNight = find('晚班产量');
  const cTotal = find('产量');
  if (cId < 0) { issues.push('「' + sheet.name + '」表找不到「设备编号」列'); return []; }
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const id = String(row[cId] == null ? '' : row[cId]).trim();
    if (!id) continue;
    const range = cRange >= 0 ? String(row[cRange] == null ? '' : row[cRange]) : '';
    const { specMin, specMax } = parseSpecRange(range);
    const speed = cSpeed >= 0 ? parseNumber(row[cSpeed]) : null;
    out.push({
      id, name: cName >= 0 ? row[cName] || null : null, type: cType >= 0 ? row[cType] || null : null,
      specRangeRaw: range || null, specMin, specMax, speedMps: speed,
      dayOutput: cDay >= 0 ? parseNumber(row[cDay]) : null,
      nightOutput: cNight >= 0 ? parseNumber(row[cNight]) : null,
      totalOutput: cTotal >= 0 ? parseNumber(row[cTotal]) : null,
    });
  }
  if (!out.length) issues.push('「' + sheet.name + '」表没有解析到任何设备行');
  if (out.length && out.every(m => m.specMin == null)) issues.push('「' + sheet.name + '」表的「规格区间」全部无法解析，拉丝适配将无法判定');
  if (out.length && out.every(m => m.speedMps == null)) issues.push('「' + sheet.name + '」表的「拉丝速度」全部无法解析，拉丝工时将无法计算');
  return out;
}

function parseMatrix(sheet, issues) {
  const rows = sheet.rows || [];
  if (!rows.length) { issues.push('「' + sheet.name + '」表为空'); return { machineIds: [], rows: [] }; }
  const header = rows[0];
  const { find } = headerIndex(header);
  const cName = find('品名');
  const cSpec = find('规格');
  const cTorsion = find('捻距（平均值）', '捻距(平均值)');
  if (cName < 0 || cSpec < 0) { issues.push('「' + sheet.name + '」表找不到「品名」或「规格」列'); return { machineIds: [], rows: [] }; }
  /* 设备列：表头形如 "8201(每分钟平均产出米数)"，取括号前的设备编号 */
  const machineCols = [];
  header.forEach((h, i) => {
    const t = String(h == null ? '' : h);
    if (t.indexOf('产出米数') < 0) return;
    const m = t.match(/(\d{4,})/);
    if (m) machineCols.push({ id: m[1], col: i });
  });
  const machineIds = machineCols.map(m => m.id);
  if (!machineIds.length) { issues.push('「' + sheet.name + '」表找不到任何设备产出列'); return { machineIds: [], rows: [] }; }
  /* 按 (品名, 规格) 合并重复行。源表中同一 (品名,规格) 会出现多份（不同捻距档位），
     合并规则与 tools/build_dataset.py 的 dedup_rows 完全一致：
       · 首次出现的值优先（不覆盖已有值）；
       · 后续行只用于**回填空缺**——某台机在首次出现行里是空值、在后续行里有值，取该值；
       · 捻距取首个非空值；数值或捻距出现分歧时标记 variantConflict；
       · 记录合并了几份（variants）。
     早期实现直接丢弃后续重复行，导致这些机台被判为「不适配」，排产结果与预置快照不一致。
     空值与非正值一律 null（不适配），不补 0、不补均值——回填只搬真实的存量值。 */
  const merged = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const name = row[cName] == null ? '' : String(row[cName]).trim();
    const spec = row[cSpec] == null ? '' : String(row[cSpec]).trim();
    if (!name && !spec) continue;
    const torsion = cTorsion >= 0 ? parseNumber(row[cTorsion]) : null;
    const vals = machineCols.map(m => { const v = parseNumber(row[m.col]); return (v != null && v > 0) ? v : null; });
    const key = name + '|' + spec;
    const cur = merged.get(key);
    if (!cur) { merged.set(key, { name, spec, torsion, rates: vals, variants: 1, variantConflict: false }); continue; }
    cur.variants += 1;
    if (torsion != null && cur.torsion !== torsion) {
      if (cur.torsion != null) cur.variantConflict = true; else cur.torsion = torsion;
    }
    for (let i = 0; i < vals.length; i++) {
      const v = vals[i];
      if (v == null) continue;
      if (cur.rates[i] == null) cur.rates[i] = v;
      else if (cur.rates[i] !== v) cur.variantConflict = true;
    }
  }
  const out = [];
  for (const row of merged.values()) {
    const capIdx = row.rates.map((v, i) => v != null ? i : -1).filter(i => i >= 0);
    const item = { name: row.name, spec: row.spec, torsion: row.torsion, rates: row.rates,
      caps: capIdx.length === machineIds.length ? undefined : capIdx, capCount: capIdx.length };
    if (row.variants > 1) item.variants = row.variants;
    if (row.variantConflict) item.variantConflict = true;
    out.push(item);
  }
  if (!out.length) issues.push('「' + sheet.name + '」表没有解析到任何规格行');
  const variantKeys = out.filter(r => r.variants > 1).length;
  const conflictKeys = out.filter(r => r.variantConflict).length;
  if (variantKeys) {
    issues.push('「' + sheet.name + '」表有 ' + variantKeys + ' 个 (品名,规格) 出现多份，已按「首次出现值优先、空缺由后续行回填」合并'
      + (conflictKeys ? '；其中 ' + conflictKeys + ' 个键存在数值分歧，已标记 variantConflict 供人工核对' : ''));
  }
  return { machineIds, rows: out };
}

/** 主入口：把已解析的工作簿转成 machines / capacity */
export function parseDeviceWorkbook(parsed) {
  const issues = [];
  const sheets = findDeviceSheets(parsed);
  const drawing = sheets.drawing ? parseDrawing(sheets.drawing, issues) : [];
  const st = sheets.stranding ? parseMatrix(sheets.stranding, issues) : { machineIds: [], rows: [] };
  const cl = sheets.closing ? parseMatrix(sheets.closing, issues) : { machineIds: [], rows: [] };
  if (!sheets.drawing) issues.push('缺少「拉丝」工作表：拉丝设备与适配无法建立');
  if (!sheets.stranding) issues.push('缺少「捻股」工作表：捻股产能矩阵无法建立');
  if (!sheets.closing) issues.push('缺少「合绳」工作表：合绳产能矩阵无法建立');

  const machines = { drawing, stranding: st.machineIds.map(id => ({ id })), closing: cl.machineIds.map(id => ({ id })) };
  const capacity = {
    stranding: { model: 'explicit', unit: '米/分', machineIds: st.machineIds, rows: st.rows },
    closing: { model: 'explicit', unit: '米/分', machineIds: cl.machineIds, rows: cl.rows },
  };
  const stats = { drawing: drawing.length, stranding: st.machineIds.length, closing: cl.machineIds.length,
    strandRows: st.rows.length, closingRows: cl.rows.length };
  return { machines, capacity, stats, issues, sheets: Object.keys(sheets).filter(k => sheets[k]).map(k => sheets[k].name) };
}
