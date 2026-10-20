/* 应用入口：外壳、导航、路由、全局动作 */
import { html, raw, icon, el, qs, clear, delegate, enhanceInteractive } from './core/dom.js';
import { store, OPERATOR } from './core/store.js';
import { installErrorBoundary, buildDiagnosticsReport, serializeDiagnostics, log } from './core/diagnostics.js';
import * as persist from './core/persist.js';
import { bus } from './core/bus.js';
import { fmtDateTime, fmtDate, toDate, todayOf, isTodaySimulated, downloadBlob, toCSV, nowISO } from './core/util.js';
import { PROCESSES, RULES } from './engine/rules.js';
import { openModal, toastHost, emptyState, syncMenus } from './components/ui.js';
import { renderWorkbench, WORKBENCH_ACTIONS } from './views/workbench.js';
import { renderMaterials, MATERIAL_ACTIONS } from './views/materials.js';
import { renderOrders, ORDER_ACTIONS } from './views/orders.js';
import { renderSettings, SETTINGS_ACTIONS } from './views/settings.js';
import { renderSimulate, SIM_ACTIONS } from './views/simulate.js';
import { renderLoad, LOAD_ACTIONS } from './views/load.js';
import { openTaskDrawer, TASK_ACTIONS } from './views/taskDrawer.js';
import { loadDefaultRatedData } from './data/defaultRated.js';
import { confirmDeviceReplacement } from './views/deviceImport.js';

const toast = toastHost();
const NAV = [
  { group: '排产' },
  { key: 'workbench', label: '排产工作台', ico: 'gauge', view: renderWorkbench, actions: WORKBENCH_ACTIONS },
  { key: 'orders', label: '订单中心', ico: 'list', view: renderOrders, actions: ORDER_ACTIONS },
  { key: 'materials', label: '材料库', ico: 'box', view: renderMaterials, actions: MATERIAL_ACTIONS },
  { group: '计划管理' },
  { key: 'simulate', label: '异常重排', ico: 'bolt', view: renderSimulate, actions: SIM_ACTIONS },
  { key: 'load', label: '负荷分析', ico: 'chart', view: renderLoad, actions: LOAD_ACTIONS, p2: true },
  { key: 'settings', label: '排产设置', ico: 'settings', view: renderSettings, actions: SETTINGS_ACTIONS },
];

let CTX = null;
let viewUnbind = null;

function navigate(route, patch = {}) {
  store.setUI({ route, ...patch });
  render();
}

function buildCtx() {
  const s = store.state;
  const version = store.currentVersion;
  const ctx = {
    store, state: s, snapshot: s.snapshot, cap: store.cap, settings: s.settings,
    version, metrics: version?.metrics ?? null, validation: version?.validation ?? null,
    ui: s.ui, gate: store.gate(), todayControl: todayControl(s.settings), navigate, rerender: render, toast,
    openTask: (taskId) => openTaskDrawer(ctx, taskId),
    openOrder: (orderId) => navigate('orders', { selection: { ...s.ui.selection, orderId } }),
    exportLoadReport: (sc) => exportLoadReport(sc),
    afterImport,
  };
  return ctx;
}

/* ---------------- 当前日期（排产参考「今天」） ----------------
 * 数据是历史窗口（计划起点 2026-08）时，系统真实日期落在窗口之外，
 * 甘特图的今日高亮、now 线与「定位今日」就都没有落点。这里给一个人工指定的参考日期。
 * 它是**参考线**：只影响时间轴显示与定位，不参与排产约束、不改变任何任务。
 */
function todayControl(s) {
  const t = todayOf(s);
  const sim = isTodaySimulated(s);
  const inWindow = (() => {
    const v = s && s.planStart ? toDate(s.planStart) : null;
    if (!v) return true;
    const from = v.getTime();
    const to = from + (Number(s.horizonDays) || 45) * 24 * 3600000;
    return t.getTime() >= from && t.getTime() <= to;
  })();
  const tip = '排产参考「今天」：影响甘特图的今日高亮、now 线与「定位今日」，不参与排产约束、不改变任务。'
    + (inWindow ? '' : ' 当前值不在计划窗口内，时间轴上不会画出参考线。');
  return html`<label class="today-ctl${sim ? ' sim' : ''}${inWindow ? '' : ' out'}" title="${tip}">
    <span class="tc-label">今天</span>
    <input type="date" data-act="setCurrentDate" value="${fmtDate(t)}" aria-label="排产参考今天（当前日期）" />
    ${sim ? raw('<span class="tc-tag">模拟</span>') : ''}
    ${sim ? raw('<button type="button" class="tc-reset" data-act="resetCurrentDate" title="恢复为系统日期" aria-label="恢复为系统日期">×</button>') : ''}
    ${inWindow ? '' : raw('<span class="tc-tag warn" title="当前参考日期不在计划窗口内">窗口外</span>')}
  </label>`;
}

/* ---------------- 外壳 ---------------- */
function renderShell() {
  const gate = store.gate();
  /* 侧栏与顶栏在 #view 之外，单独补齐键盘可达性。 */
  setTimeout(() => { enhanceInteractive(qs('#sidebar')); enhanceInteractive(qs('#topbar')); }, 0);
  const s = store.state;
  const version = store.currentVersion;
  const workbenchActive = s.ui.route === 'workbench';
  const riskBadge = version ? (version.validation.counts.block || null) : null;
  const orderBadge = s.snapshot ? s.snapshot.orders.filter(o => o.endCode !== '已结束').length : null;

  qs('#sidebar').innerHTML = html`
    <div class="brand">
      <div class="mark">JW</div>
      <div class="txt"><b>君威智能排产助手</b><span>钢绳索具 · 多工序排产工作台</span></div>
    </div>
    <nav class="nav">
      ${raw(NAV.map(n => n.group ? html`<div class="nav-group">${n.group}</div>` : html`
        <div class="nav-item ${s.ui.route === n.key ? 'on' : ''}" data-act="nav" data-route="${n.key}">
          ${raw(icon(n.ico, 16))}<span>${n.label}</span>
          ${n.p2 ? raw('<span class="badge p2">P2</span>') : ''}
          ${n.key === 'workbench' && riskBadge ? html`<span class="badge risk">${riskBadge}</span>` : ''}
          ${n.key === 'orders' && orderBadge ? html`<span class="badge">${orderBadge}</span>` : ''}
        </div>`).join(''))}
    </nav>
    </div>`;

  /* 注意 todayControl 收到的是 settings 而不是 state：currentDate / planStart / horizonDays 都挂在 settings 上。
     （写错成 state 时不会报错，只会静默读不到 currentDate —— 控件永远显示系统日期。） */
  qs('#topbar').innerHTML = html`
    <div class="tb-row">
      <div class="tb-title">
        <h1>多工序订单自动排产</h1>
      </div>
      <div class="tb-actions">
        ${workbenchActive ? '' : raw(todayControl(s.settings))}
        ${workbenchActive ? '' : html`<button class="btn primary" data-act="generate"${gate.ok ? '' : ' disabled'} title="${gate.ok ? '按当前排产设置生成候选计划' : '缺少必需条件：' + gate.reasons.join('；')}">${raw(icon('play', 14))}${version ? '重新生成计划' : '生成候选计划'}</button>`}
        <button class="btn primary" data-act="export"${version ? '' : ' disabled'} title="${version ? '选择需要导出的文件类型' : '先生成候选计划后再导出'}">${raw(icon('download', 14))}导出</button>
        <button class="btn danger" data-act="startBlank" title="清空当前订单与计划；当前产品定额会保留">${raw(icon('ban', 14))}清空订单信息</button>
        <button class="btn" data-act="replaceRated" title="导入新的产品定额文件，替换当前设备与产能数据">${raw(icon('upload', 14))}更换产品定额</button>
      </div>
    </div>
    ${s.persistence && s.persistence.status === 'quota' ? html`<div class="banner warn" style="margin:10px 20px 0">${raw(icon('alert', 15))}
      <div><b>本地存储配额不足，已暂停持久化。</b>当前会话仍可正常使用，但刷新后可能丢失未保存的版本。可在「诊断」面板清理本地数据。</div></div>` : ''}
  </div>`;
}

