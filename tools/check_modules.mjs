/* 可靠的 ESM 自检：node --check 对本项目 .js 会假通过（无 package.json type:module），
   因此逐个复制为 .mjs 再检查，并校验 import 说明符能否解析到真实文件。 */
import { readFile, writeFile, readdir, mkdtemp, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join as pjoin, dirname, resolve, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const run = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = pjoin(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (extname(e.name) === '.js') out.push(p);
  }
  return out;
}

/** 去掉注释但保留字符串：import 说明符本身在字符串里，不能一起删。
    必须做这一步，否则文档注释里的用法示例（例如「import ... from './web/src/engine/index.js'」）
    会被当成真实 import，产生「模块缺失」的假报警。 */
function stripComments(src) {
  let out = '', i = 0, inStr = null;
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += src[i + 1] || ''; i += 2; continue; }
      if (c === inStr) inStr = null;
      i++; continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; out += c; i++; continue; }
    if (c === '/' && n === '*') { const j = src.indexOf('*/', i + 2); i = j < 0 ? src.length : j + 2; out += ' '; continue; }
    if (c === '/' && n === '/') { const j = src.indexOf('\n', i); i = j < 0 ? src.length : j; continue; }
    out += c; i++;
  }
  return out;
}

const files = await walk(pjoin(ROOT, 'web/src'));
const tmp = await mkdtemp(pjoin(tmpdir(), 'jwchk-'));
let syntaxFail = 0, importFail = 0, checked = 0, imports = 0;

for (const f of files) {
  const src = await readFile(f, 'utf8');
  const dst = pjoin(tmp, f.replace(/[\/]/g, '_') + '.mjs');
  await writeFile(dst, src, 'utf8');
  try { await run(process.execPath, ['--check', dst]); checked++; }
  catch (e) { syntaxFail++; console.log('语法错误 ' + f + '\n' + String(e.stderr || e.message).split('\n').slice(0, 3).join('\n')); }

  const code = stripComments(src);
  for (const m of code.matchAll(/from\s+'([^']+)'/g)) {
    const spec = m[1];
    if (!spec.startsWith('.')) continue;
    imports++;
    const target = resolve(dirname(f), spec);
    const okFile = await stat(target).then(s => s.isFile()).catch(() => false);
    if (!okFile) { importFail++; console.log('模块缺失 ' + f + ' -> ' + spec); }
  }
}
console.log('文件 ' + files.length + ' · 语法检查通过 ' + checked + ' · 语法失败 ' + syntaxFail + ' · import ' + imports + ' 条 · 解析失败 ' + importFail);
process.exit(syntaxFail + importFail ? 1 : 0);