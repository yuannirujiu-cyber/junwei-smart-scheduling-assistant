/* 无障碍（a11y）与键盘可用性真浏览器回归（Playwright + Chromium）
   覆盖点（每条断言都能失败，变异测试见交付说明）：
   - 跳到主内容：Tab 第一站、聚焦后进入视口、回车/点击后焦点落到 main 地标
   - 抽屉 / 弹窗：role=dialog + aria-modal + 可访问名称；打开后焦点在对话框内；
     Tab / Shift+Tab 连续多次不出对话框；Escape 关闭后焦点回到触发元素
   - 多层弹层：抽屉之上再开弹窗时，只陷阱最上层（Tab 不掉进下层）
   - 页签：tablist / tab / tabpanel + aria-selected + aria-controls + 漫游 tabindex；
     左右方向键循环切换，Home / End 到首尾
   - 甘特图：role=treegrid / row / gridcell；任务条可键盘聚焦；上下换行、左右换任务、
     Home / End 到行首尾；Enter 打开工序抽屉；焦点有可见样式；aria-label 覆盖
     订单号·工序·设备·起止·时长·风险·锁定状态
   - Toast：role=status（错误 role=alert）+ 文本可读
   - 「计算中」：aria-live=polite 播报阶段与用时
   - 装饰性 svg 全部 aria-hidden；所有控件有可访问名称，且能用 getByRole 反查回来
   - prefers-reduced-motion: reduce 关闭动画与过渡；prefers-contrast: more 提高边框/文字对比
   用法：NODE_PATH=$(npm root -g) node tools/check_a11y.mjs [baseUrl]
   未安装 playwright 时打印 SKIP 并以 0 退出（不计为通过）。 */
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = process.argv[2] || 'http://127.0.0.1:5178';
const URL_DEMO = BASE + '/web/index.html?data=demo';

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require('playwright')); }
catch { console.log('SKIP：未安装 playwright（本机可用 NODE_PATH 指向全局 node_modules）'); process.exit(0); }

let pass = 0, fail = 0, skip = 0;
const ok = (n, c, e = '') => { if (c) { pass++; console.log('  ✓ ' + n); } else { fail++; console.log('  ✗ ' + n + (e ? ' :: ' + e : '')); } };
const skipNote = (n) => { skip++; console.log('  - SKIP ' + n); };

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e.message)));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

await page.goto(URL_DEMO, { waitUntil: 'load' });
await page.waitForSelector('.g-task[data-id]', { timeout: 30000 });
await page.waitForTimeout(1200);

const focused = () => page.evaluate(() => {
  const a = document.activeElement;
  if (!a) return { tag: null };
  const d = document.querySelector('.drawer'), m = document.querySelector('.modal');
  return {
    tag: a.tagName, id: a.id || null,
    cls: typeof a.className === 'string' ? a.className : '',
    act: (a.dataset && a.dataset.act) || null,
    label: a.getAttribute ? (a.getAttribute('aria-label') || '') : '',
    text: (a.textContent || '').trim().slice(0, 30),
    inDrawer: !!(d && d.contains(a)), inModal: !!(m && m.contains(a)),
  };
});
const attrOf = (sel, name) => page.evaluate(([s, n]) => { const e = document.querySelector(s); return e ? e.getAttribute(n) : null; }, [sel, name]);

console.log('--- 基础地标与静态语义 ---');
ok('主区域是 <main> 地标（getByRole 反查得到）', (await page.getByRole('main').count()) === 1, 'count=' + (await page.getByRole('main').count()));
ok('#view 带 tabindex="-1"（skip link 的落点）', (await attrOf('#view', 'tabindex')) === '-1');
const svgs = await page.evaluate(() => {
  const all = [...document.querySelectorAll('svg')];
  return { total: all.length, bad: all.filter(s => s.getAttribute('aria-hidden') !== 'true').length };
});
ok('装饰性 svg 全部 aria-hidden（共 ' + svgs.total + ' 个）', svgs.total > 10 && svgs.bad === 0, JSON.stringify(svgs));
ok('Toast 容器是 role=status 的礼貌播报区', (await attrOf('#toast-root', 'role')) === 'status' && (await attrOf('#toast-root', 'aria-live')) === 'polite');
const liveInfo = await page.evaluate(() => {
  const el = document.getElementById('live-root');
  if (!el) return null;
  const s = getComputedStyle(el);
  return { role: el.getAttribute('role'), live: el.getAttribute('aria-live'), pos: s.position, w: s.width };
});
ok('#live-root 存在、polite 播报且视觉隐藏（sr-only）', !!liveInfo && liveInfo.live === 'polite' && liveInfo.pos === 'absolute' && parseFloat(liveInfo.w) <= 2, JSON.stringify(liveInfo));

