/* 持久化 / 审计 / 多标签页并发 的真浏览器回归（Playwright）
   覆盖：刷新恢复会话、审计只增不改、诊断面板、同源多标签页内容冲突提示。
   未安装 playwright 时明确 SKIP 并以 0 退出。 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('SKIP：未安装 playwright（可用 NODE_PATH=$(npm root -g) 指向全局 node_modules）'); process.exit(0); }

const BASE = process.argv[2] || 'http://127.0.0.1:5178';
let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? ' :: ' + e : '')); } };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const errors = [];
const wire = p => { p.on('pageerror', e => errors.push(String(e.message))); };

console.log('--- 首次会话：排产 + 锁定 + 落盘 ---');
const a = await ctx.newPage(); wire(a);
await a.goto(BASE + '/web/index.html?data=demo&fresh=1', { waitUntil: 'load' });
await a.waitForSelector('.g-task', { timeout: 120000 });
await a.waitForTimeout(1500);
const ready = await a.evaluate(() => window.__jwStore.state.persistence.status);
ok('持久化已就绪（status=ok）', ready === 'ok', ready);

await a.locator('.g-task').first().click();
await a.waitForSelector('.drawer', { timeout: 10000 });
const lockedId = await a.locator('[data-act="lock"]').getAttribute('data-id');
await a.locator('[data-act="lock"]').click();
await a.waitForTimeout(1200);
await a.keyboard.press('Escape');
await a.waitForTimeout(600);
const st1 = await a.evaluate(() => ({
  auditTotal: window.__jwStore.state.auditTotal,
  actions: window.__jwStore.state.audit.map(x => x.action),
  savedAt: window.__jwStore.state.persistence.lastSavedAt,
  locked: window.__jwStore.currentVersion.tasks.filter(t => t.locked).map(t => t.id),
}));
ok('审计已记录排产与锁定', st1.actions.includes('version.generate') && st1.actions.includes('task.lock'), JSON.stringify(st1.actions.slice(-5)));
ok('最近保存时间已写入', !!st1.savedAt, String(st1.savedAt));
ok('锁定状态存在于版本中', st1.locked.includes(lockedId), JSON.stringify(st1.locked));

console.log('--- 刷新后恢复会话（应用已剥离 fresh 参数，刷新走恢复路径）---');
const urlAfterFresh = a.url();
ok('干净启动后 fresh 参数已从地址栏剥离', !/fresh=1/.test(urlAfterFresh), urlAfterFresh);
await a.reload({ waitUntil: 'load' });
await a.waitForSelector('.g-task', { timeout: 120000 });
await a.waitForTimeout(1500);
const st2 = await a.evaluate(() => ({
  restored: !!window.__jwStore.state.sessionRestored,
  versions: window.__jwStore.state.versions.length,
  locked: window.__jwStore.currentVersion ? window.__jwStore.currentVersion.tasks.filter(t => t.locked).map(t => t.id) : [],
  auditTotal: window.__jwStore.state.auditTotal,
  banner: !!document.querySelector('.banner'),
}));
ok('刷新后标记为已恢复会话', st2.restored === true);
ok('刷新后版本仍在', st2.versions >= 1, 'versions=' + st2.versions);
ok('刷新后锁定状态保留', st2.locked.includes(lockedId), JSON.stringify(st2.locked));
ok('刷新后审计条数未回退', st2.auditTotal >= st1.auditTotal, st1.auditTotal + ' → ' + st2.auditTotal);

console.log('--- 第二个标签页：恢复同一会话 + 并发冲突提示 ---');
const b = await ctx.newPage(); wire(b);
await b.goto(BASE + '/web/index.html?data=demo', { waitUntil: 'load' });
await b.waitForSelector('.g-task', { timeout: 120000 });
await b.waitForTimeout(1500);
const st3 = await b.evaluate(() => ({ restored: !!window.__jwStore.state.sessionRestored, fp: window.__jwStore.currentVersion && window.__jwStore.currentVersion.fingerprint }));
ok('新标签页也恢复同一会话', st3.restored === true);
ok('新标签页持有版本内容指纹', !!st3.fp, String(st3.fp));

// A 再改动一个任务 → 广播 → B 应出现冲突横幅
await a.locator('.g-task').nth(1).click();
await a.waitForSelector('.drawer', { timeout: 10000 });
await a.locator('[data-act="lock"]').click();
await a.waitForTimeout(1600);
const conflict = await b.evaluate(() => window.__jwStore.state.conflict);
ok('B 检测到并发修改并给出提示', !!conflict && /另一个标签页/.test(conflict.msg || ''), JSON.stringify(conflict && conflict.msg));
await a.keyboard.press('Escape');

console.log('--- 诊断面板 ---');
/* 「诊断」收在顶栏「更多」菜单里：先展开菜单再点 */
await b.locator('.menu[data-menu="more"] .menu-btn').click();
await b.waitForTimeout(320);
await b.locator('[data-act="diagnostics"]').click();
await b.waitForSelector('.modal', { timeout: 8000 });
await b.waitForTimeout(600);
const diagTxt = await b.locator('.modal-b').innerText();
ok('诊断面板显示持久化状态', /本地持久化/.test(diagTxt) && /正常|不可用|配额/.test(diagTxt), diagTxt.slice(0, 90).replace(/\n/g, ' '));
ok('诊断面板显示应用版本与数据结构版本', /应用版本/.test(diagTxt) && /数据结构 v\d/.test(diagTxt));
ok('诊断面板显示审计与日志', /最近审计/.test(diagTxt) && /最近日志/.test(diagTxt));
ok('诊断面板提供导出诊断包入口', (await b.locator('[data-act="diagExport"]').count()) === 1);
ok('诊断面板提供清空持久化入口', (await b.locator('[data-act="diagClear"]').count()) === 1);
await b.keyboard.press('Escape');
await b.waitForTimeout(400);

