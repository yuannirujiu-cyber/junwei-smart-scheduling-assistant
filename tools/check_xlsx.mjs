#!/usr/bin/env node
/* 自检脚本：验证 web/src/export/xlsxWriter.js 产出的 .xlsx 字节能否被 Python 的 zipfile / openpyxl 读回。
   用法：node tools/check_xlsx.mjs [输出文件路径]
   校验项：
   1) writeXlsx 返回的 Blob 类型与字节；
   2) ZIP 结构（条目、CRC32、大小）—— 由 Python zlib 独立校验（zipfile.testzip）；
   3) 工作表内容 —— 中文、特殊字符、数值、两位小数、日期时间、合并单元格、冻结窗格、自动筛选、工作表名清理。
   依赖：Node 18+；python3（openpyxl 可选，缺省时只做 ZIP 校验）。openpyxl 位于 ../../.pylibs。
   退出码：0 全部通过；1 存在失败项。
*/
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, resolve, join, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');                      // 君威智能排产助手
const PYLIBS = resolve(ROOT, '..', '.pylibs');         // 黑客松 .../.pylibs
const WRITER = resolve(ROOT, 'web/src/export/xlsxWriter.js');
/* 输出路径必须显式用 --out 指定（审查报告 P2-6）：
   早期把 argv[2] 当输出路径，与其它脚本「argv[2] = 输入数据路径」的约定冲突，
   一条复制粘贴的命令就能把 data/dataset.json 静默写成一个 xlsx。
   现在：① 只认 --out；② 拒绝写入 data/ 目录；③ 拒绝覆盖任何已存在的非 .xlsx 文件；④ 位置参数一律拒绝。 */
function resolveOut(argv) {
  /* 位置参数判定必须跳过 --out 的取值：早期写法把 --out 后面的路径也当成位置参数，
     导致「--out /tmp/x.xlsx」被自己拒绝（同一处逻辑两次踩坑，这里显式跳过）。 */
  const pos = [];
  for (let k = 2; k < argv.length; k++) {
    const a = argv[k];
    if (a === '--out') { k++; continue; }
    if (a.startsWith('--out=')) continue;
    if (!a.startsWith('--')) pos.push(a);
  }
  if (pos.length) {
    console.error('拒绝执行：本脚本不再接受位置参数（' + pos.join(' ') + '）。');
    console.error('输出路径请用：--out /tmp/xxx.xlsx（不写则落到临时目录）。');
    process.exit(2);
  }
  let raw = null;
  const i = argv.indexOf('--out');
  if (i >= 0) raw = argv[i + 1] || '';
  const eq = argv.find(a => a.startsWith('--out='));
  if (eq) raw = eq.slice('--out='.length);
  if (raw == null) return join(tmpdir(), 'jw-check-xlsx.xlsx');
  const p = resolve(raw);
  const dataDir = resolve(ROOT, 'data') + sep;
  if (p.startsWith(dataDir)) { console.error('拒绝写入 data/ 目录：' + p); process.exit(2); }
  if (!/\.xlsx$/i.test(p)) { console.error('输出文件必须以 .xlsx 结尾：' + p); process.exit(2); }
  if (existsSync(p)) { console.error('拒绝覆盖已存在的文件：' + p); process.exit(2); }
  return p;
}
const OUT = resolveOut(process.argv);

/* ---------------- 载入写入器（无 package.json 时 .js 会被当作 CommonJS，回退到 data: URL） ---------------- */
async function loadWriter() {
  try { return await import(pathToFileURL(WRITER).href); } catch (e) { /* 回退 */ }
  const src = await readFile(WRITER, 'utf8');
  return await import('data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64'));
}

/* ---------------- 构造成例工作簿 ---------------- */
function build() {
  return [
    {
      name: '排产清单',
      columns: [
        { header: '订单号', key: 'orderId', width: 16 },
        { header: '数量', key: 'qty', width: 10, type: 'number' },
        { header: '换型耗时(h)', key: 'setupHours', width: 11, type: 'decimal' },
        { header: '加工开始', key: 'start', width: 18, type: 'datetime' },
        { header: '交期政策', key: 'policy', width: 20 },
      ],
      rows: [
        { orderId: 'DEMO-2026-0001', qty: 2000, setupHours: 3.5, start: new Date(2026, 8, 21, 8, 0), policy: '硬交期（不允许延期）' },
        { orderId: 'DEMO-2026-0002', qty: 12345, setupHours: 0, start: new Date(2026, 8, 22, 13, 30), policy: '软交期（宽限 ≤72 小时）' },
      ],
      title: '排产清单 · 版本 V1 ·【模拟结果，含未验证参数】',
      preamble: [['版本号', 'V1'], ['模拟结果标识', '模拟结果，含未验证参数'], ['特殊字符', '中文 & <标签> "双引号" 与 单引号']],
      freeze: true,
      autoFilter: true,
      note: '自检样例：仅用于验证导出器字节正确性，非真实计划。',
    },
    { name: '非法/名称:测试[1]', columns: [{ header: '列A', key: 'a' }, { header: '列B', key: 'b' }], rows: [[1, 'x']] },
    { name: '排产清单', columns: [{ header: '重名测试', key: 'x' }], rows: [['去重']] },
  ];
}

