/* 静态审计：data-act 名称 × 动作表 × 手动绑定
   抓的是「渲染出来但点了没反应」这类静默失效（前端审查报告 P0-2 / P1-4 / P1-5 都属于这一类），
   这类缺陷渲染断言看不出来，必须做交叉核对。

   判定要准，避免假报警：
   1. 只统计**字面量** data-act（跳过含模板插值、字符串拼接的动态值）；
   2. 跳过选择器上下文（querySelector('[data-act="x"]')）——那不是渲染；
   3. 一个名字只要满足下列任一条件就算「有处理」：
        a) 出现在某个动作表里；
        b) 代码里存在对它的手动绑定（[data-act="x"] 选择器 + addEventListener）。
   只有「渲染了、既不在动作表、也没有手动绑定」才算真的没人管。 */
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname, join, extname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
async function walk(dir) {
  const out = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else if (extname(e.name) === '.js') out.push(p);
  }
  return out;
}
const files = await walk(resolve(ROOT, 'web/src'));
const texts = new Map();
for (const f of files) texts.set(f.replace(ROOT + '/', ''), await readFile(f, 'utf8'));

/* 动态值的判定用显式字符列表，不用正则字符类——
   上一版把 \\u0060 写进字符类，结果类里混进了字母 u，导致 focusRisk 这种含 u 的合法名字被判为动态值。 */
const DYN_CHARS = [String.fromCharCode(36), String.fromCharCode(39), String.fromCharCode(34), String.fromCharCode(96), '+', '#'];
const isLiteral = v => !DYN_CHARS.some(c => v.indexOf(c) >= 0);
const rendered = new Map();
const manuallyBound = new Set();
let dynamicCount = 0;

/** 取出一段源码里所有 menuButton(...) 的实参文本（按括号深度配对，跳过字符串里的括号）。 */
function menuButtonRanges(t) {
  const out = [];
  const re = /menuButton\s*\(/g;
  let m;
  while ((m = re.exec(t))) {
    let i = m.index + m[0].length, depth = 1, str = null;
    const start = i;
    for (; i < t.length && depth > 0; i++) {
      const c = t[i];
      if (str) { if (c === '\\') i++; else if (c === str) str = null; continue; }
      if (c === '(' || c === ')' || c === '[' || c === ']' || c === '{' || c === '}') {
        if (c === '(' || c === '[' || c === '{') depth++;
        else depth--;
        continue;
      }
      if (c === String.fromCharCode(39) || c === '"' || c === '`') str = c;
    }
    out.push(t.slice(start, i));
    re.lastIndex = i;
  }
  return out;
}

for (const [file, t] of texts) {
  // 手动绑定：querySelector('[data-act="x"]') 与 querySelector('[data-act=x]') 两种写法都算
  for (const m of t.matchAll(/\[data-act=(?:"([^"]+)"|'([^']+)'|([A-Za-z_][\w-]*))\]/g)) {
    manuallyBound.add(m[1] || m[2] || m[3]);
  }
  for (const m of t.matchAll(/(\[?)data-act="([^"]+)"/g)) {
    if (m[1] === '[') continue;
    const v = m[2];
    if (!isLiteral(v)) { dynamicCount++; continue; }
    if (!rendered.has(v)) rendered.set(v, new Set());
    rendered.get(v).add(file);
  }
  /* 下拉菜单（menuButton）的选项把动作名作为**值**传给组件，而不是字面量 data-act="..."，
     上面的正则看不见它们，会把一整批真实存在的动作误报成「无触发元素」。
     这里按 items 里的写法 act: 'name' 收集（第 4 个参数控制是否计入动态拼接数）。 */
  /* 只在 menuButton(...) 的实参范围内收集 act:'…'：
     explain.js 的证据条目里也有 act 字段，那是数据不是控件，全局匹配会误报；
     而按「向前找 400 字符」又会漏掉长 items 数组后面的项，所以这里按括号配对取准确区间。 */
  for (const call of menuButtonRanges(t)) {
    for (const m of call.matchAll(/\bact:\s*'([A-Za-z][\w-]*)'/g)) {
      const v = m[1];
      if (!rendered.has(v)) rendered.set(v, new Set());
      rendered.get(v).add(file);
    }
  }
}

const handlers = new Map();
const add = (n, src) => { if (!handlers.has(n)) handlers.set(n, new Set()); handlers.get(n).add(src); };
/** 只从动作表对象内部取键：从「const X_ACTIONS = {」开始按大括号深度跟踪，
    深度为 1 且两空格缩进的 name: / name( 才视为表项。这样不会把嵌套的局部函数误当成动作。 */
function collect(srcLabel, t) {
  const lines = t.split('\n');
  let inTable = false, depth = 0;
  for (const line of lines) {
    if (!inTable) {
      if (/(?:export\s+)?const\s+[A-Za-z_]\w*ACTIONS?\w*\s*=\s*\{/.test(line)) { inTable = true; depth = 1; }
      continue;
    }
    if (depth === 1) {
      const m = /^\s{2}(?:async\s+)?([A-Za-z_]\w*)\s*[:(]/.exec(line);
      if (m) add(m[1], srcLabel);
    }
    depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
    if (depth <= 0) inTable = false;
  }
}
/* 动作表只存在于 main.js 与 views / components 里；键名形如「  name: ...」或「  name(args) {」（两空格缩进）。 */
for (const [file, t] of texts) if (/web\/src\/(main\.js|views\/|components\/)/.test(file)) collect(file, t);

const unhandled = [];
for (const [act, where] of rendered) {
  if (handlers.has(act) || manuallyBound.has(act)) continue;
  unhandled.push(act + '   （渲染于 ' + [...where].join(',') + '）');
}
unhandled.sort();

const orphans = [];
for (const [name, where] of handlers) {
  if (rendered.has(name) || manuallyBound.has(name)) continue;
  orphans.push(name + '   （定义于 ' + [...where].join(',') + '）');
}
orphans.sort();

console.log('data-act 字面量 ' + rendered.size + ' 个 · 手动绑定 ' + manuallyBound.size + ' 个 · 动态拼接 ' + dynamicCount + ' 处 · 动作表键 ' + handlers.size + ' 个');
console.log(unhandled.length
  ? '\n【渲染了但无处处理】' + unhandled.length + ' 个：\n  ' + unhandled.join('\n  ')
  : '✓ 每个渲染出来的 data-act 都有处理（动作表或手动绑定）');
console.log(orphans.length
  ? '\n【动作表里定义但无触发元素】' + orphans.length + ' 个：\n  ' + orphans.join('\n  ')
  : '✓ 没有孤儿动作');
process.exit(unhandled.length ? 1 : 0);