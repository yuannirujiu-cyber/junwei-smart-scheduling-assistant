/* 甘特图：设备视角 / 订单视角，双尺度时间轴，换型/停机/等待/交期标线叠加 */
import { html, raw, icon, el, qs, qsa, clear, delegate } from '../core/dom.js';
import { HOUR, DAY, round, fmtNum, fmtDateTime, fmtDate, isWeekend, startOfDay, addDays, todayOf } from '../core/util.js';
import { PROC_MAP, PROCESSES } from '../engine/rules.js';
import { tag, lockTag, menuButton } from './ui.js';

export const ZOOMS = {
  /* 全部视图统一放大 1.5 倍，短工序条也能展示更多订单号。 */
  hour: { key: 'hour', label: '小时', pxPerHour: 51 },
  day: { key: 'day', label: '日', pxPerHour: 11.25 },
  week: { key: 'week', label: '周', pxPerHour: 3.3 },
};
const ROW_H = 32, GAP = 0;
const LABEL_W = 300;

const WD = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/* ---------------- 键盘可访问性：树形网格（treegrid） ----------------
   任务条 role=gridcell，用「漫游 tabindex」：整张网格只有一条任务条在 Tab 序列里，
   Tab 进入后用方向键移动——上下换行、左右换同行的任务、Home/End 到行首尾、Enter/Space 打开工序抽屉。
   折叠控件（分组 / 空闲设备 / 订单）是 role=button，也可 Tab 到并用 Enter/Space 触发。 */
const CELL_SEL = '.g-task[data-id]';
const CTL_SEL = '[data-act="collapse"],[data-act="expand"]';
let ganttFocusId = null;   // 上次聚焦的任务 id：重渲染后回到原处，而不是跳回第一行
let ganttCursorCol = 0;    // 上下换行时保留的列位（行长不同则就近落点）

function cellRows(grid) {
  return qsa('[role="row"]', grid).map(rw => qsa(CELL_SEL, rw)).filter(list => list.length);
}
function setRoving(grid, active) {
  for (const c of qsa(CELL_SEL, grid)) c.tabIndex = (c === active) ? 0 : -1;
}
function applyRoving(grid) {
  const cells = qsa(CELL_SEL, grid);
  if (!cells.length) return;
  const target = (ganttFocusId && cells.find(c => c.dataset.id === ganttFocusId)) || cells[0];
  ganttFocusId = target.dataset.id;
  setRoving(grid, target);
}
function bindGanttKeyboard(grid) {
  grid.addEventListener('focusin', e => {
    const cell = e.target && typeof e.target.closest === 'function' ? e.target.closest(CELL_SEL) : null;
    if (!cell || !grid.contains(cell)) return;
    ganttFocusId = cell.dataset.id;
    const rw = cellRows(grid).find(list => list.indexOf(cell) >= 0);
    if (rw) ganttCursorCol = rw.indexOf(cell);
    setRoving(grid, cell);
  });
  grid.addEventListener('keydown', e => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    const ctl = t.closest(CTL_SEL);
    if (ctl && grid.contains(ctl)) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') { e.preventDefault(); ctl.click(); }
      return;
    }
    const cell = t.closest(CELL_SEL);
    if (!cell || !grid.contains(cell)) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      cell.click();                        // 复用既有 data-act="task" 委托，不新增动作名
      return;
    }
    const rows = cellRows(grid);
    const ri = rows.findIndex(list => list.indexOf(cell) >= 0);
    if (ri < 0) return;
    const cur = rows[ri], ci = cur.indexOf(cell);
    const col = Math.max(0, Math.min(ganttCursorCol, cur.length - 1));
    let target = null;
    if (e.key === 'ArrowRight') target = cur[Math.min(ci + 1, cur.length - 1)];
    else if (e.key === 'ArrowLeft') target = cur[Math.max(ci - 1, 0)];
    else if (e.key === 'Home') target = cur[0];
    else if (e.key === 'End') target = cur[cur.length - 1];
    else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const nr = rows[ri + (e.key === 'ArrowDown' ? 1 : -1)];
      if (nr && nr.length) target = nr[Math.min(col, nr.length - 1)];
    } else return;
    e.preventDefault();
    if (!target) return;
    ganttFocusId = target.dataset.id;
    const tr = cellRows(grid).find(list => list.indexOf(target) >= 0);
    ganttCursorCol = tr ? tr.indexOf(target) : 0;
    setRoving(grid, target);
    target.focus();
  });
}

