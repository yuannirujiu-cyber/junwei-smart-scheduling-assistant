/* 复用组件：指标卡、风险列表、标签、弹窗、抽屉、表格、工序链、Toast */
import { html, raw, icon, el, qs, qsa, delegate } from '../core/dom.js';
import { fmtNum, fmtDateTime, fmtDur, round, escapeHtml } from '../core/util.js';
import { RULE_MAP, PROC_MAP } from '../engine/rules.js';

export const DUE_POLICY = {
  hard: { label: '硬交期', cls: 'red', hint: '延期罚款，不允许延期（R8）' },
  soft: { label: '软交期', cls: 'amber', hint: '承诺交期仍为准时判断线，企业授权宽限 ≤72 小时（R8）' },
  unknown: { label: '交期政策待确认', cls: 'gray', hint: '未标注政策，不默认给予宽限（R8）' },
};

/* ---------------- 弹层栈：焦点陷阱 / 焦点恢复 / 顶层判定 ----------------
   所有弹层（抽屉、弹窗）入栈管理，只有**栈顶**参与 Tab 陷阱与 Escape：
   这样「抽屉里再开弹窗」时焦点不会跑回下层抽屉，多层弹层只陷阱最上层。
   关闭时把焦点还给打开它的那个元素（审查项：抽屉/弹窗关闭后焦点不回触发元素）。 */
const LAYERS = [];
const FOCUSABLE_SEL = 'a[href],area[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),'
  + 'textarea:not([disabled]),iframe,[contenteditable="true"],[tabindex]:not([tabindex="-1"])';

function focusableVisible(node) {
  if (!node || typeof node.getBoundingClientRect !== 'function') return false;
  if (node.hidden) return false;
  /* aria-hidden 子树里的元素不参与 Tab 陷阱（装饰性内容不该被聚焦） */
  if (typeof node.closest === 'function' && node.closest('[aria-hidden="true"]')) return false;
  const r = node.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}
/** 对话框内可聚焦元素（按 DOM 顺序，过滤不可见与 aria-hidden） */
export function focusables(root) {
  return qsa(FOCUSABLE_SEL, root).filter(focusableVisible);
}
function activeEl() { return (typeof document !== 'undefined' && document.activeElement) || null; }
function topLayer() { return LAYERS.length ? LAYERS[LAYERS.length - 1] : null; }

/** 入栈：记录触发元素并把焦点移到对话框内（首个可聚焦元素，否则容器本身） */
function pushLayer(layer) {
  const opener = activeEl();
  layer.opener = (opener && opener !== document.body && typeof opener.focus === 'function') ? opener : null;
  LAYERS.push(layer);
  const already = activeEl() && typeof layer.box.contains === 'function' && layer.box.contains(activeEl());
  if (already) return layer;                        // onMount 已经自己放了焦点，不抢
  const target = focusables(layer.box)[0] || layer.box;
  if (target && typeof target.focus === 'function') target.focus();
  return layer;
}
/**
 * 出栈：把焦点还给打开它的元素。
 *
 * 三种情况依次退化，保证「焦点永远不落在虚空里」：
 *   1) 触发元素仍在文档且可见 → 直接还给它；
 *   2) 触发元素是**下拉菜单里的项**（菜单已收起，项不可见）→ 退还给该菜单的触发按钮。
 *      这一条是必须的：菜单项打开弹窗后菜单会收起，把焦点还给一个 hidden 元素浏览器会忽略，
 *      结果 focus 掉到 body —— 实测就是这条断言变红。
 *   3) 触发元素已从文档移除 → 退回 body，明确兜底。
 */
function popLayer(layer) {
  const i = LAYERS.indexOf(layer);
  if (i >= 0) LAYERS.splice(i, 1);
  const back = layer.opener;
  if (!back) return;
  if (back.isConnected !== false && typeof back.focus === 'function' && isVisible(back)) { back.focus(); return; }
  if (back.isConnected !== false) {
    const menu = typeof back.closest === 'function' ? back.closest('.menu') : null;
    const btn = menu ? qs('.menu-btn', menu) : null;
    if (btn && typeof btn.focus === 'function' && isVisible(btn)) { btn.focus(); return; }
  }
  if (typeof document !== 'undefined' && document.body && typeof document.body.focus === 'function') document.body.focus();
}
/** 元素是否真的可见（hidden 面板里的菜单项、display:none 的祖先都算不可见） */
function isVisible(node) {
  if (!node || typeof node.getBoundingClientRect !== 'function') return false;
  if (node.hidden) return false;
  if (typeof node.closest === 'function' && node.closest('[hidden]')) return false;
  const r = node.getBoundingClientRect();
  return r.width > 0 || r.height > 0;
}
/** 弹层被强制移除（同位置重开）时同步出栈，避免栈里留下已不在文档中的层 */
function dropLayersUnder(node) {
  for (let i = LAYERS.length - 1; i >= 0; i--) {
    if (LAYERS[i].mask === node || LAYERS[i].box === node) LAYERS.splice(i, 1);
  }
}

