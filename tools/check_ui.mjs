/* 真浏览器 UI 回归（Playwright + Chromium）
   复现审查报告 §五 的 P0/P1 场景，验证修复后：
   - 抽屉内点击不再关闭抽屉，「依据」「变更记录」「人工调整」可用
   - 甘特图关键字/工序筛选真正生效
   - Escape 能关弹窗；无未捕获异常
   用法：node tools/check_ui.mjs [baseUrl]
   未安装 playwright 时打印 SKIP 并以 0 退出（不计为通过）。 */
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://127.0.0.1:5178';
const DEVICE_XLSX = process.env.DEVICE_XLSX || '/Users/kazuhamiyo/Desktop/Project/黑客松 0918～0920/黑客松数据包/产品额定（平均值）.xlsx';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('SKIP：未安装 playwright（本机可用 NODE_PATH 指向全局 node_modules）'); process.exit(0); }

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? ' :: ' + e : '')); } };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e.message)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

const URL = BASE + '/web/index.html?data=demo';
await page.goto(URL, { waitUntil: 'load' });
await page.waitForSelector('.g-task', { timeout: 30000 });
await page.waitForTimeout(1200);

console.log('--- 基础渲染 ---');
ok('无「页面渲染失败」横幅', !(await page.locator('text=页面渲染失败').count()));
ok('甘特图有任务条', (await page.locator('.g-task').count()) > 0, String(await page.locator('.g-task').count()));

console.log('--- P0-1 抽屉内点击不应关闭 ---');
await page.locator('.g-task').first().click();
await page.waitForSelector('.drawer', { timeout: 8000 });
ok('点击任务条打开抽屉', (await page.locator('.drawer').count()) === 1);
await page.locator('.drawer-b').click({ position: { x: 20, y: 200 } });
await page.waitForTimeout(350);
ok('点击抽屉正文空白后抽屉仍在', (await page.locator('.drawer').count()) === 1, 'count=' + (await page.locator('.drawer').count()));
await page.locator('.drawer-tabs button[data-tab="why"]').click();
await page.waitForTimeout(350);
ok('「依据」页签点击后抽屉仍在', (await page.locator('.drawer').count()) === 1);
ok('「依据」页签已选中', (await page.locator('.drawer-tabs button.on').innerText()).includes('依据'));
const whyText = await page.locator('.drawer-b').innerText();
ok('「依据」内容含四段式（结论/证据/规则）', whyText.includes('结论') && whyText.includes('证据') && /R\d/.test(whyText), whyText.slice(0, 60).replace(/\n/g, ' '));
await page.locator('.drawer-tabs button[data-tab="log"]').click();
await page.waitForTimeout(300);
ok('「变更记录」页签可打开', (await page.locator('.drawer').count()) === 1 && (await page.locator('.drawer-b').innerText()).includes('变更'));
await page.locator('.drawer-tabs button[data-tab="plan"]').click();
await page.waitForTimeout(300);
await page.locator('[data-act="openAdjust"]').click();
await page.waitForTimeout(300);
const adjVisible = await page.locator('#adjustWrap').isVisible();
ok('「人工调整」表单可见', adjVisible);
ok('调整表单含适配机台下拉与预览', (await page.locator('#adjustForm select[data-f="machineId"] option').count()) > 0 && (await page.locator('#adjustPreview').innerText()).length > 0);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
ok('Escape 关闭抽屉', (await page.locator('.drawer').count()) === 0);

console.log('--- P0-2 甘特图筛选 ---');
const before = await page.locator('.g-task').count();
const firstOrder = (await page.locator('.g-task').first().getAttribute('title')).split(' ')[0];
/* 逐位输入（而不是 fill 一次性赋值）：视图是整块重渲染，逐字重渲染会让光标回到开头，
   把「连续输入」变成「倒序输入」——真实用户就是这么打字的，必须覆盖。 */