export function computeRange(version, settings, opts = {}) {
  const tasks = (version?.tasks || []).filter(t => t.scheduled);
  let min = new Date(settings.planStart).getTime();
  let max = min + 14 * DAY;
  for (const t of tasks) { min = Math.min(min, t.start); max = Math.max(max, t.end); }
  const dt = new Date(settings.planStart).getTime();
  if (opts.maxDays) max = Math.min(max, min + opts.maxDays * DAY);
  /* 起点与最早计划日对齐，避免首个任务前额外留出整整一天的空白时间轴。 */
  min = startOfDay(new Date(min)).getTime();
  max = startOfDay(new Date(max + 2 * DAY)).getTime();
  return { from: min, to: max };
}

/** 生成行模型 */
export function buildRows({ version, cap, ui, filter, riskIds }) {
  const tasks = (version?.tasks || []).filter(t => t.scheduled);
  const byMachine = new Map(), byOrder = new Map();
  for (const t of tasks) {
    if (!byMachine.has(t.machineUid)) byMachine.set(t.machineUid, []);
    byMachine.get(t.machineUid).push(t);
    if (!byOrder.has(t.orderId)) byOrder.set(t.orderId, []);
    byOrder.get(t.orderId).push(t);
  }
  const kw = (filter?.keyword || '').trim().toLowerCase();
  const proc = filter?.process || 'all';
  const onlyRisk = !!filter?.onlyRisk && riskIds instanceof Set;
  /* 设备编号优先：当输入内容正好是设备号时，只保留该设备，不能再混入同号订单。
     没有同号设备时，才按完整订单号检索。 */
  const isMachineQuery = !!kw && tasks.some(t => String(t.machineId).toLowerCase() === kw);
  const matchKw = t => (!kw || (isMachineQuery
    ? String(t.machineId).toLowerCase() === kw
    : String(t.orderId).toLowerCase() === kw))
    && (!onlyRisk || riskIds.has(t.id));

  if (ui.gantt.view === 'machine') {
    const rows = [];
    for (const p of PROCESSES) {
      /* 顶部工序按钮已经承担分组切换，不再在左侧重复堆叠三条纵向分组。 */
      if (proc !== 'all' && p.key !== proc) continue;
      const machines = cap.machines[p.key] || [];
      const withTasks = machines.filter(m => (byMachine.get(m.uid) || []).some(t => (proc === 'all' || t.process === proc) && matchKw(t)));
      /* 输入关键字时，搜索结果就是一个独立清单：不保留没有命中的工序分组，
         也不显示与搜索无关的空闲设备。 */
      if (kw && withTasks.length === 0) continue;
      const idle = machines.length - withTasks.length;
      for (const m of withTasks) {
        const list = (byMachine.get(m.uid) || []).filter(t => (proc === 'all' || t.process === proc) && matchKw(t));
        const occ = list.reduce((s, t) => s + (t.end - t.start) / HOUR + (t.setupHours || 0), 0);
        rows.push({ kind: 'machine', key: m.uid, machine: m, process: p.key, tasks: list, occ,
          label: m.id, sub: m.name || '' });
      }
      if (!kw && idle > 0) {
        const idleMachines = machines.filter(m => !withTasks.includes(m));
        const idleOpen = !!ui.gantt.expanded['idle:' + p.key];
        rows.push({ kind: 'idle', key: 'idle:' + p.key, process: p.key, count: idle, collapsed: !idleOpen, machines: idleMachines });
        if (idleOpen) for (const m of idleMachines) rows.push({ kind: 'machine', key: m.uid, machine: m, process: p.key, tasks: [], occ: 0, label: m.id, sub: m.name || '' });
      }
    }
    return rows;
  }

  /* 订单视角：父行 + （展开时）三工序子行 */
  const orders = (version?.model?.active || []).filter(o => {
    const list = byOrder.get(o.id) || [];
    return list.some(t => (proc === 'all' || t.process === proc) && matchKw(t));
  });
  const limit = ui.gantt.orderLimit || 40;
  const shown = orders.slice(0, limit);
  const rows = [];
  for (const o of shown) {
    const list = (byOrder.get(o.id) || []).filter(t => (proc === 'all' || t.process === proc) && matchKw(t));
    const expanded = !!ui.gantt.expanded[o.id];
    rows.push({ kind: 'order', key: 'o:' + o.id, order: o, tasks: list, expanded,
      start: Math.min(...list.map(t => t.start)), end: Math.max(...list.map(t => t.end)) });
    if (expanded) for (const p of ['drawing', 'stranding', 'closing']) {
      const t = list.find(x => x.process === p);
      rows.push({ kind: 'op', key: 'op:' + o.id + ':' + p, order: o, process: p, task: t, parentKey: 'o:' + o.id });
    }
  }
  return rows;
}