/* ---------------- 输入焦点保持 ----------------
 * 视图层是「整块 innerHTML 重渲染」。任何在 input 事件里调用 rerender 的输入框，
 * 重渲染后都会丢焦点、光标回到开头，于是**连续输入会被反转**：
 * 实测在库存框里逐位输入 1 2 3 得到「321」，关键字框输入 2 6 0 得到「062」。
 * 这里在渲染前记录焦点元素与光标位置，渲染后按稳定标识找回并复原光标。
 * 只处理 #view 内部的可编辑控件：弹窗与抽屉挂在 body 上，有自己的焦点管理，不能抢。
 */
function captureFocus() {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  const view = qs('#view');
  if (!a || !view || !view.contains(a)) return null;
  const tag = a.tagName;
  if (tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT') return null;
  /* input[type=number] 的 selectionStart 是 null（不是数字），不能用它做「是否可编辑」的判据 ——
     否则数字输入框会被整个排除掉，仍然丢焦点、仍然反转（实测输入 1 2 3 4 得到 4321800）。 */
  let start = null, end = null;
  try { if (typeof a.selectionStart === 'number') { start = a.selectionStart; end = a.selectionEnd; } } catch (e) { /* 忽略 */ }
  return {
    act: (a.dataset && a.dataset.act) || null,
    dataId: (a.dataset && a.dataset.id) || null,
    field: (a.dataset && a.dataset.f) || null,
    id: a.id || null,
    start, end,
  };
}
function restoreFocus(snap) {
  if (!snap) return;
  const view = qs('#view');
  if (!view) return;
  let el = null;
  if (snap.id) el = qs('#' + CSS.escape(snap.id), view);
  if (!el && snap.act && snap.dataId) el = qs('[data-act="' + snap.act + '"][data-id="' + snap.dataId + '"]', view);
  if (!el && snap.field && snap.dataId) el = qs('[data-f="' + snap.field + '"][data-id="' + snap.dataId + '"]', view);
  if (!el && snap.field) el = qs('[data-f="' + snap.field + '"]', view);
  if (!el && snap.act) el = qs('[data-act="' + snap.act + '"]', view);
  if (!el || typeof el.focus !== 'function') return;
  if (el === document.activeElement) return;
  el.focus();
  if (typeof el.setSelectionRange === 'function' && snap.start != null) {
    try { el.setSelectionRange(snap.start, snap.end == null ? snap.start : snap.end); } catch (e) { /* 忽略 */ }
    return;
  }
  /* input[type=number] 不支持 setSelectionRange，而且 focus() 之后光标会停在**开头**：
     用户输完停顿一下（触发防抖重渲染）再继续输入，就会插到最前面
     （实测输入 1234、停顿、再输 56 → 得到 561234）。
     这里用「清空再写回」把光标推到末尾——number 输入框上这是唯一可靠的落点办法。 */
  if (String(el.type || '') === 'number' && el.value !== '') {
    const v = el.value;
    el.value = '';
    el.value = v;
  }
}

function render() {
  const focusSnap = captureFocus();
  renderShell();
  const s = store.state;
  const host = qs('#view');
  if (!s.snapshot) {
    host.className = 'view';
    host.innerHTML = emptyState({ icon: 'db', title: '尚未载入数据', desc: '请稍候，正在准备排产工作台。' });
    restoreFocus(focusSnap);
    return;
  }
  /* 路由键写错时会静默退回工作台。
     这里显式纠正并留下日志，避免同类问题再次无声发生。 */
  let nav = NAV.find(n => n.key === s.ui.route);
  if (!nav) {
    log.warn('route.unknown', String(s.ui.route));
    nav = NAV.find(n => n.key === 'workbench') || NAV[1];
    store.setUI({ route: nav.key });
  }
  CTX = buildCtx();
  CTX.flush = nav.key === 'workbench' || nav.key === 'load';
  host.className = 'view' + (CTX.flush ? ' flush' : '');
  host.innerHTML = '';
  try { nav.view(host, CTX); }
  catch (e) {
    console.error(e);
    host.innerHTML = html`<div class="banner block">${raw(icon('alert', 16))}<div><b>页面渲染失败</b><div>${String(e.message)}</div></div></div>`;
  }
  if (viewUnbind) viewUnbind();
  /* 重渲染会重建顶栏与视图 DOM：把之前展开的下拉菜单按 id 复原，
     这样在「筛选 / 视图」面板里连续勾选多个开关时不必反复点开。 */
  syncMenus();
  const acts = Object.assign({}, nav.actions || {}, TASK_ACTIONS);
  /* 全部动作都对 input/change 开放：表单控件（input/select/textarea）不参与 click 委托，
     只走 input/change，避免「点击瞬间读到变更前的值并把控件重渲染掉」。
     原先只注册 /^f[A-Z]/ 命名的动作，导致 filterKw / filterProcess / toggleChange 从未生效（P0-2）。 */
  CTX.__formActs = acts;
  const wrapped = {};
  for (const k of Object.keys(acts)) wrapped[k] = (e, node, ds) => acts[k](CTX, node, ds, e);
  viewUnbind = delegate(host, wrapped);
  /* 视图内的可点击 div（指标卡、风险项、工序链节点…）统一补成可键盘操作。 */
  enhanceInteractive(host);
  /* 最后一步：把输入焦点与光标位置还回去，保证连续输入不被重渲染打断。 */
  restoreFocus(focusSnap);
}

/* ---------------- 全局动作 ---------------- */
const GLOBAL_ACTIONS = {
  nav: (ctx, node) => navigate(node.dataset.route),
  async generate() {
    const v = store.currentVersion;
    await store.generate({ reason: v ? '重算计划' : '首排候选计划', keepLocksFrom: v?.id });
    navigate('workbench');
  },
  simulate() { navigate('simulate'); },
  startBlank() { confirmThenBlank(); },
  replaceRated() { confirmDeviceReplacement(CTX); },
  resetCurrentDate() { store.setCurrentDate(null); render(); },
  /* 顶栏「更多 → 数据来源」用的切换动作（同一逻辑原先只存在于 D01 视图层） */
  async switchData(node) {
    const v = node.dataset.v === 'demo' ? 'demo' : 'real';
    await loadBuiltin(v);
    await settleIntake();
  },
  cancelSolve() { store.requestCancel(); },
  diagnostics() { openDiagnosticsModal(); },
  clearConflict() { store.clearConflict(); },
  reloadPage() { location.reload(); },
  async discardRestore() {
    await store.discardPersistence();
    store.resetToBlank();
    await applyDefaultRatedData();
    render();
    toast('已放弃恢复，回到空白工作台：默认产品额定数据已就绪，请上传订单文件');
  },
  confirm() { openConfirmModal(); },
  export() { openExportModal(); },
};

function openConfirmModal() {
  const v = store.currentVersion;
  if (!v) return;
  const m = v.metrics, c = v.validation.counts;
  const lateN = v.metrics.lateOrders;
  const rows = [
    ['纳入订单数', m.orderCount + ' 单', ''],
    ['明确排除订单数', m.excludedOrders + ' 单', m.excludedOrders ? '在导出首页列出' : ''],
    ['未排订单（交期未知）', m.unscheduledOrders + ' 单', m.unscheduledOrders ? '保留在交付率分母中' : ''],
    ['数据不足被阻断订单', m.blockedOrders + ' 单', m.blockedOrders ? '需补录工艺映射' : ''],
    ['硬约束冲突', c.block + ' 项', c.block ? '必须逐项处理' : '无'],
    ['软交期风险', c.warn + ' 项', ''],
    ['人工锁定任务', v.tasks.filter(t => t.locked).length + ' 个', ''],
    ['执行冻结任务', v.tasks.filter(t => t.frozen).length + ' 个', ''],
    ['未重算的修改', v.dirty ? '有' : '无', v.dirty ? '必须先重算' : ''],
    ['参数缺口', v.simulated ? '使用演示参数' : '无', v.simulated ? '版本标记为「已确认（模拟参数）」，导出文件持续标注' : ''],
  ];
  const head = c.block
    ? html`<b>存在 ${c.block} 项阻断问题，无法确认版本。</b>请逐项处理后重算。`
    : (lateN ? html`<b>可以确认，但存在 ${lateN} 张订单预计延期。</b>需勾选「已知晓」后确认。` : html`<b>未发现硬约束冲突，可以确认。</b>`);
  const body = html`
    <div class="banner ${c.block ? 'block' : (lateN ? 'warn' : 'ok')}" style="margin-bottom:12px">
      ${raw(icon(c.block ? 'alert' : 'info', 16))}<div>${head}</div>
    </div>
    <table class="tbl"><tbody>
      ${raw(rows.map(r => html`<tr><td style="width:190px;color:var(--ink-3)">${r[0]}</td><td style="width:110px;font-weight:600">${r[1]}</td><td class="tiny muted">${r[2]}</td></tr>`).join(''))}
    </tbody></table>
    ${c.block ? html`<div class="mt">${raw(riskList(v.validation.risks.filter(r => r.level === 'block').slice(0, 6)))}</div>` : ''}
    <label class="chk mt"><input type="checkbox" id="ackLate" ${lateN ? '' : 'disabled'} /> 已知晓 ${lateN} 张订单预计延期，确认后仍按此版本执行</label>
    <div class="field mt"><label>确认备注（可选）</label><input type="text" id="confirmNote" placeholder="例如：已与生产确认，优先保住硬交期客户" /></div>`;
  const footer = html`<button class="btn" data-act="close">取消</button>
    <button class="btn dark" data-act="doConfirm" ${c.block ? 'disabled' : ''}>确认版本</button>`;
  openModal({ title: '确认前检查 · 版本 ' + v.id, width: 'wide',
    sub: '确认表示本产品内的人工认可；由于未接 ERP/MES，不显示「已下发生产」',
    body, footer,
    onMount(box, close) {
      box.querySelector('[data-act="doConfirm"]').addEventListener('click', () => {
        const ack = box.querySelector('#ackLate')?.checked;
        const note = box.querySelector('#confirmNote')?.value || '';
        const r = store.confirmVersion({ acknowledgeLate: ack, note });
        if (r) { close(); navigate('workbench'); }
      });
    } });
}

let exportScope = 'all';
function openExportModal() {
  const v = store.currentVersion;
  if (!v) return;
  const kinds = [
    ['plan', '排产清单 .xlsx', '订单 → 工序 → 机台 → 时间，含换型与风险', 'primary'],
    ['wo', '工单 .xlsx', '按机台/工序分组的执行清单', ''],
    ['gantt', '甘特图 .png', '当前视角与时间范围，含完整图例', ''],
    ['risk', '风险清单 .xlsx', '级别 / 命中规则 / 原因 / 建议', ''],
    ['csv', '当前筛选 CSV', '轻量兜底格式，便于二次处理', ''],
    ['load', '负荷分析报告', '含 SVG 图表的 HTML 报告 + CSV（计划推算）', ''],
    ['audit', '审计日志 .csv', '追加式操作轨迹：数据载入 / 排产 / 调整 / 锁定 / 确认 / 模拟', ''],
  ];
  const body = html`
    <div class="field mb"><label>导出范围</label>
      <div class="seg" style="width:fit-content">
        <button data-scope="all" class="on">全部范围</button>
        <button data-scope="filtered">当前筛选</button>
      </div>
      <div class="hint">默认「全部范围」；诊断草稿同样允许导出，但会带上状态标识。</div>
    </div>
    <div class="grid g3">
      ${raw(kinds.map(k => html`<div class="card"><div class="card-b">
        <b>${k[1]}</b>
        <div class="tiny muted mt">${k[2]}</div>
        <button class="btn ${k[3]} mt" data-act="doExport" data-kind="${k[0]}">导出</button>
      </div></div>`).join(''))}
    </div>`;
  openModal({ title: '导出方案', sub: '版本 ' + v.id + ' · ' + (v.status === 'confirmed' ? '已确认' : '草稿（未确认）'), body, width: 'wide',
    onMount(box) {
      /* 每次打开弹窗都重置为「全部范围」：模板把 on 写死在全部范围上，若不重置会出现界面与行为不一致（审查报告 §5.2）。 */
      exportScope = 'all';
      box.querySelectorAll('[data-scope]').forEach(b => b.addEventListener('click', () => {
        box.querySelectorAll('[data-scope]').forEach(x => x.classList.toggle('on', x === b));
        exportScope = b.dataset.scope;
      }));
      box.querySelectorAll('[data-act="doExport"]').forEach(b => b.addEventListener('click', async () => {
        const old = b.textContent; b.disabled = true; b.textContent = '导出中…';
        try { await doExport(b.dataset.kind, exportScope); }
        finally { b.disabled = false; b.textContent = old; }
      }));
    } });
}

async function doExport(kind, sc) {
  const v = store.currentVersion;
  const snap = store.state.snapshot;
  try {
    const mod = await import('./export/exporters.js');
    if (kind === 'plan') await mod.exportPlanXlsx(v, snap, { scope: sc });
    else if (kind === 'wo') await mod.exportWorkOrdersXlsx(v, snap, { scope: sc });
    else if (kind === 'risk') await mod.exportRisksXlsx(v);
    else if (kind === 'gantt') {
      const hostEl = qs('.gantt-wrap');
      if (!hostEl) { toast('请先切换到排产工作台再导出甘特图', 'warn'); return; }
      const ok = await mod.exportGanttPNG(hostEl, v, { scope: sc });
      if (ok === false) toast('甘特图导出未完成，可重试或改用系统截图', 'err');
    } else if (kind === 'csv') {
      const list = sc === 'filtered' ? filterScheduled(v) : v.tasks.filter(x => x.scheduled);
      const rows = csvPreamble(v, snap, sc, '排产清单', list.length)
        .concat([['订单号', '工序', '设备', '数量', '单位', '开始', '结束', '换型(h)', '锁定状态']]);
      for (const t of list) rows.push([t.orderId, PROCESSES.find(p => p.key === t.process).name, t.machineId, t.qty, t.unit, fmtDateTime(t.start), fmtDateTime(t.end), t.setupHours || 0, t.frozen ? '执行冻结' : t.locked ? '已锁定' : '']);
      downloadBlob(new Blob([toCSV(rows)], { type: 'text/csv;charset=utf-8' }), '排产清单_' + v.id + (sc === 'filtered' ? '_当前筛选' : '_全部范围') + '.csv');
    } else if (kind === 'load') exportLoadReport(sc);
    else if (kind === 'audit') exportAuditCsv();
    toast('导出完成', 'ok');
  } catch (e) {
    console.error(e);
    toast('导出失败：' + e.message + '（筛选与格式选择已保留，可重试）', 'err');
  }
}
/** CSV 抬头声明：与 xlsx/PNG 导出保持同一套标识（版本/快照/范围/确认状态/模拟参数/排除清单）。
    PRD 要求导出件脱离界面后仍能自证，因此 CSV 不能是裸表格（审查报告 §5.2 高危项）。 */
function csvPreamble(v, snap, sc, title, rowCount) {
  const P = [
    ['君威智能排产助手 · ' + title + '（CSV）'],
    ['版本', v.id + '（' + v.name + '）'],
    ['版本状态', v.status === 'confirmed' ? (v.simulated ? '已确认（模拟参数）' : '已确认') : (v.dirty ? '待重算（草稿）' : '草稿（未确认）')],
    ['数据快照', v.dataVersion || snap?.meta?.name || '—'],
    ['计划起点 / 窗口', fmtDateTime(v.settings?.planStart) + ' · ' + (v.settings?.horizonDays || '—') + ' 天'],
    ['导出时间', nowISO()],
    ['导出人', v.confirmedBy || OPERATOR],
    ['导出范围', sc === 'filtered' ? '当前筛选（工序 / 关键字）' : '全部范围'],
    ['导出条数', rowCount],
    ['风险概览', '阻断 ' + v.validation.counts.block + ' · 警告 ' + v.validation.counts.warn + ' · 提示 ' + v.validation.counts.info],
    ['排除订单', (v.excludedOrders || []).length ? (v.excludedOrders.join('、')) : '无'],
    ['数据不足阻断订单', (v.blockedOrders || []).map(b => b.orderId).join('、') || '无'],
  ];
  if (v.simulated) P.push(['⚠ 模拟结果，含未验证参数', '演示参数版本，不进入正式已确认状态，不得作为执行依据']);
  if (v.status !== 'confirmed') P.push(['⚠ 草稿', '本文件为未确认草稿，不作为执行依据']);
  if (v.basedOnOldData) P.push(['⚠ 基于旧数据', '该版本基于已替换的数据快照']);
  P.push([]);
  return P;
}
/** 当前筛选下的已排任务（与甘特图工具栏的工序 / 关键字筛选一致） */
function filterScheduled(v) {
  const f = store.state.ui.filters.workbench || {};
  const kw = String(f.keyword || '').trim().toLowerCase();
  const isMachineQuery = !!kw && v.tasks.some(t => t.scheduled && String(t.machineId).toLowerCase() === kw);
  return v.tasks.filter(t => t.scheduled
    && (!f.process || f.process === 'all' || t.process === f.process)
    && (!kw || (isMachineQuery ? String(t.machineId).toLowerCase() === kw : String(t.orderId).toLowerCase() === kw)));
}
/** 负荷分析报告：自包含 HTML，内嵌 SVG 图表。
    PRD D07 要求「导出分析报告包含范围、口径、图表」，纯 CSV 无法承载图表（审查报告 P2-2）。
    同时仍导出 CSV，便于二次处理。 */

/* ---------------- 诊断面板（运行状态 / 持久化 / 日志 / 审计） ---------------- */
async function openDiagnosticsModal() {
  const report = await buildDiagnosticsReport({ store });
  const p = report.persistence || {};
  const est = p.estimate ? Math.round((p.estimate.usage || 0) / 1024) + " KB / " + Math.round((p.estimate.quota || 0) / 1048576) + " MB" : "未知";
  const statusText = { ok: "正常", unavailable: "不可用（内存态）", quota: "配额不足，已暂停", error: "写入失败", unknown: "未初始化" }[p.status] || p.status;
  const kv = (k, v) => html`<dt>${k}</dt><dd>${v}</dd>`;
  const body = html`
    <div class="grid g2">
      <div>
        <h4 style="font-size:12.5px;margin-bottom:6px">应用与持久化</h4>
        <dl class="kv tight">
          ${raw(kv("应用版本", report.app.version + "（数据结构 v" + report.app.schemaVersion + "）"))}
          ${raw(kv("本地持久化", statusText + (p.reason ? "：" + p.reason : "")))}
          ${raw(kv("最近保存", (store.state.persistence && store.state.persistence.lastSavedAt) || "—"))}
          ${raw(kv("存储占用", est))}
          ${raw(kv("审计条数", report.auditTotal == null ? "—" : report.auditTotal))}
          ${raw(kv("日志条数", String(report.logs.length) + " / 上限 300"))}
        </dl>
        <h4 style="font-size:12.5px;margin:12px 0 6px">数据快照</h4>
        <dl class="kv tight">
          ${raw(kv("标识", report.dataset && report.dataset.key || "—"))}
          ${raw(kv("订单数", report.dataset ? String(report.dataset.orders) : "—"))}
          ${raw(kv("设备数据来源", report.dataset && report.dataset.deviceSource || "—"))}
          ${raw(kv("设备规模", report.dataset && report.dataset.stats ? ("拉丝 " + report.dataset.stats.drawing + " / 捻股 " + report.dataset.stats.stranding + " / 合绳 " + report.dataset.stats.closing) : "—"))}
        </dl>
      </div>
      <div>
        <h4 style="font-size:12.5px;margin-bottom:6px">版本</h4>
        <div class="tbl-wrap" style="max-height:180px"><table class="tbl"><thead><tr><th>版本</th><th>状态</th><th class="num">任务</th><th class="num">准时率</th><th>指纹</th></tr></thead><tbody>
          ${raw((report.versions || []).map(v => html`<tr><td class="mono tiny">${v.id}</td><td class="tiny">${v.status}${v.simulated ? " · 模拟" : ""}${v.dirty ? " · 待重算" : ""}</td><td class="num tiny">${v.tasks}</td><td class="num tiny">${v.deliveryRate == null ? "—" : v.deliveryRate + "%"}</td><td class="mono tiny2">${v.fingerprint || "—"}</td></tr>`).join(""))}
        </tbody></table></div>
        <h4 style="font-size:12.5px;margin:12px 0 6px">最近审计（只增不改）</h4>
        <div class="tbl-wrap" style="max-height:150px"><table class="tbl"><thead><tr><th>时间</th><th>操作者</th><th>动作</th></tr></thead><tbody>
          ${raw((report.auditTail || []).slice(-12).reverse().map(a => html`<tr><td class="tiny2 mono">${a.at}</td><td class="tiny">${a.by}</td><td class="tiny">${a.action}</td></tr>`).join(""))}
        </tbody></table></div>
      </div>
    </div>
    <h4 style="font-size:12.5px;margin:14px 0 6px">最近日志</h4>
    <div class="tbl-wrap" style="max-height:200px"><table class="tbl"><thead><tr><th>时间</th><th>级别</th><th>事件</th><th>数据</th></tr></thead><tbody>
      ${raw((report.logs || []).slice(-40).reverse().map(l => html`<tr><td class="tiny2 mono">${l.at}</td><td class="tiny">${l.level}</td><td class="tiny mono">${l.event}</td><td class="tiny2 muted">${l.data == null ? "" : JSON.stringify(l.data).slice(0, 110)}</td></tr>`).join(""))}
    </tbody></table></div>`
  ;
  openModal({ title: "运行诊断", sub: "出问题时把这份报告导出，就能复现「发生了什么、什么数据、哪个版本」", width: "wide", body,
    footer: html`<button class="btn" data-act="close">关闭</button>
      <button class="btn" data-act="diagSave">立即保存到本地</button>
      <button class="btn" data-act="diagAuditCsv">导出审计日志 CSV</button>
      <button class="btn danger" data-act="diagClear">清空本地持久化</button>
      <button class="btn primary" data-act="diagExport">导出诊断包 JSON</button>`,
    onMount(box, close) {
      box.querySelector("[data-act=diagExport]").addEventListener("click", async () => {
        const rep = await buildDiagnosticsReport({ store });
        downloadBlob(new Blob([serializeDiagnostics(rep, true)], { type: "application/json;charset=utf-8" }), "诊断包_" + nowISO().replace(/[: ]/g, "-") + ".json");
        toast("诊断包已导出（订单号已打码）", "ok");
      });
      box.querySelector("[data-act=diagAuditCsv]").addEventListener("click", () => exportAuditCsv());
      box.querySelector("[data-act=diagSave]").addEventListener("click", async () => {
        const r = await store.persistNow("手动保存");
        toast(r.ok ? "已保存到本地" : ("保存失败：" + r.error), r.ok ? "ok" : "err");
      });
      box.querySelector("[data-act=diagClear]").addEventListener("click", async () => {
        await store.discardPersistence();
        close();
        toast("已清空本地持久化；当前内存中的状态仍可继续使用", "warn");
        render();
      });
    } });
}

/** 审计日志导出：只增不改的完整轨迹，供审计留档 */
function exportAuditCsv() {
  const list = store.state.audit || [];
  const rows = [
    ["君威智能排产助手 · 审计日志"],
    ["导出时间", nowISO()],
    ["操作者", OPERATOR],
    ["数据快照", store.state.datasetKey || "—"],
    ["说明", "追加式日志：记录数据载入、排产、人工调整、锁定、确认与模拟采用；不提供修改与删除单条的能力"],
    [],
    ["时间", "序号", "操作者", "动作", "版本", "详情"],
  ];
  for (const a of list) rows.push([a.at, a.seq, a.by, a.action, a.versionId || "", a.detail == null ? "" : JSON.stringify(a.detail)]);
  downloadBlob(new Blob([toCSV(rows)], { type: "text/csv;charset=utf-8" }), "审计日志_" + nowISO().slice(0, 10) + ".csv");
  toast("已导出 " + list.length + " 条审计记录", "ok");
}

function exportLoadReport(sc) {
  const v = store.currentVersion; if (!v) { toast('尚未生成计划', 'warn'); return; }
  const m = v.metrics;
  const rows = csvPreamble(v, store.state.snapshot, sc || 'all', '设备负荷分析（计划推算）', m.machineLoad.length)
    .concat([['工序', '设备编号', '可用(h)', '加工(h)', '换型(h)', '空闲(h)', '占用率(%)', '加工利用率(%)', '数据来源']]);
  for (const x of m.machineLoad) rows.push([PROCESSES.find(p => p.key === x.process).name, x.machineId, x.availH, x.runH, x.setupH, x.idleH, x.occRate ?? '不可用', x.runRate ?? '不可用', '计划推算']);
  downloadBlob(new Blob([toCSV(rows)], { type: 'text/csv;charset=utf-8' }), '设备负荷分析_' + v.id + '.csv');
  downloadBlob(new Blob([loadReportHtml(v, sc || 'all')], { type: 'text/html;charset=utf-8' }), '负荷分析报告_' + v.id + '.html');
  toast('已导出负荷分析报告（HTML 含图表）+ CSV，口径：计划推算', 'ok');
}

/** 生成自包含的负荷分析 HTML：内嵌 SVG 条形图，不依赖任何外部资源 */
function loadReportHtml(v, sc) {
  const m = v.metrics;
  const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  const bar = (label, value, max, color, fmtV) => {
    const w = max > 0 ? Math.max(0, Math.min(100, value / max * 100)) : 0;
    return '<div style="display:flex;align-items:center;gap:8px;margin:3px 0;font-size:12px">'
      + '<div style="width:104px;flex:none;color:#64748b">' + esc(label) + '</div>'
      + '<div style="flex:1;height:14px;background:#f1f5f9;border-radius:4px;overflow:hidden">'
      + '<i style="display:block;height:100%;width:' + w.toFixed(1) + '%;background:' + color + '"></i></div>'
      + '<div style="width:86px;flex:none;text-align:right;font-variant-numeric:tabular-nums">' + fmtV(value) + '</div></div>';
  };
  const byProc = Object.entries(m.byProcess);
  const maxOcc = Math.max(1, ...byProc.map(([, x]) => x.occRate || 0));
  const top = m.machineLoad.filter(x => x.occRate != null).slice().sort((a, b) => b.occRate - a.occRate).slice(0, 20);
  const maxTop = Math.max(1, ...top.map(x => x.occRate));
  const high = m.machineLoad.filter(x => x.occRate != null && x.occRate >= 90);
  const unavail = m.machineLoad.filter(x => x.availH <= 0);
  const setupCount = new Map();
  for (const t of v.tasks) { if (!t.scheduled || !t.setupHours) continue; setupCount.set(t.machineId, (setupCount.get(t.machineId) || 0) + 1); }
  const reasons = x => {
    const parts = [];
    if (x.setupH > 0) parts.push('换型 ' + setupCount.get(x.machineId) + ' 次 / ' + x.setupH + ' h');
    const d = (v.settings.downtime || []).filter(y => String(y.machineId) === String(x.machineId));
    if (d.length) parts.push('窗口内停机 ' + d.map(y => y.from + '~' + y.to).join('、'));
    return parts.length ? parts.join('；') : '原因待核实';
  };
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">'
    + '<title>设备负荷分析报告 · ' + esc(v.id) + '</title>'
    + '<style>' + "body{font-family:\"PingFang SC\",\"Microsoft YaHei\",system-ui,sans-serif;margin:0;padding:24px 28px;color:#0f172a;font-size:13px;line-height:1.6}h1{font-size:19px;margin:0 0 4px}h2{font-size:14px;margin:22px 0 8px;padding-bottom:5px;border-bottom:1px solid #e2e8f0}table{border-collapse:collapse;width:100%;font-size:12px}th,td{border-bottom:1px solid #eef2f7;padding:5px 8px;text-align:left}th{background:#f8fafc;font-weight:600}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}.meta{display:grid;grid-template-columns:auto 1fr;gap:2px 14px;font-size:12px;margin:8px 0 0}.meta dt{color:#64748b}.meta dd{margin:0}.warn{background:#fff7ed;border:1px solid #ffedd5;color:#9a3412;padding:8px 11px;border-radius:8px;margin:10px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:20px}" + '</style></head><body>'
    + '<h1>君威智能排产助手 · 设备负荷分析报告</h1>'
    + '<div style="color:#64748b;font-size:12px">数据来源：<b>计划推算</b>，不是 MES 实际实绩</div>'
    + '<dl class="meta">'
    + '<dt>版本</dt><dd>' + esc(v.id) + '（' + esc(v.name) + '）' + (v.status === 'confirmed' ? ' · 已确认' : ' · 草稿（未确认）') + '</dd>'
    + '<dt>数据快照</dt><dd>' + esc(v.dataVersion) + '</dd>'
    + '<dt>导出范围</dt><dd>' + (sc === 'filtered' ? '当前筛选' : '全部范围') + '</dd>'
    + '<dt>导出时间</dt><dd>' + esc(nowISO()) + '</dd>'
    + '<dt>计划起点 / 窗口</dt><dd>' + esc(fmtDateTime(v.settings.planStart)) + ' · ' + m.windowHours + ' 小时（' + esc(m.windowLabel || '') + '）</dd>'
    + '<dt>统计口径</dt><dd>占用率 =（加工 + 换型）÷ 该设备窗口内可用时长；加工利用率只含加工。任务按与窗口的交集计。</dd>'
    + '</dl>'
    + (v.simulated ? '<div class="warn"><b>模拟结果，含未验证参数</b>：换型耗时与工序需求量系数为演示参数，不得作为执行依据。</div>' : '')
    + '<h2>一、三工序负荷对比</h2><div class="grid"><div>'
    + byProc.map(([k, x]) => '<div style="font-weight:600;margin:8px 0 2px">' + esc(PROCESSES.find(p => p.key === k).name) + '（' + x.machines + ' 台）</div>'
        + bar('计划占用率', x.occRate || 0, maxOcc, '#2563eb', z => z.toFixed(1) + '%')
        + bar('加工利用率', x.runRate || 0, maxOcc, '#0d9488', z => z.toFixed(1) + '%')).join('')
    + '</div><div><table><thead><tr><th>工序</th><th class="num">设备</th><th class="num">可用 h</th><th class="num">加工 h</th><th class="num">换型 h</th><th class="num">占用率</th></tr></thead><tbody>'
    + byProc.map(([k, x]) => '<tr><td>' + esc(PROCESSES.find(p => p.key === k).name) + '</td><td class="num">' + x.machines + '</td><td class="num">' + x.availH + '</td><td class="num">' + x.runH + '</td><td class="num">' + x.setupH + '</td><td class="num">' + (x.occRate == null ? '不可用' : x.occRate + '%') + '</td></tr>').join('')
    + '</tbody></table></div></div>'
    + '<h2>二、设备占用率排行（前 20）</h2>'
    + top.map(x => bar(x.machineId + ' · ' + PROCESSES.find(p => p.key === x.process).name, x.occRate, maxTop, x.occRate >= 90 ? '#ea580c' : '#2563eb', z => z.toFixed(1) + '%')).join('')
    + '<h2>三、高负荷设备（占用率 ≥ 90%）</h2>'
    + (high.length ? '<table><thead><tr><th>设备</th><th>工序</th><th class="num">占用率</th><th class="num">加工 h</th><th class="num">换型 h</th><th>可确证的原因</th></tr></thead><tbody>'
        + high.map(x => '<tr><td>' + esc(x.machineId) + '</td><td>' + esc(PROCESSES.find(p => p.key === x.process).name) + '</td><td class="num">' + x.occRate + '%</td><td class="num">' + x.runH + '</td><td class="num">' + x.setupH + '</td><td>' + esc(reasons(x)) + '</td></tr>').join('')
        + '</tbody></table><div style="color:#64748b;font-size:12px;margin-top:6px">负荷高不等于超载：占用冲突才是确定性阻断。以上原因仅列当前计划中可追溯的依据，其余标注「原因待核实」。</div>'
      : '<div style="color:#64748b">窗口内没有占用率 ≥ 90% 的设备。</div>')
    + '<h2>四、不可用设备（窗口内零可用时长）</h2>'
    + (unavail.length ? '<table><thead><tr><th>设备</th><th>工序</th><th>说明</th></tr></thead><tbody>' + unavail.map(x => '<tr><td>' + esc(x.machineId) + '</td><td>' + esc(PROCESSES.find(p => p.key === x.process).name) + '</td><td>窗口内全部落入停机</td></tr>').join('') + '</tbody></table>' : '<div style="color:#64748b">无。</div>')
    + '<h2>五、全部设备明细</h2><table><thead><tr><th>工序</th><th>设备</th><th class="num">可用 h</th><th class="num">加工 h</th><th class="num">换型 h</th><th class="num">空闲 h</th><th class="num">占用率</th><th class="num">加工利用率</th></tr></thead><tbody>'
    + m.machineLoad.map(x => '<tr><td>' + esc(PROCESSES.find(p => p.key === x.process).name) + '</td><td>' + esc(x.machineId) + '</td><td class="num">' + x.availH + '</td><td class="num">' + x.runH + '</td><td class="num">' + x.setupH + '</td><td class="num">' + x.idleH + '</td><td class="num">' + (x.occRate == null ? '不可用' : x.occRate + '%') + '</td><td class="num">' + (x.runRate == null ? '不可用' : x.runRate + '%') + '</td></tr>').join('')
    + '</tbody></table></body></html>';
}

async function afterImport(dataset, key, opts) {
  await store.loadDataset(key, dataset, { id: key, name: dataset.meta?.name || '导入数据快照' });
  await applyDefaultRatedData();
  toast('订单已导入：' + store.state.snapshot.orders.length + ' 条', 'ok');
  /* 空白启动补齐最后一半 → 自动排产；已有计划时替换订单 → 由用户决定何时重算。 */
  if (opts && opts.autoSettle === false) {
    toast('已自动配套默认产品额定数据；确认无误后点「生成候选计划」重算', 'warn');
    navigate('orders');
    return;
  }
  await settleIntake();
}

/**
 * 空白启动的收口逻辑：订单与默认产品额定数据都到位后才排产。
 * 只到位一部分时明确告知还缺什么（不静默、不拿半份数据去排产）。
 */
export async function settleIntake() {
  const st = store.intakeStatus();
  if (!st.ready) {
    toast('还缺少：' + st.missing.join('、') + '，补齐后会自动生成首排计划', 'warn');
    navigate('workbench');
    return false;
  }
  toast('订单 ' + st.orders.rows + ' 条 · 设备 ' + st.devices.rows + ' 台已就位，正在生成首排候选计划…');
  await store.generate({ reason: '导入数据首排' });
  toast('首排候选计划已生成', 'ok');
  navigate('workbench');
  return true;
}

/** 回到空白工作台。已有数据时先确认，避免一键清空正在演示的快照。 */
export async function confirmThenBlank() {
  const s = store.state;
  const dirty = s.versions.length > 0 || !!(s.snapshot && s.snapshot.orders.length);
  const doBlank = async () => {
    store.resetToBlank();
    await applyDefaultRatedData();
    render();
    toast('已回到空白工作台：默认产品额定数据已就绪，请上传订单文件', 'ok');
  };
  if (!dirty) { doBlank(); return true; }
  openModal({
    title: '回到空白工作台',
    body: html`<div class="banner warn">${raw(icon('alert', 16))}<div><b>当前会话将被清空。</b>
      数据快照、内存中的方案版本与选中状态都会重置。
      已落盘的审计轨迹与历史版本不会被删除，但它们不再出现在当前会话里。</div></div>`,
    footer: html`<button class="btn" data-act="close">取消</button>
      <button class="btn primary" data-act="doBlank">确认清空并回到空白</button>`,
    onMount(box, close) {
      box.querySelector('[data-act=doBlank]').addEventListener('click', () => { close(); doBlank(); });
    },
  });
  return true;
}

/* ---------------- 数据载入 ---------------- */
async function applyDefaultRatedData() {
  if (store.state.snapshot?.meta?.deviceSourceId) return false;
  const rated = await loadDefaultRatedData();
  store.applyDeviceData({
    machines: rated.machines,
    capacity: rated.capacity,
    source: rated.meta.name,
    sourceId: rated.meta.id,
    stats: rated.meta.stats,
  });
  return true;
}

/* 内置快照只负责订单与场景；尚未选择产品定额时才补入内置默认数据。 */
export async function loadBuiltin(which = 'real') {
  const url = which === 'demo' ? '../data/demo-dataset.json' : '../data/dataset.json';
  const res = await fetch(url);
  if (!res.ok) throw new Error('无法载入 ' + url + '（HTTP ' + res.status + '）');
  const ds = await res.json();
  await store.loadDataset(which, ds, { id: which, name: which === 'demo' ? 'DEMO 演示场景数据（虚构）' : '君威脱敏数据快照' });
  await applyDefaultRatedData();
  return ds;
}

/* ---------------- 启动 ---------------- */
/** 便于自检与排障：把 store 挂到 window（只读用途，不改变任何行为）。 */
if (typeof window !== 'undefined') { window.__jwStore = store; window.__jwDiag = { log, persist }; }

async function boot() {
  bus.on('toast', ({ msg, kind }) => toast(msg, kind));
  /* 全局错误边界：记录到环形缓冲并给出非阻塞提示，不吞异常、不清空状态。 */
  installErrorBoundary(({ kind, message, count }) => {
    toast('运行期' + (kind === 'unhandledrejection' ? '异步' : '') + '错误（第 ' + count + ' 次）：' + String(message).slice(0, 90) + '　可在「诊断」面板查看并导出诊断包', 'err');
  });
  log.info('app.boot', { url: location.href, ua: navigator.userAgent.slice(0, 80) });
  /* 计算中状态：阶段文案 + 已用时 + 取消入口（PRD 8.3；原先 bus.emit('solving') 没有任何订阅者）。 */
  let calcTimer = null;
  const hideCalc = () => { if (calcTimer) { clearInterval(calcTimer); calcTimer = null; } qs('.calc')?.remove(); };
  bus.on('solving', s => {
    const wrap = qs('#view');
    if (!wrap) return;
    if (s.status !== 'running') { hideCalc(); return; }
    let node = qs('.calc');
    if (!node) {
      node = el('div.calc');
      node.innerHTML = html`<div class="spin"></div><div class="calc-msg"></div>
        <div class="tiny muted calc-elapsed"></div>
        <button class="btn sm" data-act="cancelSolve">取消计算</button>
        <div class="tiny muted2">计算期间旧版本仍可查看；取消会保留原计划</div>`;
      wrap.style.position = 'relative';
      wrap.appendChild(node);
    }
    qs('.calc-msg', node).textContent = s.message || '正在生成候选计划';
    if (!calcTimer) calcTimer = setInterval(() => {
      const n = qs('.calc'); if (!n) return;
      const t = qs('.calc-elapsed', n);
      if (t) t.textContent = '已用时 ' + ((performance.now() - (store.state.solving.startedAt || performance.now())) / 1000).toFixed(1) + ' 秒';
    }, 200);
  });
  const globalActivate = (node) => {
    const fn = GLOBAL_ACTIONS[node.dataset.act];
    if (fn) { fn(null, node, node.dataset); return true; }
    return false;
  };
  /* 顶栏 / 侧栏里的表单控件（data-act 挂在 input 上）走这条通道：
     document 级 click 派发对 input 不适用，必须单独接 change。 */
  const GLOBAL_FORM_ACTIONS = {
    setCurrentDate(node) {
      const v = String(node.value || '').trim();
      store.setCurrentDate(v || null);
      render();      // 顶栏与甘特图都要跟着刷新（今日高亮、now 线、模拟标注）
    },
  };
  document.addEventListener('change', (e) => {
    const node = e.target.closest('[data-act]');
    if (!node || !document.body.contains(node)) return;
    const view0 = qs('#view');
    if (view0 && view0.contains(node)) return;      // #view 内的由 onForm 负责
    const fn = GLOBAL_FORM_ACTIONS[node.dataset.act];
    if (fn) fn(node);
  });
  document.addEventListener('click', (e) => {
    const node = e.target.closest('[data-act]');
    if (!node || !document.body.contains(node)) return;
    if (globalActivate(node)) e.preventDefault();
  });
  /* 全局动作的键盘等价通道：侧栏导航与顶栏按钮在 #view 之外，
     它们的 data-act 由上面的 document 级 click 处理，因此这里必须有配套的 keydown，
     否则「纯键盘走完全流程」在第一步（切页）就断了。 */
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    if (e.defaultPrevented) return;   // 已被更具体的处理器消费，避免重复触发
    const node = e.target.closest('[data-act]');
    if (!node || !document.body.contains(node)) return;
    if (['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'].includes(node.tagName)) return;
    if (globalActivate(node)) e.preventDefault();
  });
  /* Escape 的关闭与焦点恢复由 components/ui.js 的弹层栈统一负责（document 捕获阶段、只处理栈顶）。
     这里**不再**重复绑定：曾同时保留「栈关闭 + 遮罩 click()」两条路径，
     第二次关闭会把焦点重新打到 BODY，导致「关闭后焦点回到触发元素」失效。 */
  const view = qs('#view');
  /* 文本 / 数字输入框在「输入过程中」不逐字重渲染。
     原因：视图是整块 innerHTML 重渲染，逐字重渲染会丢焦点、光标回到开头 ——
     实测在库存框里输入 1 2 3 4 得到「4321」（倒序），关键字输入 260 得到「062」。
     光标位置对 text 输入框可以恢复（见 restoreFocus），但 input[type=number] 不支持
     setSelectionRange，只能靠「输入期间不重渲染」来根治：停止输入 300ms 后再重渲染一次，
     既保证连续输入正确，又不会让派生显示（过滤结果、低于安全库存提示）迟迟不更新。 */
  const TYPING_DEBOUNCE_MS = 300;
  const TYPING_TYPES = ['text', 'number', 'search', 'url', 'tel', 'password', 'email'];
  const onForm = e => {
    const n = e.target.closest('[data-act]'); if (!n || !CTX) return;
    const a = CTX.__formActs?.[n.dataset.act]; if (!a) return;
    if (n.__handled === e.type) return;
    n.__handled = e.type;
    const el = e.target;
    const typing = e.type === 'input' && el && el.tagName === 'INPUT'
      && TYPING_TYPES.includes(String(el.type || 'text').toLowerCase());
    if (typing) {
      clearTimeout(el.__typingTimer);
      const node = el, ds = { ...n.dataset };
      el.__typingTimer = setTimeout(() => a(CTX, node, ds, e), TYPING_DEBOUNCE_MS);
      return;
    }
    a(CTX, n, n.dataset, e);
  };
  view.addEventListener('input', onForm);
  view.addEventListener('change', onForm);
  view.innerHTML = html`<div class="empty">${raw(icon('refresh', 26))}<h3>正在准备工作台…</h3></div>`;
  /* 先尝试从本地持久化恢复上次会话；恢复成功则不覆盖用户已确认的版本。
     显式带上 ?fresh=1 可跳过恢复（部署与演示时的「干净启动」）。 */
  const fresh = new URLSearchParams(location.search).get('fresh') === '1';
  let restored = false;
  try { restored = await store.initPersistence({ fresh }); }
  catch (e) { log.warn('persist.initFailed', String(e.message)); }
  /* fresh 只对本次启动生效：从地址栏剥离，避免用户手动刷新时反复回到干净会话。 */
  if (fresh && history.replaceState) {
    const q = new URLSearchParams(location.search); q.delete('fresh');
    history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q.toString() : ''));
  }
  if (restored) {
    try { await applyDefaultRatedData(); }
    catch (e) { log.warn('defaultRated.restoreFailed', String(e.message)); toast('内置产品额定数据载入失败：' + e.message, 'err'); }
    render();
    const r = store.state.sessionRestored;
    toast('已恢复上次会话：' + r.versions + ' 个版本（其中已确认 ' + r.confirmed + ' 个），数据快照 ' + r.datasetKey, 'ok');
    return;
  }
  /* 空白启动：预置固定的产品额定数据。
     应用打开时只需导入订单文件；
     内置快照可通过 ?data=demo|real 的显式深链打开，不会在启动时被静默载入。
     ?data=demo|real 是显式深链（演示与书签用），明确写了才载入。 */
  const deep = new URLSearchParams(location.search).get('data');
  if (deep === 'demo' || deep === 'real') {
    try { await loadBuiltin(deep); await settleIntake(); return; }
    catch (e) { log.warn('boot.deepLinkFailed', String(e.message)); toast('深链数据载入失败：' + e.message + '，回到空白工作台', 'err'); }
  }
  store.resetToBlank();
  try { await applyDefaultRatedData(); }
  catch (e) { log.warn('defaultRated.bootFailed', String(e.message)); toast('内置产品额定数据载入失败：' + e.message, 'err'); }
  render();
  const st = store.intakeStatus();
  toast('空白工作台已就绪：还缺少 ' + st.missing.join('、') + '，导入后会自动生成首排计划');
}
boot();
