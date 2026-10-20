/* D07 设备负荷分析（PRD 第 7 章 D07、第 10 章指标口径）
   本页全部数字由当前版本的计划排程结果推算，不是 MES 实际实绩。
   口径与 engine/metrics.js 保持一致，切换时间窗口时按同一公式在窗口内重算：
     占用率 =（窗口内加工时长 + 换型时长）÷ 窗口内可用时长；可用时长 = 窗口小时数 − 窗口内已知停机。
   高负荷只作警告提示，不做超载判定；原因只写当前计划中可确证的事实，其余标为「原因待核实」。 */
import { html, raw, icon } from '../core/dom.js';
import { HOUR, DAY, round, sum, fmtNum, fmtPct, fmtDateTime } from '../core/util.js';
import { PROCESSES } from '../engine/rules.js';
import { section, hbar, tag, procTag, versionTag, emptyState } from '../components/ui.js';

const PROC = Object.fromEntries(PROCESSES.map(p => [p.key, p]));
const STATUS_LABEL = { draft: '草稿', stale: '待重算', confirmed: '已确认', superseded: '已替代' };

/* ---------------- 时间窗口 ---------------- */
export const LOAD_WINDOWS = [
  { key: 'all', label: '全计划窗口', note: '' },
  { key: '14', label: '未来 14 天', note: '自计划开始时刻起算' },
  { key: '7', label: '未来 7 天', note: '自计划开始时刻起算' },
  { key: 'week', label: '本周', note: '自然周，周一 00:00 起' },
];
const WIN_MAP = Object.fromEntries(LOAD_WINDOWS.map(w => [w.key, w]));

let winKey = 'all';        // 当前时间窗口，默认全计划窗口
let lastHost = null;       // 最近一次渲染的容器
let lastCtx = null;        // 最近一次的 ctx，供事件委托绑定异常时回退

/** 片段拼接：html`` 的结果是已转义字符串，嵌入外层模板时必须显式 raw()，避免二次转义 */
const frag = v => raw(v == null ? '' : v);
const metricsOf = ctx => ctx.metrics || ctx.version?.metrics || null;

/** 解析时间窗口：全部裁剪到计划窗口内；本周取含计划开始日的自然周（周一 00:00 起） */
export function resolveWindow(key, planStart, planEnd) {
  const w = WIN_MAP[key] || WIN_MAP.all;
  let from = planStart, to = planEnd;
  if (w.key === '14' || w.key === '7') to = Math.min(planEnd, planStart + (w.key === '14' ? 14 : 7) * DAY);
  else if (w.key === 'week') {
    const d = new Date(planStart);
    const monday = new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7)).getTime();
    from = Math.max(planStart, monday);
    to = Math.min(planEnd, monday + 7 * DAY);
  }
  if (!(to > from)) to = Math.min(planEnd, from + HOUR);
  return { key: w.key, label: w.label, note: w.note, from, to, hours: round((to - from) / HOUR, 1) };
}

/* 停机记录 → 设备（与 engine/metrics.js 完全相同的解析顺序） */
function machineOf(cap, d) {
  return cap?.machineById?.(d.process || 'stranding', d.machineId)
    || cap?.machines?.drawing?.find(x => x.id === d.machineId)
    || cap?.machines?.closing?.find(x => x.id === d.machineId) || null;
}
const overlapH = (a, b, from, to) => { const s = Math.max(a, from), e = Math.min(b, to); return e > s ? (e - s) / HOUR : 0; };

