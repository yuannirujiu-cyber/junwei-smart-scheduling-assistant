/* 浏览器端零依赖 XLSX / CSV 读取器
 * ------------------------------------------------------------------
 * 技术约束：原生 ES Modules、零第三方依赖、零 CDN，现代 Chrome / Safari 直接可用。
 * 仅使用浏览器原生能力：DOMParser、DecompressionStream、TextDecoder、Blob / Response。
 *
 * 导出：
 *   readXlsx(fileOrArrayBuffer) -> { sheets: [{ name, rows }], meta: { sheetNames, date1904 } }
 *   readCsv(fileOrText)         -> { sheets: [{ name, rows }], meta: { sheetNames, date1904 } }
 *   guessColumnMapping(headers, targetFields) -> { [targetField.key]: columnIndex }
 *
 * 约定：rows[0] 为表头行；单元格值为 string | number | Date | null（布尔/错误值按原始语义返回）。
 *   - 空值统一表示为 null：空字符串单元格（<si><t></t></si>、<is><t></t></is>、<v></v>）
 *     与空数字单元格一样返回 null，不再返回 ""；调用方只需判 null。
 * 实现要点：自行解析 ZIP（EOCD → central directory → local file header），
 * deflate 交给浏览器 DecompressionStream('deflate-raw')，XML 交给 DOMParser。
 * 完整性：每个用到的条目都用中央目录里的 CRC-32 与解压后字节核对，长度或校验和不符一律抛可读错误，
 * 不再静默返回被篡改/被截断的内容。
 * 资源上限（readXlsx 第二个参数可覆盖，默认见 DEFAULT_READ_LIMITS）：
 *   maxRows 单表最大行数 / maxCols 单表最大列数 / maxCells 单表最大单元格总数 / maxPartBytes 单条目解压上限；
 * 超限抛出的错误会写明「哪张表、超了哪个限制、当前值」，避免稀疏表被物化成超大数组导致内存爆炸。
 */

/* ============================ 通用小工具 ============================ */

/** 把上下文收敛成可读错误信息；cause 保留原始错误对象，便于排查根因 */
function fail(msg, cause) {
  const err = new Error(msg);
  if (cause !== undefined && cause !== null) err.cause = cause;
  throw err;
}

/** 资源上限类错误：消息本身已包含表名/限制名/当前值，外层不再二次包裹 */
function failLimit(msg) {
  const err = new Error(msg);
  err.limit = true;
  throw err;
}

/** 取元素属性：优先按限定名（如 r:id），失败再按命名空间 + localName 兜底 */
function attr(el, name, ns, local) {
  if (!el || !el.getAttribute) return null;
  let v = el.getAttribute(name);
  if ((v == null || v === '') && ns && el.getAttributeNS) {
    const v2 = el.getAttributeNS(ns, local);
    if (v2 != null && v2 !== '') v = v2;
  }
  return v == null || v === '' ? null : v;
}

/** 元素/节点的 localName（无命名空间前缀） */
function localNameOf(node) {
  return node.localName || String(node.nodeName || '').replace(/^.*:/, '');
}

/** 直接子元素列表（跳过文本节点，避免 live NodeList 反复求值的开销） */
function childElements(el) {
  const out = [];
  const kids = el.childNodes;
  if (!kids) return out;
  for (let i = 0; i < kids.length; i++) {
    const n = kids[i];
    if (n.nodeType === 1) out.push(n);
  }
  return out;
}

/** 后代元素查询：优先用 DOMParser 文档自带的 getElementsByTagName */
function tags(root, name) {
  if (!root || !root.getElementsByTagName) return [];
  return root.getElementsByTagName(name);
}

/** 取第一个匹配的后代元素 */
function firstTag(root, name) {
  const list = tags(root, name);
  return list && list.length ? list[0] : null;
}

/** 解析 XML 并做错误兜底；label 用于给出「哪一段坏了」的可读提示 */
function parseXml(text, label) {
  if (typeof DOMParser === 'undefined') {
    fail('当前环境不支持 DOMParser，无法解析 Excel 内部 XML');
  }
  let doc;
  try {
    doc = new DOMParser().parseFromString(text, 'application/xml');
  } catch (e) {
    fail('解析 ' + label + ' 的 XML 失败：' + (e && e.message ? e.message : e));
  }
  if (!doc || !doc.documentElement) fail('解析 ' + label + ' 的 XML 失败：文档为空');
  // Chrome / Firefox 解析失败时不会抛错，而是返回带 <parsererror> 的文档
  const errs = tags(doc, 'parsererror');
  if (errs && errs.length) {
    fail('解析 ' + label + ' 的 XML 失败：文件内容不是合法 XML（可能已损坏）');
  }
  if (localNameOf(doc.documentElement) === 'parsererror') {
    fail('解析 ' + label + ' 的 XML 失败：文件内容不是合法 XML（可能已损坏）');
  }
  return doc;
}

/** 字节 → UTF-8 字符串 */
function utf8(bytes) {
  return new TextDecoder('utf-8').decode(bytes);
}

/** Excel 会把控制字符写成 _x000D_ 这类转义，这里还原（仅在该模式出现时才做替换） */
function decodeXEscapes(s) {
  if (!s || s.indexOf('_x') < 0) return s;
  return s.replace(/_x([0-9A-Fa-f]{4})_/g, function (m, hex) {
    return String.fromCharCode(parseInt(hex, 16));
  });
}

/* ============================ 1. ZIP 解析 ============================ */