/* ---------------- 纯 Node 的 ZIP 结构自检（Python 不可用时的兜底） ---------------- */
function nodeZipCheck(bytes, crc32) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocdSig = 0x06054b50, cdSig = 0x02014b50, lfSig = 0x04034b50;
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 65536; i--) {
    if (dv.getUint32(i, true) === eocdSig) { eocd = i; break; }
  }
  if (eocd < 0) return { ok: false, error: '未找到 EOCD 结束记录' };
  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOffset = dv.getUint32(eocd + 16, true);
  const problems = [];
  const names = [];
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== cdSig) { problems.push('中央目录记录签名错误 @' + p); break; }
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const cmtLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = Buffer.from(bytes.subarray(p + 46, p + 46 + nameLen)).toString('utf8');
    names.push(name);
    if (dv.getUint32(localOff, true) !== lfSig) problems.push(name + '：本地头签名错误');
    const lNameLen = dv.getUint16(localOff + 26, true);
    const lExtraLen = dv.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const data = bytes.subarray(dataStart, dataStart + csize);
    if (csize !== usize) problems.push(name + '：STORE 方式下压缩大小与原始大小不一致');
    if (bytes.length < dataStart + csize) problems.push(name + '：数据区越界');
    if (crc32(data) !== crc) problems.push(name + '：CRC32 不匹配');
    p += 46 + nameLen + extraLen + cmtLen;
  }
  if (p - cdOffset !== cdSize) problems.push('中央目录大小与 EOCD 记录不一致');
  return { ok: problems.length === 0, count, names, problems };
}

/* ---------------- Python 校验：zipfile（CRC）+ openpyxl（内容） ---------------- */
const PY = [
  'import json, sys, zipfile',
  'out = {"ok": False}',
  'path = sys.argv[1]',
  'z = zipfile.ZipFile(path)',
  'bad = z.testzip()',
  'out["entries"] = z.namelist()',
  'out["crc_ok"] = bad is None',
  'out["crc_bad_entry"] = bad',
  'out["ok"] = True',
  'try:',
  '    from openpyxl import load_workbook',
  '    out["openpyxl"] = True',
  '    wb = load_workbook(path)',
  '    sheets = []',
  '    for ws in wb.worksheets:',
  '        rows = []',
  '        for row in ws.iter_rows(values_only=True):',
  '            vals = []',
  '            for v in row:',
  '                if v is None:',
  '                    vals.append(None)',
  '                elif hasattr(v, "isoformat"):',
  '                    vals.append(v.isoformat())',
  '                else:',
  '                    vals.append(v)',
  '            rows.append(vals)',
  '        sheets.append({"title": ws.title, "dims": ws.dimensions, "freeze": ws.freeze_panes,',
  '                        "filter": ws.auto_filter.ref, "merges": [str(m) for m in ws.merged_cells.ranges],',
  '                        "rows": rows})',
  '    out["sheets"] = sheets',
  'except ImportError as e:',
  '    out["openpyxl"] = False',
  '    out["openpyxlError"] = str(e)',
  'except Exception as e:',
  '    out["openpyxl"] = False',
  '    out["openpyxlError"] = repr(e)',
  'print(json.dumps(out, ensure_ascii=False))',
].join('\n');

function runPython(file) {
  const env = Object.assign({}, process.env);
  env.PYTHONPATH = env.PYTHONPATH ? PYLIBS + ':' + env.PYTHONPATH : PYLIBS;
  const r = spawnSync('python3', ['-c', PY, file], { env, encoding: 'utf8' });
  if (r.error) return { available: false, error: String(r.error.message || r.error) };
  if (r.status !== 0) return { available: true, ok: false, error: (r.stderr || '').trim() || ('退出码 ' + r.status) };
  try { return Object.assign({ available: true }, JSON.parse(r.stdout)); }
  catch (e) { return { available: true, ok: false, error: 'Python 输出无法解析：' + String(r.stdout).slice(0, 200) }; }
}

