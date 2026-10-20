#!/usr/bin/env node
/* Node 自检脚本：验证 web/src/data/xlsxReader.js（结构 + 真实文件逐格比对 + 边界加固）
 * ---------------------------------------------------------------------------
 * 覆盖三类证据：
 *   1) 真实文件结构断言（订单信息 / 产品额定（平均值）/ 典型质量案例）；
 *   2) 【真实文件抽样逐格比对】用 python + openpyxl 作 oracle：每表随机 2000 格 + 全部表头 +
 *      全部日期列，逐格断言「值 / 类型 / 日期」一致——这一节每格一条断言，改错一格即红；
 *   3) 边界加固断言：稀疏放大上限、CRC-32 校验（store + deflate）、UTF-16 编码识别、数字精度、
 *      RFC4180 引号、分隔符嗅探、空值口径、行号单调、错误 cause —— 每条都能在缺陷复现时失败。
 * 说明：Node 没有 DOMParser，这里用脚本内的最小 XML polyfill 代替，
 *   「浏览器真实 DOMParser」这一分支不在本脚本覆盖范围内（不假装覆盖）。
 * oracle 需要 python3 + openpyxl：优先用 $PYTHONPATH，其次用仓库同级 .pylibs；
 *   两者都不可用时本脚本判失败并以退出码 1 结束（不静默跳过）。
 * 运行：node tools/check_xlsx_reader.mjs
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { deflateRawSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { readXlsx, readCsv, guessColumnMapping, DEFAULT_READ_LIMITS } from '../web/src/data/xlsxReader.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(HERE, '..', '..', '黑客松数据包');
const REPO_DIR = join(HERE, '..');

/* ======================= 1. 最小 XML DOM polyfill ======================= */

function decodeEnt(s) {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x?[0-9A-Fa-f]+|amp|lt|gt|quot|apos);/g, function (m, e) {
    if (e.charCodeAt(0) === 35) {
      const hex = e[1] === 'x' || e[1] === 'X';
      const code = parseInt(e.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[e] || m;
  });
}

function mkText(text) {
  return { nodeType: 3, nodeName: '#text', localName: '#text', childNodes: [], textContent: text };
}

function collect(root, name) {
  const out = [];
  const stack = [];
  for (let i = root.childNodes.length - 1; i >= 0; i--) stack.push(root.childNodes[i]);
  while (stack.length) {
    const n = stack.pop();
    if (n.nodeType !== 1) continue;
    if (n.nodeName === name || n.localName === name) out.push(n);
    for (let i = n.childNodes.length - 1; i >= 0; i--) stack.push(n.childNodes[i]);
  }
  return out;
}

function mkElement(name) {
  const el = { nodeType: 1, nodeName: name, localName: name.replace(/^.*:/, ''), childNodes: [], _attrs: new Map() };
  el.getAttribute = function (n) { const v = el._attrs.get(n); return v === undefined ? null : v; };
  el.hasAttribute = function (n) { return el._attrs.has(n); };
  el.getAttributeNS = function (ns, local) {
    if (el._attrs.has(local)) return el._attrs.get(local);
    for (const [k, v] of el._attrs) if (k.slice(k.indexOf(':') + 1) === local) return v;
    return null;
  };
  el.getElementsByTagName = function (n) { return collect(el, n); };
  el.getElementsByTagNameNS = function (ns, n) { return collect(el, n); };
  Object.defineProperty(el, 'textContent', {
    get() { let s = ''; for (const c of el.childNodes) s += c.textContent; return s; },
    enumerable: true, configurable: true,
  });
  return el;
}

const ATTR_RE = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
function parseAttrs(src, el) {
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(src))) {
    el._attrs.set(m[1], decodeEnt(m[2] !== undefined ? m[2] : m[3]));
  }
}

function findTagEnd(s, start) {
  let q = 0;
  for (let i = start + 1; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === q) q = 0; continue; }
    if (ch === '"' || ch === "'") { q = ch; continue; }
    if (ch === '>') return i;
  }
  return s.length;
}

function miniParse(src) {
  const docRoot = { nodeType: 9, nodeName: '#document', childNodes: [], getElementsByTagName: (n) => collect(docRoot, n) };
  const stack = [docRoot];
  const len = src.length;
  let i = 0;
  while (i < len) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (lt > i) stack[stack.length - 1].childNodes.push(mkText(decodeEnt(src.slice(i, lt))));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt); i = e < 0 ? len : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) {
      const e = src.indexOf(']]>', lt);
      const end = e < 0 ? len : e;
      stack[stack.length - 1].childNodes.push(mkText(src.slice(lt + 9, end)));
      i = end + 3; continue;
    }
    if (src.startsWith('<?', lt)) { const e = src.indexOf('?>', lt); i = e < 0 ? len : e + 2; continue; }
    if (src.startsWith('<!', lt)) { const e = src.indexOf('>', lt); i = e < 0 ? len : e + 1; continue; }
    const gt = findTagEnd(src, lt);
    const raw = src.slice(lt + 1, gt);
    if (raw.charCodeAt(0) === 47) { if (stack.length > 1) stack.pop(); i = gt + 1; continue; }
    const selfClose = raw.charCodeAt(raw.length - 1) === 47;
    const body = selfClose ? raw.slice(0, -1) : raw;
    const sp = body.search(/\s/);
    const name = sp < 0 ? body : body.slice(0, sp);
    const el = mkElement(name);
    if (sp >= 0) parseAttrs(body.slice(sp), el);
    stack[stack.length - 1].childNodes.push(el);
    if (!selfClose) stack.push(el);
    i = gt + 1;
  }
  const doc = {
    nodeType: 9, nodeName: '#document', documentElement: docRoot.childNodes.filter((n) => n.nodeType === 1)[0] || null,
    getElementsByTagName: (n) => collect(docRoot, n),
  };
  return doc;
}

function MiniDOMParser() {}
MiniDOMParser.prototype.parseFromString = function (text) { return miniParse(String(text)); };
if (typeof globalThis.DOMParser === 'undefined') globalThis.DOMParser = MiniDOMParser;

/* ======================= 2. 断言 / 打印工具 ======================= */

let pass = 0;
let failCount = 0;
const failures = [];
function check(label, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + label + (extra ? '  ' + extra : '')); }
  else { failCount++; failures.push(label + (extra ? '  ' + extra : '')); console.log('  ✗ ' + label + (extra ? '  ' + extra : '')); }
  return !!cond;
}
function eq(label, actual, expected) { return check(label, actual === expected, '实际=' + JSON.stringify(actual) + ' 期望=' + JSON.stringify(expected)); }
function section(t) { console.log('\n=== ' + t + ' ==='); }

/* 逐格比对用的静默断言：成功不逐条打印（否则几千行），失败进清单，计数照常累加 */
let quietPass = 0;
let quietFail = 0;
const quietFailures = [];
function checkQuiet(label, cond, extra) {
  if (cond) { quietPass++; return true; }
  quietFail++; if (quietFailures.length < 25) quietFailures.push(label + (extra ? '  ' + extra : ''));
  return false;
}

/* 真实文件相关断言计数：用于汇报「有多少断言真的读到了真实文件」 */
let realFileAsserts = 0;
let realCellCount = 0;   // 逐格比对实际比过的格数
function checkReal(label, cond, extra) { realFileAsserts++; return check(label, cond, extra); }
function checkRealQuiet(label, cond, extra) { realFileAsserts++; return checkQuiet(label, cond, extra); }

function cellRepr(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  if (v instanceof Date) return 'Date(' + v.toISOString() + ')';
  if (typeof v === 'string') return JSON.stringify(v);
  return String(v);
}
function previewRow(r, n) { return '[' + r.slice(0, n).map(cellRepr).join(', ') + ']'; }
function preview(rows, n, cols) {
  return rows.slice(0, n).map((r) => '    ' + previewRow(r, cols)).join('\n');
}
function typesOf(row) { return row.map((v) => (v === null ? 'null' : v instanceof Date ? 'Date' : typeof v)).join(','); }
function ms(t0) { return (Number(process.hrtime.bigint() - t0) / 1e6).toFixed(0) + 'ms'; }
function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1) + 'MB'; }

/** 执行并捕获错误；不抛错时返回 null */
async function catchErr(fn) {
  try { await fn(); return null; } catch (e) { return e; }
}