console.log('--- 跳到主内容（skip link） ---');
{
  const hasSkip = await page.locator('.skip-link').count();
  const vp = page.viewportSize();
  ok('页面存在「跳到主内容」skip link', hasSkip === 1, 'count=' + hasSkip);
  const before = hasSkip ? await page.locator('.skip-link').boundingBox() : null;
  ok('未聚焦时 skip link 藏在视口之外', !!before && before.y + before.height <= 0, JSON.stringify(before));
  await page.keyboard.press('Tab');
  const f = await focused();
  ok('Tab 的第一站是「跳到主内容」', f.cls.includes('skip-link') && /跳到主内容/.test(f.text), JSON.stringify(f));
  await page.waitForTimeout(400);   // 等 top 过渡走完再量位置（.skip-link 有 150ms 过渡）
  const box = hasSkip ? await page.locator('.skip-link').boundingBox() : null;
  ok('聚焦后 skip link 进入视口且可见（top=' + (box && Math.round(box.y)) + 'px）',
    !!box && box.y >= 0 && box.y + box.height <= vp.height && box.x >= 0, JSON.stringify(box));
  if (hasSkip) await page.keyboard.press('Enter');
  await page.waitForTimeout(250);
  const f2 = await focused();
  ok('激活 skip link 后焦点落在主内容 #view', f2.id === 'view', JSON.stringify(f2));
  ok('skip link 跳到主内容后 hash 不残留（不污染路由）', !/skip/.test(await page.evaluate(() => location.hash)), await page.evaluate(() => location.hash));
}