/** 全局键处理（捕获阶段）：Escape 关最上层；Tab / Shift+Tab 在对话框内循环 */
function onLayerKeydown(e) {
  const top = topLayer();
  if (!top) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();  // 不让 main.js 的兜底把同一层再关一次
    top.close();
    return;
  }
  if (e.key !== 'Tab') return;
  const list = focusables(top.box);
  if (!list.length) { e.preventDefault(); if (top.box.focus) top.box.focus(); return; }
  const first = list[0], last = list[list.length - 1];
  const cur = activeEl();
  const inside = cur && typeof top.box.contains === 'function' && top.box.contains(cur);
  if (!inside) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
  if (e.shiftKey && cur === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && cur === last) { e.preventDefault(); first.focus(); }
}
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('keydown', onLayerKeydown, true);
}


/* ---------------- 下拉菜单：把同类功能聚合成一个按钮 ----------------
   设计约束：
     · 不是一个「弹层」——菜单不抢焦点、不做 Tab 陷阱，Tab 可以直接离开并关闭它；
     · Escape 关闭菜单并把焦点还给触发按钮；但如果同时开着抽屉 / 弹窗，
       由弹层栈先关掉最上层（本模块的 Escape 走冒泡阶段，会被弹层栈的捕获阶段拦住）；
     · 面板内容由各页面模板渲染，打开状态记在模块变量里，渲染后由 syncMenus() 复原，
       这样「点面板里的勾选项 → 页面重渲染 → 面板仍然开着、焦点仍在原处」，连续调整多个开关不用反复点开。
   ------------------------------------------------------------------ */
const MENU_SEL = '.menu';
let openMenuId = null;      // 当前展开的菜单 id
let openFocusKey = null;    // 展开时被点/被聚焦的那一项（用于重渲染后恢复焦点）

function menuEl(id) { return typeof document === 'undefined' ? null : qs('.menu[data-menu="' + id + '"]'); }
function menuPanel(root) { return root ? qs('.menu-panel', root) : null; }

function applyMenuState(root, open) {
  if (!root) return;
  const panel = menuPanel(root);
  const btn = qs('.menu-btn', root);
  if (btn) btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  if (panel) panel.hidden = !open;
  root.classList.toggle('open', open);
}
/** 关闭当前菜单（可选是否把焦点还给触发按钮） */
export function closeMenus(restoreFocus) {
  if (!openMenuId) return;
  const root = menuEl(openMenuId);
  applyMenuState(root, false);
  const btn = root ? qs('.menu-btn', root) : null;
  openMenuId = null; openFocusKey = null;
  if (restoreFocus && btn) btn.focus();
}
/** 展开指定菜单（同时关闭其它菜单） */
export function openMenu(id, focusKey) {
  if (openMenuId && openMenuId !== id) closeMenus(false);
  const root = menuEl(id);
  if (!root) return;
  openMenuId = id; openFocusKey = focusKey || null;
  applyMenuState(root, true);
}
/**
 * 渲染后复原菜单状态。页面重渲染会重建 DOM，这里按模块变量把面板重新展开，
 * 并把焦点放回用户刚才操作的那一项（用 data-act + data-v 作为稳定标识）。
 * 由 main.js 在每次 render() 之后调用。
 */
export function syncMenus() {
  if (!openMenuId) return;
  const root = menuEl(openMenuId);
  if (!root) { openMenuId = null; openFocusKey = null; return; }   // 该菜单已不在页面上
  applyMenuState(root, true);
  if (!openFocusKey) return;
  const items = qsa('.menu-item', menuPanel(root));
  const hit = items.find((it) => (it.dataset.act || '') + '|' + (it.dataset.v || '') === openFocusKey);
  if (hit && typeof hit.focus === 'function') hit.focus();
}

/**
 * 捕获阶段记录「用户刚按下的那一项」。
 * 为什么必须在捕获阶段：菜单项的动作由 #view 上的事件委托处理，它比 document 上的监听器更靠内、
 * 先执行；而那个动作往往会立刻重渲染整个视图，于是冒泡阶段再读 item 时 DOM 已经被换掉了。
 * 在捕获阶段先把标识记下来，重渲染后 syncMenus() 才能把焦点放回原处。
 */