/* 表驱动 CRC-32（IEEE 802.3 反射多项式 0xEDB88320），与 ZIP 条目校验和口径一致；
 * 不依赖任何库，用于发现「deflate 字节被篡改后仍能解出一部分」的静默损坏。 */
const CRC32_TABLE = (function () {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();

/** 计算字节数组的 CRC-32（无符号 32 位） */
function crc32(bytes) {
  let crc = -1;
  for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ bytes[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** 32 位整数 → 8 位十六进制，用于可读的校验失败信息 */
function hex8(n) {
  return ('00000000' + (n >>> 0).toString(16)).slice(-8);
}

/** 列下标（0 基）→ Excel 列名（0→A、16383→XFD），用于超限报错 */
function colRefName(col) {
  let n = col + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s || 'A';
}

const SIG_EOCD = 0x06054b50;      // 中央目录结束记录
const SIG_EOCD64 = 0x06064b50;    // ZIP64 结束记录
const SIG_EOCD64_LOC = 0x07064b50;// ZIP64 结束记录定位器
const SIG_CD = 0x02014b50;        // 中央目录条目
const SIG_LFH = 0x04034b50;       // 本地文件头

/** 从文件末尾向前定位 EOCD（0x06054b50），最多回退 64KB + 22 字节（注释上限） */
function findEocd(dv, len) {
  const min = Math.max(0, len - 22 - 65535);
  for (let p = len - 22; p >= min; p--) {
    if (dv.getUint32(p, true) === SIG_EOCD) {
      const commentLen = dv.getUint16(p + 20, true);
      if (p + 22 + commentLen <= len) return p;
    }
  }
  return -1;
}

/** 读 64 位小端（用 BigInt 兜底，最终转 Number；Excel 文件不会超过 2^53） */
function readU64(dv, p) {
  if (typeof dv.getBigUint64 === 'function') return Number(dv.getBigUint64(p, true));
  return dv.getUint32(p, true) + dv.getUint32(p + 4, true) * 4294967296;
}

/**
 * 解析 central directory，返回 Map<条目名, {name, method, crc, csize, usize, localOff}>
 * （crc/usize 取自中央目录，供后续完整性校验用）
 * 目录条目（名字以 / 结尾、大小为 0）直接跳过。
 */
function readZipEntries(bytes, dv) {
  const len = bytes.length;
  const eocd = findEocd(dv, len);
  if (eocd < 0) fail('读取 Excel 失败：找不到 ZIP 结尾记录（EOCD），该文件可能不是 .xlsx');

  let count = dv.getUint16(eocd + 10, true);
  let cdOffset = dv.getUint32(eocd + 16, true);

  // ZIP64：EOCD 中字段为 0xFFFF / 0xFFFFFFFF 时改读 ZIP64 结束记录
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const locPos = eocd - 20;
    if (locPos >= 0 && dv.getUint32(locPos, true) === SIG_EOCD64_LOC) {
      const z64 = readU64(dv, locPos + 8);
      if (z64 >= 0 && z64 + 56 <= len && dv.getUint32(z64, true) === SIG_EOCD64) {
        count = readU64(dv, z64 + 32);
        cdOffset = readU64(dv, z64 + 48);
      }
    }
  }
  if (cdOffset < 0 || cdOffset >= len) fail('读取 Excel 失败：ZIP 中央目录偏移非法，文件可能已损坏');

  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > len || dv.getUint32(p, true) !== SIG_CD) break; // 容忍尾部噪声，能读多少读多少
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    let csize = dv.getUint32(p + 20, true);
    let usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    let localOff = dv.getUint32(p + 42, true);
    const name = utf8(bytes.subarray(p + 46, p + 46 + nameLen));

    // ZIP64 扩展字段：按 usize, csize, localOff 的顺序补齐被置为 0xFFFFFFFF 的字段
    if (usize === 0xffffffff || csize === 0xffffffff || localOff === 0xffffffff) {
      let q = p + 46 + nameLen;
      const qEnd = q + extraLen;
      while (q + 4 <= qEnd) {
        const hid = dv.getUint16(q, true);
        const hsz = dv.getUint16(q + 2, true);
        if (hid === 0x0001) {
          let r = q + 4;
          if (usize === 0xffffffff) { usize = readU64(dv, r); r += 8; }
          if (csize === 0xffffffff) { csize = readU64(dv, r); r += 8; }
          if (localOff === 0xffffffff) { localOff = readU64(dv, r); r += 8; }
          break;
        }
        q += 4 + hsz;
      }
    }

    const isDir = name.endsWith('/') && csize === 0;
    if (!isDir && name) {
      entries.set(name, { name: name, method: method, crc: crc, csize: csize, usize: usize, localOff: localOff });
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  if (!entries.size) fail('读取 Excel 失败：ZIP 中央目录为空，文件可能已损坏');
  return entries;
}

/** 从 local file header 取压缩数据区（严格要求 0x04034b50 签名） */
function entryRawBytes(bytes, dv, entry) {
  const p = entry.localOff;
  if (p + 30 > bytes.length || dv.getUint32(p, true) !== SIG_LFH) {
    fail('读取 Excel 失败：条目 ' + entry.name + ' 的本地文件头无效，文件可能已损坏');
  }
  const nameLen = dv.getUint16(p + 26, true);
  const extraLen = dv.getUint16(p + 28, true);
  const start = p + 30 + nameLen + extraLen;
  const end = start + entry.csize;
  if (start > bytes.length || end > bytes.length) {
    fail('读取 Excel 失败：条目 ' + entry.name + ' 声明的数据长度 ' + entry.csize +
      ' 字节超出了文件末尾（文件共 ' + bytes.length + ' 字节），文件已损坏或被截断');
  }
  return bytes.subarray(start, end);
}

/** 流式拼接解压结果；累计超过 maxBytes 立即停手，避免「压缩炸弹」把内存吃光 */
async function collectStream(stream, entryName, maxBytes) {
  const reader = stream.getReader();
  const chunks = [];
  let total = 0;
  let overflow = false;
  for (;;) {
    let step;
    try {
      step = await reader.read();
    } catch (err) {
      // 原始错误挂到 cause：这类失败是「数据坏了」，不是「浏览器不行」
      fail('Excel 内部条目 ' + entryName + ' 解压失败：deflate 数据不完整或已损坏，' +
        '文件可能被截断或篡改', err);
    }
    if (step.done) break;
    const chunk = step.value;
    total += chunk.length;
    if (total > maxBytes) { overflow = true; break; }
    chunks.push(chunk);
  }
  if (overflow) {
    try { await reader.cancel(); } catch (e) { /* 取消失败不影响错误上报 */ }
    fail('Excel 内部条目 ' + entryName + ' 解压后超过 ' + maxBytes + ' 字节上限，已停止解压；' +
      '该文件可能是恶意构造的压缩炸弹，可在 readXlsx 第二个参数中用 maxPartBytes 调整上限');
  }
  const out = new Uint8Array(total);
  let p = 0;
  for (let i = 0; i < chunks.length; i++) { out.set(chunks[i], p); p += chunks[i].length; }
  return out;
}

/** deflate 解压：交给浏览器原生 DecompressionStream('deflate-raw')
 * 失败时区分「当前环境不支持 DecompressionStream」与「文件损坏」，不再统一提示“请升级浏览器” */
async function inflateRaw(bytes, entryName, maxBytes) {
  if (typeof DecompressionStream === 'undefined') {
    fail('当前环境不支持 DecompressionStream，无法解压 xlsx 内部的 deflate 数据；' +
      '请改用较新版本的 Chrome / Edge / Safari，或把数据另存为 .csv 后重新导入');
  }
  let stream;
  try {
    stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  } catch (err) {
    fail('Excel 内部条目 ' + entryName + ' 解压失败：数据不是合法的 deflate 流，文件可能已损坏', err);
  }
  return collectStream(stream, entryName, maxBytes);
}

/** 用中央目录里的长度与 CRC-32 核对解压结果；不符即判定文件损坏/被篡改，绝不静默返回 */
function verifyEntry(entry, data) {
  if (entry.usize !== 0xffffffff && data.length !== entry.usize) {
    fail('读取 Excel 失败：条目 ' + entry.name + ' 解压后为 ' + data.length + ' 字节，' +
      '与中央目录声明的 ' + entry.usize + ' 字节不一致，文件可能已损坏或被截断');
  }
  if (entry.crc !== 0xffffffff) {
    const actual = crc32(data);
    if (actual !== entry.crc) {
      fail('读取 Excel 失败：条目 ' + entry.name + ' 的 CRC-32 校验失败（实际 0x' + hex8(actual) +
        '，期望 0x' + hex8(entry.crc) + '），文件内容已损坏或被篡改');
    }
  }
  return data;
}

/** 读取 ZIP 中某个条目的原始字节；不存在返回 null */
async function readZipBytes(entries, bytes, dv, name, limits) {
  const e = entries.get(name);
  if (!e) return null;
  if (e.usize !== 0xffffffff && e.usize > limits.maxPartBytes) {
    fail('读取 Excel 失败：条目 ' + name + ' 声明的解压后大小 ' + e.usize + ' 字节超过上限 ' +
      limits.maxPartBytes + ' 字节（可在 readXlsx 第二个参数中用 maxPartBytes 调整）');
  }
  const raw = entryRawBytes(bytes, dv, e);
  if (e.method === 0) return verifyEntry(e, raw);                                  // store：直接切片
  if (e.method === 8) return verifyEntry(e, await inflateRaw(raw, name, limits.maxPartBytes)); // deflate
  fail('读取 Excel 失败：条目 ' + name + ' 使用了不支持的压缩方法 ' + e.method);
}

/** 读取 ZIP 条目并解码成文本；不存在返回 null */
async function readZipText(entries, bytes, dv, name, limits) {
  const b = await readZipBytes(entries, bytes, dv, name, limits);
  return b == null ? null : utf8(b);
}

/* ============================ 2. XLSX 结构解析 ============================ */

const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

/** 关系目标路径归一化：相对 xl/ 目录，同时处理绝对路径与 ../ */
function resolvePartPath(target) {
  if (!target) return null;
  let t = String(target).replace(/\\/g, '/').trim();
  if (t.charAt(0) === '/') t = t.slice(1);
  else if (t.indexOf('xl/') !== 0) t = 'xl/' + t;
  const out = [];
  const segs = t.split('/');
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    if (!s || s === '.') continue;
    if (s === '..') out.pop();
    else out.push(s);
  }
  return out.join('/');
}

/** 解析 xl/_rels/workbook.xml.rels → Map<rId, 目标路径> */
function parseWorkbookRels(doc) {
  const map = new Map();
  const rels = tags(doc, 'Relationship');
  for (let i = 0; i < rels.length; i++) {
    const el = rels[i];
    const id = attr(el, 'Id');
    const type = attr(el, 'Type') || '';
    const target = resolvePartPath(attr(el, 'Target'));
    if (!id || !target) continue;
    // 只认工作表关系；chartsheet / 其他部件忽略
    if (type && type.indexOf('/worksheet') < 0) continue;
    map.set(id, target);
  }
  return map;
}

/** 共享字符串表：兼容纯文本 <t>、富文本 <r><t> 与 <rPh> 拼音排除 */
function parseSharedStrings(doc) {
  const list = [];
  const root = firstTag(doc, 'sst') || doc.documentElement;
  const items = childElements(root);
  for (let i = 0; i < items.length; i++) {
    const si = items[i];
    if (localNameOf(si) !== 'si') continue;
    let s = '';
    const kids = childElements(si);
    for (let j = 0; j < kids.length; j++) {
      const k = kids[j];
      const nm = localNameOf(k);
      if (nm === 't') s += k.textContent || '';
      else if (nm === 'r') {
        const runs = childElements(k);
        for (let m = 0; m < runs.length; m++) {
          if (localNameOf(runs[m]) === 't') s += runs[m].textContent || '';
        }
      }
      // rPh（拼音注音）不是单元格内容，跳过
    }
    list.push(decodeXEscapes(s));
  }
  return list;
}

/* 内置日期/时间格式编号：
 * 14–22、45–47 为核心日期时间格式（规范要求）；
 * 27–36、50–58 是 OOXML 中按区域显示的日期时间格式（中日韩 Excel/WPS 常见），一并视为日期。 */
const BUILTIN_DATE_FMT_IDS = (function () {
  const s = new Set();
  const add = function (a, b) { for (let i = a; i <= b; i++) s.add(i); };
  add(14, 22); add(27, 36); add(45, 47); add(50, 58);
  return s;
})();

/** 自定义格式串是否像日期：去掉引号字面量、转义字符与 [..] 段后再找 y/m/d/h */
function looksLikeDateFormat(code) {
  if (!code) return false;
  const cleaned = String(code)
    .replace(/\[[^\]]*\]/g, '')     // [Red] / [$-409] / [>100] 等
    .replace(/"[^"]*"/g, '')        // 引号内是字面量
    .replace(/\\./g, '');           // \ 转义下一个字符
  return /[ymdh]/i.test(cleaned);
}

/** 解析 xl/styles.xml，返回「样式下标 → 是否日期格式」的布尔数组 */
function parseStyleDateFlags(doc) {
  const custom = new Map();
  const fmts = tags(doc, 'numFmt');
  for (let i = 0; i < fmts.length; i++) {
    const id = parseInt(attr(fmts[i], 'numFmtId') || '', 10);
    if (Number.isFinite(id)) custom.set(id, attr(fmts[i], 'formatCode') || '');
  }
  const flags = [];
  const cellXfs = firstTag(doc, 'cellXfs');
  if (cellXfs) {
    const xfs = childElements(cellXfs);
    for (let i = 0; i < xfs.length; i++) {
      if (localNameOf(xfs[i]) !== 'xf') continue;
      const id = parseInt(attr(xfs[i], 'numFmtId') || '0', 10);
      const isDate = BUILTIN_DATE_FMT_IDS.has(id) ||
        (custom.has(id) && looksLikeDateFormat(custom.get(id)));
      flags.push(isDate);
    }
  }
  return flags;
}

const MS_PER_DAY = 86400000;

/** Excel 序列号 → Date（UTC 构造，避免本地时区/夏令时造成跨日偏移）
 * 1900 系统：序列 1 = 1900-01-01；Excel 误把 1900 当闰年，存在不存在的 1900-02-29（序列 60）。
 * 因此序列 < 60 时基准取 1899-12-31，序列 ≥ 61 时基准取 1899-12-30。
 * 序列 60 无法用 JS Date 表示，归到 1900-02-28。
 * 1904 系统：序列 0 = 1904-01-01。 */
function excelSerialToDate(serial, date1904) {
  if (!Number.isFinite(serial)) return null;
  let ms;
  if (date1904) {
    ms = Date.UTC(1904, 0, 1) + serial * MS_PER_DAY;
  } else {
    const adjusted = serial < 60 ? serial + 1 : serial;
    ms = Date.UTC(1899, 11, 30) + adjusted * MS_PER_DAY;
  }
  // 序列号是浮点天数，按秒取整可消除 0.1 天之类的二进制误差
  ms = Math.round(ms / 1000) * 1000;
  const d = new Date(ms);
  return Number.isFinite(d.getTime()) ? d : null;
}

/** 单元格引用 "C5" → 列下标 2（只解析字母部分，0 基） */
function colOfRef(ref) {
  let n = 0, seen = false;
  for (let i = 0; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    let v = -1;
    if (c >= 65 && c <= 90) v = c - 64;        // A-Z
    else if (c >= 97 && c <= 122) v = c - 96;  // a-z
    if (v < 0) break;
    n = n * 26 + v;
    seen = true;
  }
  return seen ? n - 1 : -1;
}

/** 富文本容器（<is> / <si>）取纯文本 */
function richTextOf(el) {
  let s = '';
  const kids = childElements(el);
  for (let i = 0; i < kids.length; i++) {
    const nm = localNameOf(kids[i]);
    if (nm === 't') s += kids[i].textContent || '';
    else if (nm === 'r') {
      const runs = childElements(kids[i]);
      for (let j = 0; j < runs.length; j++) {
        if (localNameOf(runs[j]) === 't') s += runs[j].textContent || '';
      }
    }
  }
  return decodeXEscapes(s);
}

/** 空字符串按「空单元格」处理，统一返回 null（与空数字单元格、<si><t></t></si> 口径一致） */
function emptyToNull(s) {
  return s == null || s === '' ? null : s;
}

/**
 * 单元格取值。
 * t="s" 共享字符串；t="inlineStr" 取 is/t；t="str" 取 v（公式字符串）；
 * t="b" 布尔；t="e" 错误值（返回原始文本）；t="d" ISO 日期；无 t 视为数字。
 * 数字若命中日期样式则转 Date。空单元格与空字符串一律返回 null（列位置由调用方按 r 属性补齐）。
 */
function cellValue(cell, ctx) {
  const t = attr(cell, 't') || 'n';
  const sIdx = parseInt(attr(cell, 's') || '-1', 10);
  let vText = null;
  let isEl = null;
  const kids = childElements(cell);
  for (let i = 0; i < kids.length; i++) {
    const nm = localNameOf(kids[i]);
    if (nm === 'v') vText = kids[i].textContent;
    else if (nm === 'is') isEl = kids[i];
  }

  if (t === 'inlineStr') return isEl ? emptyToNull(richTextOf(isEl)) : null;
  if (t === 's') {
    if (vText == null || vText === '') return null;
    const idx = parseInt(vText, 10);
    const v = ctx.sharedStrings[idx];
    return v === undefined ? null : emptyToNull(v);
  }
  if (t === 'str') return vText == null ? null : emptyToNull(decodeXEscapes(vText));
  if (t === 'b') return vText === '1' || String(vText).toLowerCase() === 'true';
  if (t === 'e') return vText == null ? null : emptyToNull(vText);   // #N/A、#DIV/0! 等原样返回
  if (t === 'd') {
    if (!vText) return null;
    const d = new Date(vText);
    return Number.isFinite(d.getTime()) ? d : vText;
  }
  if (vText == null || vText === '') return null;
  const num = Number(vText);
  if (!Number.isFinite(num)) return decodeXEscapes(vText);
  if (sIdx >= 0 && ctx.dateStyles[sIdx]) {
    const d = excelSerialToDate(num, ctx.date1904);
    if (d) return d;
  }
  return num;
}

/** 取出 sheetData 下的 row 元素（避免全树扫描）；退化时回落到 getElementsByTagName */
function rowElementsOf(doc) {
  const sheetData = firstTag(doc, 'sheetData');
  if (!sheetData) return tags(doc, 'row');
  const out = [];
  const kids = childElements(sheetData);
  for (let i = 0; i < kids.length; i++) {
    if (localNameOf(kids[i]) === 'row') out.push(kids[i]);
  }
  return out;
}

/**
 * 解析一张工作表 → rows（行 0 为表头行）
 * - 行按 r 属性落位，缺行补空行，保证行不错位；行号推进只增不减，
 *   乱序行（如先 r=3 后 r=2）之后的无 @r 行不会再落回已写过的下标、覆盖销毁前面的行；
 * - 行内按单元格 r 属性的列号落位，中间空单元格补 null，保证列不错位；
 * - 行宽取「有值单元格」的最大列号（WPS 会在极远处留下只有样式的空单元格，
 *   例如拉丝表里存在 XCR2 这类空壳，不能据此把行撑到 1.6 万列）；
 * - 末尾整行为空的行裁掉，其余行统一补齐到本表最大宽度；
 * - 全程先按稀疏结构记账，只在最后按最终宽度物化；行数 / 列数 / 单元格总数任一超限
 *   立即抛出可读错误（含表名、限制名、当前值），避免「1.4KB 的 xlsx 放大成几百 MB 数组」。
 */
function parseSheetRows(doc, ctx, sheetName) {
  const limits = ctx.limits;
  const rowEls = rowElementsOf(doc);
  const rows = [];
  let width = 0;
  let lastRow = -1;
  let nextIdx = 0;

  for (let i = 0; i < rowEls.length; i++) {
    const rowEl = rowEls[i];
    const rNum = parseInt(attr(rowEl, 'r') || '', 10);
    const rIdx = Number.isFinite(rNum) && rNum > 0 ? rNum - 1 : nextIdx;
    if (rIdx + 1 > limits.maxRows) {
      failLimit('工作表「' + sheetName + '」行号 ' + (rIdx + 1) + ' 超过单表最大行数上限 ' + limits.maxRows +
        '（可在 readXlsx 第二个参数中用 maxRows 调整）');
    }
    if (rIdx + 1 > nextIdx) nextIdx = rIdx + 1;   // 只增不减：下一行的落位不回退、不覆盖已写行

    const cells = childElements(rowEl);
    const vals = [];       // [列下标, 值]
    let maxCol = -1;
    let nextCol = 0;
    for (let j = 0; j < cells.length; j++) {
      const c = cells[j];
      if (localNameOf(c) !== 'c') continue;
      const ref = attr(c, 'r');
      const col = ref ? colOfRef(ref) : nextCol;
      if (col < 0) continue;
      if (col + 1 > nextCol) nextCol = col + 1;
      const v = cellValue(c, ctx);
      if (v === null) continue;                   // 只有样式没有值的空壳：跳过，且不参与撑宽
      if (col + 1 > limits.maxCols) {
        failLimit('工作表「' + sheetName + '」列号 ' + (col + 1) + '（' + colRefName(col) +
          '）超过单表最大列数上限 ' + limits.maxCols + '（可在 readXlsx 第二个参数中用 maxCols 调整）');
      }
      vals.push([col, v]);
      if (col > maxCol) maxCol = col;
    }

    if (maxCol >= 0) {
      const arr = new Array(maxCol + 1).fill(null);
      for (let k = 0; k < vals.length; k++) arr[vals[k][0]] = vals[k][1];
      rows[rIdx] = arr;
      if (maxCol + 1 > width) width = maxCol + 1;
      if (rIdx > lastRow) lastRow = rIdx;
      // 纯空区域也要记账：最终稠密结果至少有 (lastRow+1) × width 个格子
      const projected = (lastRow + 1) * width;
      if (projected > limits.maxCells) {
        failLimit('工作表「' + sheetName + '」按已读到的行列推算共 ' + projected +
          ' 个单元格，超过单表最大单元格数上限 ' + limits.maxCells +
          '（可在 readXlsx 第二个参数中用 maxCells 调整）');
      }
    }
  }

  const out = [];
  const end = Math.min(rows.length, lastRow + 1);
  for (let i = 0; i < end; i++) {
    const r = rows[i];
    if (!r) { out.push(new Array(width).fill(null)); continue; }
    if (r.length < width) {
      const padded = r.slice();
      while (padded.length < width) padded.push(null);
      out.push(padded);
    } else {
      out.push(r);
    }
  }
  const total = out.length * width;
  if (total > limits.maxCells) {
    failLimit('工作表「' + sheetName + '」单元格总数 ' + total + ' 超过单表最大单元格数上限 ' +
      limits.maxCells + '（可在 readXlsx 第二个参数中用 maxCells 调整）');
  }
  return out;
}

/** 统一把 File / Blob / ArrayBuffer / TypedArray 归一成 Uint8Array */
async function toBytes(input) {
  if (!input) fail('读取失败：没有拿到文件内容');
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  if (typeof input.arrayBuffer === 'function') return new Uint8Array(await input.arrayBuffer());
  fail('读取失败：readXlsx 需要 File / Blob / ArrayBuffer');
}

/** 默认资源上限：单表 20 万行 / 1024 列 / 500 万单元格、单个条目解压后 128MB
 *  （真实数据包最大条目解压后约 21MB，留有充足余量；恶意稀疏表会被这几道闸门挡住） */
export const DEFAULT_READ_LIMITS = Object.freeze({
  maxRows: 200000,
  maxCols: 1024,
  maxCells: 5000000,
  maxPartBytes: 128 * 1024 * 1024,
});

/** 归一化调用方传入的上限；非法值回落到默认值 */
function normalizeLimits(options) {
  const o = options || {};
  const pick = function (v, d) {
    return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : d;
  };
  return {
    maxRows: pick(o.maxRows, DEFAULT_READ_LIMITS.maxRows),
    maxCols: pick(o.maxCols, DEFAULT_READ_LIMITS.maxCols),
    maxCells: pick(o.maxCells, DEFAULT_READ_LIMITS.maxCells),
    maxPartBytes: pick(o.maxPartBytes, DEFAULT_READ_LIMITS.maxPartBytes),
  };
}

/**
 * 读取 .xlsx
 * @param {File|Blob|ArrayBuffer|Uint8Array} fileOrArrayBuffer
 * @param {{maxRows?: number, maxCols?: number, maxCells?: number, maxPartBytes?: number}} [options] 资源上限覆盖
 * @returns {Promise<{sheets: {name: string, rows: any[][], }[], meta: {sheetNames: string[], date1904: boolean}}>}
 */
export async function readXlsx(fileOrArrayBuffer, options) {
  const limits = normalizeLimits(options);
  const bytes = await toBytes(fileOrArrayBuffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = readZipEntries(bytes, dv);

  /* ---- 工作簿主体：工作表名 + r:id + 1904 日期系统 ---- */
  const wbText = await readZipText(entries, bytes, dv, 'xl/workbook.xml', limits);
  if (wbText == null) fail('读取 Excel 失败：缺少 xl/workbook.xml，该文件可能不是有效的 .xlsx');
  const wbDoc = parseXml(wbText, 'xl/workbook.xml');

  const wbPr = firstTag(wbDoc, 'workbookPr');
  const date1904 = wbPr ? /^(1|true)$/i.test(attr(wbPr, 'date1904') || '') : false;

  /* ---- 关系表：r:id → 实际工作表文件（顺序未必对应 sheet1/2/3） ---- */
  let relMap = new Map();
  const relText = await readZipText(entries, bytes, dv, 'xl/_rels/workbook.xml.rels', limits);
  if (relText != null) relMap = parseWorkbookRels(parseXml(relText, 'xl/_rels/workbook.xml.rels'));

  /* ---- 共享字符串 ---- */
  let sharedStrings = [];
  const sstText = await readZipText(entries, bytes, dv, 'xl/sharedStrings.xml', limits);
  if (sstText != null) sharedStrings = parseSharedStrings(parseXml(sstText, 'xl/sharedStrings.xml'));

  /* ---- 样式：哪些 xf 是日期格式 ---- */
  let dateStyles = [];
  const styleText = await readZipText(entries, bytes, dv, 'xl/styles.xml', limits);
  if (styleText != null) dateStyles = parseStyleDateFlags(parseXml(styleText, 'xl/styles.xml'));

  /* ---- 逐表解析 ---- */
  const sheetsEl = firstTag(wbDoc, 'sheets');
  const sheetEls = sheetsEl ? childElements(sheetsEl).filter(function (el) { return localNameOf(el) === 'sheet'; })
    : tags(wbDoc, 'sheet');
  if (!sheetEls.length) fail('读取 Excel 失败：工作簿中没有任何工作表');

  const ctx = { sharedStrings: sharedStrings, dateStyles: dateStyles, date1904: date1904, limits: limits };
  const sheets = [];
  const sheetNames = [];
  for (let i = 0; i < sheetEls.length; i++) {
    const el = sheetEls[i];
    const name = attr(el, 'name') || ('Sheet' + (i + 1));
    sheetNames.push(name);
    const rid = attr(el, 'r:id', NS_REL, 'id');
    let path = rid ? relMap.get(rid) : null;
    if (!path) path = 'xl/worksheets/sheet' + (i + 1) + '.xml';  // 兜底：按序号猜

    const xml = await readZipText(entries, bytes, dv, path, limits);
    if (xml == null) {
      fail('读取工作表「' + name + '」失败：压缩包内找不到 ' + path);
    }
    const doc = parseXml(xml, '工作表「' + name + '」(' + path + ')');
    let rows;
    try {
      rows = parseSheetRows(doc, ctx, name);
    } catch (e) {
      if (e && e.limit) throw e;   // 上限错误已写明表名/限制/当前值，不再二次包裹
      fail('解析工作表「' + name + '」失败：' + (e && e.message ? e.message : e));
    }
    sheets.push({ name: name, rows: rows });
  }

  return { sheets: sheets, meta: { sheetNames: sheetNames, date1904: date1904 } };
}

/* ============================ 3. CSV 解析 ============================ */

/** 按指定编码严格解码；遇到非法字节序列返回 null（不抛错，便于逐级回退判断） */
function decodeStrict(bytes, encoding) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch (e) {
    return null;
  }
}

/** 统计奇/偶某一路字节里 0x00 的比例：UTF-16 文本每隔一个字节就是 0x00 */
function nulRatio(bytes, offset) {
  let n = 0, zeros = 0;
  const end = Math.min(bytes.length, 4096);
  for (let i = offset; i < end; i += 2) { n++; if (bytes[i] === 0) zeros++; }
  return n ? zeros / n : 0;
}

/** 无 BOM 时的 UTF-16 判别：返回 'utf-16le' / 'utf-16be' / null
 *  CSV 里必然有逗号/换行/数字等 ASCII 字符，它们在 UTF-16 中高字节为 0x00，
 *  因此「一路几乎全是 0x00、另一路几乎没有」是可靠的判别特征。 */
function guessUtf16(bytes) {
  if (bytes.length < 4 || bytes.length % 2 !== 0) return null;
  const even = nulRatio(bytes, 0);
  const odd = nulRatio(bytes, 1);
  if (odd >= 0.25 && even <= 0.05) return 'utf-16le';
  if (even >= 0.25 && odd <= 0.05) return 'utf-16be';
  return null;
}

/** Blob → 文本：BOM 优先（UTF-8 / UTF-16LE / UTF-16BE）→ 无 BOM 的 UTF-16 特征 → 严格 UTF-8
 *  → GBK（中文 Windows 导出常见）→ 都失败时抛可读错误。
 *  绝不在编码不明时“凑合解码”，宁可报错也不把乱码当成功。 */
async function blobToText(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return utf8(buf.subarray(3));   // UTF-8 BOM
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    const s = decodeStrict(buf.subarray(2), 'utf-16le');
    if (s === null) fail('读取 CSV 失败：文件带 UTF-16LE BOM，但内容不是合法的 UTF-16 文本，文件可能已损坏');
    return s;
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const s = decodeStrict(buf.subarray(2), 'utf-16be');
    if (s === null) fail('读取 CSV 失败：文件带 UTF-16BE BOM，但内容不是合法的 UTF-16 文本，文件可能已损坏');
    return s;
  }
  const utf16 = guessUtf16(buf);
  if (utf16) {
    const s = decodeStrict(buf, utf16);
    if (s !== null) return s;
  }
  const asUtf8 = decodeStrict(buf, 'utf-8');
  if (asUtf8 !== null) return asUtf8;
  const asGbk = decodeStrict(buf, 'gbk');
  if (asGbk !== null && asGbk.indexOf('\ufffd') < 0) return asGbk;
  fail('读取 CSV 失败：无法确定文件编码（既不是 UTF-8 / UTF-16，也不是 GBK）。' +
    '请在 Excel「另存为」时选择「CSV UTF-8（逗号分隔）」，或另存为 UTF-8 文本后重试');
}

