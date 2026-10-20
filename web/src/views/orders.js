/* D02 订单中心：筛选、汇总、列表、详情抽屉与交期政策补录 */
import { html, raw, icon, qs } from '../core/dom.js';
import { dataTable, tag, procTag, dueTag, chainView, openDrawer, emptyState, section, ruleTags, riskList } from '../components/ui.js';
import { PROC_MAP } from '../engine/rules.js';
import { fmtDate, fmtDateTime, fmtNum, round, HOUR } from '../core/util.js';
import { parseSpec, layLabel } from '../engine/spec.js';
import { menuButton } from '../components/ui.js';
import { checkOrderMaterials } from '../engine/materials.js';
import { estimateStrandDiameter as estStrand } from '../engine/mapping.js';

export function renderOrders(host, ctx) {
  const { snapshot, version, ui } = ctx;
  if (!snapshot) { host.innerHTML = emptyState({ icon: 'db', title: '尚未载入数据', desc: '请先回到排产工作台上传订单文件。' }); return; }
  const f = ui.filters.order || {};
  /* 生效中的筛选数：筛选被收进面板后，必须让按钮自己显示「还开着几个筛选」，否则用户看不出列表被过滤过。 */
  /* 材料门禁：缺料的订单整行标红（订单异常），与排产阻断清单同源。 */
  const materials = ctx.settings.materials || [];
  const matOf = new Map();
  for (const o of snapshot.orders) {
    if (o.endCode === '已结束') continue;
    const r = checkOrderMaterials(o, materials);
    if (!r.ok) matOf.set(o.id, r.missing);
  }
  const activeOrdersFilterCount = ['priority', 'duePolicy', 'status', 'risk', 'keyword']
    .filter(k => f[k]).length + (f.includeHistory ? 1 : 0);
  const stats = version?.validation?.orderStats || new Map();
  const risks = version?.validation?.risks || [];
  const riskCounts = version?.validation?.counts || { block: 0, warn: 0, info: 0 };
  const riskFilter = ui.riskFilter || 'all';
  const tasksByOrder = new Map();
  for (const t of (version?.tasks || [])) { if (!tasksByOrder.has(t.orderId)) tasksByOrder.set(t.orderId, []); tasksByOrder.get(t.orderId).push(t); }

  const all = snapshot.orders.filter(o => f.includeHistory ? true : o.endCode !== '已结束');
  const rows = all.filter(o => {
    if (f.keyword) {
      const k = f.keyword.toLowerCase();
      if (!(String(o.id).toLowerCase().includes(k) || String(o.spec || '').toLowerCase().includes(k) || String(o.productName || '').includes(f.keyword))) return false;
    }
    if (f.priority && (o.priority || '普通') !== f.priority) return false;
    if (f.duePolicy && (o.duePolicy || 'unknown') !== f.duePolicy) return false;
    if (f.status) {
      const st = statusOf(o, tasksByOrder.get(o.id));
      if (f.status !== st) return false;
    }
    if (f.risk) {
      const r = stats.get(o.id);
      if (!r || !riskMatches(r, f.risk)) return false;
    }
    if (f.dueFrom && o.preShipDate && o.preShipDate < f.dueFrom) return false;
    if (f.dueTo && o.preShipDate && o.preShipDate > f.dueTo) return false;
    return true;
  });

  const cnt = {
    total: all.length,
    scheduled: all.filter(o => (tasksByOrder.get(o.id) || []).length === 3).length,
    unscheduled: all.filter(o => { const t = tasksByOrder.get(o.id) || []; return t.length < 3; }).length,
    hard: all.filter(o => o.duePolicy === 'hard').length,
    unknown: all.filter(o => !o.duePolicy || o.duePolicy === 'unknown').length,
  };

  const cols = [
    { label: '订单号', render: o => html`<b class="mono">${o.id}</b>`, width: '112px' },
    { label: '品名 / 规格', render: o => html`<div class="ellip" style="max-width:170px" title="${(o.productName || '') + ' ' + (o.spec || '')}">
        <div>${o.productName || '—'}</div><div class="tiny muted mono">${o.spec || '—'}</div></div>`, width: '170px' },
    { label: '数量', num: true, render: o => html`${o.qtyMeters != null ? fmtNum(o.qtyMeters, 0) + ' ' + (o.qtyMetersUnit || '米') : '<span class="muted">—</span>'}
        ${o.qtyKg != null ? html`<div class="tiny muted">${fmtNum(o.qtyKg, 0)} ${o.qtyKgUnit || 'Kg'}</div>` : ''}`, width: '64px' },
    { label: '预发货日', render: o => o.preShipDate ? fmtDate(o.preShipDate) : html`<span class="tag red sm">缺失</span>`, width: '76px' },
    { label: '优先级', render: o => tag(o.priority || '普通', o.priority === '重点客户' ? 'red' : o.priority === '重点订单' ? 'amber' : 'gray'), width: '58px' },
    { label: '交期政策', render: o => dueTag(o.duePolicy || 'unknown', o.graceHours), width: '98px' },
    { label: '预计合绳完工', render: o => { const t = (tasksByOrder.get(o.id) || []).find(x => x.process === 'closing'); return t ? fmtDateTime(t.end) : html`<span class="muted">—</span>`; }, width: '100px' },
    { label: '预计延期', num: true, render: o => { const r = stats.get(o.id); if (!r || r.tardH == null) return html`<span class="muted tiny">未知</span>`;
        return r.tardH > 0 ? html`<span style="color:var(--warn);font-weight:600">${round(r.tardH, 1)} h</span>` : html`<span style="color:var(--ok)">准时</span>`; }, width: '64px' },
    { label: '材料', render: o => { const miss = matOf.get(o.id); if (!miss) return tag('齐备', 'green', 'check');
        return html`<span title="${miss.map(x => x.name + '：' + x.reason).join('；')}">${raw(tag('缺料·' + miss.map(x => x.name).join('、'), 'red', 'alert'))}</span>`; }, width: '86px' },
    { label: '排产状态', render: o => { const t = tasksByOrder.get(o.id) || []; const d = t.filter(x => x.process === 'drawing').length,
        s = t.filter(x => x.process === 'stranding').length, c = t.filter(x => x.process === 'closing').length;
        const full = d && s && c; const any = d || s || c;
        return tag(full ? '已排' : any ? '部分排产' : '未排', full ? 'green' : any ? 'amber' : 'red'); }, width: '70px' },
    { label: '风险', render: o => { const r = stats.get(o.id); if (!r) return html`<span class="muted tiny">—</span>`;
        if (r.statusTag === 'hard-violation') return tag('硬交期违约', 'red', 'alert');
        if (r.statusTag === 'soft-over') return tag('超宽限', 'red', 'alert');
        if (r.statusTag === 'soft-grace') return tag('宽限内延期', 'amber', 'info');
        if (r.statusTag === 'unverifiable') return tag('交期未知', 'gray', 'alert');
        if (r.statusTag === 'unknown-policy') return tag('政策待确认', 'gray', 'info');
        return tag('准时', 'green', 'check'); }, width: '72px' },
  ];

  host.className = 'view orders-view';
  host.innerHTML = html`
    <div class="grid g6 mb">
      ${raw([['订单总数', cnt.total, ''], ['已排产', cnt.scheduled, 'good'], ['未/部分排产', cnt.unscheduled, cnt.unscheduled ? 'bad' : ''],
         ['硬交期订单', cnt.hard, 'bad'], ['政策待确认', cnt.unknown, 'warnv'], ['历史已结束', snapshot.orders.filter(o => o.endCode === '已结束').length, '']]
        .map(c => html`<div class="card"><div class="card-b" style="padding:10px 12px">
          <div class="tiny muted">${c[0]}</div>
          <div style="font-size:20px;font-weight:680;font-variant-numeric:tabular-nums" class="${c[2]}">${c[1]}</div></div></div>`).join(''))}
    </div>

    <div class="card mb"><div class="card-b">
      <div class="row">
        <input type="text" data-act="fKeyword" placeholder="订单号 / 规格 / 品名关键词" value="${f.keyword || ''}" style="width:230px" />
        ${raw(menuButton({ id: 'orders-filter', label: '筛选', ico: 'filter', align: 'left', keepOpen: true, wide: true,
          badge: activeOrdersFilterCount || '',
          title: '按优先级、交期政策、排产状态与风险筛选订单',
          items: [
            { head: '优先级' },
            { label: '全部优先级', act: 'setFilter', v: 'priority:', checked: !f.priority },
            ...['重点客户', '重点订单', '普通'].map(p => ({ label: p, act: 'setFilter', v: 'priority:' + p, checked: f.priority === p })),
            { sep: true },
            { head: '交期政策' },
            { label: '全部交期政策', act: 'setFilter', v: 'duePolicy:', checked: !f.duePolicy },
            { label: '硬交期', act: 'setFilter', v: 'duePolicy:hard', checked: f.duePolicy === 'hard' },
            { label: '软交期（宽限 ≤72h）', act: 'setFilter', v: 'duePolicy:soft', checked: f.duePolicy === 'soft' },
            { label: '政策待确认', act: 'setFilter', v: 'duePolicy:unknown', checked: f.duePolicy === 'unknown' },
            { sep: true },
            { head: '排产状态' },
            { label: '全部排产状态', act: 'setFilter', v: 'status:', checked: !f.status },
            { label: '已排产', act: 'setFilter', v: 'status:full', checked: f.status === 'full' },
            { label: '部分排产', act: 'setFilter', v: 'status:partial', checked: f.status === 'partial' },
            { label: '未排产', act: 'setFilter', v: 'status:none', checked: f.status === 'none' },
            { sep: true },
            { head: '风险' },
            { label: '全部风险', act: 'setFilter', v: 'risk:', checked: !f.risk },
            { label: '延期', act: 'setFilter', v: 'risk:late', checked: f.risk === 'late' },
            { label: '硬交期违约', act: 'setFilter', v: 'risk:hard', checked: f.risk === 'hard' },
            { label: '交期未知', act: 'setFilter', v: 'risk:unknown', checked: f.risk === 'unknown' },
            { sep: true },
            { label: '包含已结束历史订单', hint: '历史订单不进入待排范围，只影响列表显示', act: 'toggleHistory', checked: !!f.includeHistory },
            { label: '清空全部筛选', act: 'fReset', danger: false },
          ] }))}
        <span class="spacer"></span>
        <span class="tiny muted">${rows.length} / ${all.length} 条</span>
        <button class="btn sm" data-act="gotoWorkbench">${raw(icon('gauge', 13))}去工作台</button>
      </div>
    </div></div>

    <div class="orders-layout">
      <div class="card orders-list"><div class="card-h"><h3>订单清单</h3>
        <span class="sub">数量列同时保留米与 Kg 两种口径；交期以「预发货日」为准</span>
        <div class="right"><span class="tiny muted2">历史已结束订单不进入待排范围，可作为交付参考</span></div></div>
        <div class="card-b flush">
          ${raw(dataTable({ columns: cols, rows, rowKey: o => o.id,
            rowAttrs: o => 'clickable' + (ui.selection.orderId === o.id ? ' sel' : '') + (matOf.has(o.id) ? ' row-block' : '') }))}
        </div>
      </div>
      <aside class="card orders-risk"><div class="card-h"><h3>风险与异常</h3>
        <div class="right"><div class="seg">
          <button data-act="riskFilter" data-v="all" class="${riskFilter === 'all' ? 'on' : ''}">全部 ${risks.length}</button>
          <button data-act="riskFilter" data-v="block" class="${riskFilter === 'block' ? 'on' : ''}">阻断 ${riskCounts.block}</button>
          <button data-act="riskFilter" data-v="warn" class="${riskFilter === 'warn' ? 'on' : ''}">警告 ${riskCounts.warn}</button>
          <button data-act="riskFilter" data-v="info" class="${riskFilter === 'info' ? 'on' : ''}">提示 ${riskCounts.info}</button>
        </div></div></div>
        <div class="card-b flush">${raw(riskList(risks, { filter: riskFilter }))}</div>
      </aside>
    </div>`;

  const tbl = qs('table.tbl', host);
  if (tbl) tbl.addEventListener('click', e => {
    const tr = e.target.closest('tr[data-row]');
    if (!tr) return;
    openOrderDrawer(ctx, tr.dataset.row);
  });
}