function onMenuPressCapture(e) {
  const t = e.target;
  if (!t || typeof t.closest !== 'function') return;
  const item = t.closest('.menu-item');
  if (!item) return;
  const root = item.closest(MENU_SEL);
  if (root && root.dataset.keepOpen === '1') {
    openFocusKey = (item.dataset.act || '') + '|' + (item.dataset.v || '');
  }
}

function onMenuClick(e) {
  const t = e.target;
  if (!t || typeof t.closest !== 'function') return;
  const trigger = t.closest('.menu-btn');
  if (trigger) {
    const root = trigger.closest(MENU_SEL);
    const id = root && root.dataset.menu;
    e.preventDefault();
    if (openMenuId === id) closeMenus(false); else openMenu(id, null);
    return;
  }
  const item = t.closest('.menu-item');
  if (item) {
    /* 面板内的普通项：先让事件委托把动作跑完，再收起面板（多选项/多开关的面板除外）。
       用 setTimeout 0 是为了排在被委托的 data-act 处理之后。 */
    const root = item.closest(MENU_SEL);
    const keepOpen = root && root.dataset.keepOpen === '1';
    const key = (item.dataset.act || '') + '|' + (item.dataset.v || '');
    if (keepOpen) { openFocusKey = key; return; }
    setTimeout(() => closeMenus(false), 0);
    return;
  }
  if (openMenuId && !t.closest('.menu-panel')) closeMenus(true);
}

function onMenuKeydown(e) {
  if (!openMenuId) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    if (typeof e.stopPropagation === 'function') e.stopPropagation();
    closeMenus(true);
    return;
  }
  const root = menuEl(openMenuId);
  const items = root ? qsa('.menu-item:not([disabled])', menuPanel(root)) : [];
  if (!items.length) return;
  const cur = items.indexOf(activeEl());
  const go = (i) => { const n = items[(i + items.length) % items.length]; if (n && n.focus) n.focus(); };
  if (e.key === 'ArrowDown') { e.preventDefault(); go(cur < 0 ? 0 : cur + 1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); go(cur < 0 ? items.length - 1 : cur - 1); }
  else if (e.key === 'Home') { e.preventDefault(); go(0); }
  else if (e.key === 'End') { e.preventDefault(); go(items.length - 1); }
  else if (e.key === 'Tab') { closeMenus(false); }
}

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('click', onMenuPressCapture, true);
  document.addEventListener('click', onMenuClick);
  document.addEventListener('keydown', onMenuKeydown);
}

const CHECK_SVG = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

/**
 * 生成一个下拉菜单按钮。
 * @param {object} o { id, label, ico, align, badge, tone, title, keepOpen, wide, items }
 *   items 项：{ label, hint, act, v, data:{}, disabled, disabledHint, danger, checked, sep, head }
 *   keepOpen: true 时点选项不收起面板（用于连续切换多个开关 / 单选组）
 */
export function menuButton(o) {
  const id = o.id;
  const cls = ['menu', o.align === 'left' ? 'left' : 'right'].join(' ');
  const btnCls = ['menu-btn', o.tone === 'primary' ? 'primary' : '', o.tone === 'sm' ? 'sm' : ''].filter(Boolean).join(' ');
  const badge = o.badge == null || o.badge === '' || o.badge === 0 ? '' : html`<span class="menu-badge">${o.badge}</span>`;
  const caret = '<svg class="caret" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>';
  const items = (o.items || []).map((it) => {
    if (it.sep) return '<div class="menu-sep" role="separator"></div>';
    if (it.head) return '<div class="menu-head">' + escapeHtml(it.head) + '</div>';
    /* 静态信息项（如图例）：不是可执行动作，用 div 而不是 button，避免被当成菜单项聚焦 */
    if (it.static) {
      return '<div class="menu-item static">'
        + '<span class="mi-mark">' + (it.sw ? '<i class="mi-sw" style="' + escapeHtml(it.sw) + '"></i>' : '') + '</span>'
        + '<span class="mi-body"><span class="mi-label">' + escapeHtml(it.label) + '</span>'
        + (it.hint ? '<span class="mi-hint">' + escapeHtml(it.hint) + '</span>' : '') + '</span></div>';
    }
    const data = Object.entries(it.data || {}).map(([k, v]) => ' data-' + k + '="' + escapeHtml(String(v)) + '"').join('');
    const attrs = (it.act ? ' data-act="' + escapeHtml(it.act) + '"' : '')
      + (it.v != null ? ' data-v="' + escapeHtml(String(it.v)) + '"' : '')
      + data
      + (it.disabled ? ' disabled aria-disabled="true"' : '')
      + (it.disabled && it.disabledHint ? ' title="' + escapeHtml(it.disabledHint) + '"' : '');
    return '<button type="button" class="menu-item' + (it.danger ? ' danger' : '') + (it.checked ? ' on' : '') + '" role="menuitem"' + attrs + '>'
      + '<span class="mi-mark">' + (it.checked ? CHECK_SVG : '') + '</span>'
      + '<span class="mi-body"><span class="mi-label">' + escapeHtml(it.label) + '</span>'
      + (it.hint ? '<span class="mi-hint">' + escapeHtml(it.hint) + '</span>' : '')
      + '</span></button>';
  }).join('');
  return html`<div class="${cls}" data-menu="${id}"${raw(o.keepOpen ? ' data-keep-open="1"' : '')}">
    <button type="button" class="${btnCls}" aria-haspopup="menu" aria-expanded="false" aria-controls="menu-panel-${id}"${raw(o.title ? ' title="' + escapeHtml(o.title) + '"' : '')}>
      ${o.ico ? raw(icon(o.ico, 14)) : ''}<span>${o.label}</span>${raw(badge)}${raw(caret)}</button>
    <div class="menu-panel${o.wide ? ' wide' : ''}" id="menu-panel-${id}" role="${o.menuRole || 'menu'}" aria-label="${o.label}" hidden>${raw(items)}</div>
  </div>`;
}

