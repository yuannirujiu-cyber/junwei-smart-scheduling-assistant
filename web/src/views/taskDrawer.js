/* D04 工序详情抽屉：安排 / 依据 / 变更记录 + 人工锁定与调整 */
import { html, raw, icon, qs, qsa, el } from '../core/dom.js';
import { openDrawer, tag, procTag, dueTag, lockTag, ruleTags, evidenceBlock, chainView } from '../components/ui.js';
import { explainTask } from '../engine/explain.js';
import { changeoverBetween, changeoverFromInitial } from '../engine/spec.js';
import { durationMin } from '../engine/model.js';
import { PROCESSES, PROC_MAP } from '../engine/rules.js';
import { fmtDateTime, fmtDur, fmtDate, fmtNum, escapeHtml as escapeText, round, HOUR, diffHours, deepClone } from '../core/util.js';

export function openTaskDrawer(ctx, taskId) {
  const { version, cap, settings, snapshot } = ctx;
  const t = version.tasks.find(x => x.id === taskId);
  if (!t) { ctx.toast('未找到该任务', 'err'); return; }
  const order = (version.model.active || []).find(o => o.id === t.orderId) || snapshot.orders.find(o => o.id === t.orderId);
  const ex = explainTask(t, { cap, version, settings, model: version.model });

  const drawer = openDrawer({
    title: PROC_MAP[t.process].name + ' · ' + t.orderId,
    sub: '设备 ' + t.machineId + (t.machineName ? '（' + t.machineName + '）' : '') + ' · ' + fmtDateTime(t.start) + ' → ' + fmtDateTime(t.end),
    wide: true,
    tabs: [
      { key: 'plan', label: '安排' },
      { key: 'why', label: '依据' },
      { key: 'log', label: '变更记录' },
    ],
    body: renderTab(ctx, t, order, ex, 'plan'),
    footer: html`
      <button class="btn" data-act="tab" data-tab="plan">安排</button>
      <button class="btn" data-act="tab" data-tab="why">依据</button>
      <span class="spacer"></span>
      ${t.frozen ? tag('执行冻结（已开工/完工）', 'violet', 'pause')
        : html`<button class="btn" data-act="freeze" data-id="${t.id}" title="已开工/完工的工序不可自动移动，需人工确认">标记执行冻结</button>`}
      ${t.frozen ? '' : (t.locked
        ? html`<button class="btn danger" data-act="unlock" data-id="${t.id}">${raw(icon('unlock', 14))}解除锁定</button>`
        : html`<button class="btn" data-act="lock" data-id="${t.id}">${raw(icon('lock', 14))}锁定该任务</button>`)}
      <button class="btn primary" data-act="openAdjust" data-id="${t.id}">${raw(icon('wrench', 14))}人工调整</button>`,
    onMount(box) {
      box.querySelectorAll('.drawer-tabs button').forEach(b => b.addEventListener('click', () => switchTab(box, ctx, t, order, ex, b.dataset.tab)));
      box.querySelectorAll('.drawer-f [data-act="tab"]').forEach(b => b.addEventListener('click', () => switchTab(box, ctx, t, order, ex, b.dataset.tab)));
      bindAdjust(box, ctx, t, order, ex);
      bindLock(box, ctx, t, order, ex);
    },
  });
  return drawer;
}

function switchTab(box, ctx, t, order, ex, key) {
  /* 页签状态同步：class 只影响视觉，aria-selected / 漫游 tabindex / tabpanel 归属才决定读屏与键盘行为 */
  box.querySelectorAll('.drawer-tabs button').forEach(b => {
    const on = b.dataset.tab === key;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
    b.tabIndex = on ? 0 : -1;
  });
  const body = box.querySelector('.drawer-b');
  if (body && body.getAttribute('role') === 'tabpanel') body.setAttribute('aria-labelledby', 'jw-tab-' + key);
  body.innerHTML = renderTab(ctx, t, order, ex, key);
  bindAdjust(box, ctx, t, order, ex);
  bindLock(box, ctx, t, order, ex);
}

