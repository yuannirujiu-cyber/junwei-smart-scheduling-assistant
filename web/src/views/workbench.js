/* D03 排产工作台：指标卡 + 双视角甘特图 + 风险面板 */
import { html, raw, icon, qs, el, clear } from '../core/dom.js';
import { metricCards, tag, versionTag, emptyState, openModal } from '../components/ui.js';
import { renderGantt, locateTask, ZOOMS } from '../components/gantt.js';
import { PROCESSES } from '../engine/rules.js';
import { fmtDateTime, round, HOUR } from '../core/util.js';
import { mountOrderImport, openOrderFilePicker } from './orderImport.js';

export function renderWorkbench(host, ctx) {
  const { version, metrics, validation, ui, settings, gate } = ctx;

  if (!version) {
    host.className = 'view';
    host.innerHTML = emptyState({ icon: 'gauge', title: '还没有排产结果',
      desc: '上传订单文件后，系统会按 R1–R10 约束把订单拆到拉丝 → 捻股 → 合绳三道工序，并排到具体机台与时间。',
      actions: [{ label: '上传订单文件', act: 'uploadOrder', cls: 'primary', icon: 'upload' }] }) +
      '<input id="workbenchOrderFile" type="file" accept=".xlsx,.csv" style="display:none" />';
    mountOrderImport(host, ctx);
    return;
  }

  const stale = !!version.dirty || version.status === 'stale';
  const host2 = host;
  const command = html`
    ${raw(ctx.todayControl)}
    <button class="btn sm" data-act="uploadOrder">${raw(icon('upload', 14))}上传订单</button>
    <button class="btn sm primary" data-act="generate"${gate.ok ? '' : ' disabled'} title="${gate.ok ? '按当前排产设置生成候选计划' : '缺少必需条件：' + gate.reasons.join('；')}">${raw(icon('play', 14))}重新生成</button>
    <input id="workbenchOrderFile" type="file" accept=".xlsx,.csv" style="display:none" />`;

  host2.innerHTML = html`
    <div style="display:flex;flex-direction:column;height:100%;min-height:0">
      <div class="workbench-actions">${raw(command)}</div>
      ${metricCards(metrics, { stale, active: ui.metricFilter, layout: 'workbench' })}
      ${version.basedOnOldData ? html`<div class="banner gray" style="margin:10px 20px 0">${raw(icon('info', 16))}
        <div><b>当前版本基于已替换的数据快照（${version.datasetKey || '—'}）。</b>该版本内容与确认记录未被覆写；如需按当前数据排产请重新生成。</div></div>` : ''}
      ${stale ? html`<div class="banner warn" style="margin:10px 20px 0">
        ${raw(icon('refresh', 16))}<div><b>存在未重算的修改。</b>当前指标与甘特图基于上一次计算结果，确认前必须重算。</div>
        <div class="act"><button class="btn sm primary" data-act="generate">立即重算</button></div>
      </div>` : ''}
      <div style="flex:1;min-height:0;display:flex;flex-direction:column;padding:10px 20px 0">
        <div id="gantt-host" style="flex:1;min-height:0;display:flex"></div>
      </div>
    </div>`;

  const ganttHost = qs('#gantt-host', host2);
  const gctx = {
    version, cap: ctx.cap, ui, settings, validation,
    filter: ui.filters.workbench,
    selectedOrderId: ui.selection.orderId, selectedTaskId: ui.selection.taskId,
  };
  renderGantt(ganttHost, gctx);
  mountOrderImport(host2, ctx);
  ctx.ganttApi = gctx.api;

  /* 定位选中任务 */
  if (ui.selection.taskId && ui.gantt.__locate) {
    const t = version.tasks.find(x => x.id === ui.selection.taskId);
    if (t) { const el2 = qs('[data-act="task"][data-id="' + CSS.escape(t.id) + '"]', host2); el2?.scrollIntoView({ block: 'nearest' }); }
  }
}