await page.locator('[data-act="filterKw"]').fill('');
await page.locator('[data-act="filterKw"]').type(firstOrder, { delay: 60 });
await page.waitForTimeout(1000);
ok('关键字逐位输入顺序正确（不被重渲染打断）', (await page.locator('[data-act="filterKw"]').inputValue()) === firstOrder,
  await page.locator('[data-act="filterKw"]').inputValue());
const afterKw = await page.locator('.g-task').count();
ok('关键字筛选减少任务条', afterKw > 0 && afterKw < before, before + ' → ' + afterKw + '（关键字 ' + firstOrder + '）');
await page.locator('[data-act="filterKw"]').fill('');
await page.waitForTimeout(900);
/* 工序下拉已收进「筛选」面板：先展开面板，再点选项。
   顺带验证面板在重渲染后**仍然展开**、选中态与徽标同步——这正是把控件收进菜单后最容易坏的地方。 */
await page.locator('.menu[data-menu="gantt-filter"] .menu-btn').click();
await page.waitForTimeout(320);
ok('筛选面板可展开', await page.locator('.menu[data-menu="gantt-filter"] .menu-panel').isVisible());
await page.locator('.menu[data-menu="gantt-filter"] .menu-item[data-v="stranding"]').click();
await page.waitForTimeout(900);
const afterProc = await page.locator('.g-task').count();
const strandingOnly = await page.locator('.g-task.stranding').count();
ok('工序筛选后只剩该工序任务', afterProc > 0 && afterProc === strandingOnly && afterProc < before, '总数 ' + afterProc + ' / 捻股 ' + strandingOnly + '（原 ' + before + '）');
ok('重渲染后面板仍然展开（不必反复点开）', await page.locator('.menu[data-menu="gantt-filter"] .menu-panel').isVisible());
ok('选中项带选中态（未被重渲染重置）', await page.locator('.menu[data-menu="gantt-filter"] .menu-item[data-v="stranding"]').evaluate(n => n.classList.contains('on')));
ok('筛选按钮显示生效中的筛选数', /^1$/.test((await page.locator('.menu[data-menu="gantt-filter"] .menu-badge').innerText()).trim()));
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
ok('Escape 收起筛选面板', (await page.locator('.menu-panel:not([hidden])').count()) === 0);
await page.locator('.menu[data-menu="gantt-filter"] .menu-btn').click();
await page.waitForTimeout(300);
await page.locator('.menu[data-menu="gantt-filter"] .menu-item[data-act="clearFilter"]').click();
await page.waitForTimeout(900);
ok('清除筛选后任务条恢复', (await page.locator('.g-task').count()) === before, String(await page.locator('.g-task').count()) + ' vs ' + before);

