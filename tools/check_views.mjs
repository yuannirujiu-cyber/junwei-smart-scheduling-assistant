/* 视图渲染集成自检（无需浏览器）：
   用最小 DOM 桩驱动**真实 store**（web/src/core/store.js）载入数据 → 真实引擎排产 → 逐个渲染 D00–D07 页面，
   断言：不抛异常、无 undefined/NaN/[object Object] 泄漏、无二次转义、关键元素与任务条存在。

   审查报告 §六 指出的问题与本次修正：
   - 原 :86 手搓 state 时自己补了 gantt.expanded: {}，而真实 store.createState() 没有 → P0-1 被夹具掩盖。
     现在直接使用真实 store 的 ui 对象（loadDataset 后清空版本作为干净起点），不再手搓 ui。
   - 原 :106 的二次转义检测只匹配 &lt;div|span|table，检测不到 &amp;lt; 与其他标签名；
     现在检测任意 &amp;lt; 与 &lt; + 任意标签名。
   - 原 :151 的 includes(class=g-task) 可能被图例里写死的 class=g-change 之类子串命中；
     现在用正则 /class="g-task\b/。
   - 新增断言：设备视角与订单视角都必须渲染出任务条；至少一个「空闲设备」分组可展开；
     甘特/工作台渲染不得出现「页面渲染失败」横幅。
   用法：node tools/check_views.mjs [data/dataset.json|data/demo-dataset.json]（两份数据都会跑） */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BT = String.fromCharCode(96);        // 反引号：用于检测未替换的模板占位符
const DOLLAR = String.fromCharCode(36);
const BS = String.fromCharCode(92);

/* ---------- 最小 DOM 桩 ---------- */
function stubEl(tag = 'div') {
  return {
    tagName: tag, innerHTML: '', textContent: '', className: '', value: '', checked: false, disabled: false,
    style: {}, dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {},
    remove() {}, scrollIntoView() {}, focus() {}, click() {},
    contains() { return false; }, closest() { return null; },
    querySelector() { return stubEl(); },
    querySelectorAll() { return []; },
  };
}
globalThis.document = {
  createElement: (t) => stubEl(t),
  createDocumentFragment: () => stubEl('fragment'),
  createTextNode: (t) => ({ text: String(t) }),
  querySelector: () => stubEl(),
  querySelectorAll: () => [],
  body: stubEl('body'),
  addEventListener() {},
};
globalThis.window = globalThis;
globalThis.requestAnimationFrame = (fn) => { fn(); };
globalThis.CSS = { escape: (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => BS + c) };
globalThis.performance = globalThis.performance || { now: () => Date.now() };

/* ---------- 真实 store + 真实视图 ---------- */
const { store } = await import(resolve(ROOT, 'web/src/core/store.js'));
const { PROCESSES } = await import(resolve(ROOT, 'web/src/engine/rules.js'));
const { renderWorkbench } = await import(resolve(ROOT, 'web/src/views/workbench.js'));
const { renderOrders } = await import(resolve(ROOT, 'web/src/views/orders.js'));
const { renderDataPrep } = await import(resolve(ROOT, 'web/src/views/dataPrep.js'));
const { renderSettings } = await import(resolve(ROOT, 'web/src/views/settings.js'));
const { renderVersions } = await import(resolve(ROOT, 'web/src/views/versions.js'));
const { renderSimulate } = await import(resolve(ROOT, 'web/src/views/simulate.js'));
const { renderLoad } = await import(resolve(ROOT, 'web/src/views/load.js'));
const { renderGantt } = await import(resolve(ROOT, 'web/src/components/gantt.js'));

let pass = 0, fail = 0, skip = 0;
const ok = (n, c, e = '') => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n + (e ? ' :: ' + e : '')); } };
const skipNote = (n) => { skip++; console.log('  SKIP: ' + n); };
const S = (h) => String(h);