/** 嗅探分隔符：只统计「表头行」（第一个非空行）里引号外的逗号 / 制表符 / 分号，取最多者，并列时优先逗号。
 *  只看表头是为了避免正文里的逗号（如 "1,5" 这类小数写法）投票把分隔符选错。 */
function sniffDelimiter(text) {
  const counts = { ',': 0, '\t': 0, ';': 0 };
  let i = 0;
  // 跳过表头之前的空行
  while (i < text.length && (text[i] === '\r' || text[i] === '\n')) {
    if (text[i] === '\r' && text[i + 1] === '\n') i += 2; else i++;
  }
  let inQ = false;
  let atFieldStart = true;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\r' || ch === '\n') break;                 // 表头行结束，正文不参与投票
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { i++; continue; }          // "" 转义，仍处于引用态
        inQ = false;
      }
      continue;
    }
    if (ch === '"' && atFieldStart) { inQ = true; atFieldStart = false; continue; }
    atFieldStart = false;
    if (counts[ch] !== undefined) counts[ch]++;
  }
  let best = ',';
  let bestN = -1;
  const keys = [',', '\t', ';'];
  for (let i2 = 0; i2 < keys.length; i2++) {
    if (counts[keys[i2]] > bestN) { bestN = counts[keys[i2]]; best = keys[i2]; }
  }
  return best;
}