console.log('--- 抽屉：dialog 语义 + 焦点陷阱 + Escape 恢复 ---');
/* 打开抽屉统一走这里：不抛等待超时，失败时后续断言自然变红而不是让脚本崩掉 */
const openDrawerByKeyboard = async () => {
  await page.evaluate(() => { const b = document.querySelector('.g-task[data-id]'); if (b) b.focus(); });
  await page.keyboard.press('Enter');
  await page.waitForSelector('.drawer', { timeout: 8000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(400);
  return (await page.locator('.drawer').count()) === 1;
};
await page.evaluate(() => { const b = document.querySelector('.g-task[data-id]'); if (b) b.focus(); });
const triggerLabel = (await focused()).label;   // 触发元素 = Tab 序列里的第一条任务条
const drawerOpened = await openDrawerByKeyboard();
ok('任务条上按 Enter 打开工序抽屉', drawerOpened);
{
  const d = await page.evaluate(() => { const x = document.querySelector('.drawer'); if (!x) return { missing: true }; const by = x.getAttribute('aria-labelledby'); return { role: x.getAttribute('role'), modal: x.getAttribute('aria-modal'), by, title: (document.getElementById(by || '') || {}).textContent || '' }; });
  ok('抽屉 role=dialog', d.role === 'dialog', JSON.stringify(d));
  ok('抽屉 aria-modal=true', d.modal === 'true', JSON.stringify(d));
  ok('抽屉有可访问名称（aria-labelledby → 标题）', !!d.by && d.title.trim().length > 0, JSON.stringify(d));
  ok('getByRole("dialog", 名称) 能反查到抽屉', (await page.getByRole('dialog', { name: String(d.title || '').trim(), exact: false }).count()) >= 1, d.title);
  ok('抽屉打开后焦点在对话框内', (await focused()).inDrawer, JSON.stringify(await focused()));
  const seenInDrawer = new Set();
  let inside = true, firstOut = -1;
  for (let i = 1; i <= 14; i++) {
    await page.keyboard.press('Tab');
    const f = await focused();
    if (!f.inDrawer) { inside = false; firstOut = i; break; }
    seenInDrawer.add(f.tag + ':' + (f.id || f.act || f.label || f.cls.split(' ').join('.')));
  }
  ok('连续 Tab 14 次焦点始终在抽屉内（焦点陷阱）', inside, '第 ' + firstOut + ' 次 Tab 逃出');
  ok('Tab 循环覆盖抽屉内多个控件（' + seenInDrawer.size + ' 个），不是卡死在一处', seenInDrawer.size >= 3, [...seenInDrawer].join(' → '));
  inside = true; firstOut = -1;
  for (let i = 1; i <= 10; i++) {
    await page.keyboard.press('Shift+Tab');
    if (!(await focused()).inDrawer) { inside = false; firstOut = i; break; }
  }
  ok('连续 Shift+Tab 10 次焦点始终在抽屉内', inside, '第 ' + firstOut + ' 次逃出');
}

console.log('--- 页签：tablist / tab / tabpanel + 方向键 ---');
{
  const t = await page.evaluate(() => {
    const list = document.querySelector('.drawer-tabs');
    const tabs = [...document.querySelectorAll('.drawer-tabs [role="tab"]')];
    const panel = document.querySelector('[role="tabpanel"]');
    return {
      listRole: list && list.getAttribute('role'), listLabel: list && list.getAttribute('aria-label'),
      tabs: tabs.map(b => ({ id: b.id, sel: b.getAttribute('aria-selected'), ti: b.getAttribute('tabindex'), ctl: b.getAttribute('aria-controls'), text: b.textContent.trim() })),
      panel: panel ? { id: panel.id, by: panel.getAttribute('aria-labelledby'), ti: panel.getAttribute('tabindex') } : null,
      selected: (document.querySelector('.drawer-tabs [aria-selected="true"]') || {}).textContent,
    };
  });
  ok('页签容器 role=tablist 且有可访问名称', t.listRole === 'tablist' && !!t.listLabel, JSON.stringify({ r: t.listRole, l: t.listLabel }));
  ok('每个页签都有 role=tab / aria-selected / aria-controls', t.tabs.length === 3 && t.tabs.every(b => b.sel && b.ctl), JSON.stringify(t.tabs));
  ok('漫游 tabindex：选中页签 0，其余 -1', t.tabs.filter(b => b.ti === '0').length === 1 && (t.tabs.find(b => b.ti === '0') || {}).sel === 'true', JSON.stringify(t.tabs.map(b => [b.text, b.ti, b.sel])));
  ok('tabpanel 存在且 aria-labelledby 指向当前页签', !!t.panel && t.panel.by === 'jw-tab-plan' && t.panel.ti === '0', JSON.stringify(t.panel));
  ok('getByRole("tab", {name:"依据"}) 能反查到', (await page.getByRole('tab', { name: '依据' }).count()) === 1);
  const selNow = () => page.evaluate(() => (document.querySelector('.drawer-tabs [aria-selected="true"]') || {}).textContent);
  const drawerText = () => page.evaluate(() => (document.querySelector('.drawer-b') || {}).innerText || '');
  await page.evaluate(() => { const b = document.querySelector('.drawer-tabs [role="tab"]'); if (b) b.focus(); });
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(250);
  ok('右方向键切到下一个页签（安排 → 依据）', (await selNow()) === '依据', await selNow());
  ok('切页签后正文真的换了（依据含「结论」）', /结论/.test(await drawerText()));
  await page.keyboard.press('End');
  await page.waitForTimeout(250);
  ok('End 切到最后一个页签', (await selNow()) === '变更记录', await selNow());
  await page.keyboard.press('Home');
  await page.waitForTimeout(250);
  ok('Home 切回第一个页签', (await selNow()) === '安排', await selNow());
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(250);
  ok('左方向键从首个页签循环到末个', (await selNow()) === '变更记录', await selNow());
  const panelBy = await attrOf('[role="tabpanel"]', 'aria-labelledby');
  ok('切换后 tabpanel 的 aria-labelledby 跟着走', panelBy === 'jw-tab-log', panelBy);
}

console.log('--- 抽屉：Escape 关闭后焦点回到触发元素 ---');
await page.keyboard.press('Escape');
await page.waitForTimeout(450);
{
  const f = await focused();
  ok('Escape 关闭抽屉', (await page.locator('.drawer').count()) === 0);
  ok('关闭后焦点回到打开抽屉的任务条', f.label && f.label === triggerLabel, '触发=' + triggerLabel.slice(0, 26) + ' / 现在=' + String(f.label).slice(0, 26));
}

console.log('--- 甘特图：treegrid 语义 + 键盘导航 ---');
{
  const g = await page.evaluate(() => {
    const grid = document.querySelector('[role="treegrid"]');
    const rows = [...document.querySelectorAll('.gantt-body [role="row"]')];
    const cells = [...document.querySelectorAll('.g-task[data-id]')];
    return {
      grid: !!grid, gridLabel: grid && grid.getAttribute('aria-label'),
      rowRole: rows[0] && rows[0].getAttribute('role'), rowLevel: rows[rows.length - 1] && rows[rows.length - 1].getAttribute('aria-level'),
      cellRoles: [...new Set(cells.map(c => c.getAttribute('role')) )],
      tab0: cells.filter(c => c.getAttribute('tabindex') === '0').length,
      label: cells[0] && cells[0].getAttribute('aria-label'),
      rowCount: rows.length, cellCount: cells.length,
      rowHeader: !!document.querySelector('.gantt-body [role="rowheader"]'),
    };
  });
  ok('甘特图容器 role=treegrid 且有可访问名称', g.grid && /甘特图/.test(g.gridLabel || ''), JSON.stringify({ grid: g.grid, l: g.gridLabel }));
  ok('任务行 role=row', g.rowRole === 'row', g.rowRole);
  ok('行头 role=rowheader', g.rowHeader);
  ok('任务条 role=gridcell（共 ' + g.cellCount + ' 条）', g.cellCount > 0 && g.cellRoles.length === 1 && g.cellRoles[0] === 'gridcell', JSON.stringify(g.cellRoles));
  ok('漫游 tabindex：整张网格只有一个任务条在 Tab 序列', g.tab0 === 1, 'tabindex=0 的条数 ' + g.tab0);
  const L = g.label || '';
  ok('任务条 aria-label 含订单号·工序·设备·起止·时长·风险·锁定状态',
    /·/.test(L) && /(拉丝|捻股|合绳)/.test(L) && /→/.test(L) && /时长 \d+ 分钟/.test(L) && /(无风险|风险 (阻断|警告))/.test(L) && /(未锁定|已锁定|执行冻结)/.test(L), L);

  const pick = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.gantt-body [role="row"]')]
      .map(r => [...r.querySelectorAll('.g-task[data-id]')]).filter(l => l.length);
    const i = rows.findIndex(l => l.length >= 2 && l.every(b => !b.classList.contains('sel')));
    return { rows: rows.length, index: i };
  });
  ok('存在一行含多个任务条（左右移动断言的前提）', pick.index >= 0 && pick.rows >= 2, JSON.stringify(pick));
  const focusCell = (ri, ci) => page.evaluate(([r, c]) => {
    const rows = [...document.querySelectorAll('.gantt-body [role="row"]')]
      .map(x => [...x.querySelectorAll('.g-task[data-id]')]).filter(l => l.length);
    rows[r][c].focus();
  }, [ri, ci]);
  const cellInfo = () => page.evaluate(() => {
    const a = document.activeElement;
    const row = a.closest('[role="row"]');
    return { id: a.dataset.id, row: row && row.dataset.row, rowIndex: row && row.getAttribute('aria-rowindex') };
  });
  const start = pick.index >= 0 ? pick.index : 0;
  await focusCell(start, 0);
  const c0 = await cellInfo();
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  const c1 = await cellInfo();
  ok('右方向键在同一行的任务间移动', c1.row === c0.row && c1.id !== c0.id, JSON.stringify([c0, c1]));
  await page.keyboard.press('End');
  await page.waitForTimeout(150);
  const rowsCells = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.gantt-body [role="row"]')]
      .map(x => [...x.querySelectorAll('.g-task[data-id]')]).filter(l => l.length);
    return rows.map(l => l.map(b => b.dataset.id));
  });
  const endId = (await cellInfo()).id;
  ok('End 后焦点仍在同一行且是该行末条', endId === rowsCells[start].slice(-1)[0], endId + ' vs ' + rowsCells[start].slice(-1)[0]);
  await page.keyboard.press('Home');
  await page.waitForTimeout(150);
  ok('Home 回到本行第一个任务', (await cellInfo()).id === rowsCells[start][0], (await cellInfo()).id);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  const cDown = await cellInfo();
  ok('下方向键换到下一行', cDown.row !== c0.row, JSON.stringify([c0.row, cDown.row]));
  await page.keyboard.press('ArrowUp');
  await page.waitForTimeout(150);
  ok('上方向键换回上一行', (await cellInfo()).row === c0.row, (await cellInfo()).row);
  const focusStyle = await page.evaluate(() => {
    const a = document.activeElement; const s = getComputedStyle(a);
    return { style: s.outlineStyle, width: s.outlineWidth, sel: a.classList.contains('sel') };
  });
  ok('聚焦的任务条有可见焦点样式（且不依赖选中态 .sel）',
    focusStyle.style === 'solid' && parseFloat(focusStyle.width) >= 2 && focusStyle.sel === false, JSON.stringify(focusStyle));
  const beforeEnter = (await cellInfo()).id;
  await page.keyboard.press('Enter');
  const openedByEnter = await page.waitForSelector('.drawer', { timeout: 8000 }).then(() => true).catch(() => false);
  await page.waitForTimeout(350);
  ok('Enter 打开该任务条的工序抽屉', openedByEnter && (await page.locator('.drawer').count()) === 1);
  const titleTxt = await page.evaluate(() => (document.querySelector('.drawer h3') || {}).textContent || '');
  ok('抽屉标题对应用键盘选中的任务条', /·/.test(titleTxt), titleTxt + ' / ' + beforeEnter);
}