function statusOf(o, tasks) {
  const t = tasks || [];
  const full = ['drawing', 'stranding', 'closing'].every(p => t.some(x => x.process === p));
  if (full) return 'full';
  return t.length ? 'partial' : 'none';
}
function riskMatches(r, kind) {
  if (kind === 'late') return r.tardH > 0;
  if (kind === 'hard') return r.statusTag === 'hard-violation';
  if (kind === 'unknown') return r.statusTag === 'unverifiable' || r.statusTag === 'unknown-policy';
  return true;
}

/* ---------------- 订单详情抽屉 ---------------- */
export function openOrderDrawer(ctx, orderId) {
  const { snapshot, version, cap } = ctx;
  const o = snapshot.orders.find(x => x.id === orderId);
  if (!o) return;
  const active = (version?.model.active || []).find(x => x.id === orderId);
  const tasks = (version?.tasks || []).filter(t => t.orderId === orderId);
  const ov = active || o;
  const risks = (version?.validation.risks || []).filter(r => r.orderId === orderId);
  const parsed = o.parsed || parseSpec(o.spec);
  const strandDia = estStrand(parsed.diameterMm, parsed.strandCount);

  const body = html`
    ${tasks.length ? html`<div class="mb">${raw(chainView(ov, tasks))}</div>` : ''}
    <h4 style="font-size:12.5px;color:var(--ink-3)" class="mb">原始字段</h4>
    <dl class="kv tight mb">
      <dt>项目编号</dt><dd class="mono">${o.id}</dd>
      <dt>内部订单单号</dt><dd class="mono tiny">${o.internalNo || '—'}</dd>
      <dt>品名</dt><dd>${o.productName || '—'}</dd>
      <dt>规格</dt><dd class="mono">${o.spec || '—'}</dd>
      <dt>涂层</dt><dd>${o.coating || '—'}</dd>
      <dt>业务数量</dt><dd>${o.qtyMeters != null ? fmtNum(o.qtyMeters, 0) + ' ' + (o.qtyMetersUnit || '米') : '—'}</dd>
      <dt>计价数量</dt><dd>${o.qtyKg != null ? fmtNum(o.qtyKg, 0) + ' ' + (o.qtyKgUnit || 'Kg') : '—'}</dd>
      <dt>订单日期</dt><dd>${fmtDate(o.orderDate)}</dd>
      <dt>预发货日</dt><dd>${o.preShipDate ? fmtDate(o.preShipDate) : '<span class="tag red sm">缺失</span>'}</dd>
      <dt>结束码</dt><dd>${o.endCode}${o.lastShipDate ? ' · 最后销货 ' + fmtDate(o.lastShipDate) : ''}</dd>
    </dl>
    <h4 style="font-size:12.5px;color:var(--ink-3)" class="mb">规格解析结果</h4>
    <dl class="kv tight mb">
      <dt>绳径</dt><dd>${parsed.diameterMm ?? '—'} mm${parsed.diameterRaw ? '（原文 ' + parsed.diameterRaw + '）' : ''}</dd>
      <dt>牌号 / 捻向</dt><dd>${parsed.grade || '—'} ${layLabel(parsed.lay)}</dd>
      <dt>结构</dt><dd class="mono">${parsed.structure || '—'}</dd>
      <dt>股数 / 股结构</dt><dd>${parsed.strandCount ?? '—'} × ${parsed.strandConstruction || '—'}</dd>
      <dt>绳芯</dt><dd>${parsed.core || '—'}</dd>
      <dt>推导股径</dt><dd>${strandDia != null ? strandDia + ' mm（几何贴合 πD/(N+π)，演示参数）' : '—'}</dd>
    </dl>
    <div class="banner gray mb">${raw(icon('info', 15))}<div>规格解析成功不代表工艺路线已匹配完成；下表的映射状态才是排产依据。</div></div>
    <h4 style="font-size:12.5px;color:var(--ink-3)" class="mb">工艺映射</h4>
    ${tasks.length === 3 ? html`<dl class="kv tight mb">
      <dt>合绳规格</dt><dd class="mono">${tasks.find(t => t.process === 'closing')?.specLabel || '—'}</dd>
      <dt>股型 / 股径</dt><dd class="mono">${tasks.find(t => t.process === 'stranding')?.jobRef?.name || '—'} / ${tasks.find(t => t.process === 'stranding')?.jobRef?.spec || '—'} mm</dd>
      <dt>拉丝原料</dt><dd class="mono">${tasks.find(t => t.process === 'drawing')?.specLabel || '—'}</dd>
    </dl>` : html`<div class="banner warn mb">${raw(icon('alert', 15))}<div>该订单工艺映射不完整，未进入排产范围。缺失项见下方风险。</div></div>`}
    <h4 style="font-size:12.5px;color:var(--ink-3)" class="mb">交期政策与优先级（可补录）</h4>
    <div class="grid g2 mb">
      <div class="field"><label>交期政策</label>
        <select data-act="setPolicy" aria-label="交期政策（可补录）" data-id="${o.id}">
          <option value="unknown"${!o.duePolicy || o.duePolicy === 'unknown' ? ' selected' : ''}>待确认（不默认宽限）</option>
          <option value="hard"${o.duePolicy === 'hard' ? ' selected' : ''}>硬交期（不允许延期）</option>
          <option value="soft"${o.duePolicy === 'soft' ? ' selected' : ''}>软交期（宽限 ≤72 小时）</option>
        </select></div>
      <div class="field"><label>优先级</label>
        <select data-act="setPriority" aria-label="优先级（可补录）" data-id="${o.id}">
          ${raw(['普通', '重点订单', '重点客户'].map(p => html`<option value="${p}"${(o.priority || '普通') === p ? ' selected' : ''}>${p}</option>`).join(''))}
        </select></div>
    </div>
    <div class="banner info mb">${raw(icon('info', 15))}<div>补录会写入待重算草稿，不直接改已确认版本；重算后生效。</div></div>
    <h4 style="font-size:12.5px;color:var(--ink-3)" class="mb">关联风险（${risks.length}）</h4>
    ${risks.length ? raw(risks.slice(0, 8).map(r => html`
      <div class="evidence" style="border-left-color:${r.level === 'block' ? 'var(--block)' : r.level === 'warn' ? 'var(--warn)' : 'var(--ink-4)'};margin-bottom:7px">
        <div class="t">${r.title} ${r.rule ? ruleTags([r.rule]) : ''}</div>
        <div class="tiny">${r.why}</div></div>`).join('')) : html`<div class="muted tiny">该订单当前没有风险项。</div>`}`;

  const incSet = new Set(ctx.settings.includedOrderIds || snapshot.orders.map(x => x.id));
  const isIn = incSet.has(o.id);
  openDrawer({ title: '订单 ' + o.id, sub: (o.productName || '') + ' · ' + (o.spec || ''), wide: true, body,
    footer: html`<button class="btn" data-act="close">关闭</button>
      <button class="btn ${isIn ? 'danger' : 'primary'}" data-act="toggleInclude" data-id="${o.id}">${isIn ? '排除本次排产' : '纳入本次排产'}</button>
      <span class="spacer"></span>
      ${tasks.length ? raw(tasks.map(t => html`<button class="btn" data-act="openTaskX" data-id="${t.id}">${PROC_MAP[t.process].name} · ${t.machineId}</button>`).join('')) : ''}`,
    onMount(box, close) {
      box.querySelectorAll('[data-act="openTaskX"]').forEach(b => b.addEventListener('click', () => { close(); ctx.openTask(b.dataset.id); }));
      box.querySelectorAll('[data-act="setPolicy"]').forEach(sel => sel.addEventListener('change', () => {
        ctx.settings.duePolicy[sel.dataset.id] = sel.value;
        const ord = snapshot.orders.find(x => x.id === sel.dataset.id);
        if (ord) ord.duePolicy = sel.value;
        ctx.store.toast('已补录交期政策，需重算后生效', 'ok');
      }));
      box.querySelectorAll('[data-act="setPriority"]').forEach(sel => sel.addEventListener('change', () => {
        ctx.settings.priority[sel.dataset.id] = sel.value;
        const ord = snapshot.orders.find(x => x.id === sel.dataset.id);
        if (ord) ord.priority = sel.value;
        ctx.store.toast('已调整优先级，需重算后生效', 'ok');
      }));
    } });
}