const scan = (name, htmlText) => {
  const s = S(htmlText);
  ok(name + ' 非空', s.length > 200, 'len=' + s.length);
  ok(name + ' 无 undefined', !/undefined/.test(s), (s.match(/.{0,40}undefined.{0,40}/) || [''])[0]);
  ok(name + ' 无 NaN', !/\bNaN\b/.test(s), (s.match(/.{0,40}NaN.{0,40}/) || [''])[0]);
  ok(name + ' 无 [object Object]', !s.includes('[object Object]'));
  /* 二次转义：既查 &amp;lt;（已转义内容被再转义一次），也查 &lt; + 任意标签名 */
  const esc = s.match(/&amp;lt;|&lt;[a-zA-Z/!]/);
  ok(name + ' 无二次转义', !esc, esc ? s.slice(Math.max(0, esc.index - 45), esc.index + 60) : '');
  ok(name + ' 无未替换占位符', !s.includes(DOLLAR + '{') && !s.includes(BT));
  ok(name + ' 无「页面渲染失败」横幅', !s.includes('页面渲染失败'));
};

/** 复刻 main.js:120-124 的兜底：视图抛异常时页面顶部会出现「页面渲染失败」横幅 */
function renderPage(label, name, fn, host) {
  try { fn(host, mkCtx()); }
  catch (e) {
    fail++;
    console.log('  FAIL: ' + label + ' ' + name + ' 渲染抛异常（main.js 会显示「页面渲染失败」横幅） :: ' + e.message);
    host.innerHTML = '<div class="banner block"><b>页面渲染失败</b><div>' + String(e.message) + '</div></div>';
  }
  scan(label + ' ' + name, host.innerHTML);
}

function mkCtx() {
  const state = store.state;
  const version = store.currentVersion;
  return {
    store, state, snapshot: state.snapshot, cap: store.cap, settings: state.settings,
    version, metrics: version ? version.metrics : null, validation: version ? version.validation : null,
    ui: state.ui, navigate() {}, rerender() {}, toast() {}, openTask() {}, openOrder() {},
    exportLoadReport() {}, afterImport: async () => {},
    __formActs: {}, __inputActs: {}, __changeActs: {},
  };
}