/** 按窗口计算设备负荷（口径同 PRD 第 10 章；全计划窗口与 computeMetrics 结果一致） */
export function computeLoadWindow(ctx, key = winKey) {
  const cap = ctx.cap || {};
  const settings = ctx.settings || {};
  const m0 = metricsOf(ctx);
  const planStart = m0?.planStart ?? (settings.planStart ? new Date(settings.planStart).getTime() : Date.now());
  const planEnd = planStart + (m0?.windowHours ?? (settings.horizonDays || 45) * 24) * HOUR;
  const win = resolveWindow(key, planStart, planEnd);

  /* 窗口内已知停机（可用时长扣减项） */
  const downByUid = new Map(), downList = new Map();
  for (const d of (settings.downtime || [])) {
    const m = machineOf(cap, d);
    if (!m) continue;
    const h = overlapH(new Date(d.from).getTime(), new Date(d.to).getTime(), win.from, win.to);
    if (h <= 0) continue;
    downByUid.set(m.uid, (downByUid.get(m.uid) || 0) + h);
    const arr = downList.get(m.uid) || [];
    arr.push({ from: new Date(d.from).getTime(), to: new Date(d.to).getTime(), reason: d.reason || '', hours: round(h, 2) });
    downList.set(m.uid, arr);
  }

  /* 窗口内加工/换型占用：任务按与窗口的交集计算 */
  const runByUid = new Map(), setupByUid = new Map(), tasksByUid = new Map();
  for (const t of (ctx.version?.tasks || [])) {
    if (!t.scheduled) continue;
    const run = overlapH(t.start, t.end, win.from, win.to);
    const setup = (t.setupHours || 0) > 0 ? overlapH(t.start - t.setupHours * HOUR, t.start, win.from, win.to) : 0;
    if (run > 0) runByUid.set(t.machineUid, (runByUid.get(t.machineUid) || 0) + run);
    if (setup > 0) setupByUid.set(t.machineUid, (setupByUid.get(t.machineUid) || 0) + setup);
    if (run > 0 || setup > 0) {
      const arr = tasksByUid.get(t.machineUid) || [];
      arr.push({ orderId: t.orderId, setupHours: t.setupHours || 0, setupReasons: t.setupReasons || [], candidateCount: t.candidateCount });
      tasksByUid.set(t.machineUid, arr);
    }
  }

  const machines = [];
  for (const p of PROCESSES) {
    for (const m of (cap.machines?.[p.key] || [])) {
      const down = downByUid.get(m.uid) || 0;
      const avail = Math.max(0, win.hours - down);
      const run = runByUid.get(m.uid) || 0, setup = setupByUid.get(m.uid) || 0;
      machines.push({
        process: p.key, processName: p.name, machineId: m.id, uid: m.uid, machineName: m.name || '',
        runH: round(run, 2), setupH: round(setup, 2), occH: round(run + setup, 2),
        availH: round(avail, 2), idleH: round(Math.max(0, avail - run - setup), 2), downH: round(down, 2),
        occRate: avail > 0 ? round((run + setup) / avail * 100, 1) : null,
        runRate: avail > 0 ? round(run / avail * 100, 1) : null,
        down: downList.get(m.uid) || [],
        tasks: tasksByUid.get(m.uid) || [],
      });
    }
  }

  const byProcess = {};
  for (const p of PROCESSES) {
    const ms = machines.filter(x => x.process === p.key);
    const availH = round(sum(ms.map(x => x.availH)), 1), runH = round(sum(ms.map(x => x.runH)), 1);
    const setupH = round(sum(ms.map(x => x.setupH)), 1), occH = round(runH + setupH, 2);
    byProcess[p.key] = { key: p.key, name: p.name, color: p.color, machines: ms.length, availH, runH, setupH, occH,
      idleH: round(Math.max(0, availH - occH), 1),
      occRate: availH > 0 ? round(occH / availH * 100, 1) : null,
      runRate: availH > 0 ? round(runH / availH * 100, 1) : null };
  }

  const totals = {
    machines: machines.length,
    availH: round(sum(machines.map(x => x.availH)), 1), runH: round(sum(machines.map(x => x.runH)), 1),
    setupH: round(sum(machines.map(x => x.setupH)), 1), idleH: round(sum(machines.map(x => x.idleH)), 1),
    downH: round(sum(machines.map(x => x.downH)), 1),
  };
  totals.occH = round(totals.runH + totals.setupH, 2);
  totals.occRate = totals.availH > 0 ? round(totals.occH / totals.availH * 100, 1) : null;
  totals.runRate = totals.availH > 0 ? round(totals.runH / totals.availH * 100, 1) : null;

  return {
    win, machines, byProcess, totals,
    ranking: machines.slice().sort((a, b) => (b.occRate ?? -1) - (a.occRate ?? -1) || b.occH - a.occH).slice(0, 20),
    highLoad: machines.filter(x => x.occRate != null && x.occRate >= 90).sort((a, b) => b.occRate - a.occRate),
    unavailable: machines.filter(x => x.availH <= 0),
    composition: machines.filter(x => x.availH > 0).sort((a, b) => b.occH - a.occH).slice(0, 12),
  };
}