export function tag(text, cls = 'gray', ico = null, title = '') {
  return html`<span class="tag ${cls}"${title ? raw(' title="' + escapeHtml(title) + '"') : ''}>${ico ? raw(icon(ico, 11)) : ''}${text}</span>`;
}
export function procTag(p) { const m = PROC_MAP[p]; return m ? tag(m.name, m.cls) : tag(p); }
export function dueTag(policy, graceHours) {
  const d = DUE_POLICY[policy] || DUE_POLICY.unknown;
  return tag(d.label + (policy === 'soft' && graceHours ? '（宽限 ' + graceHours + 'h）' : ''), d.cls, policy === 'hard' ? 'alert' : null, d.hint);
}
export function ruleTags(ids) {
  return raw((ids || []).map(id => html`<span class="rule-ref" title="${(RULE_MAP[id]?.title || '') + '：' + (RULE_MAP[id]?.text || '')}">${id}</span>`).join(' '));
}
export function lockTag(t) {
  if (t.frozen) return tag('执行冻结', 'violet', 'pause', '已开工/完工，不可自动移动');
  if (t.locked) return tag('已锁定', 'violet', 'lock', '重算时保持机台与起止时间不变');
  return '';
}
export function sevPill(level) {
  const m = { block: ['block', '阻断'], warn: ['warn', '警告'], info: ['info', '提示'] };
  const [c, t] = m[level] || m.info;
  return html`<span class="sev-pill ${c}">${t}</span>`;
}