function renderTab(ctx, t, order, ex, key) {
  if (key === 'plan') return tabPlan(ctx, t, order, ex);
  if (key === 'why') return tabWhy(ctx, t, ex);
  return tabLog(ctx, t);
}

/* ---------------- 安排 ---------------- */
function tabPlan(ctx, t, order, ex) {
  const rows = [
    ['订单', t.orderId + (order?.productName ? ' · ' + order.productName : '')],
    ['规格', order?.spec || '—'],
    ['工序', PROC_MAP[t.process].name],
    ['机台 / 型号', '<b>' + t.machineId + '</b>' + (t.machineName ? ' · ' + t.machineName : '')],
    ['开始 / 结束', fmtDateTime(t.start) + ' → ' + fmtDateTime(t.end)],
  ];
  if (t.reserveReason) rows.push(['设备预约', '<b>本任务是被预约的</b>：' + escapeText(t.reserveReason)]);
  if (Array.isArray(t.riskTags) && t.riskTags.length) rows.push(['风险标签', t.riskTags.map(escapeText).join('；')]);
  const waits = [];
  const list = ctx.version.tasks.filter(x => x.orderId === t.orderId && x.scheduled);
  const a = list.find(x => x.process === 'drawing'), b = list.find(x => x.process === 'stranding'), c = list.find(x => x.process === 'closing');
  if (a && b) waits.push(['拉丝 → 捻股', round((b.start - a.end) / HOUR, 1) + ' 小时' + ((b.start - a.end) / HOUR > 72 ? '（超 72 小时上限）' : '')]);
  if (b && c) waits.push(['捻股 → 合绳', round((c.start - b.end) / HOUR, 1) + ' 小时' + ((c.start - b.end) / HOUR > 72 ? '（超 72 小时上限）' : '')]);
  return html`
    ${order ? html`<div class="mb">${raw(chainView(order, list))}</div>` : ''}
    <dl class="kv">${raw(rows.map(r => html`<dt>${r[0]}</dt><dd>${raw(r[1])}</dd>`).join(''))}</dl>
    ${waits.length ? html`<div class="hr"></div><dl class="kv">${raw(waits.map(r => html`<dt>${r[0]} 等待</dt><dd>${r[1]}</dd>`).join(''))}</dl>` : ''}
    ${order?.due ? html`<div class="hr"></div><dl class="kv">
      <dt>承诺交期</dt><dd>${fmtDate(order.due)} ${dueTag(order.duePolicy, order.graceHours)}</dd>
      <dt>允许最晚完工</dt><dd>${fmtDate(order.allowLatest)}</dd>
      <dt>预计合绳完工</dt><dd>${c ? fmtDateTime(c.end) : '尚未完整排产'}</dd>
    </dl>` : ''}
    ${raw(adjustForm(ctx, t))}
    ${ex.caveats.length ? html`<div class="banner warn mt">${raw(icon('info', 15))}<div>${raw(ex.caveats.join(' '))}</div></div>` : ''}`;
}

/* ---------------- 依据 ---------------- */
function tabWhy(ctx, t, ex) {
  return html`
    <div class="evidence" style="border-left-color:var(--brand);margin-bottom:12px">
      <div class="t">结论</div><div>${ex.conclusion}</div>
      <div class="tiny muted2" style="margin-top:5px">命中规则 ${ruleTags(ex.rules)}</div>
    </div>
    <h4 class="mb" style="font-size:12.5px;color:var(--ink-3)">具体约束</h4>
    ${raw(ex.constraints.map(c => html`<div class="tiny" style="margin-bottom:6px;display:flex;gap:7px">
      <span>${ruleTags([c.rule])}</span><span class="muted">${c.text}</span></div>`).join(''))}
    <h4 class="mb mt" style="font-size:12.5px;color:var(--ink-3)">证据</h4>
    ${raw(evidenceBlock(ex.evidence))}
    <div class="banner gray mt">${raw(icon('info', 15))}
      <div>解释由结构化计算结果驱动；无证据的原因显示为「需要核实」，不做「最优」「唯一可行」等无依据断言。</div></div>`;
}