/** 纯数字字段转 number，但只在「无损往返」时才转：String(Number(s)) === s。
 *  这样 12345678901234567890（超过 Number.MAX_SAFE_INTEGER）会保持字符串，
 *  "0.10"、"007"、"250529243-01" 等带前导零/非数字形态也一律留字符串，不会静默失真。 */
function csvCell(raw) {
  if (raw === '') return null;
  if (/^-?(0|[1-9]\d*)(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    if (Number.isFinite(n) && String(n) === raw) return n;
  }
  return raw;
}

/** 分隔文本 → 二维数组：支持引号包裹、"" 转义、\r\n / \n / \r 三种换行。
 *  按 RFC4180 收紧引号语义：只有出现在「字段起始位置」的 " 才进入引用态；
 *  字段中间出现的裸引号（如规格里的英寸符号 1/2"）按普通字符处理，不再吞掉该行余下内容。 */
function parseDelimited(text, delim) {
  const rows = [];
  let row = [];
  let field = '';
  let inQ = false;
  let atFieldStart = true;
  let i = 0;
  const len = text.length;
  while (i < len) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQ = false; atFieldStart = false; i++; continue;
      }
      field += ch; i++; continue;
    }
    if (ch === '"' && atFieldStart) { inQ = true; atFieldStart = false; i++; continue; }
    if (ch === delim) { row.push(csvCell(field)); field = ''; atFieldStart = true; i++; continue; }
    if (ch === '\r' || ch === '\n') {
      row.push(csvCell(field)); field = '';
      rows.push(row); row = []; atFieldStart = true;
      if (ch === '\r' && text[i + 1] === '\n') i += 2; else i++;
      continue;
    }
    field += ch; atFieldStart = false; i++;
  }
  if (field !== '' || row.length) { row.push(csvCell(field)); rows.push(row); }

  // 裁掉末尾整行为空的行（文件末尾换行造成的空行）
  while (rows.length) {
    const last = rows[rows.length - 1];
    let empty = true;
    for (let k = 0; k < last.length; k++) { if (last[k] !== null && last[k] !== '') { empty = false; break; } }
    if (empty) rows.pop(); else break;
  }
  return rows;
}

