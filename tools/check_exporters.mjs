/* 导出器集成自检：用真实版本对象调用四类导出，并对**产物字节**做独立校验。

   审查报告 §六 / §5.2 指出的问题与本次修正：
   - 原 :75 的 typeof r === 'boolean' 恒真（exportGanttPNG 吞异常返回 false），PNG 从未被校验；
     现在真实校验 PNG 字节：签名 + IHDR 宽高 + **全部 chunk 的 CRC32** + 至少一个 IDAT 可解压；
     环境无 Canvas 2D 时**明确标记 SKIP 而不是通过**，另附 PNG 校验器自检（合法接受 / 各类损坏拒绝）。
   - 原 :82 的 text.includes('V1') || b0.includes(Buffer.from('V1')) 是同一测试写两遍；
     现在解压（本写入器用 STORE，必要时 inflate）工作表 XML，断言版本号与「模拟参数标识」字符串真的在其中。
   - 原 :53 的「排产清单(筛选)」没传 filter，与「全部」是同一份数据；
     现在传 工序=捻股 的真实筛选，并用 XML 行数断言两次导出行数确实不同、差值等于被筛掉的任务数。
   - 顺带用独立 CRC32 复核每个 ZIP 条目的 CRC（不只是 magic 字节 + 体积）。 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import zlib from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const captured = [];
function stubEl(tag = 'div') {
  return { tagName: tag, innerHTML: '', textContent: '', className: '', style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, appendChild() {}, removeChild() {}, remove() {}, click() {},
    querySelector() { return stubEl(); }, querySelectorAll() { return []; }, contains() { return false; }, closest() { return null; } };
}
globalThis.document = { createElement: (t) => stubEl(t), querySelector: () => stubEl(), body: stubEl('body'), addEventListener() {} };
globalThis.window = globalThis;
globalThis.URL.createObjectURL = (blob) => { captured.push(blob); return 'blob:stub/' + captured.length; };
globalThis.URL.revokeObjectURL = () => {};
globalThis.Blob = globalThis.Blob || (await import('node:buffer')).Blob;

const { buildCapacity } = await import(resolve(ROOT, 'web/src/engine/capacity.js'));
const { buildModel } = await import(resolve(ROOT, 'web/src/engine/model.js'));
const { runSchedule, improveSchedule } = await import(resolve(ROOT, 'web/src/engine/scheduler.js'));
const { validateSchedule } = await import(resolve(ROOT, 'web/src/engine/validate.js'));
const { computeMetrics } = await import(resolve(ROOT, 'web/src/engine/metrics.js'));
const EX = await import(resolve(ROOT, 'web/src/export/exporters.js'));

let pass = 0, fail = 0, skip = 0;
const ok = (n, c, e = '') => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n + (e ? ' :: ' + e : '')); } };
const skipNote = (n) => { skip++; console.log('  SKIP: ' + n); };
const buf = async (b) => Buffer.from(await b.arrayBuffer());

/* ---------------- 独立 CRC32（不复用被测实现） ---------------- */
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(bytes) { let c = 0xFFFFFFFF; for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }

