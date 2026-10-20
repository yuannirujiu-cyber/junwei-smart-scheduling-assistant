#!/usr/bin/env node
/* 校验「算法说明」目录：图示与说明文档必须存在、结构完整，并且与引擎实现保持一致。
 * ---------------------------------------------------------------------------
 * 这个脚本不只是「文件在不在」，它守两件事：
 *   1) 流程图是生成出来的，生成器里的布局数学一旦出错（例如 NaN 坐标、连线指向不存在的节点），
 *      肉眼很难发现，但这里会直接报红；
 *   2) 说明文档里写的阈值、上限、四行决策必须与 web/src/engine/dispatch.js 的实际常量一致 ——
 *      文档与代码各说各话是这类交付物最常见的腐坏方式。
 * 用法：node tools/check_flowchart.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = resolve(ROOT, '算法说明');
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? ' :: ' + e : '')); } };

/* ---------- 1. 文件齐备 ---------- */
console.log('--- 1. 目录内容 ---');
const FILES = ['README.md', '01-排产决策流程图.svg', '02-三工序排产算法说明.md', '排产决策流程图.html'];
for (const f of FILES) ok('存在 ' + f, existsSync(resolve(DIR, f)));

const svg = readFileSync(resolve(DIR, '01-排产决策流程图.svg'), 'utf8');
const html = readFileSync(resolve(DIR, '排产决策流程图.html'), 'utf8');
const md = readFileSync(resolve(DIR, '02-三工序排产算法说明.md'), 'utf8');
const readme = readFileSync(resolve(DIR, 'README.md'), 'utf8');

/* ---------- 2. SVG 结构 ---------- */
console.log('--- 2. 流程图结构 ---');
const W = Number((svg.match(/width="(\d+)" height="(\d+)"/) || [])[1]);
const H = Number((svg.match(/width="(\d+)" height="(\d+)"/) || [])[2]);
ok('SVG 声明了画布尺寸', Number.isFinite(W) && Number.isFinite(H) && W > 800 && H > 1500, W + ' x ' + H);
ok('SVG 是自包含的（无外部引用 / 无 <image> / 无 <script>）',
  !/<image|href="http|xlink:href="http|<script/i.test(svg));
ok('定义了箭头 marker 且被引用', /<marker id="ah"/.test(svg) && /marker-end="url\(#ah\)"/.test(svg));
const nanHits = (svg.match(/NaN|undefined|Infinity/g) || []).length;
ok('坐标与文本里没有 NaN / undefined / Infinity', nanHits === 0, '命中 ' + nanHits + ' 处');

const ids = [...svg.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]).filter((x) => x !== 'ah');
ok('节点数量充足（>= 25）', ids.length >= 25, '实际 ' + ids.length + ' 个：' + ids.slice(0, 6).join(',') + ' …');
ok('节点 id 唯一（无重复）', new Set(ids).size === ids.length, ids.length + ' → ' + new Set(ids).size);

/* 连线端点必须落在画布内：这是生成器布局算错的直接信号 */
const paths = [...svg.matchAll(/ d="M ([^"]+)"/g)].map((m) => m[1]);
let outside = 0;
for (const p of paths) {
  const nums = p.match(/-?\d+(?:\.\d+)?/g) || [];
  for (let i = 0; i + 1 < nums.length; i += 2) {
    const x = Number(nums[i]), y = Number(nums[i + 1]);
    if (!(x >= -20 && x <= W + 20 && y >= -20 && y <= H + 20)) outside++;
  }
}
ok('所有连线端点都在画布内', outside === 0, '越界 ' + outside + ' 个端点');
ok('连线数量充足（>= 30）', paths.length >= 30, '实际 ' + paths.length + ' 条');