/* ---------------- 指标卡 ---------------- */
export function metricCards(m, opts = {}) {
  const stale = opts.stale;
  const workbenchLayout = opts.layout === 'workbench';
  const leading = opts.leading || '';
  const pct = v => Math.max(0, Math.min(100, Number(v) || 0));
  const rate = pct(m.deliveryRate);
  const occupied = pct(m.machineOccRate);
  const running = Math.min(occupied, pct(m.machineRunRate));
  const setup = Math.max(0, occupied - running);
  const donut = (kind, segments, label) => ({
    kind, segments: segments.map(x => pct(x)), label,
  });
  const cards = [
    { key: 'rate', k: '预测准时交付率', v: m.deliveryRate, unit: '%',
      f: '纳入 ' + m.orderCount + ' 单 · 准时 ' + m.onTimeOrders + ' 单',
      cls: m.deliveryRate >= 90 ? 'good' : m.deliveryRate >= 75 ? 'warnv' : 'bad',
      donut: donut('delivery', [rate, 100 - rate], m.deliveryRate == null ? '—' : fmtNum(m.deliveryRate, 1) + '%'),
      title: 'U 中完整排产且预计合绳完工不晚于承诺交期的订单 ÷ U 总数（PRD 第 10 章）' },
    { key: 'late', k: '预计延期订单', v: m.lateOrders, unit: '单',
      f: m.lateHours ? '累计延期 ' + fmtDur(m.lateHours) : '无延期', cls: m.lateOrders ? 'warnv' : 'good',
      title: '有最终完工时间且超过承诺交期的订单数；未排订单单列「交期未知」' },
    { key: 'hard', k: '硬交期风险', v: m.hardRiskCount, unit: '单',
      f: '预计违约 ' + m.hardViolation + ' · 无法验证 ' + m.hardUnverifiable, cls: m.hardRiskCount ? 'bad' : 'good',
      title: '硬交期订单中预计违约及因未排产而无法验证的订单数' },
    { key: 'unsched', k: '未完整排产', v: m.unscheduledOrders, unit: '单',
      f: '数据不足阻断 ' + m.blockedOrders + ' · 求解未排 ' + Math.max(0, m.unscheduledOrders - m.blockedOrders), cls: m.unscheduledOrders ? 'bad' : 'good',
      title: '未排订单仍保留在交付率分母中（PRD 第 10 章）' },
    { key: 'occ', k: '设备计划占用率', v: m.machineOccRate, unit: '%',
      f: '加工 ' + m.machineRunRate + '% · 换型 ' + m.totalSetupHours + 'h', cls: '',
      donut: donut('utilization', [running, setup, 100 - occupied], m.machineOccRate == null ? '—' : fmtNum(m.machineOccRate, 1) + '%'),
      title: '窗口内加工与换型占用时长 ÷ 窗口内设备可用时长' },
  ];
  /* 工作台按「交付 / 产能」优先，再呈现三类异常；其他页面仍沿用五等分顺序。 */
  const displayCards = workbenchLayout ? [cards[0], cards[4], cards[1], cards[2]] : cards;
  const renderCard = (c, i) => {
    const tier = workbenchLayout ? (i < 2 ? ' core' : ' risk') : '';
    return html`
    <div class="metric${tier} ${c.cls}${c.donut ? ' chart chart-' + c.donut.kind : ''}${stale ? ' stale' : ''}${opts.active === c.key ? ' on' : ''}" data-act="metric" data-key="${c.key}" title="${c.title}">
      <div class="metric-main">
        <div class="k">${c.k}</div>
        <div class="v">${c.v == null ? '—' : fmtNum(c.v, Number.isInteger(c.v) ? 0 : 1)}<small>${c.unit || ''}</small></div>
        <div class="f">${c.f}</div>
      </div>
      ${c.donut ? html`<div class="metric-donut" aria-hidden="true" style="--a:${c.donut.segments[0]}%;--b:${c.donut.segments[1]}%;--c:${c.donut.segments[2] || 0}%"><span>${c.donut.label}</span></div>` : ''}
    </div>`;
  };
  if (workbenchLayout) {
    return html`<div class="metrics workbench-metrics">${raw(displayCards.map(renderCard).join(''))}</div>`;
  }
  return html`<div class="metrics">${raw(displayCards.map(renderCard).join(''))}</div>`;
}

/* ---------------- 风险列表 ---------------- */
export function riskList(risks, opts = {}) {
  const filter = opts.filter || 'all';
  const list = filter === 'all' ? risks : risks.filter(r => r.level === filter);
  if (!list.length) return html`<div class="empty sm">${raw(icon('check', 26))}<p>当前筛选下没有风险项</p></div>`;
  const ico = { block: 'alert', warn: 'info', info: 'dot' };
  return raw(list.map(r => html`
    <div class="risk-item ${r.level}" data-act="risk" data-id="${r.id}">
      <div class="sev">${raw(icon(ico[r.level], 12))}</div>
      <div class="bd">
        <div class="ttl">${sevPill(r.level)}<span>${r.title}</span>${(r.ruleRefs && r.ruleRefs.length) ? ruleTags(r.ruleRefs) : (r.rule ? ruleTags([r.rule]) : '')}</div>
        <div class="why">${r.why}</div>
        ${r.fix ? html`<div class="fix">→ ${r.fix}</div>` : ''}
      </div>
    </div>`).join(''));
}

/* ---------------- 工序链 ---------------- */
export function chainView(order, tasks) {
  const get = p => (tasks || []).find(t => t.process === p);
  const parts = [];
  ['drawing', 'stranding', 'closing'].forEach((p, i) => {
    const t = get(p); const m = PROC_MAP[p];
    parts.push(t
      ? html`<div class="node ${m.cls}" data-act="task" data-id="${t.id}">
          <div class="p">${m.name}${t.locked ? raw(' ' + icon('lock', 10)) : ''}</div>
          <div class="m">${t.machineId}</div>
          <div class="t">${fmtDateTime(t.start)}<br>${fmtDateTime(t.end)}</div>
        </div>`
      : html`<div class="node ${m.cls} unscheduled"><div class="p">${m.name}</div><div class="m muted">未安排</div><div class="t">工艺映射缺失</div></div>`);
    if (i < 2) {
      const a = get(p), b = get(['stranding', 'closing'][i]);
      if (a && b) {
        const w = (b.start - a.end) / 3600000;
        parts.push(html`<div class="arrow ${w > 72 ? 'bad' : ''}">${raw(icon('arrowRight', 14))}<small>等待 ${round(w, 1)}h</small></div>`);
      } else parts.push(html`<div class="arrow">${raw(icon('arrowRight', 14))}</div>`);
    }
  });
  return html`<div class="chain">${raw(parts.join(''))}</div>`;
}