/* ---------------- PNG 结构校验（签名 + IHDR + 全部 chunk CRC + IDAT 可解压） ---------------- */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
function validatePng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 8 + 25) return { ok: false, why: '字节长度不足（' + (bytes ? bytes.length : 0) + '）' };
  if (!bytes.subarray(0, 8).equals(PNG_SIG)) return { ok: false, why: '签名不符：' + bytes.subarray(0, 8).toString('hex') };
  let off = 8, chunks = 0, idat = [], ihdr = null, sawIend = false;
  while (off + 12 <= bytes.length) {
    const len = bytes.readUInt32BE(off);
    const type = bytes.toString('latin1', off + 4, off + 8);
    if (off + 12 + len > bytes.length) return { ok: false, why: 'chunk ' + type + ' 声明长度 ' + len + ' 超出文件末尾' };
    const data = bytes.subarray(off + 8, off + 8 + len);
    const want = bytes.readUInt32BE(off + 8 + len);
    const got = crc32(bytes.subarray(off + 4, off + 8 + len));
    if (want !== got) return { ok: false, why: 'chunk ' + type + ' CRC32 不符：文件 0x' + want.toString(16) + ' vs 实算 0x' + got.toString(16) };
    chunks++;
    if (chunks === 1 && type !== 'IHDR') return { ok: false, why: '首个 chunk 不是 IHDR 而是 ' + type };
    if (type === 'IHDR') {
      if (len !== 13) return { ok: false, why: 'IHDR 长度 ' + len + ' != 13' };
      ihdr = { width: data.readUInt32BE(0), height: data.readUInt32BE(4), depth: data[8], color: data[9] };
    }
    if (type === 'IDAT') idat.push(data);
    off += 12 + len;
    if (type === 'IEND') { sawIend = true; break; }
  }
  if (!ihdr) return { ok: false, why: '缺少 IHDR' };
  if (!(ihdr.width > 0 && ihdr.height > 0)) return { ok: false, why: 'IHDR 宽高非法 ' + ihdr.width + 'x' + ihdr.height };
  if (!sawIend) return { ok: false, why: '未到达 IEND（文件被截断）' };
  if (off !== bytes.length) return { ok: false, why: 'IEND 之后还有 ' + (bytes.length - off) + ' 字节多余数据' };
  if (!idat.length) return { ok: false, why: '没有 IDAT 数据块' };
  const merged = Buffer.concat(idat);
  let inflated;
  try { inflated = zlib.inflateSync(merged); } catch (e) { return { ok: false, why: 'IDAT 无法解压：' + e.message }; }
  const expect = (Math.ceil(ihdr.width * (ihdr.color === 6 ? 4 : ihdr.color === 2 ? 3 : 1) / 1) + 1) * ihdr.height;
  if (inflated.length < expect) return { ok: false, why: 'IDAT 解压后 ' + inflated.length + ' 字节 < 期望至少 ' + expect + ' 字节' };
  return { ok: true, why: '', width: ihdr.width, height: ihdr.height, chunks, inflated: inflated.length };
}
/** 自造合法 PNG（用于证明校验器本身不是恒真） */
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'latin1');
  const c = Buffer.alloc(4); c.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, c]);
}
function makeTestPng(w, h, idatOverride) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc(h * (1 + w * 4));
  const idat = idatOverride || zlib.deflateSync(raw);
  return Buffer.concat([PNG_SIG, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

/* ---------------- ZIP 读取（STORE / DEFLATE，含 CRC 复核） ---------------- */
function readZip(b) {
  let eocd = -1;
  const floor = Math.max(0, b.length - 22 - 65535);
  for (let i = b.length - 22; i >= floor; i--) if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error('未找到 ZIP EOCD');
  const count = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    if (b.readUInt32LE(off) !== 0x02014b50) throw new Error('中央目录记录损坏 @' + off);
    const method = b.readUInt16LE(off + 10);
    const crc = b.readUInt32LE(off + 16);
    const csize = b.readUInt32LE(off + 20);
    const usize = b.readUInt32LE(off + 24);
    const nameLen = b.readUInt16LE(off + 28), extraLen = b.readUInt16LE(off + 30), cmtLen = b.readUInt16LE(off + 32);
    const localOff = b.readUInt32LE(off + 42);
    const name = b.toString('utf8', off + 46, off + 46 + nameLen);
    if (b.readUInt32LE(localOff) !== 0x04034b50) throw new Error('本地文件头损坏：' + name);
    const lnameLen = b.readUInt16LE(localOff + 26), lextraLen = b.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lnameLen + lextraLen;
    const stored = b.subarray(dataStart, dataStart + csize);
    let data;
    if (method === 0) data = Buffer.from(stored);
    else if (method === 8) data = zlib.inflateRawSync(stored);
    else throw new Error('不支持的压缩方法 ' + method + '：' + name);
    entries.set(name, { method, crc, csize, usize, data });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}
const sheetXml = (zip, i) => {
  const k = 'xl/worksheets/sheet' + i + '.xml';
  if (!zip.has(k)) throw new Error('缺少工作表部件 ' + k);
  return zip.get(k).data.toString('utf8');
};
const countRows = (xml) => (xml.match(/<row\b/g) || []).length;

/* ---------------- 真实版本对象 ---------------- */
const ds = JSON.parse(await readFile(resolve(ROOT, 'data/demo-dataset.json'), 'utf8'));
const snapshot = { meta: ds.meta, orders: ds.orders, machines: ds.machines, capacity: ds.capacity, specIndex: ds.specIndex, simulationPresets: ds.simulationPresets || null };
const settings = { planName: '导出自检', planStart: '2026-09-21T00:00', horizonDays: 60, setupWeight: 0.5,
  changeoverModel: { sameStructure: 1, structure: 3, both: 5, initial: 0 },
  qtyModel: { closingFactor: 1, strandShrink: 1.02, drawShrink: 1.02, defaultWireCount: 19 },
  demoParams: { enabled: true, reason: '自检', operator: '自检' }, includedOrderIds: null, downtime: [], duePolicy: {}, priority: {} };
const cap = buildCapacity(snapshot);
const model = buildModel({ snapshot, settings, cap });
const s1 = runSchedule({ model, settings, horizonDays: 60 });
const s2 = improveSchedule({ model, settings, tasks: s1.tasks, horizonDays: 60 });
const validation = validateSchedule({ model, tasks: s2.tasks, unscheduled: s1.unscheduled, settings, horizonDays: 60 });
const metrics = computeMetrics({ model, tasks: s2.tasks, unscheduled: s1.unscheduled, validation, settings, horizonDays: 60 });
const version = { id: 'V1', name: '导出自检版本', status: 'draft', simulated: true, baselineId: null,
  createdAt: '2026-09-19 10:00', createdBy: '自检', dataVersion: snapshot.meta.name, settings, model,
  tasks: s2.tasks, unscheduled: s1.unscheduled, validation, metrics,
  excludedOrders: [], blockedOrders: model.blocked.map(b => ({ orderId: b.order.id, gaps: b.gaps })), changes: [], logs: {} };

/* ---------------- PNG 校验器自检（证明断言不是恒真） ---------------- */
const goodPng = makeTestPng(16, 8);
const goodV = validatePng(goodPng);
ok('PNG 校验器接受合法 PNG', goodV.ok, goodV.why);
const crcBad = Buffer.from(goodPng); crcBad[crcBad.length - 5] ^= 0xFF;
ok('PNG 校验器拒绝 CRC 被篡改的 PNG', !validatePng(crcBad).ok, validatePng(crcBad).why);
const truncated = goodPng.subarray(0, goodPng.length - 6);
ok('PNG 校验器拒绝被截断的 PNG', !validatePng(truncated).ok, validatePng(truncated).why);
const sigBad = Buffer.from(goodPng); sigBad[1] = 0x00;
ok('PNG 校验器拒绝签名错误的 PNG', !validatePng(sigBad).ok, validatePng(sigBad).why);
const idatBad = makeTestPng(16, 8, Buffer.from([0x00, 0x01, 0x02, 0x03]));
ok('PNG 校验器拒绝 IDAT 不可解压的 PNG', !validatePng(idatBad).ok, validatePng(idatBad).why);

/* ---------------- 四类导出 ---------------- */
ok('导出函数齐全', ['exportPlanXlsx', 'exportWorkOrdersXlsx', 'exportRisksXlsx', 'exportGanttPNG'].every(k => typeof EX[k] === 'function'),
  Object.keys(EX).join(','));

const produced = [];
async function runExport(name, fn) {
  const before = captured.length;
  try {
    await fn();
    const got = captured.slice(before);
    ok(name + ' 产出 Blob', got.length >= 1, '捕获 ' + got.length + ' 个');
    if (got.length) produced.push({ name, blob: got[0] });
    return got[0] || null;
  } catch (e) { fail++; console.log('  FAIL: ' + name + ' 抛异常 :: ' + e.message); return null; }
}
/* 真实筛选：工序=捻股（scope=filtered 时必须真的改变行数） */
const FILTER = { process: 'stranding', keyword: '', onlyRisk: false };
const planAllBlob = await runExport('排产清单(全部)', () => EX.exportPlanXlsx(version, snapshot, { scope: 'all' }));
const planFilteredBlob = await runExport('排产清单(筛选 工序=捻股)', () => EX.exportPlanXlsx(version, snapshot, { scope: 'filtered', filter: FILTER }));
await runExport('工单(全部)', () => EX.exportWorkOrdersXlsx(version, snapshot, { scope: 'all' }));
await runExport('风险清单', () => EX.exportRisksXlsx(version));

const xlsxBlobs = captured.filter(b => String(b.type).includes('spreadsheet'));
ok('至少 4 个 xlsx Blob', xlsxBlobs.length >= 4, 'got ' + xlsxBlobs.length);
for (let i = 0; i < xlsxBlobs.length; i++) {
  const b = await buf(xlsxBlobs[i]);
  ok('xlsx#' + i + ' ZIP 签名', b[0] === 0x50 && b[1] === 0x4B, 'magic=' + b.slice(0, 2).toString('hex'));
  ok('xlsx#' + i + ' 体积合理', b.length > 3000, b.length + 'B');
  let zip = null, err = null;
  try { zip = readZip(b); } catch (e) { err = e; }
  ok('xlsx#' + i + ' ZIP 结构与中央目录可解析', !!zip, err ? err.message : '');
  if (!zip) continue;
  let crcBad2 = 0, sizeBad = 0;
  for (const [, e] of zip) { if (crc32(e.data) !== e.crc) crcBad2++; if (e.data.length !== e.usize) sizeBad++; }
  ok('xlsx#' + i + ' 各条目 CRC32 与原始大小均相符', crcBad2 === 0 && sizeBad === 0, crcBad2 + ' 个 CRC 不符 / ' + sizeBad + ' 个大小不符');
  ok('xlsx#' + i + ' 含必要部件', ['[Content_Types].xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml'].every(n => zip.has(n)),
    [...zip.keys()].length + ' 个条目');
}

/* 模拟参数标识与版本号必须出现在**解压后的工作表 XML** 里 */
if (planAllBlob) {
  const zip = readZip(await buf(planAllBlob));
  const xml = sheetXml(zip, 1) + sheetXml(zip, 2) + sheetXml(zip, 3);
  ok('排产清单工作表 XML 是真实 XML', sheetXml(zip, 1).trimStart().startsWith('<?xml'), sheetXml(zip, 1).slice(0, 60));
  ok('排产清单工作表 XML 含版本号 V1', xml.includes('V1'), 'XML 长度 ' + xml.length);
  ok('排产清单工作表前言含「模拟结果标识」行与标注值',
    xml.includes('模拟结果标识') && xml.includes('模拟结果，含未验证参数（演示参数模式，不作为正式执行依据）'),
    (xml.match(/模拟[^<"]{0,40}/g) || []).slice(0, 3).join(' | '));
  ok('排产清单工作表标题带【模拟结果，含未验证参数】', xml.includes('【模拟结果，含未验证参数】'),
    (xml.match(/排产清单[^<"]{0,40}/g) || []).slice(0, 2).join(' | '));
}

/* 筛选导出必须真的少行，且行数差 = 被筛掉的任务数 */
if (planAllBlob && planFilteredBlob) {
  const rowsAll = countRows(sheetXml(readZip(await buf(planAllBlob)), 1));
  const rowsFiltered = countRows(sheetXml(readZip(await buf(planFilteredBlob)), 1));
  const schedAll = version.tasks.filter(t => t && t.scheduled !== false).length;
  const schedStrand = version.tasks.filter(t => t && t.scheduled !== false && t.process === 'stranding').length;
  ok('「工序=捻股」筛选真的改变了导出行数', rowsFiltered !== rowsAll, '全部 ' + rowsAll + ' 行 / 筛选 ' + rowsFiltered + ' 行');
  ok('筛选行数差 = 被筛掉的任务数', (rowsAll - rowsFiltered) === (schedAll - schedStrand),
    '行数差 ' + (rowsAll - rowsFiltered) + ' vs 任务数差 ' + (schedAll - schedStrand) + '（全部任务 ' + schedAll + ' / 捻股 ' + schedStrand + '）');
}

/* ---------------- 甘特 PNG：真实校验产出的字节 ---------------- */
const probeCanvas = document.createElement('canvas');
const HAS_CANVAS2D = !!(probeCanvas.getContext && probeCanvas.getContext('2d'));
const pngBefore = captured.length;
let pngRet = null;
try { pngRet = await EX.exportGanttPNG(stubEl(), version, { scope: 'all' }); }
catch (e) { fail++; console.log('  FAIL: 甘特导出抛异常 :: ' + e.message); }
const pngBlobs = captured.slice(pngBefore).filter(b => String(b.type).includes('png'));
if (pngBlobs.length) {
  const bytes = await buf(pngBlobs[0]);
  const v = validatePng(bytes);
  ok('甘特 PNG 结构有效（签名 + IHDR 宽高 + 全部 chunk CRC + IDAT 可解压）', v.ok, v.why);
  if (v.ok) console.log('  PNG：' + bytes.length + ' 字节 · ' + v.width + 'x' + v.height + ' · ' + v.chunks + ' 个 chunk · IDAT 解压 ' + v.inflated + ' 字节');
  ok('甘特导出返回 true', pngRet === true, String(pngRet));
} else if (!HAS_CANVAS2D) {
  skipNote('甘特 PNG 字节校验：本环境无 Canvas 2D（exportGanttPNG 返回 ' + pngRet + '），未产出 PNG —— 不计为通过；PNG 校验器本身已用自造样本自检');
} else {
  ok('甘特导出产出 PNG Blob', false, 'exportGanttPNG 返回 ' + pngRet + '，但环境有 Canvas 2D');
}

console.log('通过 ' + pass + ' / 失败 ' + fail + (skip ? ' / 跳过 ' + skip : '') + ' · 捕获 Blob ' + captured.length);
process.exit(fail ? 1 : 0);