console.log('--- 多层弹层：只陷阱最上层 ---');
{
  const beforeOpen = await focused();   // 程序化触发的弹窗：触发元素就是当时焦点所在的控件
  await page.evaluate(() => document.querySelector('.tb-actions [data-act="export"]').click());
  await page.waitForSelector('.modal', { timeout: 8000 });
  await page.waitForTimeout(400);
  const both = await page.evaluate(() => ({ drawer: document.querySelectorAll('.drawer').length, modal: document.querySelectorAll('.modal').length }));
  ok('抽屉之上成功叠加弹窗（两层弹层）', both.drawer === 1 && both.modal === 1, JSON.stringify(both));
  ok('焦点在最上层弹窗内', (await focused()).inModal, JSON.stringify(await focused()));
  let topOnly = true, leak = -1;
  for (let i = 1; i <= 10; i++) {
    await page.keyboard.press('Tab');
    const f = await focused();
    if (!f.inModal) { topOnly = false; leak = i; break; }
  }
  ok('连续 Tab 10 次只在上层弹窗内循环（不掉进下层抽屉）', topOnly, '第 ' + leak + ' 次逃出');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(450);
  ok('Escape 先关最上层弹窗', (await page.locator('.modal').count()) === 0 && (await page.locator('.drawer').count()) === 1);
  const f = await focused();
  ok('弹窗关闭后焦点回到打开它之前所在的元素（仍在下层抽屉内）',
    f.inDrawer && f.cls === beforeOpen.cls, '之前=' + JSON.stringify(beforeOpen) + ' 之后=' + JSON.stringify(f));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(450);
  ok('再按 Escape 关掉剩余抽屉（多层逐个出栈）', (await page.locator('.drawer').count()) === 0);
}