/* ---------------- 主流程 ---------------- */
const writer = await loadWriter();
const { writeXlsx, crc32, XLSX_MIME } = writer;
const sheets = build();
const blob = writeXlsx({ sheets, title: '导出器自检', creator: '君威智能排产助手' });
const bytes = new Uint8Array(await blob.arrayBuffer());
await writeFile(OUT, bytes);

const results = [];
const check = (name, pass, detail) => { results.push({ name, pass: !!pass, detail: detail || '' }); };

check('writeXlsx 返回 Blob 且 MIME 正确', blob instanceof Blob && blob.type === XLSX_MIME, blob.type);
check('字节非空', bytes.length > 1000, bytes.length + ' 字节');

const nz = nodeZipCheck(bytes, crc32);
check('Node 侧 ZIP 结构（签名/大小/CRC32）', nz.ok, nz.ok ? nz.count + ' 个条目' : (nz.problems || []).join('；'));

const expectedEntries = ['[Content_Types].xml', '_rels/.rels', 'docProps/core.xml', 'docProps/app.xml',
  'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml', 'xl/worksheets/sheet3.xml'];
check('ZIP 条目齐全', expectedEntries.every(e => (nz.names || []).includes(e)), (nz.names || []).join(', '));

const py = runPython(OUT);
if (!py.available) {
  check('Python 可用（zipfile/openpyxl 读回）', false, '未找到 python3：' + py.error);
} else if (!py.ok) {
  check('Python 可读取该文件', false, py.error || '未知错误');
} else {
  check('Python zipfile 读取 + CRC 校验（zlib 独立校验）', py.crc_ok === true, py.crc_ok === true ? '全部条目 CRC 正确' : ('损坏条目 ' + py.crc_bad_entry));
  check('Python openpyxl 可打开', py.openpyxl === true, py.openpyxl ? '' : (py.openpyxlError || ''));
  if (py.openpyxl) {
    const sheetsOut = py.sheets || [];
    const titles = sheetsOut.map(s => s.title);
    check('工作表名清理与重名处理', JSON.stringify(titles) === JSON.stringify(['排产清单', '非法 名称 测试 1', '排产清单(2)']), titles.join(' | '));
    const s1 = sheetsOut[0] || { rows: [] };
    check('中文与 XML 特殊字符原样读回', JSON.stringify(s1.rows[3] && s1.rows[3][1]) === JSON.stringify('中文 & <标签> "双引号" 与 单引号'), JSON.stringify(s1.rows[3] && s1.rows[3][1]));
    const d = s1.rows[5] || [];
    check('数量为数值单元格', d[1] === 2000, String(d[1]) + ' (' + typeof d[1] + ')');
    check('两位小数格式（0.00）', d[2] === 3.5, String(d[2]) + ' (' + typeof d[2] + ')');
    check('日期时间可还原（yyyy-mm-dd hh:mm）', String(d[3]).slice(0, 19) === '2026-09-21T08:00:00', String(d[3]));
    check('合并单元格（标题 + 表尾）', (s1.merges || []).length === 2, (s1.merges || []).join(','));
    check('冻结窗格（首行前言 + 表头）', s1.freeze === 'A6', String(s1.freeze));
    check('自动筛选范围含表头与数据', s1.filter === 'A5:E7', String(s1.filter));
  }
}

/* ---------------- 报告 ---------------- */
console.log('XLSX 导出器自检');
console.log('  写入器：' + WRITER.replace(ROOT + '/', ''));
console.log('  样例文件：' + OUT + '（' + bytes.length + ' 字节）');
console.log('  Python：' + (py.available ? (py.openpyxl ? 'zipfile + openpyxl ' : 'zipfile（openpyxl 不可用）') : '不可用'));
console.log('');
let failed = 0;
for (const r of results) {
  if (!r.pass) failed++;
  console.log('  ' + (r.pass ? '[通过]' : '[失败]') + ' ' + r.name + (r.detail ? ' —— ' + r.detail : ''));
}
console.log('');
console.log(failed ? ('自检未全部通过：' + failed + ' / ' + results.length + ' 项失败') : ('自检全部通过：' + results.length + ' 项'));
process.exit(failed ? 1 : 0);