/* ---------------- 弹窗 ---------------- */
export function openModal({ title, sub = '', body, footer = '', width = '', onMount = null, closeOnMask = true }) {
  const root = qs('#modal-root');
  qsa('.modal-mask', root).forEach(m => { dropLayersUnder(m); m.remove(); });
  const mask = el('div.modal-mask');
  const box = el('div.modal' + (width ? '.' + width : ''));
  /* 对话框语义：role=dialog + aria-modal + 可访问名称（aria-labelledby 指向标题元素） */
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'jw-modal-title');
  box.setAttribute('tabindex', '-1');
  box.innerHTML = html`
    <div class="modal-h">
      <div><h3 id="jw-modal-title">${title}</h3>${sub ? html`<div class="sub">${sub}</div>` : ''}</div>
      <button class="btn ghost sm close" data-act="close" aria-label="关闭对话框" title="关闭">${raw(icon('x', 14))}</button>
    </div>
    <div class="modal-b">${raw(body)}</div>
    ${footer ? html`<div class="modal-f">${raw(footer)}</div>` : ''}`;
  mask.appendChild(box); root.appendChild(mask);
  requestAnimationFrame(() => mask.classList.add('on'));
  const layer = { box, mask, closed: false, close: null };
  /* 幂等关闭：Escape、遮罩点击、关闭按钮可能同时来，只关一次、焦点只还一次 */
  const close = () => {
    if (layer.closed) return;
    layer.closed = true;
    popLayer(layer);
    mask.classList.remove('on'); setTimeout(() => mask.remove(), 180);
  };
  layer.close = close;
  delegate(box, { close });
  if (closeOnMask) mask.addEventListener('click', e => { if (e.target === mask) close(); });
  if (onMount) onMount(box, close);
  pushLayer(layer);
  return { el: box, close };
}

/* ---------------- 抽屉 ---------------- */
export function openDrawer({ title, sub = '', tabs = null, body, footer = '', wide = false, onMount = null }) {
  const root = qs('#drawer-root');
  // 清掉可能仍在退场动画中的旧遮罩：否则它会拦截新抽屉的点击（审查报告 P1-10）
  // 同时把旧遮罩对应的弹层条目出栈，避免栈顶残留一个已不在文档中的对话框。
  qsa('.drawer-mask', root).forEach(m => { dropLayersUnder(m); m.remove(); });
  qsa('.drawer', root).forEach(b => b.remove());
  const mask = el('div.drawer-mask');
  const box = el('div.drawer' + (wide ? '.wide' : ''));
  /* 对话框语义：抽屉同样是模态对话框（role=dialog + aria-modal + 标题作为可访问名称） */
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'jw-drawer-title');
  box.setAttribute('tabindex', '-1');
  box.innerHTML = html`
    <div class="drawer-h">
      <div><h3 id="jw-drawer-title">${title}</h3>${sub ? html`<div class="sub">${sub}</div>` : ''}</div>
      <button class="btn ghost sm close" data-act="close" aria-label="关闭抽屉" title="关闭">${raw(icon('x', 14))}</button>
    </div>
    ${tabs ? html`<div class="drawer-tabs" role="tablist" aria-label="详情页签">${raw(tabs.map((t, i) => html`<button id="jw-tab-${t.key}" role="tab" data-act="tab" data-tab="${t.key}" aria-selected="${i === 0 ? 'true' : 'false'}" aria-controls="jw-tabpanel" tabindex="${i === 0 ? '0' : '-1'}" class="${i === 0 ? 'on' : ''}">${t.label}</button>`).join(''))}</div>` : ''}
    ${tabs ? html`<div class="drawer-b" id="jw-tabpanel" role="tabpanel" aria-labelledby="jw-tab-${tabs[0].key}" tabindex="0">${raw(body)}</div>`
      : html`<div class="drawer-b">${raw(body)}</div>`}
    ${footer ? html`<div class="drawer-f">${raw(footer)}</div>` : ''}`;
  mask.appendChild(box); root.appendChild(mask);
  requestAnimationFrame(() => { mask.classList.add('on'); box.classList.add('on'); });
  const layer = { box, mask, closed: false, close: null };
  const close = () => {
    if (layer.closed) return;
    layer.closed = true;
    popLayer(layer);
    mask.classList.remove('on'); box.classList.remove('on');
    setTimeout(() => { mask.remove(); box.remove(); }, 240);
  };
  layer.close = close;
  delegate(box, { close });
  /* 页签键盘语义：左右方向键在页签间移动（循环），Home / End 到首尾；移动即激活。
     激活复用视图已注册的 click 处理（taskDrawer 的 switchTab），不新增动作名。 */
  const tablist = qs('[role="tablist"]', box);
  if (tablist) tablist.addEventListener('keydown', e => {
    const list = qsa('[role="tab"]', tablist);
    if (!list.length) return;
    const cur = Math.max(0, list.findIndex(b => b === document.activeElement || (typeof b.contains === 'function' && b.contains(document.activeElement))));
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = list[(cur + 1) % list.length];
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = list[(cur - 1 + list.length) % list.length];
    else if (e.key === 'Home') next = list[0];
    else if (e.key === 'End') next = list[list.length - 1];
    else return;
    e.preventDefault();
    next.focus();
    next.click();
  });
  /* 只有点在遮罩本身（抽屉外部）才关闭。
     原先直接绑 close，导致抽屉内任意点击（页签、按钮、正文空白）都会把抽屉关掉，
     「依据」「变更记录」「人工调整」全部不可用 —— 审查报告 P0-1。 */
  mask.addEventListener('click', e => { if (e.target === mask) close(); });
  if (onMount) onMount(box, close);
  pushLayer(layer);
  return { el: box, close };
}