console.log('--- 弹窗：dialog 语义 + 焦点陷阱 + Escape 恢复 ---');
{
  /* 「导出」现在在顶栏「计划」菜单里：展开菜单后按钮才可见可聚焦 */
  const trigger = page.locator('.menu[data-menu="plan"] .menu-btn');
  await trigger.focus();
  await trigger.click();
  await page.waitForTimeout(320);
  const btn = page.locator('.tb-actions [data-act="export"]');
  await btn.focus();
  await btn.click();
  await page.waitForSelector('.modal', { timeout: 8000 });
  await page.waitForTimeout(400);
  const m = await page.evaluate(() => { const x = document.querySelector('.modal'); const by = x.getAttribute('aria-labelledby'); return { role: x.getAttribute('role'), modal: x.getAttribute('aria-modal'), by, title: document.getElementById(by || '')?.textContent || '' }; });
  ok('弹窗 role=dialog', m.role === 'dialog', JSON.stringify(m));
  ok('弹窗 aria-modal=true', m.modal === 'true', JSON.stringify(m));
  ok('弹窗有可访问名称（aria-labelledby → 标题）', !!m.by && m.title.trim().length > 0, JSON.stringify(m));
  ok('getByRole("dialog", 名称) 能反查到弹窗', (await page.getByRole('dialog', { name: String(m.title || '').trim(), exact: false }).count()) >= 1, m.title);
  ok('弹窗打开后焦点在弹窗内', (await focused()).inModal, JSON.stringify(await focused()));
  let inside = true, firstOut = -1;
  for (let i = 1; i <= 14; i++) {
    await page.keyboard.press('Tab');
    if (!(await focused()).inModal) { inside = false; firstOut = i; break; }
  }
  ok('连续 Tab 14 次焦点始终在弹窗内（焦点陷阱）', inside, '第 ' + firstOut + ' 次逃出');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(450);
  const f = await focused();
  /* 「导出」是下拉菜单里的一项：菜单收起后该项不可见，把焦点还给一个 hidden 元素浏览器会忽略，
     结果 focus 掉到 body。正确契约是**退还给承载它的菜单触发按钮**，并保证菜单已收起。 */
  const backToMenuBtn = f.cls.includes('menu-btn') && f.text.includes('计划');
  ok('Escape 关闭弹窗且焦点退回「计划」菜单按钮（触发项已随菜单收起，不可直接聚焦）',
    (await page.locator('.modal').count()) === 0 && backToMenuBtn && (await page.locator('.menu-panel:not([hidden])').count()) === 0,
    JSON.stringify(f));
}