/* ---------------- 渲染片段 ---------------- */
/** 本地表格渲染：类名与 components/ui.js 的 dataTable 一致，单元格内容已是安全 HTML */
function loadTable({ columns, rows, rowKey = (r, i) => i, empty = '没有符合条件的记录', maxHeight = null }) {
  if (!rows.length) return html`<div class="empty sm">${frag(icon('search', 24))}<p>${empty}</p></div>`;
  return html`<div class="tbl-wrap"${maxHeight ? raw(' style="max-height:' + maxHeight + '"') : ''}>
    <table class="tbl"><thead><tr>
      ${frag(columns.map(c => html`<th class="${c.num ? 'num' : ''}"${c.width ? raw(' style="width:' + c.width + '"') : ''}>${c.label}</th>`).join(''))}
    </tr></thead><tbody>
      ${frag(rows.map((r, i) => html`<tr data-row="${rowKey(r, i)}">${frag(columns.map(c => html`<td class="${c.num ? 'num' : ''}${c.cls ? ' ' + c.cls : ''}">${frag(c.render(r, i))}</td>`).join(''))}</tr>`).join(''))}
    </tbody></table></div>`;
}

/** 占用构成条：加工 / 换型 / 空闲，宽度按窗口内可用时长归一 */
function minibar(r) {
  const base = r.availH > 0 ? r.availH : 0;
  const w = v => base > 0 ? round(Math.max(0, Math.min(100, v / base * 100)), 2) : 0;
  const title = base > 0
    ? '加工 ' + fmtNum(r.runH, 1) + ' h · 换型 ' + fmtNum(r.setupH, 1) + ' h · 空闲 ' + fmtNum(r.idleH, 1) + ' h · 可用 ' + fmtNum(r.availH, 1) + ' h'
    : '不可用：窗口内可用时长为 0（全部落入停机窗口）';
  return html`<div class="minibar" title="${title}"><i class="a" style="width:${w(r.runH)}%"></i><i class="b" style="width:${w(r.setupH)}%"></i><i class="c" style="width:${w(r.idleH)}%"></i></div>`;
}

function compRow(label, r, sub) {
  return html`<div class="row" style="gap:10px;flex-wrap:nowrap">
    <span class="tiny" style="width:184px;flex:none">${label}${sub ? frag(html` <span class="muted2">${sub}</span>`) : ''}</span>
    <span style="flex:1;min-width:90px">${frag(minibar(r))}</span>
    <span class="tiny2 muted2" style="flex:none">加工 ${fmtNum(r.runH, 1)} · 换型 ${fmtNum(r.setupH, 1)} · 空闲 ${fmtNum(r.idleH, 1)} · 可用 ${fmtNum(r.availH, 1)} h</span>
  </div>`;
}

const gotoBtn = r => html`<button class="btn ghost sm" data-act="gotoWorkbench" data-machine="${r.machineId}" data-process="${r.process}">${frag(icon('target', 13))}定位到工作台</button>`;

const machineCell = r => html`<span class="mono">${r.machineId}</span>${frag(r.machineName ? html` <span class="tiny2 muted2">${r.machineName}</span>` : '')}`;

/** 可确证原因：只列当前计划中可追溯的换型、停机与适配限制，其余标为待核实 */
function loadFacts(row) {
  const facts = [];
  const setups = row.tasks.filter(t => (t.setupHours || 0) > 0);
  if (setups.length) {
    const fields = [];
    for (const t of setups) for (const f of (t.setupReasons || [])) if (!fields.includes(f)) fields.push(f);
    facts.push({ k: '换型 ' + setups.length + ' 次，占用 ' + fmtNum(row.setupH, 1) + ' h' + (fields.length ? '；触发字段：' + fields.slice(0, 3).join('、') : ''),
      src: 'R3/R4 相邻任务规格比对；换型耗时在数据包未提供矩阵时使用演示参数（R5）' });
  }
  if (row.downH > 0) {
    const list = row.down.map(d => fmtDateTime(d.from) + '—' + fmtDateTime(d.to) + (d.reason ? '（' + d.reason + '）' : '')).join('；');
    facts.push({ k: '窗口内停机 ' + fmtNum(row.downH, 1) + ' h：' + list, src: '当前版本的停机设置（不可用时段）' });
  }
  const only = row.tasks.filter(t => t.candidateCount === 1).length;
  const few = row.tasks.filter(t => t.candidateCount === 2).length;
  if (only) facts.push({ k: only + ' 个任务在全厂只有 1 台适配设备（规格适配限制）', src: 'R1 产能矩阵非空列 / 拉丝规格区间' });
  if (few) facts.push({ k: few + ' 个任务仅 2 台适配设备，可分流余量有限', src: 'R1 产能矩阵非空列 / 拉丝规格区间' });
  if (!facts.length) facts.push({ unknown: true });
  return facts;
}