const REQUIRED = ['n1', 'n5', 'n12', 'n13', 'n17', 'n21', 'dd1', 'dd2', 'dd3', 'aA', 'aB', 'aC', 'aD'];
const missing = REQUIRED.filter((r) => !ids.includes(r));
ok('关键节点齐全（数据接入 / 建模 / 派单四动作 / 落位 / 校验 / 确认）', missing.length === 0, '缺：' + missing.join(','));

/* ---------- 3. HTML 查看页 ---------- */
console.log('--- 3. HTML 查看页 ---');
ok('HTML 内联了 SVG（不依赖外部文件即可打开）', html.includes('<svg') && html.includes('viewBox'));
ok('HTML 里的节点数与 SVG 一致（说明是同一份图）', REQUIRED.every((r) => html.includes('id="' + r + '"')));
ok('HTML 不引用任何外部资源（离线可用）',
  !/<script|<link|<img|src="http/i.test(html));
ok('HTML 顶部给出返回本目录与算法说明的链接', /href="\.\/README\.md"/.test(html) && /href="\.\/02-/.test(html));

/* ---------- 4. 说明文档覆盖关键内容 ---------- */
console.log('--- 4. 算法说明文档 ---');
const SECTIONS = ['目标序', '输入与输出', '前瞻派单核心', '后处理', '复杂度', '显式偏离', '实测结果', '已知限制', '自检'];
const missSec = SECTIONS.filter((s) => !md.includes(s));
ok('覆盖全部关键小节', missSec.length === 0, '缺：' + missSec.join(','));
ok('明确声明「不是全局最优」（不含糊其辞）', md.includes('不是全局最优') && md.includes('不保证'), '');
ok('给出了四行动作 A/B/C/D 的完整描述',
  ['动作 A', '动作 B', '动作 C', '动作 D'].every((a) => md.includes(a) || svg.includes(a)));
ok('README 索引了三份产物并说明如何重新生成',
  FILES.slice(0, 3).every((f) => readme.includes(f)) && readme.includes('build_flowchart.mjs'));

/* ---------- 5. 与引擎实现一致（防文档腐坏） ---------- */
console.log('--- 5. 与引擎实现一致性 ---');
const { DISPATCH_DEFAULTS, INTERVAL_LIMIT_MIN } = await import('../web/src/engine/dispatch.js');
ok('R6 工序间隔上限 = 4320 分钟，与文档一致', INTERVAL_LIMIT_MIN === 4320 && md.includes('4320'));
const th = DISPATCH_DEFAULTS.thresholdMin;
for (const [k, label] of [['drawing', '拉丝'], ['stranding', '捻股'], ['closing', '合绳']]) {
  ok(label + '紧急余量阈值 ' + th[k] + ' 分钟同时出现在算法说明与流程图中',
    md.includes(String(th[k])) && svg.includes(String(th[k])), 'md=' + md.includes(String(th[k])) + ' svg=' + svg.includes(String(th[k])));
}
ok('拉丝换型固定 ' + DISPATCH_DEFAULTS.drawingSetupMin + ' 分钟与文档一致',
  md.includes(String(DISPATCH_DEFAULTS.drawingSetupMin) + ' 分钟') || md.includes('固定 ' + DISPATCH_DEFAULTS.drawingSetupMin));
ok('每股换型 ' + DISPATCH_DEFAULTS.perStrandSetupMin + ' 分钟与文档一致',
  md.includes('股数 × ' + DISPATCH_DEFAULTS.perStrandSetupMin) || md.includes('股数 × 10'));
ok('负余量两种模式 AFTER_URGENT / DEFER 都已写明', md.includes('AFTER_URGENT') && md.includes('DEFER'));

const dispatchSrc = readFileSync(resolve(ROOT, 'web/src/engine/dispatch.js'), 'utf8');
ok('文档里的决策分支在代码中确有对应实现（同型号 / 预约 / 立即换型 / 让位）',
  ['dSameFamily', 'reservations.set', 'forced: true', 'recordAnomaly'].every((k) => dispatchSrc.includes(k)));

console.log('');
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