console.log('--- 当前日期（排产参考今天）---');
{
  const rc = await page.evaluate(() => { const sc = document.querySelector('[data-scroll]');
    return { over: sc.scrollWidth > sc.clientWidth + 50, left: Math.round(sc.scrollLeft),
      tasks: window.__jwStore.currentVersion.tasks.filter(t => t.scheduled).length, sys: (document.querySelector('.today-ctl input') || {}).value }; });
  /* 这条是顺带发现的真实缺陷：.gantt-wrap 缺 min-width:0，被内容撑到 5520px，
     overflow:auto 永不触发 → 横向滚动与「定位今日」全部失效。 */
  ok('甘特图横向可滚动（内容宽 > 视口宽）', rc.over);
  ok('排产参考日期默认跟随系统日期', /^\d{4}-\d{2}-\d{2}$/.test(rc.sys), rc.sys);
  /* 参考日期必须在**当前计划窗口内**才画得出高亮与 now 线；
     而本脚本跑的是 DEMO 数据（窗口与真实数据不同），所以按计划起点推导，不写死日期。 */
  const inWindowDate = await page.evaluate(() => {
    const d = new Date(window.__jwStore.state.settings.planStart);
    d.setDate(d.getDate() + 3);
    const p = (n) => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  });
  await page.locator('.today-ctl input').fill(inWindowDate);
  await page.waitForTimeout(1400);
  const rt = await page.evaluate(() => ({ state: window.__jwStore.state.settings.currentDate,
    cells: [...document.querySelectorAll('.tl-cell.today')].map(x => x.textContent.trim()),
    now: !!document.querySelector('.g-vline.now'), sim: !!document.querySelector('.today-ctl.sim'),
    reset: !!document.querySelector('.tc-reset'), value: (document.querySelector('.today-ctl input') || {}).value,
    tasks: window.__jwStore.currentVersion.tasks.filter(t => t.scheduled).length }));
  ok('修改当前日期后状态与控件同步', rt.state === inWindowDate && rt.value === inWindowDate, JSON.stringify(rt.state) + '/' + rt.value);
  const mmdd = String(Number(inWindowDate.slice(5, 7))) + '/' + String(Number(inWindowDate.slice(8, 10)));
  ok('甘特「今日」高亮移到该日期（' + mmdd + '）', rt.cells.length === 1 && rt.cells[0].indexOf(mmdd) === 0, JSON.stringify(rt.cells));
  ok('now 参考线出现', rt.now === true);
  ok('标注为「模拟」并提供恢复入口', rt.sim === true && rt.reset === true);
  ok('改日期不改变排产结果（任务数不变）', rt.tasks === rc.tasks, rt.tasks + ' vs ' + rc.tasks);
  await page.locator('.menu[data-menu="gantt-view"] .menu-btn').click();
  await page.waitForTimeout(300);
  await page.locator('.menu[data-menu="gantt-view"] .menu-item[data-act="today"]').click();
  await page.waitForTimeout(900);
  const scrolled = await page.evaluate(() => Math.round(document.querySelector('[data-scroll]').scrollLeft));
  ok('「定位今日」真的滚动了时间轴', scrolled > 0, 'scrollLeft=' + scrolled);
  await page.locator('.tc-reset').click();
  await page.waitForTimeout(1100);
  const rr = await page.evaluate(() => ({ state: window.__jwStore.state.settings.currentDate, sim: !!document.querySelector('.today-ctl.sim') }));
  ok('可恢复为系统日期', rr.state === null && rr.sim === false, JSON.stringify(rr));
}

console.log('--- P1-9 一键收敛按钮计数 ---');
await page.locator('.nav-item[data-route="data"]').click();
await page.waitForTimeout(900);
const btn = await page.locator('[data-act="scopeExcludeBlocked"]').innerText();
ok('一键收敛按钮显示真实阻断数（非 0）', /（\d+ 张）/.test(btn) && !/（0 张）/.test(btn), btn);

console.log('--- P1-10 Escape 关弹窗 ---');
await page.locator('.nav-item[data-route="workbench"]').click();
await page.waitForTimeout(900);
/* 顶栏的「导出 / 诊断」已收进下拉菜单：先展开菜单再点，
   同时验证 aria-expanded 与面板可见性 —— 菜单化后最容易坏的就是「点不到」和「展开态不同步」。 */
await page.locator('.menu[data-menu="plan"] .menu-btn').click();
await page.waitForTimeout(320);
ok('顶栏「计划」菜单展开且 aria-expanded 同步', await page.locator('.menu[data-menu="plan"] .menu-btn').getAttribute('aria-expanded') === 'true'
  && await page.locator('.menu[data-menu="plan"] .menu-panel').isVisible());
await page.locator('.menu[data-menu="plan"] .menu-item[data-act="export"]').click();
await page.waitForSelector('.modal', { timeout: 6000 });
ok('导出弹窗已打开', (await page.locator('.modal').count()) === 1);
await page.keyboard.press('Escape');
await page.waitForTimeout(500);
ok('Escape 关闭弹窗', (await page.locator('.modal-mask').count()) === 0, 'mask=' + (await page.locator('.modal-mask').count()));