/* ---------------- 变更记录 ---------------- */
function tabLog(ctx, t) {
  const list = ctx.version.changes.filter(c => c.taskId === t.id);
  const all = ctx.version.changes.slice(0, 30);
  return html`
    <h4 style="font-size:12.5px;color:var(--ink-3)" class="mb">该任务</h4>
    ${list.length ? html`<div class="timeline">${raw(list.map(c => html`
      <div class="tl-item on"><div class="th">${c.note}<span class="tiny muted2">${c.at} · ${c.by}</span></div>
      <div class="tb">${c.before && c.after ? html`${fmtDateTime(c.before.start)} / 设备 ${c.before.machineId} → ${fmtDateTime(c.after.start)} / 设备 ${c.after.machineId}` : ''}</div></div>`).join(''))}</div>`
      : html`<div class="muted tiny">该任务暂无人工变更记录，当前为系统自动生成结果。</div>`}
    <div class="hr"></div>
    <h4 style="font-size:12.5px;color:var(--ink-3)" class="mb">版本内最近变更（${ctx.version.changes.length} 条）</h4>
    ${all.length ? html`<div class="timeline">${raw(all.map(c => html`
      <div class="tl-item"><div class="th">${c.note}<span class="tiny muted2">${c.at} · ${c.by}</span></div>
      ${c.orderId ? html`<div class="tb">${c.orderId} · ${(PROC_MAP[c.process] || {}).name || ''}</div>` : ''}</div>`).join(''))}</div>`
      : html`<div class="muted tiny">版本内暂无变更记录。</div>`}`;
}