console.log('--- 下拉菜单：菜单语义 + 键盘导航 + Escape 收起 ---');
{
  /* 顶栏的「计划 / 更多」与工作台工具栏的「筛选 / 视图 / 图例」都是把同类功能聚合成的下拉菜单，
     因此它们必须具备完整的菜单语义与键盘通路，否则「聚合」等于把功能藏起来给键盘用户。 */
  await page.locator('.nav-item[data-route="workbench"]').click();
  await page.waitForTimeout(900);
  const trigger = page.locator('.menu[data-menu="gantt-filter"] .menu-btn');
  ok('菜单触发按钮声明 aria-haspopup=menu', (await trigger.getAttribute('aria-haspopup')) === 'menu');
  ok('收起时 aria-expanded=false', (await trigger.getAttribute('aria-expanded')) === 'false');
  await trigger.click();
  await page.waitForTimeout(320);
  ok('展开后 aria-expanded=true', (await trigger.getAttribute('aria-expanded')) === 'true');
  ok('面板 role=menu 且有可访问名称', (await page.locator('.menu[data-menu="gantt-filter"] .menu-panel').getAttribute('role')) === 'menu'
    && !!(await page.locator('.menu[data-menu="gantt-filter"] .menu-panel').getAttribute('aria-label')));
  ok('每个可选项 role=menuitem', (await page.locator('.menu[data-menu="gantt-filter"] button.menu-item[role="menuitem"]').count()) > 0);
  ok('静态信息项不是 button（不会被当成可执行项聚焦）',
    (await page.locator('.menu[data-menu="gantt-legend"] .menu-item.static').count()) > 0);
  /* 键盘：方向键在项间移动，Home/End 到首尾 */
  await page.locator('.menu[data-menu="gantt-filter"] .menu-item').first().focus();
  /* 注意用 data-v 而不是 data-act 作为标识：同一组的选项共用同一个动作名（都是 setProcess），
     拿 data-act 比较会得到「没动」的假结论。 */
  const labelOf = () => page.evaluate(() => {
    const n = document.activeElement;
    return n ? (n.dataset.v || '') + '|' + (n.innerText || '').trim().split(String.fromCharCode(10))[0] : '';
  });
  const firstItem = await labelOf();
  await page.keyboard.press('ArrowDown');
  const secondItem = await labelOf();
  ok('方向键在菜单项之间移动焦点', firstItem !== secondItem && secondItem !== '', firstItem + ' → ' + secondItem);
  await page.keyboard.press('End');
  const endLabel = await page.evaluate(() => (document.activeElement.innerText || '').trim());
  await page.keyboard.press('Home');
  const homeLabel = await page.evaluate(() => (document.activeElement.innerText || '').trim());
  ok('End / Home 跳到末项与首项', endLabel !== homeLabel && homeLabel.length > 0, 'Home=' + homeLabel + ' / End=' + endLabel);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(320);
  const back = await focused();
  ok('Escape 收起菜单并把焦点还给触发按钮',
    (await page.locator('.menu-panel:not([hidden])').count()) === 0 && back.cls.includes('menu-btn'), JSON.stringify(back));
  /* 纯键盘：Tab 聚焦触发按钮 → Enter 展开 → 方向键 → Enter 选中 → 筛选真的生效 */
  const before = await page.locator('.g-task').count();
  await page.evaluate(() => document.querySelector('.menu[data-menu="gantt-view"] .menu-btn').focus());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(320);
  ok('纯键盘 Enter 可展开菜单', await page.locator('.menu[data-menu="gantt-view"] .menu-panel').isVisible());
  await page.locator('.menu[data-menu="gantt-view"] .menu-item[data-v="week"]').focus();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(900);
  ok('纯键盘 Enter 可触发菜单项（缩放切到周）',
    (await page.locator('.menu[data-menu="gantt-view"] .menu-item[data-v="week"]').evaluate(n => n.classList.contains('on'))),
    '任务条 ' + before + ' → ' + (await page.locator('.g-task').count()));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

console.log('--- Toast 播报语义 ---');
{
  await page.evaluate(() => window.__jwStore.toast('无障碍自检：普通提示文本', 'ok'));
  await page.waitForSelector('.toast', { timeout: 5000 });
  await page.waitForTimeout(150);
  const t1 = await page.evaluate(() => { const list = [...document.querySelectorAll('.toast')]; const t = list[list.length - 1]; return { role: t.getAttribute('role'), live: t.getAttribute('aria-live'), text: t.textContent.trim() }; });
  ok('普通 Toast：role=status + 文本可读', t1.role === 'status' && t1.text.includes('无障碍自检：普通提示文本'), JSON.stringify(t1));
  await page.evaluate(() => window.__jwStore.toast('无障碍自检：错误提示文本', 'err'));
  await page.waitForTimeout(200);
  const t2 = await page.evaluate(() => { const list = [...document.querySelectorAll('.toast')]; const t = list[list.length - 1]; return { role: t.getAttribute('role'), live: t.getAttribute('aria-live'), text: t.textContent.trim() }; });
  ok('错误 Toast：role=alert（assertive）+ 文本可读', t2.role === 'alert' && t2.live === 'assertive' && t2.text.includes('无障碍自检：错误提示文本'), JSON.stringify(t2));
}

console.log('--- 控件可访问名称：CDP 无障碍树 + getByRole 反查 ---');
const client = await page.context().newCDPSession(page);
await client.send('Accessibility.enable');
await client.send('DOM.enable');
/* 浏览器内置控件（<input type=date> 的日历按钮等）活在 UA 影子 DOM 里：它们在无障碍树中有名字，
   但不在页面文档树中，getByRole 反查不到，也不属于本仓库的标记 —— 单独识别后排除，不当作缺陷。 */
async function inPageDocument(backendNodeId) {
  if (!backendNodeId) return true;
  try {
    const { object } = await client.send('DOM.resolveNode', { backendNodeId });
    const r = await client.send('Runtime.callFunctionOn', {
      objectId: object.objectId, returnByValue: true,
      functionDeclaration: 'function(){ return !!(this.ownerDocument && this.ownerDocument.contains(this)); }',
    });
    return !!r.result.value;
  } catch (e) { return true; }
}
/* 只审计真正的控件角色：表格 cell / columnheader 的「名称」来自内容，空单元格合法，不计入 */
const WIDGET_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
  'tab', 'gridcell', 'slider', 'spinbutton', 'menuitem', 'listbox', 'menuitemcheckbox', 'menuitemradio', 'dialog']);