/* ---------------- Toast ---------------- */
export function toastHost() {
  const root = qs('#toast-root');
  return (msg, kind = '') => {
    const ico = kind === 'ok' ? 'check' : kind === 'err' ? 'alert' : kind === 'warn' ? 'info' : 'dot';
    const node = el('div.toast' + (kind ? '.' + kind : ''));
    /* 普通 Toast 走 polite 播报（role=status），错误 Toast 走 assertive（role=alert），
       逐个标注而不是只靠容器：错误需要立即打断，不能排在礼貌队列后面。 */
    node.setAttribute('role', kind === 'err' ? 'alert' : 'status');
    node.setAttribute('aria-live', kind === 'err' ? 'assertive' : 'polite');
    node.setAttribute('aria-atomic', 'true');
    node.innerHTML = raw(icon(ico, 15)) + escapeHtml(msg);
    root.appendChild(node);
    setTimeout(() => {
      node.style.opacity = '0'; node.style.transition = 'opacity .3s';
      setTimeout(() => node.remove(), 320);
    }, kind === 'err' ? 5200 : 3400);
  };
}

/* ---------------- 空态 ---------------- */
export function emptyState({ icon: ic = 'layers', title, desc, actions = [] }) {
  return html`<div class="empty">
    <div class="mark">${raw(icon(ic, 26))}</div>
    <h3>${title}</h3>
    <p>${desc}</p>
    ${actions.length ? html`<div class="btn-row">${raw(actions.map(a => html`<button class="btn ${a.cls || ''}" data-act="${a.act}">${a.icon ? raw(icon(a.icon, 14)) : ''}${a.label}</button>`).join(''))}</div>` : ''}
  </div>`;
}

/* ---------------- 表格 ---------------- */
export function dataTable({ columns, rows, rowKey = (r, i) => i, rowAttrs = null, empty = '没有符合当前筛选的记录', maxHeight = null }) {
  if (!rows.length) return html`<div class="empty sm">${raw(icon('search', 24))}<p>${empty}</p></div>`;
  return html`<div class="tbl-wrap"${maxHeight ? raw(' style="max-height:' + maxHeight + '"') : ''}>
    <table class="tbl"><thead><tr>
      ${raw(columns.map(c => html`<th class="${c.num ? 'num' : ''}${c.cls ? ' ' + c.cls : ''}"${c.width ? raw(' style="width:' + c.width + '"') : ''}>${c.label}</th>`).join(''))}
    </tr></thead><tbody>
      ${raw(rows.map((r, i) => html`<tr class="${rowAttrs ? rowAttrs(r, i) : ''}" data-row="${rowKey(r, i)}">${raw(columns.map(c => html`<td class="${c.num ? 'num' : ''}${c.cls ? ' ' + c.cls : ''}">${raw(c.render(r, i))}</td>`).join(''))}</tr>`).join(''))}
    </tbody></table></div>`;
}

/* ---------------- 依据块 ---------------- */
export function evidenceBlock(list) {
  return raw(list.map(e => html`<div class="evidence" style="margin-bottom:8px">
    <div class="t">${e.k}${e.rule ? raw(' ' + ruleTags([e.rule])) : ''}</div>
    <div>${e.v}</div>
    ${e.src ? html`<div class="tiny muted2" style="margin-top:3px">来源：${e.src}</div>` : ''}
  </div>`).join(''));
}