/* ---------------- 人工调整表单 ---------------- */
function bindAdjust(box, ctx, t, order, ex) {
  const body = box.querySelector('.drawer-b');
  const form = qs('#adjustForm', body);
  if (!form) return;
  const { cap } = ctx;
  const specCtx = t.process === 'drawing'
    ? { wireSpecMm: t.spec?.wireSpec, outSpec: t.spec?.outSpec }
    : { row: t.jobRef?.row, structure: t.spec?.structure, diameter: t.spec?.diameter };
  const capable = cap.capableMachines(t.process, specCtx);

  const machineSel = qs('[data-f="machineId"]', form);
  const startInput = qs('[data-f="start"]', form);
  const preview = qs('#adjustPreview', form);
  const errBox = qs('#adjustErrors', form);
  const saveBtn = box.querySelector('[data-act="saveAdjust"]');

  const compute = () => {
    const mid = machineSel.value;
    const m = capable.find(c => c.machine.id === mid) || capable[0];
    const startMs = new Date(startInput.value).getTime();
    // 先判空再算工时：否则「该规格没有可用机台」的提示会被 TypeError 取代（审查报告 P1-6 附注）
    const dur = m ? durationMin(t.qty, m.rate) : null;
    const endMs = dur == null ? startMs : startMs + dur * 60000;
    const prevTask = ctx.version.tasks.find(x => x.orderId === t.orderId && x.scheduled &&
      x.process === (t.process === 'stranding' ? 'drawing' : t.process === 'closing' ? 'stranding' : null));
    const nextTask = ctx.version.tasks.find(x => x.orderId === t.orderId && x.scheduled &&
      x.process === (t.process === 'drawing' ? 'stranding' : t.process === 'stranding' ? 'closing' : null));
    const set = changeoverBetween(t.process, lastSpecBefore(ctx, t, mid, startMs), t.spec, ctx.settings.changeoverModel);
    const errs = [], warns = [];
    if (!m) errs.push('该规格没有可用机台');
    if (isNaN(startMs)) errs.push('开始时间无效');
    if (dur == null) errs.push('无法计算加工时长（数量或产能缺失），不允许保存');
    if (prevTask && startMs < prevTask.end) errs.push('开始时间早于前序工序完工时间（' + fmtDateTime(prevTask.end) + '），会违反工序先后约束');
    if (prevTask) {
      const w = (startMs - prevTask.end) / HOUR;
      if (w > 72) errs.push('与前序工序等待 ' + round(w, 1) + ' 小时，超过 R6 的 72 小时上限');
    }
    if (nextTask && endMs > nextTask.start) errs.push('完工时间晚于后序工序开工时间（' + fmtDateTime(nextTask.start) + '）');
    const clash = findOverlap(ctx, t, mid, startMs - set.hours * HOUR, endMs);
    if (clash) errs.push('与设备 ' + mid + ' 上已有占用重叠：' + clash.orderId + ' ' + PROC_MAP[clash.process].name + ' ' + fmtDateTime(clash.start) + ' → ' + fmtDateTime(clash.end));
    const down = downtimeClash(ctx, mid, startMs - set.hours * HOUR, endMs);
    if (down) errs.push('与设备停机窗口重叠：' + fmtDateTime(down.from) + ' → ' + fmtDateTime(down.to) + (down.reason ? '（' + down.reason + '）' : ''));
    if (order?.due && endMs > order.due.getTime() && t.process === 'closing') {
      const late = (endMs - order.due.getTime()) / HOUR;
      if (order.duePolicy === 'hard') errs.push('硬交期订单将延期 ' + round(late, 1) + ' 小时（R8 不允许）');
      else if (order.duePolicy === 'soft' && late > (order.graceHours || 72)) errs.push('延期 ' + round(late, 1) + ' 小时，超过软交期宽限上限');
      else warns.push('将延期 ' + round(late, 1) + ' 小时' + (order.duePolicy === 'soft' ? '（宽限内，记为延期）' : ''));
    }
    if (set.hours > 0) warns.push('需换型 ' + fmtDur(set.hours) + '：' + set.reasons.join('；'));
    preview.innerHTML = html`<dl class="kv tight">
      <dt>机台</dt><dd>${mid}${m ? ' · ' + m.rate + ' 米/分' : ''}</dd>
      <dt>换型</dt><dd>${set.hours > 0 ? fmtDur(set.hours) + '（' + set.tier + '）' : '无'}</dd>
      <dt>加工</dt><dd>${fmtDateTime(startMs)} → ${fmtDateTime(endMs)}（${dur} 分钟）</dd>
      <dt>完工变化</dt><dd>${(endMs - t.end) === 0 ? '不变' : ((endMs - t.end) > 0 ? '推迟 ' : '提前 ') + fmtDur(Math.abs(endMs - t.end) / HOUR)}</dd>
    </dl>`;
    errBox.innerHTML = errs.length
      ? html`<div class="banner block">${raw(icon('alert', 15))}<div>${raw(errs.map(e => '· ' + e).join('<br>'))}</div></div>`
      : (warns.length ? html`<div class="banner warn">${raw(icon('info', 15))}<div>${raw(warns.map(e => '· ' + e).join('<br>'))}</div></div>`
        : html`<div class="banner ok">${raw(icon('check', 15))}<div>局部校验通过：适配、占用、工序链与交期均无冲突。</div></div>`);
    saveBtn.disabled = errs.length > 0;
    saveBtn.dataset.pending = JSON.stringify({ machineId: mid, start: startMs, end: endMs, setupHours: set.hours, setupReasons: set.reasons, setupTier: set.tier, setupStart: set.hours > 0 ? startMs - set.hours * HOUR : null, rate: m?.rate, durationMin: dur });
    return !errs.length;
  };

  machineSel.addEventListener('change', compute);
  startInput.addEventListener('input', compute);
  qs('[data-act="cancelAdjust"]', box)?.addEventListener('click', () => { qs('#adjustWrap', body).style.display = 'none'; });
  compute();
}

function lastSpecBefore(ctx, t, machineId, startMs) {
  const list = ctx.version.tasks.filter(x => x.scheduled && x.machineId === machineId && x.process === t.process && x.id !== t.id && x.start < startMs)
    .sort((a, b) => b.start - a.start);
  return list[0]?.spec || null;
}
function findOverlap(ctx, t, machineId, from, to) {
  for (const x of ctx.version.tasks) {
    if (!x.scheduled || x.id === t.id || x.machineId !== machineId) continue;
    const xs = x.setupHours > 0 ? x.start - x.setupHours * HOUR : x.start;
    if (xs < to && x.end > from) return x;
  }
  return null;
}
function downtimeClash(ctx, machineId, from, to) {
  for (const d of (ctx.settings.downtime || [])) {
    if (String(d.machineId) !== String(machineId)) continue;
    const s = new Date(d.from).getTime(), e = new Date(d.to).getTime();
    if (s < to && e > from) return d;
  }
  return null;
}

