/* 零依赖 XLSX 写入器：OOXML 工作表 + 自实现 ZIP（STORE 存储）
   实现取舍（都能在代码里核对，不依赖任何第三方库）：
   - ZIP 用 STORE（不压缩）打包，CRC32 自行实现，避免引入 deflate；
   - 字符串统一写 inlineStr，不生成 sharedStrings.xml；
   - 数值/日期使用固定单元格格式：常规、两位小数(内置 2)、千分位整数(内置 3)、yyyy-mm-dd hh:mm(自定义 164)；
   - 中文经 TextEncoder 转 UTF-8 字节写入 ZIP，不会乱码；
   - 本模块不触碰 DOM，浏览器与 Node 18+ 均可直接调用（writeXlsx 返回 Blob）。
*/

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/* ---------------- CRC32（IEEE 802.3，多项式 0xEDB88320） ---------------- */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

/** 计算字节数组的 CRC32（与 ZIP 中央目录中记录的值一致） */
export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/* ---------------- 字节与 XML 工具 ---------------- */
const encoder = new TextEncoder();
/** 文本 → UTF-8 字节 */
export const utf8 = s => encoder.encode(String(s ?? ''));
const put16 = (buf, p, v) => { buf[p] = v & 0xFF; buf[p + 1] = (v >>> 8) & 0xFF; return p + 2; };
const put32 = (buf, p, v) => {
  buf[p] = v & 0xFF; buf[p + 1] = (v >>> 8) & 0xFF;
  buf[p + 2] = (v >>> 16) & 0xFF; buf[p + 3] = (v >>> 24) & 0xFF;
  return p + 4;
};
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n';