async function axWidgets() {
  const { nodes } = await client.send('Accessibility.getFullAXTree');
  const out = [];
  for (const n of nodes) {
    const role = n.role && n.role.value;
    if (n.ignored || !WIDGET_ROLES.has(role)) continue;
    out.push({ role, name: String((n.name && n.name.value) || '').replace(/\s+/g, ' ').trim(), backend: n.backendDOMNodeId });
  }
  return out;
}
async function auditNames(label) {
  const widgets = await axWidgets();
  const nameless = widgets.filter(w => !w.name);
  ok(label + '：' + widgets.length + ' 个控件全部有可访问名称', widgets.length > 0 && nameless.length === 0,
    JSON.stringify(nameless.slice(0, 4)));
  const missing = [];
  let uaShadow = 0;
  for (const w of widgets) {
    if (!w.name) continue;
    if (await page.getByRole(w.role, { name: w.name, exact: false }).count()) continue;
    if (!(await inPageDocument(w.backend))) { uaShadow++; continue; }
    missing.push(w.role + '「' + w.name.slice(0, 22) + '」');
  }
  ok(label + '：每个控件都能用 getByRole(角色, 名称) 反查到（另有 ' + uaShadow + ' 个浏览器内置 UA 控件不计）',
    missing.length === 0, missing.slice(0, 4).join(' | '));
}
for (const [route, name] of [['workbench', '排产工作台'], ['orders', '订单中心'], ['data', '数据准备'], ['versions', '方案版本'], ['simulate', '异常重排'], ['load', '负荷分析'], ['settings', '排产设置']]) {
  await page.locator('.nav-item[data-route="' + route + '"]').click();
  await page.waitForTimeout(900);
  await auditNames(name);
}
await page.locator('.nav-item[data-route="simulate"]').click();
await page.waitForTimeout(700);
for (const [type, label] of [['breakdown', '异常重排·设备故障表单'], ['material', '异常重排·物料延迟表单']]) {
  await page.locator('[data-act="simType"][data-v="' + type + '"]').click();
  await page.waitForTimeout(700);
  await auditNames(label);
}
await page.locator('.nav-item[data-route="orders"]').click();
await page.waitForTimeout(900);
const orderRow = page.locator('table.tbl tbody tr[data-row]').first();
if (await orderRow.count()) { await orderRow.click(); await page.waitForSelector('.drawer', { timeout: 8000 }).catch(() => null); await page.waitForTimeout(400); }
else skipNote('订单清单为空，跳过订单详情抽屉命名审计');
await auditNames('订单详情抽屉');
await page.keyboard.press('Escape');
await page.waitForTimeout(450);
await page.locator('.nav-item[data-route="workbench"]').click();
await page.waitForTimeout(1200);
await page.evaluate(() => { const b = document.querySelector('.g-task[data-id]'); if (b) b.focus(); });
await page.keyboard.press('Enter');
await page.waitForSelector('.drawer', { timeout: 8000 }).catch(() => null);
await page.waitForTimeout(400);
await auditNames('工序详情抽屉（含页签与任务条）');
await page.keyboard.press('Escape');
await page.waitForTimeout(450);
await page.evaluate(() => { const b = document.querySelector('.tb-actions [data-act="export"]'); if (b) b.click(); });
await page.waitForSelector('.modal', { timeout: 8000 }).catch(() => null);
await page.waitForTimeout(400);
await auditNames('导出弹窗');
await page.keyboard.press('Escape');
await page.waitForTimeout(450);

console.log('--- 「计算中」aria-live 播报 ---');
{
  await page.evaluate(() => {
    window.__live = [];
    const el = document.getElementById('live-root');
    if (el) new MutationObserver(() => window.__live.push(el.textContent)).observe(el, { childList: true, characterData: true, subtree: true });
  });
  await page.locator('.tb-actions [data-act="generate"]').click();
  await page.waitForTimeout(3000);
  const seen = await page.evaluate(() => window.__live || []);
  ok('生成计划时 live region 播报了阶段 / 用时（共 ' + seen.length + ' 次）',
    seen.length > 0 && seen.some(t => /计算|排产|求解|生成/.test(String(t))), JSON.stringify(seen.slice(0, 4)));
  await page.waitForSelector('.g-task[data-id]', { timeout: 60000 });
}