function bindLock(box, ctx, t, order, ex) {
  box.querySelectorAll('[data-act="lock"]').forEach(b => b.addEventListener('click', () => {
    ctx.store.toggleLock(t.id, true);
    box.querySelector('.close')?.click();
    setTimeout(() => openTaskDrawer(ctx, t.id), 260);
  }));
  box.querySelectorAll('[data-act="unlock"]').forEach(b => b.addEventListener('click', () => {
    ctx.store.toggleLock(t.id, false);
    box.querySelector('.close')?.click();
    setTimeout(() => openTaskDrawer(ctx, t.id), 260);
  }));
  box.querySelectorAll('[data-act="openAdjust"]').forEach(b => b.addEventListener('click', () => {
    const w = qs('#adjustWrap', box.querySelector('.drawer-b'));
    if (w) { w.style.display = ''; w.scrollIntoView({ block: 'nearest' }); }
  }));
  box.querySelectorAll('[data-act="saveAdjust"]').forEach(b => b.addEventListener('click', () => {
    const p = JSON.parse(b.dataset.pending || '{}');
    ctx.store.updateTask(t.id, p, '人工调整机台/开始时间');
    ctx.store.toast('已保存调整，标记为「待重算」；全局校验通过后才能确认版本', 'ok');
    box.querySelector('.close')?.click();
    ctx.rerender();
  }));
  box.querySelectorAll('[data-act="freeze"]').forEach(b => b.addEventListener('click', () => {
    ctx.store.setFrozen(t.id, true); ctx.rerender();
  }));
  box.querySelectorAll('[data-act="undo"]').forEach(b => b.addEventListener('click', () => {
    ctx.store.undoLast(); ctx.rerender();
  }));
}


function dtLocal(ms) {
  const d = new Date(ms); const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function adjustForm(ctx, t) {
  const cap = ctx.cap;
  const specCtx = t.process === 'drawing'
    ? { wireSpecMm: t.spec?.wireSpec, outSpec: t.spec?.outSpec }
    : { row: t.jobRef?.row, structure: t.spec?.structure, diameter: t.spec?.diameter };
  const capable = cap.capableMachines(t.process, specCtx);
  return html`<div id="adjustWrap" style="display:none" class="mt">
    <div class="hr"></div>
    <h4 style="font-size:12.5px;margin-bottom:8px">人工调整（完整锁定语义：锁定机台与起止时间）</h4>
    <div id="adjustForm">
      <div class="field mb"><label>设备（仅列出适配机台，R1）</label>
        <select data-f="machineId" aria-label="设备（仅列出适配机台）">${raw(capable.map(c => html`<option value="${c.machine.id}"${c.machine.id === t.machineId ? ' selected' : ''}>${c.machine.id}${c.machine.name ? ' · ' + c.machine.name : ''} · ${c.rate} 米/分</option>`).join(''))}</select>
        <div class="hint">共 ${capable.length} 台适配设备；不适配设备不会出现在这里（矩阵空值 = 不适配）。</div></div>
      <div class="field mb"><label>开始时间</label>
        <input type="datetime-local" data-f="start" aria-label="开始时间" value="${dtLocal(t.start)}" />
        <div class="hint">结束时间由「数量 ÷ 单位产出」自动重算，不允许随意缩短加工时间。</div></div>
      <div id="adjustPreview" class="mb"></div>
      <div id="adjustErrors" class="mb"></div>
      <div class="btn-row"><button class="btn primary" data-act="saveAdjust" disabled>保存修改</button>
        <button class="btn" data-act="cancelAdjust">取消本次修改</button>
        <button class="btn ghost" data-act="undo">撤销最近修改</button></div>
    </div>
  </div>`;
}

export const TASK_ACTIONS = {};