/** 断言「必须失败」：err 非空、消息命中 must 中每一项、且不含 mustNot 中任何一项 */
function checkThrows(label, err, must, mustNot) {
  if (!err) return check(label, false, '期望抛错，但调用成功了');
  const msg = String(err.message || err);
  const miss = (must || []).filter((p) => (p instanceof RegExp ? !p.test(msg) : msg.indexOf(p) < 0));
  const hit = (mustNot || []).filter((p) => (p instanceof RegExp ? p.test(msg) : msg.indexOf(p) >= 0));
  return check(label, miss.length === 0 && hit.length === 0,
    '消息=' + JSON.stringify(msg) +
    (miss.length ? ' 缺少关键词=' + miss.map(String).join('|') : '') +
    (hit.length ? ' 不应出现=' + hit.map(String).join('|') : ''));
}

/* ======================= 3. 构造 zip / xlsx 的工具（测试侧独立实现） ======================= */

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function concatBytes(list) {
  let total = 0;
  for (const b of list) total += b.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const b of list) { out.set(b, p); p += b.length; }
  return out;
}

/** 打包一个 zip：method=0 store / method=8 deflate，两条读取路径都能被走到 */
function zipMake(files, method) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of files) {
    const nameBytes = enc.encode(name);
    const data = enc.encode(content);
    const stored = method === 8 ? new Uint8Array(deflateRawSync(Buffer.from(data))) : data;
    const crc = crc32(data);
    const lfh = new Uint8Array(30 + nameBytes.length);
    const dv = new DataView(lfh.buffer);
    dv.setUint32(0, 0x04034b50, true); dv.setUint16(4, 20, true); dv.setUint16(8, method, true);
    dv.setUint32(14, crc, true); dv.setUint32(18, stored.length, true); dv.setUint32(22, data.length, true);
    dv.setUint16(26, nameBytes.length, true);
    lfh.set(nameBytes, 30);
    parts.push(lfh, stored);

    const cd = new Uint8Array(46 + nameBytes.length);
    const cdv = new DataView(cd.buffer);
    cdv.setUint32(0, 0x02014b50, true); cdv.setUint16(4, 20, true); cdv.setUint16(6, 20, true);
    cdv.setUint16(10, method, true);
    cdv.setUint32(16, crc, true); cdv.setUint32(20, stored.length, true); cdv.setUint32(24, data.length, true);
    cdv.setUint16(28, nameBytes.length, true); cdv.setUint32(42, offset, true);
    cd.set(nameBytes, 46);
    central.push(cd);
    offset += lfh.length + stored.length;
  }
  const cdBytes = concatBytes(central);
  const eocd = new Uint8Array(22);
  const edv = new DataView(eocd.buffer);
  edv.setUint32(0, 0x06054b50, true);
  edv.setUint16(8, files.length, true); edv.setUint16(10, files.length, true);
  edv.setUint32(12, cdBytes.length, true); edv.setUint32(16, offset, true);
  const all = concatBytes([...parts, cdBytes, eocd]);
  return all.buffer.slice(all.byteOffset, all.byteOffset + all.byteLength);
}
function zipStore(files) { return zipMake(files, 0); }
function zipDeflate(files) { return zipMake(files, 8); }

/** 定位 local file header 的数据区（测试侧独立实现，仅用于制造篡改样本） */
function locateLocal(bytes, name) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  let p = 0;
  while (p + 30 <= bytes.length && dv.getUint32(p, true) === 0x04034b50) {
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const csize = dv.getUint32(p + 18, true);
    const nm = dec.decode(bytes.subarray(p + 30, p + 30 + nameLen));
    const start = p + 30 + nameLen + extraLen;
    if (nm === name) return { headerStart: p, dataStart: start, csize: csize };
    p = start + csize;
  }
  return null;
}

/** 定位 central directory 条目（用于只改中央目录里的 CRC，制造「解压成功但校验和错」的样本） */
function locateCentral(bytes, name) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.length;
  let eocd = -1;
  for (let p = len - 22; p >= Math.max(0, len - 22 - 65535); p--) {
    if (dv.getUint32(p, true) === 0x06054b50) { eocd = p; break; }
  }
  if (eocd < 0) return -1;
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  for (let i = 0; i < count; i++) {
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const nm = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    if (nm === name) return p;
    p += 46 + nameLen + extraLen + commentLen;
  }
  return -1;
}

/** 复制一份并翻转指定条目数据区中间 1 个 bit（store 路径：XML 仍然合法，只有 CRC 能发现） */
function tamperData(bytes, name) {
  const out = new Uint8Array(bytes).slice();
  const loc = locateLocal(out, name);
  if (!loc || loc.csize < 1) return null;
  out[loc.dataStart + Math.floor(loc.csize / 2)] ^= 0x01;
  return out.buffer;
}

/** 复制一份并翻转 deflate 数据区开头 2 个字节（块头损坏 → 解压必须报错） */
function corruptDeflateData(bytes, name) {
  const out = new Uint8Array(bytes).slice();
  const loc = locateLocal(out, name);
  if (!loc || loc.csize < 2) return null;
  out[loc.dataStart] ^= 0xff;
  out[loc.dataStart + 1] ^= 0xff;
  return out.buffer;
}

/** 把某个条目的压缩方法改标成 deflate（数据不动）→ 解压必然失败，用于验证错误提示 */
function markAsDeflate(bytes, name) {
  const out = new Uint8Array(bytes).slice();
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const loc = locateLocal(out, name);
  const cen = locateCentral(out, name);
  if (!loc || cen < 0) return null;
  dv.setUint16(loc.headerStart + 8, 8, true);
  dv.setUint16(cen + 10, 8, true);
  return out.buffer;
}