/* ---------------- 版本状态 ---------------- */
export function versionTag(v, currentDatasetKey) {
  if (!v) return '';
  if (v.basedOnOldData || (currentDatasetKey && v.datasetKey && v.datasetKey !== currentDatasetKey)) {
    return tag('基于旧数据', 'gray', 'info', '该版本基于已替换的数据快照，其历史输入未被覆写；如需按新数据排产请重新生成');
  }
  if (v.status === 'confirmed') return tag(v.simulated ? '已确认（模拟参数）' : '已确认', v.simulated ? 'amber' : 'green', 'check');
  if (v.status === 'superseded') return tag('已替代', 'gray');
  if (v.status === 'stale' || v.dirty) return tag('待重算', 'amber', 'refresh');
  return v.validation?.canConfirm ? tag('可确认', 'blue') : tag('草稿（存在阻断）', 'red', 'alert');
}

/* ---------------- 折叠区 / 条形 ---------------- */
export function section(title, bodyHtml, opts = {}) {
  return html`<div class="card">
    <div class="card-h"><h3>${title}</h3>${opts.sub ? html`<span class="sub">${opts.sub}</span>` : ''}
      ${opts.right ? html`<div class="right">${raw(opts.right)}</div>` : ''}</div>
    <div class="card-b${opts.flush ? ' flush' : ''}">${raw(bodyHtml)}</div></div>`;
}
export function hbar(label, value, max, color = 'var(--brand)', fmt = v => fmtNum(v, 0)) {
  const w = max ? Math.min(100, Math.max(0, value / max * 100)) : 0;
  return html`<div class="hbar"><div class="lb">${label}</div><div class="tr"><i style="width:${w}%;background:${color}"></i></div><div class="vl">${fmt(value)}</div></div>`;
}

/* ---------------- 「计算中」状态播报（aria-live=polite） ----------------
   排产遮罩 .calc 由 main.js 在 #view 内动态插入/移除，组件层拿不到它的生命周期，
   这里用 MutationObserver 把「阶段文案 + 已用时」镜像到全局 live region（#live-root）。
   纯附加行为：观察器不可用时直接返回 null，不影响任何既有功能。 */
export function installSolveAnnouncer() {
  if (typeof document === 'undefined' || typeof MutationObserver !== 'function') return null;
  const live = qs('#live-root');
  const view = qs('#view');
  if (!live || !view) return null;
  let timer = null, lastStage = '', lastAt = 0, msgs = 0;
  const say = (stage, full, force) => {
    if (!stage) return;
    const now = Date.now();
    const changed = stage !== lastStage;
    /* 节流：已用时每 200ms 刷新一次，不能每次都播报；阶段变化尽快播，稳定阶段 5 秒播一次用时 */
    if (!force && now - lastAt < (changed ? 700 : 5000)) return;
    lastStage = stage; lastAt = now; msgs++;
    live.textContent = full;
  };
  const snap = () => {
    const calc = qs('.calc', view);
    if (!calc) return null;
    const msg = (qs('.calc-msg', calc) || {}).textContent || '正在计算';
    const el2 = qs('.calc-elapsed', calc);
    return { stage: msg, full: msg + (el2 && el2.textContent ? ' · ' + el2.textContent : '') };
  };
  const stopTimer = () => { if (timer) { clearInterval(timer); timer = null; } };
  const sync = () => {
    const s = snap();
    if (s) {
      say(s.stage, s.full, false);
      if (!timer) timer = setInterval(() => { const t = snap(); if (t) say(t.stage, t.full, true); else stopTimer(); }, 5000);
      return;
    }
    stopTimer();
    if (lastStage) { lastStage = ''; lastAt = Date.now(); live.textContent = '计算结束'; msgs++; }
  };
  const mo = new MutationObserver(sync);
  mo.observe(view, { childList: true, subtree: true, characterData: true });
  sync();
  live.__jwAnnounceCount = () => msgs;
  return mo;
}
if (typeof document !== 'undefined') installSolveAnnouncer();

/* ---------------- 跳到主内容 ----------------
   index.html 顶部有 .skip-link；点击后把焦点真正移到主区域（#view 带 tabindex="-1"），
   这样键盘用户的下一站就是页面内容，而不是从头再 Tab 一遍侧栏。 */
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('click', e => {
    const a = e.target && typeof e.target.closest === 'function' ? e.target.closest('.skip-link') : null;
    if (!a) return;
    const target = qs(a.getAttribute('href') || '#view');
    if (!target) return;
    e.preventDefault();
    if (typeof target.focus === 'function') target.focus();
    if (typeof target.scrollIntoView === 'function') target.scrollIntoView({ block: 'start' });
  });
}