/* ---------------- 口径说明 ---------------- */
export function methodLines(ctx, L) {
  const version = ctx.version || null;
  const w = L.win;
  return [
    { k: '数据来源', v: '计划推算：由当前版本的计划排程结果计算，不是 MES 实际实绩；本页不读取 MES 实时数据。' },
    { k: '版本', v: (version?.id || '—') + ' · ' + (version?.name || '—') + (version?.simulated ? '（使用演示参数）' : '') + ' · ' + (STATUS_LABEL[version?.status] || '—') },
    { k: '时间窗口', v: w.label + (w.note ? '（' + w.note + '）' : '') + '：' + fmtDateTime(w.from) + ' — ' + fmtDateTime(w.to) + '，共 ' + fmtNum(w.hours, 0) + ' 小时，覆盖 ' + L.machines.length + ' 台设备' },
    { k: '计算范围', v: '任务按与窗口的交集计算，跨窗口任务只计入窗口内部分；工序分拉丝、捻股、合绳三段汇总。' },
    { k: '设备计划占用率', v: '窗口内（加工时长 + 换型时长）÷ 窗口内设备可用时长；已剔除已知停机；分母为零显示「不可用」，不按 0% 参与比较。' },
    { k: '设备加工利用率', v: '窗口内加工时长 ÷ 窗口内设备可用时长；与含换型的占用率分开表达，跨设备汇总按时长加权。' },
    { k: '可用时长', v: '窗口小时数 − 窗口内已知停机时长（当前版本的停机设置）。' },
    { k: '换型', v: '换型计入资源占用，不计入产品加工时长；数据包未提供换型耗时矩阵时使用演示参数模型（R5）。' },
    { k: '加工时长', v: '工序需求量 ÷ 该设备对应规格的每分钟有效产出，工时向上取整到分钟（PRD 9.1）。' },
    { k: '高负荷', v: '占用率 ≥ 90% 仅作警告提示：负荷高不等于超载，占用冲突才是确定性阻断（PRD 8.2）。' },
    { k: '原因追溯', v: '只列当前计划中可确证的换型次数与时长、停机时长、适配限制（候选机台数）；其余一律标为「原因待核实」。' },
    { k: '数据边界', v: '不含 MES 实际开动、在制与完工数据；本页用于计划侧负荷判断，不用于考核设备实绩，与现场记录不一致时以现场为准。' },
  ];
}

export function loadMethodText(ctx) {
  const L = computeLoadWindow(ctx, winKey);
  return ['君威智能排产助手 · D07 设备负荷分析 · 口径说明', '（数据来源：计划推算，不是 MES 实际实绩）', '']
    .concat(methodLines(ctx, L).map(x => x.k + '：' + x.v)).join('\n');
}