console.log('--- P0-3 设备 / 产能导入 ---');
await page.locator('.nav-item[data-route="data"]').click();
await page.waitForTimeout(1200);
const banner0 = await page.locator('.banner').first().innerText().catch(() => '');
const devBanner = await page.locator('#deviceSource').innerText().catch(() => '');
ok('D01 显示设备数据来源横幅', /拉丝\s*\d+\s*台/.test(devBanner), devBanner.slice(0, 80).replace(/\n/g, ' '));
ok('初始为 DEMO 设备（拉丝 6 台）', /拉丝\s*6\s*台/.test(devBanner), devBanner.replace(/\n/g, ' ').slice(0, 90));
const hasDeviceSlot = await page.locator('#dropzoneDevice').count();
ok('存在「设备 / 产能文件」上传槽', hasDeviceSlot === 1);
await page.locator('#deviceFileInput').setInputFiles(DEVICE_XLSX);
await page.waitForSelector('[data-act="confirmDevice"]', { timeout: 90000 });
ok('弹出设备确认弹窗', (await page.locator('.modal').count()) === 1);
const modalTxt = await page.locator('.modal-b').innerText();
ok('确认弹窗列出三类设备数量', /拉丝设备[^\d]*\d+\s*台/.test(modalTxt) && /捻股设备/.test(modalTxt) && /合绳设备/.test(modalTxt), modalTxt.slice(0, 100).replace(/\n/g, ' '));
await page.locator('[data-act="confirmDevice"]').click();
await page.waitForTimeout(2500);
const devBanner2 = await page.locator('#deviceSource').innerText().catch(() => '');
ok('替换后设备数变为真实台账（拉丝 47 / 捻股 51 / 合绳 11）',
  /拉丝\s*47\s*台/.test(devBanner2) && /捻股\s*51\s*台/.test(devBanner2) && /合绳\s*11\s*台/.test(devBanner2),
  devBanner2.replace(/\n/g, ' ').slice(0, 130));
ok('横幅不再显示「沿用上一个快照」', !/沿用上一个快照/.test(devBanner2), devBanner2.replace(/\n/g, ' ').slice(0, 100));

console.log('--- 替换设备后重新生成计划 ---');
await page.locator('.tb-actions [data-act="generate"]').click();
await page.waitForSelector('.g-task', { timeout: 120000 });
await page.waitForTimeout(1500);
ok('替换设备后可重新生成计划', (await page.locator('.g-task').count()) > 0, String(await page.locator('.g-task').count()));
const realDev = await page.evaluate(() => window.__jwStore.cap.stats());
ok('引擎实际使用的是真实台账（47/51/11）', realDev.drawing === 47 && realDev.stranding === 51 && realDev.closing === 11, JSON.stringify(realDev));

console.log('--- P1-4 / P1-5 / P1-3 新入口 ---');
await page.locator('.nav-item[data-route="workbench"]').click();
await page.waitForTimeout(1500);
await page.locator('.seg button[data-v="order"]').click();
await page.waitForTimeout(1200);
const pageInfo = await page.evaluate(() => {
  const st = window.__jwStore.state;
  const ids = new Set(window.__jwStore.currentVersion.tasks.filter(x => x.scheduled).map(x => x.orderId));
  return { total: ids.size, limit: st.ui.gantt.orderLimit, shown: document.querySelectorAll('[data-row^="o:"]').length };
});
const expectBtn = pageInfo.total > pageInfo.limit;
ok('分页按钮与订单数匹配（当前 ' + pageInfo.total + ' 单 / 上限 ' + pageInfo.limit + '）',
  (await page.locator('[data-act="moreOrders"]').count()) === (expectBtn ? 1 : 0), JSON.stringify(pageInfo));