console.log('--- 审计日志可导出 ---');
const auditCsv = await b.evaluate(async () => {
  let captured = null;
  const orig = URL.createObjectURL;
  URL.createObjectURL = (blob) => { captured = blob; return 'blob:stub'; };
  document.querySelector('.tb-actions [data-act="export"]').click();
  await new Promise(r => setTimeout(r, 500));
  const btn = [...document.querySelectorAll('[data-act="doExport"]')].find(x => x.dataset.kind === 'audit');
  if (!btn) { URL.createObjectURL = orig; return null; }
  btn.click();
  await new Promise(r => setTimeout(r, 600));
  URL.createObjectURL = orig;
  return captured ? await captured.text() : null;
});
ok('审计日志导出内容包含动作轨迹', !!auditCsv && /task\.lock/.test(auditCsv) && /version\.generate/.test(auditCsv), auditCsv ? auditCsv.slice(0, 80).replace(/\n/g, ' ') : 'null');
await b.keyboard.press('Escape');
await b.waitForTimeout(600);
ok('导出弹窗已关闭（不残留遮罩）', (await b.locator('.modal-mask').count()) === 0, 'mask=' + (await b.locator('.modal-mask').count()));

console.log('--- 放弃恢复后回到干净会话 ---');
/* 「诊断」收在顶栏「更多」菜单里：先展开菜单再点 */
await b.locator('.menu[data-menu="more"] .menu-btn').click();
await b.waitForTimeout(320);
await b.locator('[data-act="diagnostics"]').click();
await b.waitForSelector('.modal', { timeout: 8000 });
await b.locator('[data-act="diagClear"]').click();
await b.waitForTimeout(1200);
const cleared = await b.evaluate(() => ({ auditTotal: window.__jwStore.state.auditTotal, versions: window.__jwStore.state.versions.length, persistence: window.__jwStore.state.persistence && window.__jwStore.state.persistence.status }));
ok('清空后本地审计归零', cleared.auditTotal <= 2, JSON.stringify(cleared));

ok('全程无未捕获 JS 异常', errors.length === 0, errors.slice(0, 3).join(' | '));
await browser.close();
console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);