/** XML 转义，并剔除 XML 1.0 不允许的控制字符 */
export function xmlEscape(v) {
  return String(v ?? '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** 0 → A、25 → Z、26 → AA */
export function colLetter(i) {
  let n = Number(i) || 0, s = '';
  do { s = String.fromCharCode(65 + ((n % 26) + 26) % 26) + s; n = Math.floor(n / 26) - 1; } while (n >= 0);
  return s;
}
function colIndex(letters) {
  let n = 0;
  for (const ch of String(letters).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** 工作表名清理：去掉 Excel 非法字符与首尾单引号、压缩空白、限长 31 */
export function safeSheetName(name, index = 1) {
  let s = String(name ?? '').replace(/[\\\/\?\*\[\]:]/g, ' ').replace(/^'+|'+$/g, '').replace(/\s+/g, ' ').trim();
  if (s.length > 31) s = s.slice(0, 31).trim();
  if (!s) s = 'Sheet' + index;
  return s;
}
function uniqueSheetName(name, used) {
  let s = name, i = 2;
  while (used.some(u => u.toLowerCase() === s.toLowerCase())) {
    const suffix = '(' + i + ')';
    s = name.slice(0, 31 - suffix.length) + suffix;
    i++;
  }
  return s;
}

/** 时间值 → Excel 序列号（1900 日期系统；按本地墙上时间换算，避免时区偏移） */
const EXCEL_EPOCH = 25569;   // 1970-01-01 对应的 Excel 序列号
function toDateLike(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === 'number') return isNaN(v) ? null : new Date(v);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0);
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d;
}
export function excelSerial(v) {
  const d = toDateLike(v);
  if (!d) return null;
  const ms = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds());
  return Math.round((ms / 86400000 + EXCEL_EPOCH) * 86400000) / 86400000;   // 保留到毫秒，避免秒级抖动
}

/* ---------------- ZIP（STORE，不压缩） ---------------- */
function dosStamp(when) {
  const d = (when instanceof Date && !isNaN(when.getTime())) ? when : new Date();
  const y = Math.min(2107, Math.max(1980, d.getFullYear()));
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/** 把 [{name, data}] 打成 ZIP（STORE）。CRC32、压缩/原始大小、偏移均按规范填写。 */
export function zipStore(entries, when = new Date()) {
  const files = (entries || []).map(e => {
    const data = (e.data instanceof Uint8Array) ? e.data : utf8(e.data);
    return { name: utf8(e.name), data, crc: crc32(data) };
  });
  const { time, date } = dosStamp(when);
  let localSize = 0, centralSize = 0;
  for (const f of files) { localSize += 30 + f.name.length + f.data.length; centralSize += 46 + f.name.length; }
  const out = new Uint8Array(localSize + centralSize + 22);
  const offsets = [];
  let p = 0;
  for (const f of files) {
    offsets.push(p);
    p = put32(out, p, 0x04034b50);   // local file header
    p = put16(out, p, 20);           // version needed 2.0
    p = put16(out, p, 0x0800);       // bit 11：文件名按 UTF-8 解码
    p = put16(out, p, 0);            // method 0 = STORE
    p = put16(out, p, time);
    p = put16(out, p, date);
    p = put32(out, p, f.crc);
    p = put32(out, p, f.data.length);  // 压缩后大小（STORE 时等于原始大小）
    p = put32(out, p, f.data.length);  // 原始大小
    p = put16(out, p, f.name.length);
    p = put16(out, p, 0);            // extra field 长度
    out.set(f.name, p); p += f.name.length;
    out.set(f.data, p); p += f.data.length;
  }
  const cdStart = p;
  files.forEach((f, i) => {
    p = put32(out, p, 0x02014b50);   // central directory header
    p = put16(out, p, 20);           // version made by
    p = put16(out, p, 20);           // version needed
    p = put16(out, p, 0x0800);
    p = put16(out, p, 0);
    p = put16(out, p, time);
    p = put16(out, p, date);
    p = put32(out, p, f.crc);
    p = put32(out, p, f.data.length);
    p = put32(out, p, f.data.length);
    p = put16(out, p, f.name.length);
    p = put16(out, p, 0);            // extra
    p = put16(out, p, 0);            // comment
    p = put16(out, p, 0);            // 起始磁盘号
    p = put16(out, p, 0);            // 内部属性
    p = put32(out, p, 0);            // 外部属性
    p = put32(out, p, offsets[i]);   // 本地头偏移
    out.set(f.name, p); p += f.name.length;
  });
  const cdSize = p - cdStart;
  p = put32(out, p, 0x06054b50);     // EOCD
  p = put16(out, p, 0);
  p = put16(out, p, 0);
  p = put16(out, p, files.length);
  p = put16(out, p, files.length);
  p = put32(out, p, cdSize);
  p = put32(out, p, cdStart);
  p = put16(out, p, 0);              // 注释长度
  return out;
}

/* ---------------- 样式 ----------------
   两位小数(2)、千分位整数(3) 直接用 Excel 内置格式；
   日期时间用自定义 numFmt 164 = yyyy-mm-dd hh:mm —— 内置 22 在 Excel 里实际显示为 m/d/yy h:mm，
   与车间习惯的「年-月-日 时:分」不一致，因此显式声明格式码。
*/
const STYLE = { general: 0, decimal: 1, number: 2, datetime: 3, header: 4, title: 5, note: 6, group: 7, label: 8 };
const TYPE_STYLE = { text: STYLE.general, number: STYLE.number, decimal: STYLE.decimal, datetime: STYLE.datetime };

const STYLES_XML = XML_HEAD + `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm"/></numFmts>
<fonts count="5">
<font><sz val="10"/><color rgb="FF0F172A"/><name val="微软雅黑"/></font>
<font><b/><sz val="10"/><color rgb="FF0F172A"/><name val="微软雅黑"/></font>
<font><i/><sz val="9"/><color rgb="FF64748B"/><name val="微软雅黑"/></font>
<font><b/><sz val="13"/><color rgb="FF0F172A"/><name val="微软雅黑"/></font>
<font><b/><sz val="10"/><color rgb="FF1E3A8A"/><name val="微软雅黑"/></font>
</fonts>
<fills count="3">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFEFF4FF"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left/><right/><top/><bottom style="thin"><color rgb="FFD3DAE6"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="9">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="3" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="4" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment vertical="center"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="常规" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/>
<tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/>
</styleSheet>`;

/* ---------------- 单元格 ---------------- */
function inlineStrXml(ref, styleIdx, v) {
  return '<c r="' + ref + '" s="' + styleIdx + '" t="inlineStr"><is><t xml:space="preserve">' + xmlEscape(v) + '</t></is></c>';
}
function cellXml(ref, styleIdx, v, type) {
  const t = TYPE_STYLE[type] != null ? type : 'text';
  if (v == null || v === '') return '<c r="' + ref + '" s="' + styleIdx + '"/>';
  if (t === 'number' || t === 'decimal') {
    const s = String(v).trim();
    const n = typeof v === 'number' ? v : (/^-?[\d,]+(\.\d+)?$/.test(s) ? parseFloat(s.replace(/[,\s，]/g, '')) : NaN);
    if (Number.isFinite(n)) return '<c r="' + ref + '" s="' + styleIdx + '" t="n"><v>' + n + '</v></c>';
    return inlineStrXml(ref, styleIdx, v);   // 非数值退化为文本，避免写出坏单元格
  }
  if (t === 'datetime') {
    const serial = excelSerial(v);
    if (serial != null) return '<c r="' + ref + '" s="' + styleIdx + '" t="n"><v>' + serial + '</v></c>';
    return inlineStrXml(ref, styleIdx, v);
  }
  return inlineStrXml(ref, styleIdx, v);
}
function styleOf(col) {
  if (typeof col.style === 'number') return col.style;
  if (typeof col.style === 'string' && STYLE[col.style] != null) return STYLE[col.style];
  return TYPE_STYLE[col.type] != null ? TYPE_STYLE[col.type] : STYLE.general;
}
function normWidth(w) {
  if (w == null) return null;
  const n = typeof w === 'number' ? w : parseFloat(String(w).replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(80, Math.max(6, Math.round(n * 10) / 10));
}

/* ---------------- 工作表 ---------------- */
function buildSheetXml(sheet, name) {
  const columns = (sheet.columns || []).map(c => ({
    header: c.header ?? '', key: c.key ?? c.header ?? '',
    width: normWidth(c.width), type: c.type || 'text', style: c.style,
  }));
  if (!columns.length) throw new Error('工作表「' + name + '」缺少 columns 定义');
  const nCols = columns.length;
  const lastCol = colLetter(nCols - 1);

  const models = [];
  const addMerged = (text, style, h) => models.push({ merge: true, h, cells: [{ v: text, style, type: 'text' }] });

  if (sheet.title) addMerged(sheet.title, STYLE.title, 22);
  for (const line of (sheet.preamble || [])) {
    models.push({ cells: (line || []).map((v, i) => ({ v, style: i === 0 ? STYLE.label : STYLE.general, type: typeof v === 'number' ? 'number' : 'text' })) });
  }
  const headerRow = models.length + 1;
  models.push({ h: 24, cells: columns.map(c => ({ v: c.header, style: STYLE.header, type: 'text' })) });
  let dataRows = 0;
  for (const r of (sheet.rows || [])) {
    if (r && typeof r === 'object' && !Array.isArray(r) && (r.__group != null || r.__note != null || r.__title != null)) {
      if (r.__group != null) addMerged(r.__group, STYLE.group, 18);
      else if (r.__title != null) addMerged(r.__title, STYLE.title, 22);
      else addMerged(r.__note, STYLE.note, null);
      continue;
    }
    models.push({
      cells: columns.map((c, i) => ({
        v: Array.isArray(r) ? r[i] : (r ? r[c.key] : null),
        style: styleOf(c), type: c.type,
      })),
    });
    dataRows++;
  }
  const lastDataRow = models.length;
  if (sheet.note) addMerged(sheet.note, STYLE.note, null);

  const rowsXml = models.map((m, i) => {
    const r = i + 1;
    const cells = m.cells.map((c, ci) => cellXml(colLetter(ci) + r, c.style, c.v, c.type)).join('');
    return '<row r="' + r + '"' + (m.h ? ' ht="' + m.h + '" customHeight="1"' : '') + '>' + cells + '</row>';
  }).join('');

  const merges = [];
  if (nCols > 1) models.forEach((m, i) => { if (m.merge) merges.push('A' + (i + 1) + ':' + lastCol + (i + 1)); });
  const mergeXml = merges.length ? '<mergeCells count="' + merges.length + '">' + merges.map(r => '<mergeCell ref="' + r + '"/>').join('') + '</mergeCells>' : '';

  const colsXml = columns.some(c => c.width)
    ? '<cols>' + columns.map((c, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + (c.width || 12) + '" customWidth="1"/>').join('') + '</cols>'
    : '';

  let afXml = '';
  if (sheet.autoFilter === true && dataRows > 0) afXml = '<autoFilter ref="A' + headerRow + ':' + lastCol + Math.max(headerRow, lastDataRow) + '"/>';
  else if (typeof sheet.autoFilter === 'string' && sheet.autoFilter) afXml = '<autoFilter ref="' + xmlEscape(sheet.autoFilter) + '"/>';

  let ySplit = 0, xSplit = 0;
  const fz = sheet.freeze;
  if (fz === true) ySplit = headerRow;
  else if (typeof fz === 'number' && fz > 0) ySplit = Math.round(fz);
  else if (typeof fz === 'string') {
    const m = /^([A-Za-z]+)?(\d+)?$/.exec(fz.trim());
    if (m && m[2]) { ySplit = +m[2] - 1; xSplit = m[1] ? colIndex(m[1]) : 0; }
  }
  let paneXml = '';
  if (ySplit > 0 || xSplit > 0) {
    const topLeft = colLetter(xSplit) + (ySplit + 1);
    const pane = (xSplit && ySplit) ? 'bottomRight' : (ySplit ? 'bottomLeft' : 'topRight');
    paneXml = '<pane' + (xSplit ? ' xSplit="' + xSplit + '"' : '') + (ySplit ? ' ySplit="' + ySplit + '"' : '') +
      ' topLeftCell="' + topLeft + '" activePane="' + pane + '" state="frozen"/>' +
      '<selection pane="' + pane + '" activeCell="' + topLeft + '" sqref="' + topLeft + '"/>';
  }

  const lastRow = Math.max(1, models.length);
  return XML_HEAD + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
    + '<dimension ref="A1:' + lastCol + lastRow + '"/>'
    + '<sheetViews><sheetView workbookViewId="0">' + paneXml + '</sheetView></sheetViews>'
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + colsXml
    + '<sheetData>' + rowsXml + '</sheetData>'
    + afXml + mergeXml
    + '<pageMargins left="0.4" right="0.4" top="0.55" bottom="0.55" header="0.3" footer="0.3"/>'
    + '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>'
    + '</worksheet>';
}

/* ---------------- 工作簿各部件 ---------------- */
function contentTypesXml(n) {
  let s = XML_HEAD + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
    + '<Default Extension="xml" ContentType="application/xml"/>'
    + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
    + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    + '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>'
    + '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>';
  for (let i = 1; i <= n; i++) s += '<Override PartName="/xl/worksheets/sheet' + i + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
  return s + '</Types>';
}
function rootRelsXml() {
  return XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
    + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>'
    + '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>'
    + '</Relationships>';
}
function coreXml({ title, creator, created }) {
  const iso = (created instanceof Date && !isNaN(created.getTime()) ? created : new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
  return XML_HEAD + '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" '
    + 'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">'
    + (title ? '<dc:title>' + xmlEscape(title) + '</dc:title>' : '')
    + '<dc:creator>' + xmlEscape(creator || '君威智能排产助手') + '</dc:creator>'
    + '<cp:lastModifiedBy>' + xmlEscape(creator || '君威智能排产助手') + '</cp:lastModifiedBy>'
    + '<dcterms:created xsi:type="dcterms:W3CDTF">' + iso + '</dcterms:created>'
    + '<dcterms:modified xsi:type="dcterms:W3CDTF">' + iso + '</dcterms:modified>'
    + '</cp:coreProperties>';
}
function appXml(names, creator) {
  return XML_HEAD + '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" '
    + 'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">'
    + '<HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>工作表</vt:lpstr></vt:variant>'
    + '<vt:variant><vt:i4>' + names.length + '</vt:i4></vt:variant></vt:vector></HeadingPairs>'
    + '<TitlesOfParts><vt:vector size="' + names.length + '" baseType="lpstr">'
    + names.map(n => '<vt:lpstr>' + xmlEscape(n) + '</vt:lpstr>').join('') + '</vt:vector></TitlesOfParts>'
    + '<Application>' + xmlEscape(creator || '君威智能排产助手') + '</Application>'
    + '<AppVersion>1.0</AppVersion><DocSecurity>0</DocSecurity>'
    + '</Properties>';
}
function workbookXml(parts) {
  let s = XML_HEAD + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
    + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + '<workbookPr defaultThemeVersion="124226"/>'
    + '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000" activeTab="0"/></bookViews>'
    + '<sheets>';
  parts.forEach((p, i) => { s += '<sheet name="' + xmlEscape(p.name) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>'; });
  s += '</sheets>';
  // 打印时重复表头行（含前言与表头），现场按页装订不会丢列名
  s += '<definedNames>';
  parts.forEach((p, i) => {
    const q = "'" + p.name.replace(/'/g, "''") + "'";
    s += '<definedName name="_xlnm.Print_Titles" localSheetId="' + i + '">' + xmlEscape(q) + '!$1:$' + p.headerRow + '</definedName>';
  });
  s += '</definedNames><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>';
  return s;
}
function workbookRelsXml(n) {
  let s = XML_HEAD + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
  for (let i = 1; i <= n; i++) {
    s += '<Relationship Id="rId' + i + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + i + '.xml"/>';
  }
  s += '<Relationship Id="rId' + (n + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
  return s + '</Relationships>';
}

/** 生成 XLSX 字节（便于 Node 侧校验；浏览器请用 writeXlsx） */
export function buildXlsx({ sheets = [], created = new Date(), title = '', creator = '君威智能排产助手' } = {}) {
  const list = (sheets || []).filter(Boolean);
  if (!list.length) throw new Error('writeXlsx：至少需要 1 个工作表');
  const used = [];
  const parts = list.map((s, i) => {
    const name = uniqueSheetName(safeSheetName(s.name, i + 1), used);
    used.push(name);
    return { name, xml: buildSheetXml(s, name), headerRow: (s.title ? 1 : 0) + (s.preamble ? s.preamble.length : 0) + 1 };
  });
  const files = [
    { name: '[Content_Types].xml', data: contentTypesXml(parts.length) },
    { name: '_rels/.rels', data: rootRelsXml() },
    { name: 'docProps/core.xml', data: coreXml({ title, creator, created }) },
    { name: 'docProps/app.xml', data: appXml(parts.map(p => p.name), creator) },
    { name: 'xl/workbook.xml', data: workbookXml(parts) },
    { name: 'xl/_rels/workbook.xml.rels', data: workbookRelsXml(parts.length) },
    { name: 'xl/styles.xml', data: STYLES_XML },
  ];
  parts.forEach((p, i) => files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: p.xml }));
  return zipStore(files, created);
}

/** 写出 .xlsx Blob：sheets 形如 [{ name, columns, rows, freeze, autoFilter, note, title, preamble }] */
export function writeXlsx({ sheets = [], created = new Date(), title = '', creator = '君威智能排产助手' } = {}) {
  const bytes = buildXlsx({ sheets, created, title, creator });
  return new Blob([bytes], { type: XLSX_MIME });
}

/** 快速构造工作表：headers 可传字符串数组或 {header,key,width,type} 数组；rows 为对象数组（或数组的数组） */
export function sheetFromRows(name, headers, rows, opts = {}) {
  const columns = (headers || []).map(h => (typeof h === 'string' ? { header: h, key: h, type: 'text' } : Object.assign({ type: 'text' }, h)));
  return Object.assign({}, opts, { name, columns, rows: rows || [] });
}

export { STYLE as XLSX_STYLE };