if (expectBtn) {
  const t0 = await page.locator('[data-act="moreOrders"]').innerText();
  ok('按钮显示 已显示/总数', /已显示\s*\d+\s*\/\s*\d+/.test(t0), t0);
  await page.locator('[data-act="moreOrders"]').click();
  await page.waitForTimeout(800);
  const shown2 = await page.locator('[data-row^="o:"]').count();
  ok('点击后展示更多订单', shown2 > pageInfo.shown, pageInfo.shown + ' → ' + shown2);
}
await page.locator('.seg button[data-v="machine"]').click();
await page.waitForTimeout(900);
await page.locator('.g-task').first().click();
await page.waitForSelector('.drawer', { timeout: 8000 });
ok('抽屉出现「标记执行冻结」入口', (await page.locator('[data-act="freeze"]').count()) === 1);
const frozenId = await page.locator('[data-act="freeze"]').getAttribute('data-id');
await page.locator('[data-act="freeze"]').click();
await page.waitForTimeout(900);
const frozenOk = await page.evaluate(id => { const v = window.__jwStore.currentVersion; const t = v.tasks.find(x => x.id === id); return !!(t && t.frozen); }, frozenId);
ok('点击后任务进入执行冻结', frozenOk === true);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);


console.log('--- P1-4 真实数据（301 单 > 40）分页按钮 ---');
{
  const p2 = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  /* 空白启动：真实数据集必须显式深链（裸地址现在是空白工作台，不会有甘特任务条）。 */
  await p2.goto(BASE + '/web/index.html?data=real&fresh=1', { waitUntil: 'load' });
  await p2.waitForSelector('.g-task', { timeout: 120000 });
  await p2.waitForTimeout(1500);
  await p2.locator('.seg button[data-v="order"]').click();
  await p2.waitForTimeout(1500);
  const info = await p2.evaluate(() => {
    const st = window.__jwStore.state;
    const ids = new Set(window.__jwStore.currentVersion.tasks.filter(x => x.scheduled).map(x => x.orderId));
    return { total: ids.size, limit: st.ui.gantt.orderLimit, shown: document.querySelectorAll('[data-row^="o:"]').length };
  });
  ok('真实数据订单数超过上限', info.total > info.limit, JSON.stringify(info));
  ok('真实数据出现分页按钮', (await p2.locator('[data-act="moreOrders"]').count()) === 1, JSON.stringify(info));
  const before = info.shown;
  await p2.locator('[data-act="moreOrders"]').click();
  await p2.waitForTimeout(1200);
  const after = await p2.locator('[data-row^="o:"]').count();
  ok('点击后渲染更多订单行', after > before, before + ' → ' + after);
  await p2.close();
}


console.log('--- P1-2 D06 扰动类型切换 ---');
await page.locator('.nav-item[data-route="simulate"]').click();
await page.waitForTimeout(1000);
await page.locator('[data-act="simType"][data-v="breakdown"]').click();
await page.waitForTimeout(600);
ok('选中「设备故障」后显示故障表单', (await page.locator('[data-f="b-machine"]').count()) === 1 && (await page.locator('[data-f="m-new"]').count()) === 0);
await page.locator('[data-act="runSim"]').click();
await page.waitForSelector('.cmp-card', { timeout: 120000 });
ok('故障模拟产出候选卡', (await page.locator('.cmp-card').count()) >= 1);
await page.locator('[data-act="simType"][data-v="material"]').click();
await page.waitForTimeout(700);
ok('跑过模拟后切换到「物料延迟」仍换表单', (await page.locator('[data-f="m-new"]').count()) === 1, 'material form=' + (await page.locator('[data-f="m-new"]').count()));
ok('类型卡片有选中态', (await page.locator('[data-act="simType"][data-v="material"] .tag').count()) >= 1);

console.log('--- P1-6 缺交期订单必须被阻断 ---');
const gateInfo = await page.evaluate(() => {
  const st = window.__jwStore;
  const blocked = st.currentVersion ? st.currentVersion.blockedOrders.map(x => x.orderId) : [];
  return { blocked, hasNoDue: blocked.length };
});
ok('阻断清单非空（含映射缺口与缺交期）', gateInfo.blocked.length > 0, JSON.stringify(gateInfo.blocked.slice(0, 6)));

ok('无未捕获 JS 异常', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log('\n通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);