export function renderGantt(host, ctx) {
  const { version, cap, ui, settings, filter, validation } = ctx;
  const range = computeRange(version, settings, { maxDays: 60 });
  const zoom = ZOOMS[ui.gantt.zoom] || ZOOMS.day;
  /* 先算风险集合，再构建行：这样「只看有风险的任务」筛选才有依据
     （原先 filter.onlyRisk 只写进了状态，甘特图从未使用 —— 是个死控件）。 */
  const riskOf = new Map();
  for (const r of (validation?.risks || [])) {
    if (!r.taskId) continue;
    const cur = riskOf.get(r.taskId);
    if (r.level === 'block') riskOf.set(r.taskId, 'block');
    else if (r.level === 'warn' && cur !== 'block') riskOf.set(r.taskId, 'warn');
  }
  const rows = buildRows({ version, cap, ui, filter, riskIds: new Set(riskOf.keys()) });
  const totalMs = range.to - range.from;
  const width = Math.max(600, Math.round(totalMs / HOUR * zoom.pxPerHour));
  /* 订单视角的分页信息：用于「显示更多订单」按钮（原先 moreOrders 动作没有任何触发元素，是死代码）。 */
  const kw0 = String(filter?.keyword || '').trim().toLowerCase();
  const isMachineQuery0 = !!kw0 && (version?.tasks || []).some(t => t.scheduled && String(t.machineId).toLowerCase() === kw0);
  const orderIdsWithTasks = new Set((version?.tasks || []).filter(t => t.scheduled && (!kw0
    || (isMachineQuery0 ? String(t.machineId).toLowerCase() === kw0 : String(t.orderId).toLowerCase() === kw0))).map(t => t.orderId));
  const orderTotal = orderIdsWithTasks.size;
  const orderShown = rows.filter(r => r.kind === 'order').length;
  /* 生效中的筛选数：显示在「筛选」按钮的徽标上，避免筛选被藏进面板后「看不见自己开着筛选」。 */
  const activeFilterCount = (filter?.process && filter.process !== 'all' ? 1 : 0)
    + (filter?.onlyRisk ? 1 : 0) + (kw0 ? 1 : 0);
  /* 时间轴若被上限截断，必须显式告知，不能静默不画（PRD 4.2 / 审查报告 P2-1）。 */
  const allSched = (version?.tasks || []).filter(t => t.scheduled);
  const maxEnd = allSched.length ? allSched.reduce((a, t) => Math.max(a, t.end), 0) : 0;
  const truncated = maxEnd > range.to;
  const hiddenTasks = truncated ? allSched.filter(t => t.end > range.to).length : 0;
  const x = ms => Math.round((ms - range.from) / HOUR * zoom.pxPerHour);
  const w = (a, b) => Math.max(2, Math.round((b - a) / HOUR * zoom.pxPerHour));
  const isInitialSetup = t => t.setupTier === '首次上机' || (t.setupReasons || []).some(r => String(r).includes('首次上机'));
  const setupText = t => {
    if (isInitialSetup(t)) return '';
    return w(t.setupStart, t.start) > 26 ? '换型 ' + t.setupHours + 'h' : '换';
  };
  const processTabs = ui.gantt.view === 'machine'
    ? html`<div class="gantt-process-tabs" role="group" aria-label="选择工序">
        <button type="button" data-act="selectGanttProcess" data-v="all" class="${filter.process === 'all' ? 'on' : ''}">全部</button>
        ${raw(PROCESSES.map(p => html`<button type="button" data-act="selectGanttProcess" data-v="${p.key}" class="${filter.process === p.key ? 'on' : ''}">${p.name}</button>`).join(''))}
      </div>`
    : '';

  /* ---- 时间轴 ---- */
  /* 今日高亮用「排产参考今天」（可在顶栏修改），默认就是系统日期 —— 行为与以前一致 */
  const today = todayOf(settings);
  const todayKey = fmtDate(today);
  const axisTop = [], axisSub = [];
  const d0 = startOfDay(new Date(range.from));
  for (let d = new Date(d0); d.getTime() < range.to; d = addDays(d, 1)) {
    const left = x(d.getTime()), wid = x(addDays(d, 1).getTime()) - left;
    const cls = (isWeekend(d) ? ' weekend' : '') + (fmtDate(d) === todayKey ? ' today' : '');
    axisTop.push(html`<div class="tl-cell${cls}" style="left:${left}px;width:${wid}px">${d.getMonth() + 1}/${d.getDate()} ${WD[d.getDay()]}</div>`);
    if (zoom.key !== 'week') {
      const hw = wid / 2;
      axisSub.push(html`<div class="tl-shift" style="left:${left}px;width:${hw}px">白班</div>`);
      axisSub.push(html`<div class="tl-shift" style="left:${left + hw}px;width:${hw}px">晚班</div>`);
    }
  }

  /* ---- 停机区间（设备行叠加） ---- */
  const downs = (settings.downtime || []).filter(d => ui.gantt.showDowntime !== false);
  const downsByMachine = new Map();
  for (const d of downs) {
    const mid = String(d.machineId);
    if (!downsByMachine.has(mid)) downsByMachine.set(mid, []);
    downsByMachine.get(mid).push(d);
  }
  function downsForMachine(mid) {
    return (downsByMachine.get(String(mid)) || []).map(d => {
      const s = new Date(d.from).getTime(), e = new Date(d.to).getTime();
      if (e < range.from || s > range.to) return '';
      return html`<div class="g-down" style="left:${x(s)}px;width:${w(s, e)}px" title="设备停机：${d.reason || ''} ${fmtDateTime(d.from)} → ${fmtDateTime(d.to)}">${w(s, e) > 40 ? '停机' : ''}</div>`;
    }).join('');
  }
  /* ---- 行 ---- */
  let rowSeq = 0;                       // 树形网格的 aria-rowindex（表头不在网格内，从 1 开始）
  const bodyRows = rows.map(r => {
    if (r.kind === 'group') {
      return row(r, html`<span style="cursor:pointer;display:flex;align-items:center;gap:6px" data-act="collapse" data-key="${r.key}"
          role="button" tabindex="0" aria-expanded="${r.collapsed ? 'false' : 'true'}"
          aria-label="${r.collapsed ? '展开' : '折叠'}${r.label}分组（${r.active}/${r.count} 台有任务）">
          ${raw(icon(r.collapsed ? 'chevRight' : 'chevDown', 13))}
          <span class="tag ${PROC_MAP[r.process].cls}">${r.label}</span>
          <span class="muted tiny">${r.active}/${r.count} 台有任务</span></span>`, '');
    }
    if (r.kind === 'idle') {
      return row(r, html`<span style="cursor:pointer;display:flex;align-items:center;gap:6px" data-act="collapse" data-key="${r.key}"
          role="button" tabindex="0" aria-expanded="${r.collapsed ? 'false' : 'true'}"
          aria-label="${r.collapsed ? '展开' : '折叠'}空闲设备 ${r.count} 台">
          ${raw(icon(r.collapsed ? 'chevDown' : 'chevRight', 13))}<span class="muted tiny">空闲设备 ${r.count} 台</span></span>`, '');
    }
    if (r.kind === 'machine') {
      const bars = r.tasks.map(t => bar(t, t.end - t.start)).join('') ;
      const setups = ui.gantt.showChangeover ? r.tasks.filter(t => t.setupHours > 0 && !isInitialSetup(t)).map(t =>
        html`<div class="g-change" style="left:${x(t.setupStart)}px;width:${w(t.setupStart, t.start)}px" title="换型 ${t.setupHours}h：${raw(t.setupReasons.join('；'))}">${setupText(t)}</div>`).join('') : '';
      const label = html`<span class="mono" style="font-weight:600">${r.label}</span>
        <span class="muted tiny ellip" style="flex:1">${r.sub || ''}</span>
        <span class="tiny muted2 nowrap">${round(r.occ, 0)}h</span>`;
      return row(r, label, downsForMachine(r.machine.id) + setups + bars);
    }
    if (r.kind === 'order') {
      const o = r.order;
      const strip = html`<div class="g-task" style="left:${x(r.start)}px;width:${w(r.start, r.end)}px;background:transparent;border:1px dashed var(--line-strong);color:var(--ink-3);top:6px;height:14px"></div>`;
      const bars = r.tasks.map(t => bar(t, t.end - t.start)).join('');
      const dueLine = dueMarker(o, x, range);
      const label = html`<span style="cursor:pointer;display:flex;align-items:center;gap:5px;min-width:0" data-act="expand" data-key="${o.id}"
          role="button" tabindex="0" aria-expanded="${r.expanded ? 'true' : 'false'}"
          aria-label="${r.expanded ? '折叠' : '展开'}订单 ${o.id} 的工序行">
          ${raw(icon(r.expanded ? 'chevDown' : 'chevRight', 12))}
          <b class="mono ellip">${o.id}</b></span>
        <span class="muted tiny ellip" style="max-width:88px">${o.spec || ''}</span>
        <span class="tag ${o.duePolicy === 'hard' ? 'red' : o.duePolicy === 'soft' ? 'amber' : 'gray'} sm">${(o.duePolicy === 'hard' ? '硬' : o.duePolicy === 'soft' ? '软' : '待确认')}</span>`;
      return row(r, label, strip + bars + dueLine);
    }
    /* op 子行 */
    const t = r.task;
    const label = html`<span style="padding-left:20px;display:flex;align-items:center;gap:6px">
        <span class="tag ${PROC_MAP[r.process].cls} sm">${PROC_MAP[r.process].name}</span>
        ${t ? html`<span class="mono tiny">${t.machineId}</span>` : html`<span class="tiny muted">未安排</span>`}</span>`;
    const content = t
      ? (ui.gantt.showChangeover && t.setupHours > 0 && !isInitialSetup(t) ? html`<div class="g-change" style="left:${x(t.setupStart)}px;width:${w(t.setupStart, t.start)}px">${setupText(t)}</div>` : '') + bar(t, t.end - t.start)
      : html`<div class="g-task unscheduled" style="left:${x(new Date(settings.planStart).getTime())}px;width:150px">未安排</div>`;
    const waitLine = waitMarker(r, x, w);
    return row(r, label, content + waitLine + (t ? dueMarker(r.order, x, range) : ''));
  }).join('');


  host.innerHTML = html`
  <div class="gantt-wrap">
    <div class="gantt-bar">
      <div class="seg">
        <button data-act="view" data-v="machine" class="${ui.gantt.view === 'machine' ? 'on' : ''}">设备视角</button>
        <button data-act="view" data-v="order" class="${ui.gantt.view === 'order' ? 'on' : ''}">订单视角</button>
      </div>
      ${processTabs}
      ${raw(menuButton({ id: 'gantt-filter', label: '筛选', ico: 'filter', align: 'left', keepOpen: true,
        badge: activeFilterCount || '',
        title: '按工序、风险与关键字筛选任务条',
        items: [
          { head: '工序' },
          { label: '全部工序', act: 'setProcess', v: 'all', checked: filter.process === 'all' },
          ...PROCESSES.map(p => ({ label: p.name, act: 'setProcess', v: p.key, checked: filter.process === p.key })),
          { sep: true },
          { head: '风险' },
          { label: '只看有风险的任务', hint: '阻断 / 警告 / 提示三级任一命中', act: 'toggleOnlyRisk', checked: !!filter.onlyRisk },
          { label: '清除全部筛选', act: 'clearFilter', disabled: !activeFilterCount, disabledHint: '当前没有生效中的筛选' },
        ] }))}
      <input type="text" data-act="filterKw" aria-label="按完整订单号或设备编号筛选任务条" placeholder="完整订单号 / 设备编号" value="${filter.keyword || ''}" style="width:168px" />
      ${ui.gantt.view === 'order' && orderShown < orderTotal ? html`<button class="btn sm" data-act="moreOrders">显示更多订单（已显示 ${orderShown} / ${orderTotal}）</button>` : ''}
      <span class="spacer"></span>
      ${truncated ? html`<span class="tag amber" title="时间轴上限 60 天；窗口之外的任务仍然存在于计划与导出中，未丢失">时间轴已截断·窗口外 ${hiddenTasks} 条任务</span>` : ''}
      <span class="tiny muted2">${rows.length} 行 · 时间轴 ${fmtDate(range.from)} ~ ${fmtDate(range.to)}</span>
    </div>
    <div class="gantt-scroll" data-scroll>
      <div class="gantt-inner" style="width:${LABEL_W + width}px">
        <div class="gantt-head">
          <div class="g-row" style="height:26px">
            <div class="g-label" style="width:${LABEL_W}px;min-height:26px;background:#fff;font-size:12px;color:var(--ink-3);font-weight:600">
              资源 / 订单</div>
            <div class="g-track" style="width:${width}px"><div class="tl-row" style="height:26px">${raw(axisTop.join(''))}</div></div>
          </div>
          ${zoom.key !== 'week' ? html`<div class="g-row" style="height:20px"><div class="g-label" style="width:${LABEL_W}px;min-height:20px;background:#fff"></div><div class="g-track" style="width:${width}px"><div class="tl-row lower" style="height:20px">${raw(axisSub.join(''))}</div></div></div>` : ''}
        </div>
        <div class="gantt-body" role="treegrid" aria-colcount="1" aria-rowcount="${rows.length}"
          aria-label="排产甘特图（${ui.gantt.view === 'machine' ? '设备视角' : '订单视角'}）：上下方向键换行、左右换任务、Home/End 到行首尾、回车打开工序详情">
          <div class="g-lines" style="width:${width}px;left:${LABEL_W}px">
            ${raw(gridLines(range, zoom, x))}
            ${raw(nowLine(x, range))}
          </div>
          ${raw(bodyRows)}
        </div>
      </div>
    </div>
    <div class="g-legend-note tiny muted2">可通过「筛选」按工序、风险或订单／设备编号聚焦任务。</div>
  </div>`;

  /* 交互 */
  const grid = qs('.gantt-body', host);
  if (grid && typeof grid.addEventListener === 'function' && qsa(CELL_SEL, grid).length) {
    bindGanttKeyboard(grid);
    applyRoving(grid);
  }
  const scroller = qs('[data-scroll]', host);
  /* 首屏从时间轴最左侧开始；「定位今日」仍按参考日期定位。 */
  const todayMs = () => todayOf(settings).getTime();
  const goToday = () => { scroller.scrollLeft = Math.max(0, x(todayMs()) - 200); };
  requestAnimationFrame(() => { scroller.scrollLeft = 0; });
  /* 注意顺序：api 必须**先组装完**再挂到 window 上。
     曾经用 { ...ctx.api, todayMs } 在赋值之前展开，拿到的是上一轮的旧对象，
     结果 api.x 不是函数 —— 工作台一渲染就抛错。 */
  ctx.api = { x, scroller, range, zoom, goToday, todayMs,
    locate: (ms) => { scroller.scrollLeft = Math.max(0, x(ms) - 260); } };
  if (typeof window !== 'undefined') window.__ganttApi = ctx.api;

  function row(r, labelHtml, contentHtml) {
    const h = r.kind === 'group' ? 34 : ROW_H;
    const cls = 'g-row' + (r.kind === 'group' ? ' grp' : '') + (r.kind === 'op' ? ' sub' : '') +
      (ctx.selectedOrderId === (r.order?.id) ? ' sel' : '');
    /* 树形网格行语义：分组 / 空闲设备 / 订单行可折叠 → aria-expanded；工序子行是第 2 层 */
    const foldable = r.kind === 'group' || r.kind === 'idle' || r.kind === 'order';
    const open = r.kind === 'order' ? !!r.expanded : !r.collapsed;
    return html`<div class="${cls}" style="height:${h}px" data-row="${r.key}" role="row"
        aria-level="${r.kind === 'op' ? 2 : 1}" aria-rowindex="${++rowSeq}"${foldable ? raw(' aria-expanded="' + (open ? 'true' : 'false') + '"') : ''}>
      <div class="g-label" role="rowheader" style="width:${LABEL_W}px">${raw(labelHtml)}</div>
      <div class="g-track" style="width:${width}px">${raw(contentHtml)}</div>
    </div>`;
  }
  function bar(t, durMs) {
    const risk = riskOf.get(t.id);
    const sel = ctx.selectedTaskId === t.id;
    const bw = w(t.start, t.end);
    const mins = Math.round(durMs / 60000);
    /* 订单视角的每一行已由左侧订单号标识，任务条改显示实际执行机台，便于追踪工序流转。 */
    const visualLabel = ui.gantt.view === 'order' ? t.machineId : t.orderId;
    const title = t.orderId + ' · ' + PROC_MAP[t.process].name + ' · ' + t.machineId +
      '\n' + fmtDateTime(t.start) + ' → ' + fmtDateTime(t.end) + '（' + mins + ' 分钟）' +
      '\n数量 ' + fmtNum(t.qty, 0) + ' ' + t.unit + ' @ ' + t.rate + ' 米/分' +
      (t.setupHours ? '\n换型 ' + t.setupHours + 'h：' + (t.setupReasons || []).join('；') : '') +
      (t.locked ? '\n已锁定（重算保持不变）' : '') + (t.frozen ? '\n执行冻结（已开工）' : '') +
      (risk ? '\n风险：' + (risk === 'block' ? '阻断' : '警告') : '');
    /* 可访问名称：订单号 · 工序 · 设备 · 起止 · 时长 · 风险 · 锁定状态（视觉上的条形不承载文本时也能读出来） */
    const label = t.orderId + ' · ' + PROC_MAP[t.process].name + ' · ' + t.machineId +
      ' · ' + fmtDateTime(t.start) + ' → ' + fmtDateTime(t.end) +
      ' · 时长 ' + mins + ' 分钟' +
      ' · ' + (risk ? (risk === 'block' ? '风险 阻断' : '风险 警告') : '无风险') +
      ' · ' + (t.frozen ? '执行冻结' : t.locked ? '已锁定' : '未锁定');
    return html`<div class="g-task ${t.process}${risk ? ' risk-' + risk : ''}${t.locked ? ' locked' : ''}${sel ? ' sel' : ''}"
      style="left:${x(t.start)}px;width:${bw}px" title="${title}" role="gridcell" tabindex="-1" aria-label="${label}"
      data-act="task" data-id="${t.id}">
      ${t.locked && bw > 44 ? raw('<span class="lk">' + icon('lock', 9) + '</span>') : ''}${bw > 60 ? visualLabel : (bw > 30 ? String(visualLabel).slice(-4) : '')}</div>`;
  }
  function dueMarker(o, xf, rng) {
    if (!o?.due) return '';
    const ms = o.due.getTime();
    if (ms < rng.from || ms > rng.to) return '';
    const grace = o.duePolicy === 'soft' && o.allowLatest ? xf(o.allowLatest.getTime()) - xf(ms) : 0;
    return html`${grace > 0 ? html`<div class="g-vline" style="left:${xf(ms)}px;width:${grace}px;background:linear-gradient(90deg,rgba(234,88,12,.22),rgba(234,88,12,.06));opacity:1"></div>` : ''}<div class="g-vline due" style="left:${xf(ms)}px" title="承诺交期 ${fmtDate(o.due)}"></div>`;
  }
  function waitMarker(r, xf, wf) {
    const o = r.order; if (!o) return '';
    const list = (ctx.version?.tasks || []).filter(t => t.orderId === o.id && t.scheduled);
    const a = list.find(t => t.process === 'drawing'), b = list.find(t => t.process === 'stranding'), c = list.find(t => t.process === 'closing');
    let out = '';
    if (a && b && b.start > a.end) out += html`<div class="g-wait${((b.start - a.end) / HOUR) > 72 ? ' bad' : ''}" style="left:${xf(a.end)}px;width:${wf(a.end, b.start)}px" title="拉丝→捻股 等待 ${round((b.start - a.end) / HOUR, 1)} 小时（R6 上限 72 小时）"></div>`;
    if (b && c && c.start > b.end) out += html`<div class="g-wait${((c.start - b.end) / HOUR) > 72 ? ' bad' : ''}" style="left:${xf(b.end)}px;width:${wf(b.end, c.start)}px" title="捻股→合绳 等待 ${round((c.start - b.end) / HOUR, 1)} 小时（R6 上限 72 小时）"></div>`;
    return out;
  }
  function gridLines(rng, z, xf) {
    if (z.key === 'week') return '';
    let out = '';
    const d0 = startOfDay(new Date(rng.from));
    for (let d = new Date(d0); d.getTime() < rng.to; d = addDays(d, 1)) {
      out += html`<div class="g-vline major" style="left:${xf(d.getTime())}px"></div>`;
      if (z.key === 'hour') out += html`<div class="g-vline" style="left:${xf(d.getTime() + 12 * HOUR)}px"></div>`;
    }
    return out;
  }
  function nowLine(xf, rng) {
    /* now 线同样落在「排产参考今天」上；参考点在窗口之外时不画线（不假装有落点） */
    const n = todayOf(settings).getTime();
    if (n < rng.from || n > rng.to) return '';
    return html`<div class="g-vline now" style="left:${xf(n)}px" title="当前时间（排产参考日期）"></div>`;
  }
}

/** 定位到某任务：滚动 + 展开所在分组/订单 */
export function locateTask(ui, task) {
  if (!task) return;
  ui.gantt.collapsed['grp:' + task.process] = false;
  ui.gantt.expanded[task.orderId] = true;
}