/* ---------------- 页面 ---------------- */
export function renderLoad(host, ctx) {
  lastHost = host; lastCtx = ctx;
  const version = ctx.version || ctx.store?.currentVersion || null;
  const scheduled = (version?.tasks || []).filter(t => t.scheduled);

  if (!version || !scheduled.length) {
    /* 说明：emptyState 的 actions 分支在 dom.js 的转义规则下会被二次转义，这里单独渲染按钮，保证 data-act 可用 */
    host.innerHTML = pageWrap(host, ctx, html`
      ${raw(emptyState({
        icon: 'gauge',
        title: '先生成候选计划',
        desc: '设备负荷分析按当前版本的计划排程结果推算，需要有可用的排产结果。请先在工作台生成候选计划，再回到本页查看三工序负荷、设备占用排行与高负荷原因。',
      }))}
      <div class="btn-row" style="justify-content:center;margin-top:-6px">
        <button class="btn primary" data-act="gotoWorkbench">${frag(icon('play', 14))}前往工作台生成计划</button>
      </div>`);
    return;
  }

  const L = computeLoadWindow(ctx, winKey);
  const t = L.totals, win = L.win, hl = L.highLoad;
  const canExport = typeof ctx.exportLoadReport === 'function';

  const stat = (k, v, unit, foot, cls, title) => html`<div class="metric ${cls || ''}" style="cursor:default" title="${title || ''}">
    <div class="k">${k}</div><div class="v">${v}<small>${unit || ''}</small></div><div class="f">${foot}</div></div>`;

  const toolbar = html`<div class="row mb">
    <div class="seg">
      ${frag(LOAD_WINDOWS.map(w => html`<button data-act="windowChange" data-win="${w.key}" class="${w.key === win.key ? 'on' : ''}">${w.label}</button>`).join(''))}
    </div>
    <span class="tiny muted">窗口：${fmtDateTime(win.from)} — ${fmtDateTime(win.to)} · ${fmtNum(win.hours, 0)} 小时${win.note ? '（' + win.note + '）' : ''}</span>
    <div class="spacer"></div>
    <button class="btn ghost sm" data-act="copyMethod">${frag(icon('copy', 14))}复制口径说明</button>
    <button class="btn sm" data-act="exportLoad"${canExport ? '' : raw(' disabled')} title="${canExport ? '导出负荷分析报告：含范围、口径、图表数据与可追溯说明' : '导出功能尚未接入（main.js 未注入 exportLoadReport），暂不可用'}">${frag(icon('download', 14))}导出分析报告</button>
  </div>`;

  const statStrip = html`<div class="grid g4 mb">
    ${frag(stat('窗口设备计划占用率', fmtNum(t.occRate, 1), '%', '占用 ' + fmtNum(t.occH, 1) + ' h / 可用 ' + fmtNum(t.availH, 0) + ' h', '', '窗口内（加工+换型）÷ 窗口内可用时长，与顶部指标卡同一口径'))}
    ${frag(stat('设备加工利用率', fmtNum(t.runRate, 1), '%', '加工 ' + fmtNum(t.runH, 1) + ' h · 换型 ' + fmtNum(t.setupH, 1) + ' h', '', '窗口内加工时长 ÷ 窗口内可用时长，不含换型'))}
    ${frag(stat('高负荷机台', String(hl.length), '台', '占用率 ≥ 90% · 占设备 ' + (t.machines ? fmtNum(hl.length / t.machines * 100, 1) + '%' : '—'), hl.length ? 'warnv' : 'good', '仅警告提示，不是超载判定'))}
    ${frag(stat('不可用机台', String(L.unavailable.length), '台', L.unavailable.length ? '窗口内可用时长为 0，全部落入停机窗口' : '当前窗口没有零可用时长的机台', L.unavailable.length ? 'warnv' : 'good', '分母为零按 PRD 第 10 章显示「不可用」'))}
  </div>`;

  const processCards = html`<div style="padding:14px"><div class="grid g3">
    ${frag(PROCESSES.map(p => {
      const d = L.byProcess[p.key];
      const rateCell = v => v == null ? frag(tag('不可用', 'gray')) : frag(html`<b>${fmtPct(v)}</b>`);
      return html`<div class="card">
        <div class="card-h"><h3>${p.name}</h3><div class="right">${frag(tag(d.machines + ' 台设备', 'gray'))}</div></div>
        <div class="card-b">
          <dl class="kv tight">
            <dt>设备数</dt><dd>${d.machines} 台</dd>
            <dt>可用时长</dt><dd>${fmtNum(d.availH, 1)} h</dd>
            <dt>加工时长</dt><dd>${fmtNum(d.runH, 1)} h</dd>
            <dt>换型时长</dt><dd>${fmtNum(d.setupH, 1)} h</dd>
            <dt>占用率</dt><dd>${rateCell(d.occRate)}</dd>
            <dt>加工利用率</dt><dd>${rateCell(d.runRate)}</dd>
          </dl>
          <div class="mt">
            ${frag(hbar('占用率', d.occRate || 0, 100, p.color, v => d.occRate == null ? '不可用' : fmtPct(v)))}
            ${frag(hbar('加工利用率', d.runRate || 0, 100, p.color, v => d.runRate == null ? '不可用' : fmtPct(v)))}
          </div>
        </div></div>`;
    }).join(''))}
  </div></div>`;

  const rankingBody = loadTable({
    columns: [
      { label: '工序', width: '72px', render: r => procTag(r.process) },
      { label: '设备编号', render: r => machineCell(r) },
      { label: '占用率', num: true, width: '88px', render: r => r.occRate == null ? tag('不可用', 'gray') : html`<b>${fmtPct(r.occRate)}</b>` },
      { label: '加工 h', num: true, render: r => fmtNum(r.runH, 1) },
      { label: '换型 h', num: true, render: r => r.setupH > 0 ? fmtNum(r.setupH, 1) : html`<span class="muted2">—</span>` },
      { label: '空闲 h', num: true, render: r => fmtNum(r.idleH, 1) },
      { label: '可用 h', num: true, render: r => fmtNum(r.availH, 1) },
      { label: '操作', width: '150px', render: r => gotoBtn(r) },
    ],
    rows: L.ranking,
    rowKey: r => r.uid,
    empty: '当前窗口内没有设备记录',
  });

  const compositionBody = html`
    <div class="row" style="gap:14px;margin-bottom:10px">
      <span class="row tiny" style="gap:5px"><i style="display:inline-block;width:14px;height:9px;border-radius:2px;background:var(--p-draw)"></i>加工</span>
      <span class="row tiny" style="gap:5px"><i style="display:inline-block;width:14px;height:9px;border-radius:2px;background:var(--p-change)"></i>换型</span>
      <span class="row tiny" style="gap:5px"><i style="display:inline-block;width:14px;height:9px;border-radius:2px;background:#cbd5e1"></i>空闲</span>
      <div class="spacer"></div>
      <span class="tiny2 muted2">比例按窗口内可用时长归一；不可用机台没有可用时长，不参与构成</span>
    </div>
    <div class="stack" style="gap:9px">
      ${frag(PROCESSES.map(p => compRow(p.name + '（三工序合计）', L.byProcess[p.key])).join(''))}
      <div class="hr" style="margin:2px 0"></div>
      <div class="tiny2 muted2">按占用时长（加工 + 换型）取前 12 台设备</div>
      ${frag(L.composition.map(m => compRow(m.processName + ' ' + m.machineId, m, m.machineName)).join(''))}
    </div>`;

  const highLoadBody = hl.length
    ? html`<div style="padding:12px 14px 0">
        <div class="banner gray mb">${frag(icon('info', 16))}<div>本表为<b>警告级</b>提示，不是超载判定：负荷高不等于超载，占用冲突才是确定性阻断（PRD 8.2）。原因只列当前计划中可确证的换型、停机与适配限制；其余一律标为「原因待核实」。</div></div>
      </div>
      ${frag(loadTable({
        columns: [
          { label: '工序', width: '72px', render: r => procTag(r.process) },
          { label: '设备', render: r => machineCell(r) },
          { label: '占用率', num: true, width: '84px', render: r => html`<b>${fmtPct(r.occRate)}</b>` },
          { label: '占用 / 可用', num: true, width: '118px', render: r => fmtNum(r.occH, 1) + ' / ' + fmtNum(r.availH, 1) + ' h' },
          { label: '占用构成', width: '150px', render: r => minibar(r) },
          { label: '可确证原因', render: r => loadFacts(r).map(f => f.unknown
              ? html`<div class="tiny"><span class="muted">原因待核实</span></div><div class="tiny2 muted2">当前计划中未发现可确证的换型、停机或适配限制记录</div>`
              : html`<div class="tiny">· ${f.k}</div><div class="tiny2 muted2" style="padding-left:8px">依据：${f.src}</div>`).join('') },
          { label: '操作', width: '150px', render: r => gotoBtn(r) },
        ],
        rows: hl,
        rowKey: r => r.uid,
        maxHeight: '380px',
      }))}`
    : html`<div style="padding:6px 14px 16px">
        <div class="empty sm">${frag(icon('check', 24))}<p>当前窗口没有占用率 ≥ 90% 的机台。负荷高不等于超载，占用冲突才是确定性阻断（PRD 8.2）；本页不做超载判定。</p></div>
      </div>`;

  const unavailableBody = loadTable({
    columns: [
      { label: '工序', width: '72px', render: r => procTag(r.process) },
      { label: '设备', render: r => machineCell(r) },
      { label: '占用率', width: '84px', render: () => tag('不可用', 'gray') },
      { label: '停机时长', num: true, width: '96px', render: r => fmtNum(r.downH, 1) + ' h' },
      { label: '停机窗口（窗口内）', render: r => r.down.length
          ? frag(r.down.map(d => html`<div class="tiny">${fmtDateTime(d.from)} — ${fmtDateTime(d.to)}${d.reason ? '（' + d.reason + '）' : ''}</div>`).join(''))
          : html`<span class="muted">窗口内无停机记录</span>` },
      { label: '操作', width: '150px', render: r => gotoBtn(r) },
    ],
    rows: L.unavailable,
    rowKey: r => r.uid,
  });

  const methodBody = html`<dl class="kv tight">${frag(methodLines(ctx, L).map(x => html`<dt>${x.k}</dt><dd>${x.v}</dd>`).join(''))}</dl>`;

  host.innerHTML = pageWrap(host, ctx, [
    toolbar,
    statStrip,
    section('三工序负荷对比', processCards, { flush: true }),
    section('设备占用率排行（前 20 台）', rankingBody, { flush: true }),
    section('占用构成', compositionBody, {}),
    section('高负荷机台（占用率 ≥ 90%）', highLoadBody, { flush: true }),
    L.unavailable.length ? section('不可用设备（零可用时长）', unavailableBody, { flush: true }) : '',
  ].join(''));
}