export const WORKBENCH_ACTIONS = {
  uploadOrder: (ctx, node) => openOrderFilePicker(node.closest('.view') || document),
  async generate(ctx) {
    const v = ctx.store.currentVersion;
    await ctx.store.generate({ reason: v ? '重算计划' : '首排候选计划', keepLocksFrom: v?.id });
    ctx.navigate('workbench');
  },
  setCurrentDate: (ctx, node) => { ctx.store.setCurrentDate(String(node.value || '').trim() || null); ctx.rerender(); },
  resetCurrentDate: (ctx) => { ctx.store.setCurrentDate(null); ctx.rerender(); },
  view: (ctx, node, ds) => { ctx.ui.gantt.view = ds.v; ctx.rerender(); },
  zoom: (ctx, node, ds) => { ctx.ui.gantt.zoom = ds.v; ctx.rerender(); },
  collapse: (ctx, node, ds) => {
    const k = ds.key;
    if (k.startsWith('idle:')) ctx.ui.gantt.expanded[k] = !ctx.ui.gantt.expanded[k];
    else ctx.ui.gantt.collapsed[k] = !ctx.ui.gantt.collapsed[k];
    ctx.rerender();
  },
  expand: (ctx, node, ds) => { ctx.ui.gantt.expanded[ds.key] = !ctx.ui.gantt.expanded[ds.key]; ctx.rerender(); },
  today: (ctx) => scrollToToday(ctx),
  locate: (ctx) => pickTaskToLocate(ctx),
  task: (ctx, node, ds) => {
    ctx.ui.selection = { ...ctx.ui.selection, taskId: ds.id };
    const t = ctx.version.tasks.find(x => x.id === ds.id);
    if (t) ctx.ui.selection.orderId = t.orderId;
    ctx.openTask(ds.id);
  },
  riskFilter: (ctx, node, ds) => { ctx.ui.riskFilter = ds.v; ctx.rerender(); },
  toggleRisk: (ctx) => { ctx.ui.riskOpen = !ctx.ui.riskOpen; ctx.rerender(); },
  focusRisk: (ctx, node, ds) => { ctx.ui.riskFilter = ds.level || 'block'; ctx.ui.riskOpen = true; ctx.rerender(); },
  risk: (ctx, node, ds) => {
    const r = ctx.validation.risks.find(x => x.id === ds.id);
    if (!r) return;
    if (r.taskId) { ctx.ui.selection = { ...ctx.ui.selection, taskId: r.taskId, orderId: r.orderId }; ctx.openTask(r.taskId); return; }
    if (r.orderId) { ctx.openOrder(r.orderId); return; }
    if (r.machineId) { ctx.navigate('load'); return; }
  },
  metric: (ctx, node, ds) => {
    const k = ds.key;
    if (k === 'hard' || k === 'unsched') { ctx.ui.riskFilter = 'block'; ctx.navigate('orders'); return; }
    if (k === 'late') { ctx.ui.riskFilter = 'warn'; ctx.navigate('orders'); return; }
    if (k === 'occ') { ctx.navigate('load'); return; }
    ctx.navigate('orders', { filters: { ...ctx.ui.filters, order: { ...(ctx.ui.filters.order || {}), status: 'all' } } });
  },
  /* 菜单里的工序单选（button 没有 .value，取值走 data-v）。
     原先还有一个读 <select>.value 的 filterProcess，工序下拉被收进「筛选」面板后已无触发元素，删除。 */
  setProcess: (ctx, node, ds) => { ctx.ui.filters.workbench.process = ds.v || 'all'; ctx.rerender(); },
  selectGanttProcess: (ctx, node, ds) => {
    ctx.ui.filters.workbench.process = ds.v || 'all';
    ctx.rerender();
  },
  filterKw: (ctx, node) => { ctx.ui.filters.workbench.keyword = node.value; ctx.rerender(); },
  toggleOnlyRisk: (ctx) => { const f = ctx.ui.filters.workbench; f.onlyRisk = !f.onlyRisk; ctx.rerender(); },
  clearFilter: (ctx) => {
    ctx.ui.filters.workbench = { process: 'all', onlyRisk: false, keyword: '' };
    ctx.rerender();
  },
  /* 这两个开关同时被「复选框」和「菜单项」使用：复选框读 .checked，菜单项按当前值取反 */
  toggleChange: (ctx, node) => {
    ctx.ui.gantt.showChangeover = node.type === 'checkbox' ? node.checked : !ctx.ui.gantt.showChangeover;
    ctx.rerender();
  },
  toggleDown: (ctx, node) => {
    ctx.ui.gantt.showDowntime = node.type === 'checkbox' ? node.checked : ctx.ui.gantt.showDowntime === false;
    ctx.rerender();
  },
  moreOrders: (ctx) => { ctx.ui.gantt.orderLimit = (ctx.ui.gantt.orderLimit || 40) + 40; ctx.rerender(); },
};

function scrollToToday(ctx) {
  const sc = qs('[data-scroll]');
  if (!sc) return;
  const api = window.__ganttApi;
  /* 滚到「排产参考今天」而不是系统当前时刻：数据是历史窗口时系统日期可能在窗口外，滚过去是空的。 */
  const ms = typeof api.todayMs === 'function' ? api.todayMs() : Date.now();
  if (api) sc.scrollLeft = Math.max(0, api.x(ms) - 260);
}

function pickTaskToLocate(ctx) {
  const t = ctx.version.tasks.find(x => x.id === ctx.ui.selection.taskId);
  if (!t) { ctx.toast('请先在甘特图中选择一个任务', 'warn'); return; }
  const sc = qs('[data-scroll]');
  const api = window.__ganttApi;
  if (sc && api) sc.scrollLeft = Math.max(0, api.x(t.start) - 260);
  const node = qs('[data-act="task"][data-id="' + CSS.escape(t.id) + '"]');
  node?.scrollIntoView({ block: 'center' });
}