export const ORDER_ACTIONS = {
  fKeyword: (ctx, node) => { ctx.ui.filters.order.keyword = node.value; ctx.rerender(); },
  /* 原来的四个 <select> 与一个复选框被收进「筛选」面板，统一走一个动作：
     data-v 形如 "priority:重点客户" / "status:none" / "risk:late"，空值表示「全部」。 */
  setFilter: (ctx, node, ds) => {
    const [key, ...rest] = String(ds.v || '').split(':');
    const val = rest.join(':');
    if (!['priority', 'duePolicy', 'status', 'risk'].includes(key)) return;
    ctx.ui.filters.order[key] = val || undefined;
    ctx.rerender();
  },
  toggleHistory: (ctx) => {
    const o = ctx.ui.filters.order;
    o.includeHistory = !o.includeHistory;
    ctx.rerender();
  },
  fReset: (ctx) => { ctx.ui.filters.order = {}; ctx.rerender(); },
  riskFilter: (ctx, node, ds) => { ctx.ui.riskFilter = ds.v; ctx.rerender(); },
  risk: (ctx, node, ds) => {
    const r = ctx.version?.validation?.risks.find(x => x.id === ds.id);
    if (!r) return;
    if (r.taskId) { ctx.ui.selection = { ...ctx.ui.selection, taskId: r.taskId, orderId: r.orderId }; ctx.openTask(r.taskId); return; }
    if (r.orderId) { ctx.openOrder(r.orderId); return; }
    if (r.machineId) ctx.navigate('load');
  },
  toggleInclude: (ctx, node, ds) => {
    const all = ctx.snapshot.orders.map(o => o.id);
    const cur = new Set(ctx.settings.includedOrderIds || all);
    const inSet = cur.has(ds.id);
    if (inSet) cur.delete(ds.id); else cur.add(ds.id);
    ctx.settings.includedOrderIds = cur.size === all.length ? null : [...cur];
    ctx.store.toast(inSet
      ? '已排除 ' + ds.id + '：不进入本次排产，排除清单会出现在确认页与导出首页；需重算生效'
      : '已纳入 ' + ds.id + '：需重算生效', 'ok');
    ctx.rerender();
  },
  gotoWorkbench: (ctx) => ctx.navigate('workbench'),
};