async function runDataset(label, file) {
  console.log('=== ' + label + '（' + file + '）');
  const ds = JSON.parse(await readFile(resolve(ROOT, file), 'utf8'));
  await store.loadDataset('check-' + label, ds, { id: 'check-' + label, name: '自检快照 ' + label });
  /* 夹具：干净起点。**不补 ui.gantt.expanded**——那正是 P0-1 被掩盖的原因 */
  store.state.versions = []; store.state.currentVersionId = null;
  const version = await store.generate({ reason: '自检首排' });
  const state = store.state, cap = store.cap, settings = state.settings, ui = state.ui;
  const snapshot = state.snapshot, metrics = version.metrics, validation = version.validation;

  ok(label + ' [前置] 真实 store 的 ui 完整（gantt.expanded 必须由 createState 提供）',
    !!ui.gantt && !!ui.gantt.expanded, 'ui.gantt=' + JSON.stringify(ui.gantt));
  console.log('  订单 ' + snapshot.orders.length + ' · 任务 ' + version.tasks.length + ' · 准时率 ' + metrics.deliveryRate + '%');

  for (const [name, fn] of [
    ['D03 工作台', renderWorkbench],
    ['D02 订单中心', renderOrders],
    ['D01 数据准备', renderDataPrep],
    ['D00 排产设置', renderSettings],
    ['D05 方案版本', renderVersions],
    ['D06 异常重排', renderSimulate],
    ['D07 负荷分析', renderLoad],
  ]) renderPage(label, name, fn, stubEl());

  /* 甘特图两个视角 + 三种缩放：两个视角都必须渲染出任务条 */
  const gctx = () => ({ version, cap, ui, settings, validation,
    filter: ui.filters.workbench, selectedOrderId: null, selectedTaskId: null });
  for (const view of ['machine', 'order']) {
    for (const zoom of ['hour', 'day', 'week']) {
      const host = stubEl();
      ui.gantt.view = view; ui.gantt.zoom = zoom;
      const tag = '甘特图 ' + view + '/' + zoom;
      try {
        renderGantt(host, gctx());
        scan(label + ' ' + tag, host.innerHTML);
        /* 用正则而不是 includes：图例里写死的 class=g-change 之类子串不得命中 */
        ok(label + ' ' + tag + ' 渲染出任务条', /class="g-task\b/.test(S(host.innerHTML)),
          (S(host.innerHTML).match(/class="g-[a-z-]+/g) || []).slice(0, 6).join(' '));
        ok(label + ' ' + tag + ' 图例存在', S(host.innerHTML).includes('g-legend'));
      } catch (e) { fail++; console.log('  FAIL: ' + label + ' ' + tag + ' :: ' + e.message); }
    }
  }

  /* 空闲设备分组必须可展开（真实数据可能台台有任务，则明确 SKIP 而不是通过） */
  ui.gantt.view = 'machine'; ui.gantt.zoom = 'day';
  const schedUids = new Set(version.tasks.filter(t => t.scheduled).map(t => t.machineUid));
  let idleProc = null, idleMachine = null;
  for (const p of PROCESSES) {
    const ms = cap.machines[p.key] || [];
    const idle = ms.filter(m => !schedUids.has(m.uid));
    if (idle.length) { idleProc = p.key; idleMachine = idle[0]; break; }
  }
  if (!idleProc) {
    skipNote(label + ' 「空闲设备」分组：本数据集全部机台均有任务，无空闲分组（该断言由另一份数据覆盖）');
  } else {
    try {
      const key = 'idle:' + idleProc;
      const collapsed = stubEl();
      ui.gantt.expanded[key] = false;
      renderGantt(collapsed, gctx());
      const expanded = stubEl();
      ui.gantt.expanded[key] = true;
      renderGantt(expanded, gctx());
      const rowSel = 'data-row="' + idleMachine.uid + '"';
      ok(label + ' 「空闲设备」分组（' + idleProc + '，' + idleMachine.uid + '）可展开出机台行',
        S(expanded.innerHTML).includes(rowSel) && !S(collapsed.innerHTML).includes(rowSel),
        '展开后含 ' + S(expanded.innerHTML).includes(rowSel) + ' / 收起时含 ' + S(collapsed.innerHTML).includes(rowSel));
    } catch (e) { fail++; console.log('  FAIL: ' + label + ' 「空闲设备」分组展开 :: ' + e.message); }
  }

  /* 订单视角展开订单 → 出现工序子行 */
  const firstOrder = (version.model && version.model.active || [])[0];
  if (!firstOrder) {
    skipNote(label + ' 订单视角展开：无 active 订单');
  } else {
    try {
      ui.gantt.view = 'order';
      ui.gantt.expanded[firstOrder.id] = true;
      const host = stubEl();
      renderGantt(host, Object.assign(gctx(), { selectedOrderId: firstOrder.id }));
      scan(label + ' 甘特图 展开订单', host.innerHTML);
      ok(label + ' 甘特图 展开订单后出现工序子行', S(host.innerHTML).includes('g-row sub'));
      ui.gantt.expanded[firstOrder.id] = false;
    } catch (e) { fail++; console.log('  FAIL: ' + label + ' 甘特图 展开订单 :: ' + e.message); }
  }
}

const primary = process.argv[2] || 'data/dataset.json';
const demo = 'data/demo-dataset.json';
await runDataset('dataset', primary);
if (primary !== demo) await runDataset('demo', demo);

console.log('通过 ' + pass + ' / 失败 ' + fail + (skip ? ' / 跳过 ' + skip : ''));
process.exit(fail ? 1 : 0);