/** 列序号 → 列名（构造测试样本用） */
function colName(n) {
  let s = '';
  while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

/** 复制一份并把中央目录里的 CRC 改成错值（deflate 路径：解压本身成功，只有校验和能发现） */
function tamperCentralCrc(bytes, name) {
  const out = new Uint8Array(bytes).slice();
  const p = locateCentral(out, name);
  if (p < 0) return null;
  const dv = new DataView(out.buffer, out.byteOffset, out.byteLength);
  dv.setUint32(p + 16, (dv.getUint32(p + 16, true) ^ 0x0000ffff) >>> 0, true);
  return out.buffer;
}

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PKG = 'http://schemas.openxmlformats.org/package/2006/relationships';

/** 包一层 worksheet XML */
function sheetXml(rowsXml) {
  return XML_HEAD + '<worksheet xmlns="' + NS_MAIN + '"><sheetData>' + rowsXml + '</sheetData></worksheet>';
}

/** 用最少的部件拼一个 xlsx；sheets=[{name, xml}]，可选 sharedStrings/styles/method/date1904 */
function makeXlsx(sheets, opts) {
  const o = opts || {};
  const files = [['[Content_Types].xml', XML_HEAD +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>']];
  const wbSheets = sheets.map((s, i) => '<sheet name="' + s.name + '" sheetId="' + (i + 1) +
    '" r:id="rId' + (i + 1) + '"/>').join('');
  const rels = sheets.map((s, i) => '<Relationship Id="rId' + (i + 1) + '" Type="' + NS_R +
    '/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>').join('');
  files.push(['xl/workbook.xml', XML_HEAD + '<workbook xmlns="' + NS_MAIN + '" xmlns:r="' + NS_R + '">' +
    (o.date1904 ? '<workbookPr date1904="1"/>' : '') + '<sheets>' + wbSheets + '</sheets></workbook>']);
  files.push(['xl/_rels/workbook.xml.rels', XML_HEAD + '<Relationships xmlns="' + NS_PKG + '">' + rels + '</Relationships>']);
  if (o.sharedStrings) files.push(['xl/sharedStrings.xml', o.sharedStrings]);
  if (o.styles) files.push(['xl/styles.xml', o.styles]);
  sheets.forEach((s, i) => files.push(['xl/worksheets/sheet' + (i + 1) + '.xml', s.xml]));
  return zipMake(files, o.method === 8 ? 8 : 0);
}

/* ======================= 4. 合成基准样本（沿用原有 SYNTH_A / SYNTH_B） ======================= */

const SYNTH_STYLES = XML_HEAD +
  '<styleSheet xmlns="' + NS_MAIN + '"><numFmts count="3">' +
  '<numFmt numFmtId="165" formatCode="yyyy&quot;年&quot;m&quot;月&quot;d&quot;日&quot;"/>' +
  '<numFmt numFmtId="166" formatCode="0.00&quot;m&quot;"/>' +
  '<numFmt numFmtId="167" formatCode="0.0%"/>' +
  '</numFmts><cellXfs count="7">' +
  '<xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="165"/><xf numFmtId="166"/><xf numFmtId="167"/>' +
  '<xf numFmtId="49"/><xf numFmtId="22"/></cellXfs></styleSheet>';

const SYNTH_SST = XML_HEAD + '<sst xmlns="' + NS_MAIN + '" count="5" uniqueCount="5">' +
  '<si><t>共享A</t></si>' +
  '<si><t>共享B</t></si>' +
  '<si><r><t>富</t></r><r><t>文本</t></r></si>' +
  '<si><t xml:space="preserve"> 前后空格 </t></si>' +
  '<si><t>换行_x000D_符 &amp; 实体</t></si>' +
  '</sst>';

/* 测试 A：关系乱序 + inlineStr/str/b/e + 空列补齐 + 缺行 + 1904 日期系统 */
const SYNTH_A_WB = XML_HEAD + '<workbook xmlns="' + NS_MAIN + '" xmlns:r="' + NS_R + '">' +
  '<workbookPr date1904="1"/><sheets>' +
  '<sheet name="乱序表" sheetId="1" r:id="rId2"/>' +
  '<sheet name="类型表" sheetId="2" r:id="rId1"/>' +
  '</sheets></workbook>';
const SYNTH_A_RELS = XML_HEAD + '<Relationships xmlns="' + NS_PKG + '">' +
  '<Relationship Id="rId1" Type="' + NS_R + '/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId2" Type="' + NS_R + '/worksheet" Target="worksheets/sheet2.xml"/>' +
  '<Relationship Id="rId8" Type="' + NS_R + '/sharedStrings" Target="sharedStrings.xml"/>' +
  '<Relationship Id="rId9" Type="' + NS_R + '/styles" Target="styles.xml"/>' +
  '</Relationships>';
const SYNTH_A_SHEET2 = XML_HEAD + '<worksheet xmlns="' + NS_MAIN + '"><sheetData>' +
  '<row r="1"><c r="A1" t="inlineStr"><is><t>甲</t></is></c>' +
  '<c r="B1" t="inlineStr"><is><r><t>乙</t></r><r><t>丙</t></r></is></c>' +
  '<c r="D1" t="str"><f>A1</f><v>公式串</v></c>' +
  '<c r="E1" t="b"><v>1</v></c><c r="F1" t="b"><v>0</v></c></row>' +
  '<row r="3"><c r="A3" t="e"><v>#DIV/0!</v></c><c r="C3" t="s"><v>2</v></c><c r="G3"><v>2026</v></c>' +
  '<c r="H3" s="7"/></row>' +
  '</sheetData></worksheet>';
const SYNTH_A_SHEET1 = XML_HEAD + '<worksheet xmlns="' + NS_MAIN + '"><sheetData>' +
  '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>3</v></c><c r="C1" t="s"><v>4</v></c><c r="D1" t="s"><v>1</v></c></row>' +
  '<row r="2"><c r="A2" s="1"><v>46241</v></c><c r="B2" s="2"><v>45000.5</v></c>' +
  '<c r="C2" s="3"><v>3.5</v></c><c r="D2" s="4"><v>0.25</v></c></row>' +
  '<row r="3"><c r="A3" s="1"/><c r="B3" s="6"><v>45000.75</v></c></row>' +
  '</sheetData></worksheet>';
const SYNTH_A = zipStore([
  ['[Content_Types].xml', XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'],
  ['xl/workbook.xml', SYNTH_A_WB],
  ['xl/_rels/workbook.xml.rels', SYNTH_A_RELS],
  ['xl/sharedStrings.xml', SYNTH_SST],
  ['xl/styles.xml', SYNTH_STYLES],
  ['xl/worksheets/sheet1.xml', SYNTH_A_SHEET1],
  ['xl/worksheets/sheet2.xml', SYNTH_A_SHEET2],
]);

/* 测试 B：1900 日期系统 + 1900-02-29 闰年 bug + 自定义日期格式 */
const SYNTH_B_WB = XML_HEAD + '<workbook xmlns="' + NS_MAIN + '" xmlns:r="' + NS_R + '">' +
  '<sheets><sheet name="序列" sheetId="1" r:id="rId1"/></sheets></workbook>';
const SYNTH_B_RELS = XML_HEAD + '<Relationships xmlns="' + NS_PKG + '">' +
  '<Relationship Id="rId1" Type="' + NS_R + '/worksheet" Target="worksheets/sheet1.xml"/>' +
  '<Relationship Id="rId8" Type="' + NS_R + '/sharedStrings" Target="sharedStrings.xml"/>' +
  '<Relationship Id="rId9" Type="' + NS_R + '/styles" Target="styles.xml"/>' +
  '</Relationships>';
const SYNTH_B_SHEET = XML_HEAD + '<worksheet xmlns="' + NS_MAIN + '"><sheetData>' +
  '<row r="1"><c r="A1" s="1"><v>1</v></c><c r="B1" s="1"><v>59</v></c><c r="C1" s="1"><v>60</v></c>' +
  '<c r="D1" s="1"><v>61</v></c><c r="E1" s="1"><v>36526</v></c><c r="F1" s="2"><v>46241</v></c></row>' +
  '</sheetData></worksheet>';
const SYNTH_B = zipStore([
  ['xl/workbook.xml', SYNTH_B_WB],
  ['xl/_rels/workbook.xml.rels', SYNTH_B_RELS],
  ['xl/sharedStrings.xml', SYNTH_SST],
  ['xl/styles.xml', SYNTH_STYLES],
  ['xl/worksheets/sheet1.xml', SYNTH_B_SHEET],
]);

/* ======================= 5. 开始自检 ======================= */

let TMP_DIR = null;          // oracle 临时目录（结束后清理）
let PY_ENV = null;           // python 运行环境（PYTHONPATH 指向 openpyxl）

console.log('Node ' + process.version);
console.log('DOMParser: polyfill(脚本内最小实现)  DecompressionStream: ' + (typeof DecompressionStream) +
  '  Blob: ' + typeof Blob + '  Response: ' + typeof Response);
try {
  const probe = new Uint8Array(deflateRawSync(Buffer.from('test')));  // deflate-raw "test"
  const s = new Blob([probe]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const txt = await new Response(s).text();
  console.log("DecompressionStream('deflate-raw') 探针解压结果: " + JSON.stringify(txt));
} catch (e) {
  console.log("DecompressionStream('deflate-raw') 探针失败: " + e.message);
}

/* ---- 5.1 订单信息.xlsx ---- */
section('真实文件 1：订单信息.xlsx');
{
  const t0 = process.hrtime.bigint();
  const buf = readFileSync(join(DATA_DIR, '订单信息.xlsx'));
  const book = await readXlsx(new Uint8Array(buf).buffer);
  const loadMs = ms(t0);
  const sheet = book.sheets[0];
  const rows = sheet.rows;

  checkReal('工作表数量', book.sheets.length === 1);
  checkReal('工作表名', sheet.name === '订单信息');
  checkReal('meta.sheetNames', JSON.stringify(book.meta.sheetNames) === '["订单信息"]', JSON.stringify(book.meta.sheetNames));
  checkReal('meta.date1904', book.meta.date1904 === false);
  checkReal('总行数（含表头）', rows.length === 324, '实际=' + rows.length);
  const widths = new Set(rows.map((r) => r.length));
  checkReal('每行列数均为 23', widths.size === 1 && widths.has(23), '出现过的列数=' + [...widths].join('/'));
  const header = rows[0];
  checkReal('表头前 6 列', JSON.stringify(header.slice(0, 6)) ===
    JSON.stringify(['项目编号', '订单日期', '单据日期', '内部订单单号-序号-次序号', '预发货日', '序号']),
    JSON.stringify(header.slice(0, 6)));
  console.log('  表头(前6列): ' + previewRow(header, 6));
  console.log('  前 2 行前 6 列:');
  console.log(preview(rows, 2, 6));
  console.log('  第 2 行类型: ' + typesOf(rows[1].slice(0, 6)));

  const d = rows[1][1];
  checkReal('订单日期是 Date 而非数字', d instanceof Date, '值=' + cellRepr(d));
  const expect = new Date(Date.UTC(2000, 0, 1) + (46241 - 36526) * 86400000);
  checkReal('订单日期值正确（以 36526=2000-01-01 独立换算）',
    d instanceof Date && d.toISOString() === expect.toISOString(),
    '实际=' + (d instanceof Date ? d.toISOString() : d) + ' 期望=' + expect.toISOString());
  let dateCells = 0;
  for (let i = 1; i < rows.length; i++) if (rows[i][1] instanceof Date) dateCells++;
  checkReal('B 列（订单日期）转成 Date 的单元格数', dateCells === 323, '实际=' + dateCells);
  checkReal('首行数据 A2 = 250529243-01', rows[1][0] === '250529243-01', JSON.stringify(rows[1][0]));
  console.log('  解析耗时: ' + loadMs);
}

/* ---- 5.2 产品额定（平均值）.xlsx ---- */
section('真实文件 2：产品额定（平均值）.xlsx');
{
  const t0 = process.hrtime.bigint();
  const buf = readFileSync(join(DATA_DIR, '产品额定（平均值）.xlsx'));
  const book = await readXlsx(new Uint8Array(buf).buffer);
  const loadMs = ms(t0);

  checkReal('工作表数量', book.sheets.length === 3, '实际=' + book.sheets.length);
  checkReal('工作表名与顺序', JSON.stringify(book.meta.sheetNames) ===
    JSON.stringify(['拉丝', '捻股', '合绳（绳子+绳芯）']), JSON.stringify(book.meta.sheetNames));
  checkReal('meta.date1904', book.meta.date1904 === false);

  /* 维度必须与当前源文件一致：源文件在 Sep 19 02:36 被换过
     （拉丝多了一行、捻股多了一列 8246、合绳少了一列），写死旧值会让「源文件更新」判成「读取器坏了」。 */
  const expectDims = { 拉丝: [49, 9], 捻股: [6476, 56], '合绳（绳子+绳芯）': [4701, 16] };
  for (const s of book.sheets) {
    const [er, ec] = expectDims[s.name];
    checkReal('『' + s.name + '』行数', s.rows.length === er, '实际=' + s.rows.length);
    const bad = s.rows.filter((r) => r.length !== ec).length;
    checkReal('『' + s.name + '』列数均为 ' + ec, bad === 0, '列数不一致的行数=' + bad);
    console.log('  『' + s.name + '』' + s.rows.length + ' 行 × ' + (s.rows[0] ? s.rows[0].length : 0) + ' 列，前 2 行前 6 列:');
    console.log(preview(s.rows, 2, 6));
  }
  const st = book.sheets[1];
  checkReal('捻股表头首列 = 品名', st.rows[0][0] === '品名', JSON.stringify(st.rows[0].slice(0, 3)));
  console.log('  解析耗时: ' + loadMs);
}

/* ---- 5.3 真实文件抽样逐格比对（openpyxl oracle） ---- */
section('真实文件抽样逐格比对（python + openpyxl oracle：每表随机 2000 格 + 全部表头 + 全部日期列）');

/** 生成 oracle 的 python 脚本（独立实现：openpyxl 读同一批单元格） */
const PY_ORACLE = [
  'import json, random, sys, time',
  'from datetime import datetime, date, time as dtime',
  'import openpyxl',
  '',
  'out_path = sys.argv[1]',
  'data_dir = sys.argv[2]',
  'seed = 20260919',
  'per_sheet = 2000',
  'FILES = ["订单信息.xlsx", "产品额定（平均值）.xlsx", "典型质量案例.xlsx"]',
  '',
  'def enc(v):',
  '    if v is None: return ["null", None]',
  '    if isinstance(v, bool): return ["bool", bool(v)]',
  '    if isinstance(v, datetime): return ["date", v.isoformat()]',
  '    if isinstance(v, date): return ["date", v.isoformat() + "T00:00:00"]',
  '    if isinstance(v, dtime): return ["time", v.isoformat()]',
  '    if isinstance(v, (int, float)): return ["number", v]',
  '    if isinstance(v, str): return ["string", v]',
  '    return ["other:" + type(v).__name__, str(v)]',
  '',
  'random.seed(seed)',
  'files_out = []',
  't0 = time.time()',
  'for fname in FILES:',
  '    wb = openpyxl.load_workbook(data_dir + "/" + fname, read_only=True, data_only=True)',
  '    sheets_out = []',
  '    for ws in wb.worksheets:',
  '        vals = {}',
  '        maxr = 0',
  '        maxc = 0',
  '        for ri, row in enumerate(ws.iter_rows(), start=1):',
  '            for ci, cell in enumerate(row, start=1):',
  '                v = cell.value',
  '                if v is None or v == "":',
  '                    continue',
  '                vals[(ri, ci)] = v',
  '                if ri > maxr: maxr = ri',
  '                if ci > maxc: maxc = ci',
  '        picks = set()',
  '        for c in range(1, maxc + 1):',
  '            picks.add((1, c))',
  '        date_cols = {}',
  '        for (r, c), v in vals.items():',
  '            if isinstance(v, (datetime, date, dtime)):',
  '                date_cols[c] = date_cols.get(c, 0) + 1',
  '        for c in date_cols:',
  '            if date_cols[c] >= 3:',
  '                for r in range(1, maxr + 1):',
  '                    picks.add((r, c))',
  '        budget = per_sheet',
  '        tries = 0',
  '        while budget > 0 and tries < per_sheet * 20 and maxr > 0 and maxc > 0:',
  '            tries += 1',
  '            key = (random.randint(1, maxr), random.randint(1, maxc))',
  '            if key in picks: continue',
  '            picks.add(key)',
  '            budget -= 1',
  '        cells = []',
  '        for (r, c) in sorted(picks):',
  '            k, payload = enc(vals.get((r, c)))',
  '            cells.append([r, c, k, payload])',
  '        sheets_out.append({"name": ws.title, "maxRow": maxr, "maxCol": maxc, "cells": cells})',
  '    wb.close()',
  '    files_out.append({"name": fname, "sheets": sheets_out})',
  'json.dump({"seed": seed, "elapsedSec": round(time.time() - t0, 2), "files": files_out},',
  '          open(out_path, "w", encoding="utf-8"), ensure_ascii=False)',
  'print("openpyxl oracle: cells=%d elapsed=%.2fs" % (sum(len(s["cells"]) for f in files_out for s in f["sheets"]), time.time() - t0))',
].join('\n');

/** 读取器取值 → 与 oracle 同构的 [kind, payload] */
function jsCellKind(v) {
  if (v === null || v === undefined) return ['null', null];
  if (v instanceof Date) return ['date', v.toISOString().slice(0, 19)];
  if (typeof v === 'number') return ['number', v];
  if (typeof v === 'boolean') return ['bool', v];
  return ['string', String(v)];
}

/** 比较一格：一致返回 null，否则返回可读差异（日期允许 ≤1s 误差，读取器按秒取整） */
function diffCell(pyKind, pyValue, got) {
  const pair = jsCellKind(got);
  const jk = pair[0];
  const jv = pair[1];
  const show = 'oracle[' + pyKind + ']=' + JSON.stringify(pyValue) + ' 读取器[' + jk + ']=' + JSON.stringify(jv);
  if (pyKind === 'null') return jk === 'null' ? null : show;
  if (pyKind === 'string') return jk === 'string' && jv === pyValue ? null : show;
  if (pyKind === 'bool') return jk === 'bool' && jv === pyValue ? null : show;
  if (pyKind === 'number') return jk === 'number' && jv === pyValue ? null : show;
  if (pyKind === 'date') {
    if (jk !== 'date') return show;
    const a = Date.parse(String(pyValue).replace(/\.\d+$/, '') + 'Z');
    const b = Date.parse(jv + 'Z');
    if (!Number.isFinite(a) || !Number.isFinite(b)) return show;
    return Math.abs(a - b) <= 1000 ? null : show;
  }
  if (pyKind === 'time') {
    if (jk !== 'date') return show;
    return String(pyValue).slice(0, 8) === String(jv).slice(11, 19) ? null : show;
  }
  return 'oracle 出现未预期类型 ' + pyKind + '（' + JSON.stringify(pyValue) + '）';
}

{
  TMP_DIR = mkdtempSync(join(tmpdir(), 'dsh_xlsx_oracle_'));
  const pyPath = join(TMP_DIR, 'oracle_openpyxl.py');
  const oraclePath = join(TMP_DIR, 'oracle_cells.json');
  writeFileSync(pyPath, PY_ORACLE, 'utf8');
  PY_ENV = Object.assign({}, process.env);
  if (!PY_ENV.PYTHONPATH) PY_ENV.PYTHONPATH = join(REPO_DIR, '..', '.pylibs');
  console.log('  oracle 临时目录: ' + TMP_DIR);
  const run = spawnSync('python3', [pyPath, oraclePath, DATA_DIR], { env: PY_ENV, encoding: 'utf8' });
  console.log('  ' + String(run.stdout || '').trim());
  if (run.status !== 0) {
    check('python3 + openpyxl oracle 可用', false,
      'exit=' + run.status + ' stderr=' + String(run.stderr || '').trim().split('\n').slice(-3).join(' / '));
  } else {
    check('python3 + openpyxl oracle 可用', true, 'PYTHONPATH=' + PY_ENV.PYTHONPATH);
    const spec = JSON.parse(readFileSync(oraclePath, 'utf8'));
    let totalCells = 0;
    let totalBad = 0;
    for (const f of spec.files) {
      const raw = readFileSync(join(DATA_DIR, f.name));
      const book = await readXlsx(new Uint8Array(raw).buffer);
      const byName = new Map(book.sheets.map((s) => [s.name, s.rows]));
      for (const sh of f.sheets) {
        const rows = byName.get(sh.name);
        if (!rows) { checkReal('『' + sh.name + '』存在', false); continue; }
        // 维度（只算「有值」的行列，与 oracle 用同一口径）
        checkReal('『' + sh.name + '』有值行数=' + sh.maxRow, rows.length === sh.maxRow, '实际=' + rows.length);
        const widths = new Set(rows.map((r) => r.length));
        checkReal('『' + sh.name + '』有值列数=' + sh.maxCol,
          widths.size <= 1 && (widths.size === 0 ? 0 : [...widths][0]) === sh.maxCol,
          '实际列数集合=' + [...widths].join('/'));
        let bad = 0;
        for (const cell of sh.cells) {
          const r = cell[0], c = cell[1];
          const row = rows[r - 1];
          const got = row ? row[c - 1] : undefined;
          const d = diffCell(cell[2], cell[3], got === undefined ? null : got);
          if (!checkRealQuiet(f.name + ' / ' + sh.name + ' R' + r + 'C' + c, d === null, d)) bad++;
        }
        totalCells += sh.cells.length;
        realCellCount += sh.cells.length;
        totalBad += bad;
        console.log('    ' + (bad ? '✗' : '✓') + ' ' + f.name + ' / 『' + sh.name + '』逐格比对 ' +
          sh.cells.length + ' 格（' + sh.maxRow + ' 行 × ' + sh.maxCol + ' 列口径），不一致 ' + bad + ' 格');
      }
    }
    check('真实文件逐格比对总计 ' + totalCells + ' 格全部一致', totalBad === 0, '不一致=' + totalBad);
  }
}

/* ---- 5.4 合成 store 压缩包（方法 0 / 类型 / 乱序关系 / 缺行缺列 / 1904） ---- */
section('合成用例 A：store 压缩 + 关系乱序 + 各类型单元格 + 1904 日期系统');
{
  const book = await readXlsx(SYNTH_A);
  eq('工作表数量', book.sheets.length, 2);
  check('工作表顺序按 workbook.xml（非 rId 顺序）',
    JSON.stringify(book.meta.sheetNames) === '["乱序表","类型表"]', JSON.stringify(book.meta.sheetNames));
  eq('meta.date1904', book.meta.date1904, true);

  const a = book.sheets[0].rows;
  eq('乱序表 行数（r=1,2,3 → 含 1 空行）', a.length, 3);
  check('乱序表 每行 7 列（H3 只有样式无值，不撑列）', a.every((r) => r.length === 7),
    JSON.stringify(a.map((r) => r.length)));
  console.log('  乱序表前 3 行:');
  console.log(preview(a, 3, 7));
  eq('inlineStr 单 run', a[0][0], '甲');
  eq('inlineStr 多 run 合并', a[0][1], '乙丙');
  eq('空列 B... 缺列补 null', a[0][2], null);
  eq('t="str" 公式字符串', a[0][3], '公式串');
  eq('t="b" ×2', String([a[0][4], a[0][5]]), String([true, false]));
  check('r=2 缺行补空行', a[1].every((v) => v === null) && a[1].length === 7, JSON.stringify(a[1]));
  eq('t="e" 错误值原样返回', a[2][0], '#DIV/0!');
  eq('共享字符串（富文本）', a[2][2], '富文本');
  eq('数字单元格', a[2][6], 2026);
  eq('只有样式的空单元格 = null', a[2][5], null);

  const b = book.sheets[1].rows;
  check('类型表 共享字符串/富文本/实体/空格/x 转义',
    b[0][0] === '共享A' && b[0][1] === ' 前后空格 ' && b[0][2] === '换行' + String.fromCharCode(13) + '符 & 实体' && b[0][3] === '共享B',
    b[0].map(cellRepr).join(' | '));
  const d1904 = new Date(Date.UTC(1904, 0, 1) + 46241 * 86400000);
  check('1904 系统 + 内置 14 号日期格式 → Date',
    b[1][0] instanceof Date && b[1][0].toISOString() === d1904.toISOString(),
    cellRepr(b[1][0]) + ' 期望=' + d1904.toISOString());
  const dCustom = new Date(Math.round((Date.UTC(1904, 0, 1) + 45000.5 * 86400000) / 1000) * 1000);
  check('自定义 numFmt(含 ymd) → Date（含 0.5 天小数）',
    b[1][1] instanceof Date && b[1][1].toISOString() === dCustom.toISOString(),
    cellRepr(b[1][1]) + ' 期望=' + dCustom.toISOString());
  eq('自定义格式 "0.00m" 引号内 m 不算日期 → number', b[1][2], 3.5);
  eq('自定义格式 "0.0%" → number', b[1][3], 0.25);
  eq('样式为空值单元格 → null', b[2][0], null);
  const dTime = new Date(Math.round((Date.UTC(1904, 0, 1) + 45000.75 * 86400000) / 1000) * 1000);
  check('内置 22 号日期时间格式 → Date',
    b[2][1] instanceof Date && b[2][1].toISOString() === dTime.toISOString(),
    cellRepr(b[2][1]));
}

/* ---- 5.5 合成 1900 系统：闰年 bug ---- */
section('合成用例 B：1900 日期系统与 1900-02-29 闰年 bug');
{
  const book = await readXlsx(SYNTH_B);
  const r = book.sheets[0].rows[0];
  eq('meta.date1904', book.meta.date1904, false);
  const expects = ['1900-01-01', '1900-02-28', '1900-02-28', '1900-03-01', '2000-01-01'];
  const labels = ['序列 1', '序列 59', '序列 60（Excel 伪造的 1900-02-29）', '序列 61', '序列 36526'];
  for (let i = 0; i < 5; i++) {
    const v = r[i];
    check(labels[i] + ' → ' + expects[i], v instanceof Date && v.toISOString().slice(0, 10) === expects[i],
      cellRepr(v));
  }
  check('自定义 ymd 格式 + 序列 46241 与真实文件一致',
    r[5] instanceof Date && r[5].toISOString() === new Date(Date.UTC(1899, 11, 30) + 46241 * 86400000).toISOString(),
    cellRepr(r[5]));
}

/* ---- 5.6 容错：非 zip ---- */
section('容错：非 zip 内容');
{
  const err = await catchErr(() => readXlsx(new Uint8Array([1, 2, 3, 4, 5]).buffer));
  checkThrows('非 zip 输入抛出可读错误', err, ['EOCD', 'xlsx']);
}

/* ======================= 6. 加固专项断言（对应审查报告 §5.1 表格 1-9） ======================= */

/* ---- 加固 1：稀疏→稠密放大上限（§5.1 高危项） ---- */
section('加固 1：稀疏→稠密放大与行列/单元格上限');
{
  const atkBig = makeXlsx([{ name: '攻击表', xml: sheetXml(
    '<row r="1"><c r="A1"><v>1</v></c></row>' +
    '<row r="2000"><c r="XFD2000" t="inlineStr"><is><t>深</t></is></c></row>') }]);
  console.log('  攻击样本 ' + atkBig.byteLength + ' 字节；旧实现会物化 ' + (2000 * 16384).toLocaleString() +
    ' 个单元格（约 ' + mb(2000 * 16384 * 8) + ' 指针数组）');
  const heap0 = process.memoryUsage().heapUsed;
  const t0 = process.hrtime.bigint();
  const errCol = await catchErr(() => readXlsx(atkBig));
  const cost = ms(t0);
  const heap1 = process.memoryUsage().heapUsed;
  checkThrows('超列数上限 → 可读中文错误（表名 + 限制名 + 当前值 + 调整方式）', errCol,
    ['攻击表', '列数上限', '16384', '1024', 'maxCols']);
  check('被拦下时不物化超大数组（堆增长 < 8MB）', heap1 - heap0 < 8 * 1024 * 1024,
    '堆增长=' + mb(Math.max(0, heap1 - heap0)) + ' 耗时=' + cost);

  const atkSmall = makeXlsx([{ name: '小表', xml: sheetXml(
    '<row r="1"><c r="A1"><v>1</v></c></row>' +
    '<row r="10"><c r="XFD10" t="inlineStr"><is><t>深</t></is></c></row>') }]);
  const okBook = await readXlsx(atkSmall, { maxCols: 20000, maxCells: 1000000 });
  eq('上限可用第二个参数覆盖（XFD10 + maxCols=20000 可读）', okBook.sheets[0].rows[9][16383], '深');
  eq('覆盖上限后行数仍正确', okBook.sheets[0].rows.length, 10);

  const atkRow = makeXlsx([{ name: '长表', xml: sheetXml('<row r="200001"><c r="A200001"><v>1</v></c></row>') }]);
  const errRow = await catchErr(() => readXlsx(atkRow));
  checkThrows('超单表行数上限 → 可读中文错误', errRow, ['长表', '行数上限', '200001', '200000']);

  let wide = '';
  for (let r = 1; r <= 3; r++) {
    wide += '<row r="' + r + '">';
    for (let c = 1; c <= 100; c++) wide += '<c r="' + colName(c) + r + '"><v>' + c + '</v></c>';
    wide += '</row>';
  }
  const atkCells = makeXlsx([{ name: '宽表', xml: sheetXml(wide) }]);
  const errCells = await catchErr(() => readXlsx(atkCells, { maxCells: 200 }));
  checkThrows('超单表单元格总数上限 → 可读中文错误', errCells, ['宽表', '单元格', '上限 200', '300']);

  const errPart = await catchErr(() => readXlsx(SYNTH_A, { maxPartBytes: 16 }));
  checkThrows('单条目解压上限（压缩炸弹）→ 解压前就拒绝', errPart, ['超过上限 16', 'maxPartBytes']);

  eq('默认上限与文件头注释一致', JSON.stringify(DEFAULT_READ_LIMITS),
    JSON.stringify({ maxRows: 200000, maxCols: 1024, maxCells: 5000000, maxPartBytes: 134217728 }));
}

/* ---- 加固 2：CRC-32 校验（§5.1 中危项） ---- */
section('加固 2：CRC-32 校验（store + deflate 两条路径）');
{
  const sst = XML_HEAD + '<sst xmlns="' + NS_MAIN + '" count="1" uniqueCount="1"><si><t>AAAA</t></si></sst>';
  const sheet = sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row>');
  const storeZip = makeXlsx([{ name: '篡改表', xml: sheet }], { sharedStrings: sst, method: 0 });
  const defZip = makeXlsx([{ name: '篡改表', xml: sheet }], { sharedStrings: sst, method: 8 });

  eq('store 原件读取正常（CRC 通过）', (await readXlsx(storeZip)).sheets[0].rows[0][0], 'AAAA');
  eq('deflate 原件读取正常（CRC 通过）', (await readXlsx(defZip)).sheets[0].rows[0][0], 'AAAA');

  const errStore = await catchErr(() => readXlsx(tamperData(storeZip, 'xl/sharedStrings.xml')));
  checkThrows('store 条目被篡改 → CRC-32 校验失败并指明条目名', errStore,
    ['CRC-32', 'xl/sharedStrings.xml', '损坏'], ['升级浏览器']);

  const errDef = await catchErr(() => readXlsx(tamperCentralCrc(defZip, 'xl/sharedStrings.xml')));
  checkThrows('deflate 条目 CRC 不符（解压本身成功）→ 仍被拦下', errDef,
    ['CRC-32', 'xl/sharedStrings.xml']);

  const errTrunc = await catchErr(() => readXlsx(markAsDeflate(storeZip, 'xl/worksheets/sheet1.xml')));
  checkThrows('压缩数据损坏 → 报错且不再提示「请升级浏览器」', errTrunc,
    ['xl/worksheets/sheet1.xml'], ['升级浏览器', '请升级浏览器']);
}

/* ---- 加固 3：CSV 编码识别（§5.1 中危项） ---- */
section('加固 3：CSV 编码识别（UTF-16 BOM / 无 BOM 特征 / 未知编码报错）');
{
  const text = '项目编号,品名,数量\r\n250529243-01,钢丝,2000\r\n';
  const withBom = (s, le) => {
    const b = Buffer.from(s, 'utf16le');
    if (!le) b.swap16();
    return new Uint8Array(Buffer.concat([Buffer.from(le ? [0xff, 0xfe] : [0xfe, 0xff]), b]));
  };
  const noBom = (s, le) => {
    const b = Buffer.from(s, 'utf16le');
    if (!le) b.swap16();
    return new Uint8Array(b);
  };

  /* 变异测试时读取器可能直接抛错，这里包一层，保证给出 ✗ 而不是中断整个脚本 */
  const readSafe = async (bytes) => {
    const box = { book: null, err: null };
    box.err = await catchErr(async () => { box.book = await readCsv(new Blob([bytes])); });
    return box;
  };
  const at = (box, r, c) => {
    if (!box.book) return '抛错: ' + String(box.err && box.err.message).slice(0, 30);
    const row = (box.book.sheets[0].rows || [])[r] || [];
    return row[c] === undefined ? null : row[c];
  };
  const rLe = await readSafe(withBom(text, true));
  eq('UTF-16LE + BOM：表头正确解码', at(rLe, 0, 0), '项目编号');
  eq('UTF-16LE + BOM：数量列仍是 number', at(rLe, 1, 2), 2000);
  const rBe = await readSafe(withBom(text, false));
  eq('UTF-16BE + BOM：表头正确解码', at(rBe, 0, 0), '项目编号');
  const rLe2 = await readSafe(noBom(text, true));
  eq('无 BOM 的 UTF-16LE：按交替 0x00 特征识别并正确解码', at(rLe2, 0, 0), '项目编号');
  const rBe2 = await readSafe(noBom(text, false));
  eq('无 BOM 的 UTF-16BE：按交替 0x00 特征识别并正确解码', at(rBe2, 0, 0), '项目编号');
  const rGbk = await readSafe(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4, 0x2c, 0x31, 0x0a]));
  eq('GBK（无 BOM）仍按原行为回退解码', at(rGbk, 0, 0), '中文');

  const errEnc = await catchErr(() => readCsv(new Blob([new Uint8Array(64).fill(0xff)])));
  checkThrows('编码无法确定 → 抛可读错误，而不是「成功解码出乱码」', errEnc, ['无法确定', '编码']);
}

/* ---- 加固 4：数字字段精度（§5.1 中危项） ---- */
section('加固 4：纯数字字段精度（只在无损往返时转 number）');
{
  const rows = (await readCsv('a,b,c,d,e,f,g,h\n12345678901234567890,250529243-01,007,9007199254740993,1.20,2000,3.5,-12\n')).sheets[0].rows;
  const row = rows[1] || [];
  check('超过 MAX_SAFE_INTEGER 的整数保持字符串', row[0] === '12345678901234567890', cellRepr(row[0]));
  check('编号 250529243-01 保持字符串', row[1] === '250529243-01', cellRepr(row[1]));
  check('前导零 007 保持字符串', row[2] === '007', cellRepr(row[2]));
  check('9007199254740993（超安全整数）保持字符串', row[3] === '9007199254740993', cellRepr(row[3]));
  check('"1.20" 不因 Number 往返被改写成 1.2', row[4] === '1.20', cellRepr(row[4]));
  check('可无损往返的整数仍转 number', row[5] === 2000 && typeof row[5] === 'number', cellRepr(row[5]));
  check('可无损往返的小数仍转 number', row[6] === 3.5 && typeof row[6] === 'number', cellRepr(row[6]));
  check('负数仍转 number', row[7] === -12 && typeof row[7] === 'number', cellRepr(row[7]));
}

/* ---- 加固 5：RFC4180 引号语义（§5.1 中危项） ---- */
section('加固 5：RFC4180 引号语义 + python csv 模块 oracle');
{
  const inch = '规格,数量\n1/2",10\n3/4",20\n';
  const rows = (await readCsv(inch)).sheets[0].rows;
  const row1 = rows[1] || [];
  const row2 = rows[2] || [];
  eq('字段中间的裸引号不吞行（行数）', rows.length, 3);
  check('裸引号按普通字符处理（1/2"）', row1.length === 2 && row1[0] === '1/2"' && row1[1] === 10, previewRow(row1, 2));
  check('后续行不被吞掉', row2.length === 2 && row2[0] === '3/4"' && row2[1] === 20, previewRow(row2, 2));

  const cases = [
    'a,b\n1,2\n',
    '规格,数量\n1/2",10\n3/4",20\n',
    '"含,逗号",正常\n',
    '"双引号""转义",x\n',
    '"a"b,c\n',
    'a,"多\n行",d\n',
    'a,,b\n',
    'a,b\r\n1,2\r\n',
  ];
  const casesPath = join(TMP_DIR, 'csv_cases.json');
  const pyOutPath = join(TMP_DIR, 'csv_cases_py.json');
  const pyCasesPath = join(TMP_DIR, 'csv_oracle.py');
  writeFileSync(casesPath, JSON.stringify(cases), 'utf8');
  writeFileSync(pyCasesPath, [
    'import csv, io, json, sys',
    'cases = json.load(open(sys.argv[1], encoding="utf-8"))',
    'out = []',
    'for c in cases:',
    '    rows = list(csv.reader(io.StringIO(c)))',
    '    while rows and rows[-1] == []: rows.pop()',
    '    out.append(rows)',
    'json.dump(out, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)',
  ].join('\n'), 'utf8');
  const run = spawnSync('python3', [pyCasesPath, casesPath, pyOutPath], { env: PY_ENV, encoding: 'utf8' });
  if (run.status !== 0) {
    check('python csv 模块 oracle 可用', false, String(run.stderr || '').trim().split('\n').slice(-2).join(' / '));
  } else {
    check('python csv 模块 oracle 可用', true);
    const pyRows = JSON.parse(readFileSync(pyOutPath, 'utf8'));
    for (let i = 0; i < cases.length; i++) {
      const ours = (await readCsv(cases[i])).sheets[0].rows || [];
      const norm = ours.map((r) => (r || []).map((v) => (v === null ? '' : String(v))));
      check('python csv oracle 逐字段一致 #' + (i + 1) + ' ' + JSON.stringify(cases[i]).slice(0, 26),
        JSON.stringify(norm) === JSON.stringify(pyRows[i]),
        'python=' + JSON.stringify(pyRows[i]) + ' 读取器=' + JSON.stringify(norm));
    }
  }
}

/* ---- 加固 6：分隔符嗅探只看表头（§5.1 低危项） ---- */
section('加固 6：分隔符嗅探只在表头行、且只在引号外统计');
{
  const semi = (await readCsv('a;b\n1,5,6;2,5,7;3,5,8\n')).sheets[0].rows;
  check('正文逗号远多于分号时仍按表头选分号', JSON.stringify(semi[0]) === '["a","b"]', JSON.stringify(semi[0]));
  check('正文按分号切成 3 列', (semi[1] || []).length === 3, JSON.stringify(semi[1]));
  const quoted = (await readCsv('"规格,mm";数量\n1,5;2\n')).sheets[0].rows;
  check('引号内的逗号不计票', JSON.stringify(quoted[0]) === '["规格,mm","数量"]', JSON.stringify(quoted[0]));
  eq('制表符表头 3 列', ((await readCsv('品名\t规格\t定额\n钢丝\t1.20\t38.4\n')).sheets[0].rows[0] || []).length, 3);
}

/* ---- 加固 7：空值口径（§5.1 低危项） ---- */
section('加固 7：空值口径统一为 null（含 <si><t></t></si>）');
{
  const emptySst = XML_HEAD + '<sst xmlns="' + NS_MAIN + '" count="1" uniqueCount="1"><si><t></t></si></sst>';
  const book = await readXlsx(makeXlsx([{ name: '空值表', xml: sheetXml(
    '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="inlineStr"><is><t></t></is></c>' +
    '<c r="C1" t="str"><v></v></c><c r="D1"/><c r="E1"><v>7</v></c></row>') }], { sharedStrings: emptySst }));
  const r0 = book.sheets[0].rows[0] || [];
  check('共享字符串为空 → null（不是 ""）', r0[0] === null, cellRepr(r0[0]));
  check('inlineStr 空串 → null', r0[1] === null, cellRepr(r0[1]));
  check('t="str" 空值 → null', r0[2] === null, cellRepr(r0[2]));
  check('完全空单元格 → null', r0[3] === null, cellRepr(r0[3]));
  check('同一行有值单元格不受影响', r0[4] === 7, cellRepr(r0[4]));
  check('空值仍占位、列不错位', r0.length === 5, '列数=' + r0.length);
}

/* ---- 加固 8：行号单调推进（§5.1 低危项） ---- */
section('加固 8：行号推进单调（无 @r 行不再覆盖销毁前面的行）');
{
  const book = await readXlsx(makeXlsx([{ name: '乱序行表', xml: sheetXml(
    '<row r="3"><c r="A3"><v>33</v></c></row>' +
    '<row><c r="A4"><v>44</v></c></row>' +
    '<row r="2"><c r="A2"><v>22</v></c></row>' +
    '<row><c r="A5"><v>55</v></c></row>') }]));
  const rows = book.sheets[0].rows;
  check('r=1/r=2 缺行补空行、行号不错位', rows.length === 5 && (rows[0] || []).every((v) => v === null),
    '行数=' + rows.length + ' 首行=' + JSON.stringify(rows[0]));
  check('4 个值全部保留且按行号升序（旧实现会丢掉 r=3 那一行）',
    JSON.stringify(rows.map((r) => r[0])) === JSON.stringify([null, 22, 33, 44, 55]),
    JSON.stringify(rows.map((r) => r[0])));
}

/* ---- 加固 9：错误 cause 与提示准确性（§5.1 低危项） ---- */
section('加固 9：错误 cause 与提示准确性');
{
  const sst = XML_HEAD + '<sst xmlns="' + NS_MAIN + '" count="1" uniqueCount="1"><si><t>X</t></si></sst>';
  const storeZip = makeXlsx([{ name: 'T', xml: sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row>') }],
    { sharedStrings: sst, method: 0 });
  const defZip = makeXlsx([{ name: 'T', xml: sheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row>') }],
    { sharedStrings: sst, method: 8 });

  const errBroken = await catchErr(() => readXlsx(markAsDeflate(storeZip, 'xl/worksheets/sheet1.xml')));
  checkThrows('声明 deflate 但数据不是 deflate → 解压失败（含条目名，不赖浏览器）', errBroken,
    ['xl/worksheets/sheet1.xml', '解压失败'], ['请升级浏览器', '不支持解压该 Excel 文件']);
  check('原始错误保留在 err.cause', !!(errBroken && errBroken.cause instanceof Error),
    errBroken && errBroken.cause ? String(errBroken.cause.message).slice(0, 70) : '无 cause');

  const saved = globalThis.DecompressionStream;
  let errNoDs = null;
  try {
    delete globalThis.DecompressionStream;
    errNoDs = await catchErr(() => readXlsx(defZip));
  } finally {
    globalThis.DecompressionStream = saved;
  }
  checkThrows('缺少 DecompressionStream 时提示「环境不支持」而非「文件损坏」', errNoDs,
    ['DecompressionStream', '不支持'], ['文件可能已损坏']);
}

/* ---- 加固 1b：dataPrep 上传文件大小护栏（DOM 路径，脚本内为静态断言；已用 /tmp 变异验证可红） ----
 * 注意：dataPrep.js 现在有「订单导入」与「设备 / 产能导入」两个上传函数，同一标识会在文件里出现多次，
 * 因此这里一律先把源码按「顶层函数体」切片再取锚点，不用全局 indexOf（否则锚点会错位、断言恒假）。 */
section('加固 1b：dataPrep 上传文件大小护栏（静态断言）');
{
  /** 取某个顶层函数的函数体：从签名到其后第一个行首的 }（顶层函数结束） */
  function functionBody(src, signature) {
    const start = src.indexOf(signature);
    if (start < 0) return '';
    const rest = src.slice(start);
    const end = rest.indexOf('\n}\n');
    return end < 0 ? rest : rest.slice(0, end + 3);
  }
  const dpAll = readFileSync(join(REPO_DIR, 'web/src/views/dataPrep.js'), 'utf8');
  const dpOrder = functionBody(dpAll, 'async function handleFile(');
  const dpDevice = functionBody(dpAll, 'async function handleDeviceFile(');

  check('存在单文件 20MB 上限常量', /const MAX_IMPORT_BYTES = 20 \* 1024 \* 1024;/.test(dpAll));

  const guardAt = dpOrder.indexOf('fileSize > MAX_IMPORT_BYTES');
  const parseAt = dpOrder.indexOf('mod.readXlsx(file)');
  check('订单导入：先判大小、再解析（锚点限定在 handleFile 函数体内）',
    dpOrder.length > 0 && guardAt > 0 && parseAt > guardAt,
    'handleFile 长度=' + dpOrder.length + ' guard@' + guardAt + ' parse@' + parseAt);
  check('订单导入：超限给出可读中文提示（含文件名与上限）',
    dpOrder.indexOf('文件过大，未开始解析') >= 0 && dpOrder.indexOf('fmtSize(fileSize)') >= 0 &&
    dpOrder.indexOf('fmtSize(MAX_IMPORT_BYTES)') >= 0);
  const parseStatusAt = dpOrder.indexOf('正在解析');
  check('订单导入：超限后直接 return，不进入解析',
    /return;/.test(dpOrder.slice(guardAt, parseStatusAt)) && parseStatusAt > guardAt,
    'return 出现在护栏与解析提示之间=' + /return;/.test(dpOrder.slice(guardAt, parseStatusAt)));

  const devGuardAt = dpDevice.indexOf('file.size > MAX_IMPORT_BYTES');
  const devParseAt = dpDevice.indexOf('xr.readXlsx(file)');
  const devStatusAt = dpDevice.indexOf('正在解析设备');
  check('设备 / 产能导入同样有大小护栏',
    /async function handleDeviceFile\([\s\S]{0,800}?file\.size > MAX_IMPORT_BYTES/.test(dpAll) && devGuardAt > 0,
    '函数体长度=' + dpDevice.length + ' 护栏@' + devGuardAt);
  check('设备 / 产能导入：先判大小、再解析（锚点限定在 handleDeviceFile 函数体内）',
    devGuardAt > 0 && devParseAt > devGuardAt,
    'guard@' + devGuardAt + ' parse@' + devParseAt);
  check('设备 / 产能导入：超限后直接 return',
    /return;/.test(dpDevice.slice(devGuardAt, devStatusAt)) && devStatusAt > devGuardAt);
  check('界面提示同步标注上限（单文件 ≤ 20MB）', dpAll.indexOf('单文件 ≤ 20MB') >= 0);
}

/* ======================= 7. CSV 解析 / 表头映射 ======================= */

section('CSV 解析');
{
  const csv = '\ufeff项目编号,品名,数量\r\n"250529243-01","钢丝, 镀锌",2000\r\n"A""B",普通,3.5\r\n';
  const r1 = await readCsv(csv);
  const rows = r1.sheets[0].rows;
  eq('CSV 行数', rows.length, 3);
  eq('BOM 已剥离', rows[0][0], '项目编号');
  eq('引号内逗号', rows[1][1], '钢丝, 镀锌');
  eq('"" 转义', rows[2][0], 'A"B');
  eq('数字列转 number', String([rows[1][2], rows[2][2]]), String([2000, 3.5]));
  eq('带横杠编号保持字符串', rows[1][0], '250529243-01');
  console.log('  ' + preview(rows, 3, 3).replace(/\n\s+/g, ' | '));

  const tsv = await readCsv('品名\t规格\t定额\n钢丝\t1.20\t38.4\n');
  eq('制表符嗅探', tsv.sheets[0].rows[0].length, 3);
  check('TSV 值（"1.20" 无法无损往返 → 保留字符串，38.4 仍是 number）',
    String(tsv.sheets[0].rows[1]) === String(['钢丝', '1.20', 38.4]), String(tsv.sheets[0].rows[1]));
  const semi = await readCsv('a;b;c\n1;2;3\n');
  eq('分号嗅探', String(semi.sheets[0].rows[1]), String([1, 2, 3]));
}

section('guessColumnMapping');
{
  const headers = ['项目编号', '订单日期', '单据日期', '内部订单单号-序号-次序号', '预发货日', '序号', '品名', '规格', '业务数量', '业务单位'];
  const fields = [
    { key: 'id', label: '订单号', aliases: ['项目编号', '订单号', '内部订单单号'] },
    { key: 'orderDate', label: '订单日期', aliases: ['订单日期', '下单日期'] },
    { key: 'qty', label: '数量', aliases: ['业务数量', '数量'] },
    { key: 'missing', label: '不存在的列', aliases: ['交货方式'] },
  ];
  const map = guessColumnMapping(headers, fields);
  eq('项目编号 → 0', map.id, 0);
  eq('订单日期 → 1', map.orderDate, 1);
  eq('业务数量 → 8', map.qty, 8);
  check('未命中字段不返回', !('missing' in map), JSON.stringify(map));
  const map2 = guessColumnMapping([' 全角　订单号 ', 'ＭＡＴＥＲＩＡＬ'], [{ key: 'id', aliases: ['订单号'] }, { key: 'mat', aliases: ['material'] }]);
  eq('忽略空白与全角', String([map2.id, map2.mat]), String([0, 1]));

  // 与 web/src/views/dataPrep.js 中 TARGET_FIELDS 对齐的真实回归：订单信息.xlsx 表头
  const APP_TARGET_FIELDS = [
    { key: 'id', label: '订单号', aliases: ['项目编号', '订单号', '内部订单单号'] },
    { key: 'spec', label: '规格', aliases: ['规格'] },
    { key: 'productName', label: '品名', aliases: ['品名'] },
    { key: 'qtyMeters', label: '业务数量', aliases: ['业务数量'] },
    { key: 'qtyMetersUnit', label: '业务单位', aliases: ['业务单位'] },
    { key: 'qtyKg', label: '计价数量', aliases: ['计价数量'] },
    { key: 'qtyKgUnit', label: '计价单位', aliases: ['计价单位'] },
    { key: 'orderDate', label: '订单日期', aliases: ['订单日期'] },
    { key: 'preShipDate', label: '预发货日', aliases: ['预发货日'] },
    { key: 'preArrivalDate', label: '预到货日', aliases: ['预到货日'] },
    { key: 'endCode', label: '结束码', aliases: ['结束码'] },
    { key: 'coating', label: '涂层', aliases: ['涂层'] },
  ];
  const realBuf = readFileSync(join(DATA_DIR, '订单信息.xlsx'));
  const realHeaders = (await readXlsx(new Uint8Array(realBuf).buffer)).sheets[0].rows[0];
  const appMap = guessColumnMapping(realHeaders, APP_TARGET_FIELDS);
  console.log('  订单信息.xlsx 自动映射: ' + JSON.stringify(appMap));
  for (const k of ['id', 'spec', 'qtyMeters', 'preShipDate']) {
    checkReal('应用必需字段 ' + k + ' 命中', appMap[k] >= 0, '列=' + appMap[k] + ' 表头=' + JSON.stringify(realHeaders[appMap[k]]));
  }
  checkReal('全部 12 个目标字段均命中', Object.keys(appMap).length === 12, '命中=' + Object.keys(appMap).length);
}

/* ======================= 8. 汇总 ======================= */

console.log('\n================ 汇总 ================');
console.log('通过 ' + (pass + quietPass) + ' 项，失败 ' + (failCount + quietFail) + ' 项');
console.log('  其中真实文件断言 ' + realFileAsserts + ' 项（逐格比对 ' + realCellCount + ' 格 + 结构/维度/表头映射断言）');
console.log('  边界加固断言：稀疏上限 / CRC-32 / UTF-16 编码 / 数字精度 / RFC4180 引号 / 分隔符嗅探 / 空值口径 / 行号单调 / 错误 cause / 上传大小护栏（订单 + 设备）');

if (TMP_DIR) {
  if (process.env.DSH_KEEP_ORACLE) {
    console.log('oracle 临时目录（DSH_KEEP_ORACLE 已设置，保留）: ' + TMP_DIR);
  } else {
    try { rmSync(TMP_DIR, { recursive: true, force: true }); console.log('已清理 oracle 临时目录: ' + TMP_DIR); }
    catch (e) { console.log('oracle 临时目录清理失败（可手动删除）: ' + TMP_DIR + ' | ' + e.message); }
  }
}

const allFailures = failures.concat(quietFailures);
if (failCount + quietFail) {
  console.log('失败项（逐格比对失败最多列前 25 条）：');
  for (const f of allFailures) console.log('  - ' + f);
  process.exitCode = 1;
}