/**
 * 读取 .csv / .tsv（也接受已经是文本的字符串）
 * @param {File|Blob|string} fileOrText
 * @returns {Promise<{sheets: {name: string, rows: any[][]}[], meta: {sheetNames: string[], date1904: boolean}}>}
 */
export async function readCsv(fileOrText) {
  let text;
  let name = 'CSV';
  if (typeof fileOrText === 'string') {
    text = fileOrText;
  } else if (fileOrText && typeof fileOrText.arrayBuffer === 'function') {
    text = await blobToText(fileOrText);
    if (fileOrText.name) name = String(fileOrText.name).replace(/\.[^.]+$/, '') || 'CSV';
  } else {
    fail('读取失败：readCsv 需要 File / Blob / 字符串');
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);   // 去 UTF-8 BOM

  const delim = sniffDelimiter(text);
  const rows = parseDelimited(text, delim);
  return {
    sheets: [{ name: name, rows: rows }],
    meta: { sheetNames: [name], date1904: false },
  };
}

/* ============================ 4. 表头自动映射 ============================ */

/** 归一化表头文本：全角转半角、去空白与常见分隔符、转小写 */
function normLabel(v) {
  if (v == null) return '';
  let s = String(v);
  // 全角 ASCII（！-～）转半角，全角空格转普通空格
  s = s.replace(/[\uff01-\uff5e]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xfee0); })
    .replace(/\u3000/g, ' ');
  return s.toLowerCase()
    .replace(/[\s\-_/\\()[\]{}<>、,，.。:：;；'"“”‘’|+*#]/g, '');
}

/**
 * 依据别名猜测列映射
 * @param {string[]} headers 表头行
 * @param {{key: string, label?: string, aliases?: string[]}[]} targetFields 目标字段定义
 * @returns {{[key: string]: number}} 命中的字段 → 列下标；未命中不返回
 */
export function guessColumnMapping(headers, targetFields) {
  const hs = [];
  const list = headers || [];
  for (let i = 0; i < list.length; i++) hs.push(normLabel(list[i]));

  const out = {};
  const fields = targetFields || [];
  for (let f = 0; f < fields.length; f++) {
    const field = fields[f];
    if (!field || !field.key) continue;
    const aliases = [];
    if (field.label) aliases.push(normLabel(field.label));
    const rawAliases = field.aliases || [];
    for (let a = 0; a < rawAliases.length; a++) {
      const n = normLabel(rawAliases[a]);
      if (n) aliases.push(n);
    }
    const usable = aliases.filter(function (a) { return a; });
    if (!usable.length) continue;

    // 第一轮：完全相同（最可靠）
    let hit = -1;
    for (let i = 0; i < hs.length && hit < 0; i++) {
      if (!hs[i]) continue;
      for (let a = 0; a < usable.length; a++) {
        if (hs[i] === usable[a]) { hit = i; break; }
      }
    }
    // 第二轮：互相包含（如「内部订单单号-序号-次序号」包含「内部订单单号」）
    if (hit < 0) {
      for (let i = 0; i < hs.length && hit < 0; i++) {
        if (!hs[i]) continue;
        for (let a = 0; a < usable.length; a++) {
          if (hs[i].indexOf(usable[a]) >= 0 || usable[a].indexOf(hs[i]) >= 0) { hit = i; break; }
        }
      }
    }
    if (hit >= 0) out[field.key] = hit;
  }
  return out;
}