/* main.js 对本页使用 .view.flush（padding:0、overflow:hidden），内容需要自带滚动容器；
   非 flush 时由 .view 负责滚动与内边距，不再叠加 */
function pageWrap(host, ctx, inner) {
  const flush = ctx?.flush === true || !!(host && host.classList && host.classList.contains('flush'));
  return html`<div${flush ? raw(' style="flex:1;min-height:0;overflow:auto;padding:16px 20px 28px"') : ''}>${frag(inner)}</div>`;
}

/* ---------------- 事件动作 ---------------- */
function ctxOf(ctx) { return ctx && ctx.store ? ctx : lastCtx; }
function refresh(C) { if (typeof C?.rerender === 'function') C.rerender(); else if (lastHost && C) renderLoad(lastHost, C); }

function copyText(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
  return new Promise((resolve, reject) => {
    try {
      const ta = document.createElement('textarea');
      ta.value = text; ta.setAttribute('readonly', '');
      ta.style.position = 'fixed'; ta.style.left = '-9999px';
      document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      if (ok) resolve(); else reject(new Error('浏览器未允许复制'));
    } catch (err) { reject(err); }
  });
}

export const LOAD_ACTIONS = {
  /** 定位到工作台：写入 ui.selection.machineId 与 ui.workbench.process，由工作台决定如何高亮 */
  gotoWorkbench(ctx, el, ds) {
    const C = ctxOf(ctx);
    const machineId = ds?.machine || null, process = ds?.process || null;
    const store = C?.store;
    if (store?.setUI) {
      const ui = store.state?.ui || {};
      store.setUI({
        route: 'workbench',
        selection: Object.assign({}, ui.selection || {}, machineId ? { machineId } : {}),
        workbench: Object.assign({}, ui.workbench || {}, process ? { process } : {}),
      });
      store.toast?.('已跳转工作台：' + (process ? (PROC[process]?.name || process) : '设备负荷') + (machineId ? ' 设备 ' + machineId : '') + '；若未自动定位，请在设备视角按该编号查找', 'ok');
    } else {
      refresh(C);
    }
  },
  windowChange(ctx, el, ds) {
    const C = ctxOf(ctx);
    const key = ds?.win;
    if (!WIN_MAP[key]) { C?.store?.toast?.('未知的时间窗口：' + key, 'warn'); return; }
    winKey = key;
    refresh(C);
  },
  exportLoad(ctx) {
    const C = ctxOf(ctx);
    if (typeof C?.exportLoadReport !== 'function') {
      C?.store?.toast?.('导出功能尚未接入（main.js 未注入 exportLoadReport），暂不能导出负荷分析报告', 'warn');
      return;
    }
    try { C.exportLoadReport(); }
    catch (err) { C?.store?.toast?.('导出失败：' + ((err && err.message) || '未知错误') + '，可重试', 'err'); }
  },
  copyMethod(ctx) {
    const C = ctxOf(ctx);
    if (!C) return;
    copyText(loadMethodText(C)).then(
      () => C.store?.toast?.('已复制口径说明（含数据来源与计算范围），可粘贴到分析报告或评审材料', 'ok'),
      () => C.store?.toast?.('复制失败：浏览器未允许访问剪贴板，可在页面底部「口径与数据边界」手动选择复制', 'err'));
  },
};