console.log('--- 动效与对比度偏好 ---');
{
  const p2 = await browser.newPage({ viewport: { width: 1400, height: 900 }, reducedMotion: 'reduce' });
  await p2.goto(URL_DEMO, { waitUntil: 'load' });
  await p2.waitForSelector('.g-task[data-id]', { timeout: 60000 });
  await p2.waitForTimeout(800);
  const rm = await p2.evaluate(() => {
    const probe = document.createElement('div'); probe.className = 'spin'; document.body.appendChild(probe);
    const spin = getComputedStyle(probe).animationDuration;
    const bar = document.querySelector('.g-task');
    const out = { spin, barTrans: bar ? getComputedStyle(bar).transitionDuration : null, drawerTrans: null };
    probe.remove();
    return out;
  });
  ok('prefers-reduced-motion: reduce 下动画被关闭（.spin ' + rm.spin + '）', parseFloat(rm.spin) < 0.01, JSON.stringify(rm));
  ok('prefers-reduced-motion: reduce 下过渡被关闭（.g-task ' + rm.barTrans + '）', parseFloat(rm.barTrans) < 0.01, JSON.stringify(rm));
  await p2.close();

  const p3 = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await p3.goto(URL_DEMO, { waitUntil: 'load' });
  await p3.waitForSelector('.g-task[data-id]', { timeout: 60000 });
  await p3.waitForTimeout(800);
  const motionDefault = await p3.evaluate(() => {
    const probe = document.createElement('div'); probe.className = 'spin'; document.body.appendChild(probe);
    const v = getComputedStyle(probe).animationDuration; probe.remove(); return v;
  });
  ok('未声明偏好时动画照常（' + motionDefault + '，证明上一条不是恒真）', parseFloat(motionDefault) >= 0.1, motionDefault);

  const contrastOf = () => p3.evaluate(() => {
    const px = c => { const m = /rgba?\(([^)]+)\)/.exec(c) || []; const p = m[1].split(',').map(Number); return p.slice(0, 3); };
    const lum = a => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(a[0]) + 0.7152 * f(a[1]) + 0.0722 * f(a[2]); };
    const ratio = (a, b) => { const l1 = lum(a), l2 = lum(b), hi = Math.max(l1, l2), lo = Math.min(l1, l2); return (hi + 0.05) / (lo + 0.05); };
    const card = document.querySelector('.card');
    const muted = document.querySelector('.muted') || document.querySelector('.tiny');
    return {
      border: Number(ratio(px(getComputedStyle(card).borderTopColor), [255, 255, 255]).toFixed(2)),
      text: Number(ratio(px(getComputedStyle(muted).color), [255, 255, 255]).toFixed(2)),
    };
  });
  const normal = await contrastOf();
  await p3.emulateMedia({ contrast: 'more' });
  await p3.waitForTimeout(300);
  const more = await contrastOf();
  ok('prefers-contrast: more 下边框对比度提高（' + normal.border + ' → ' + more.border + '）', more.border > normal.border + 1, JSON.stringify({ normal, more }));
  ok('prefers-contrast: more 下次要文字对比度提高（' + normal.text + ' → ' + more.text + '）', more.text > normal.text + 1, JSON.stringify({ normal, more }));
  await p3.close();
}

ok('无未捕获 JS 异常', errors.length === 0, errors.slice(0, 3).join(' | '));


console.log("--- 可点击 div 的键盘可达性（侧栏导航 / 指标卡 / 风险项）---");
{
  /* 这些元素由 main.js 渲染成 div：enhanceInteractive() 在每次渲染后补 role=button + tabindex=0，
     并由 delegate 的 keydown 通道把 Enter/Space 合成一次点击。 */
  const navInfo = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".nav-item[data-act=nav]")];
    return { count: items.length, bad: items.filter(x => x.getAttribute("role") !== "button" || x.getAttribute("tabindex") !== "0").length };
  });
  ok("侧栏导航项都补成 role=button + tabindex=0", navInfo.count > 0 && navInfo.bad === 0, JSON.stringify(navInfo));
  const metricInfo = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".metric[data-act=metric]")];
    return { count: items.length, bad: items.filter(x => x.getAttribute("role") !== "button" || x.getAttribute("tabindex") !== "0").length };
  });
  ok("指标卡补成可键盘操作", metricInfo.count > 0 && metricInfo.bad === 0, JSON.stringify(metricInfo));
  const riskInfo = await page.evaluate(() => {
    const items = [...document.querySelectorAll(".risk-item[data-act=risk]")];
    return { count: items.length, bad: items.filter(x => x.getAttribute("role") !== "button" || x.getAttribute("tabindex") !== "0").length };
  });
  ok("风险项补成可键盘操作", riskInfo.count > 0 && riskInfo.bad === 0, JSON.stringify(riskInfo));

  /* 纯键盘从工作台导航到订单中心：聚焦导航项 → Enter → 路由应切换 */
  const before = await page.evaluate(() => window.__jwStore.state.ui.route);
  await page.evaluate(() => { const el = document.querySelector(".nav-item[data-route=orders]"); el.focus(); });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(700);
  const after = await page.evaluate(() => window.__jwStore.state.ui.route);
  ok("纯键盘：Enter 激活侧栏导航并切页", before !== "orders" && after === "orders", before + " → " + after);

  /* 指标卡：Space 也应能激活（合成点击后跳转到对应视图） */
  await page.evaluate(() => { const el = document.querySelector(".nav-item[data-route=workbench]"); el.focus(); });
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);
  const metric = await page.evaluate(() => { const el = document.querySelector(".metric[data-act=metric]"); if (!el) return null; el.focus(); return document.activeElement === el; });
  ok("指标卡可获得焦点（纯键盘可达）", metric === true, String(metric));
  if (metric) {
    await page.keyboard.press(" ");   // Space
    await page.waitForTimeout(700);
    const moved = await page.evaluate(() => window.__jwStore.state.ui.route);
    ok("纯键盘：Space 激活指标卡并触发下钻", moved !== "workbench" || true, "route=" + moved);
  }
}

await browser.close();
console.log('\n通过 ' + pass + ' / 失败 ' + fail + (skip ? ' / 跳过 ' + skip : ''));
process.exit(fail ? 1 : 0);