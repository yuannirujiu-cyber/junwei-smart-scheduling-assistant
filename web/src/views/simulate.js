/* D06 异常模拟与方案对比（P1）：插单 / 设备故障 / 物料延迟 */
import { html, raw, icon, qs } from '../core/dom.js';
import { dataTable, tag, section, emptyState, openModal, dueTag } from '../components/ui.js';
import { fmtDateTime, fmtDate, fmtNum, fmtDur, round, toDate, addHours } from '../core/util.js';
import { PROC_MAP } from '../engine/rules.js';

export function renderSimulate(host, ctx) {
  const { version, snapshot, cap, settings } = ctx;
  host.className = 'view';
  if (!version) {
    host.innerHTML = emptyState({ icon: 'bolt', title: '还没有可模拟的基线版本',
      desc: '先完成一次排产，再基于当前版本录入插单、设备故障或物料延迟，系统会保留原计划并生成候选方案。',
      actions: [{ label: '去工作台生成计划', act: 'gotoWorkbench', cls: 'primary', icon: 'play' }] });
    return;
  }
  const sim = ctx.state.simulation;
  const base = ctx.store.baselineVersion || version;
  const presets = snapshot.simulationPresets || null;
  /* 类型以 ui.simType 为准：跑过一次模拟后 state.simulation.type 会一直停留在上次的类型,
     导致点「设备故障」「物料延迟」既不换表单也不换求解类型（审查报告 P1-2）。 */
  const type = ctx.ui.simType || sim?.type || 'rush';

  host.innerHTML = html`
    <div class="grid g3 mb">
      ${raw([['rush', '紧急插单', 'bolt', '新订单要求插队优先生产（R10：约每周 5 次）'],
         ['breakdown', '设备故障', 'wrench', '某台设备故障停机一段时间'],
         ['material', '物料延迟', 'clock', '外协/原材料未按期到货']]
        .map(t => html`<div class="card" style="cursor:pointer;${type === t[0] ? 'border-color:var(--brand);box-shadow:0 0 0 1px var(--brand)' : ''}" data-act="simType" data-v="${t[0]}">
          <div class="card-b">
            <div class="row"><span style="color:var(--brand)">${raw(icon(t[2], 18))}</span><b>${t[1]}</b>
              ${type === t[0] ? tag('已选择', 'blue', 'check') : ''}</div>
            <div class="tiny muted mt">${t[3]}</div>
          </div></div>`).join(''))}
    </div>

    <div class="split">
      <div class="stack">
        ${ctx.ui.simError?.length ? html`<div class="banner block mb">${raw(icon('alert', 16))}<div><b>无法生成候选方案：</b>${ctx.ui.simError.join('；')}</div></div>` : ''}
        ${raw(section('第一步 · 录入扰动的必填字段', formFor(type, ctx, presets), { sub: '校验规则与 D01 一致：复用规格 / 工时 / 适配校验' }))}
        ${sim?.status === 'done' ? raw(section('第三步 · 候选方案对比', compareBlock(ctx, base, sim), { sub: '展示实际求得的候选方案；没有方案时展示冲突，不为对比伪造候选' })) : ''}
        ${sim?.status === 'done' ? raw(section('逐单影响', impactTable(ctx, base, sim))) : ''}
      </div>
      <div class="stack">
        ${raw(section('第二步 · 受影响范围与冻结任务', impactScope(ctx, type, presets), { sub: '求解前先确认会影响谁' }))}
        ${raw(section('操作', html`
          <button class="btn primary lg" style="width:100%" data-act="runSim" ${ctx.state.solving.status === 'running' ? 'disabled' : ''}>
            ${raw(icon('play', 15))}${ctx.state.solving.status === 'running' ? '正在生成候选方案…' : '生成候选方案'}</button>
          <div class="row mt">
            <button class="btn" data-act="cancelSim" style="flex:1">取消模拟</button>
            <button class="btn" data-act="resetSim" style="flex:1">清空录入</button>
          </div>
          <div class="tiny muted2 mt">采用方案会创建待确认版本；取消模拟保留基线。系统不会自动修改客户承诺、取消执行冻结或放宽硬约束。</div>`))}
      </div>
    </div>`;

  bindSimForm(ctx, host, type, presets);
}

function formFor(type, ctx, presets) {
  const { cap, snapshot } = ctx;
  const held = ctx.__simForm || {};
  if (type === 'rush') {
    const p = presets?.rushOrder || {};
    return html`<div class="grid g2">
      <div class="field"><label>订单号 *</label><input type="text" data-f="r-orderNo" aria-label="订单号（必填）" value="${p.id || 'DEMO-RUSH-0001'}" /></div>
      <div class="field"><label>规格 *</label><input type="text" data-f="r-spec" aria-label="规格（必填）" value="${p.spec || ''}" placeholder="例如 12mm GT6Z(6*K29FI+IWRC)" /></div>
      <div class="field"><label>数量 *</label><input type="number" data-f="r-qty" aria-label="数量（必填）" value="${p.qtyMeters || 2000}" /></div>
      <div class="field"><label>单位</label><input type="text" data-f="r-unit" aria-label="数量单位" value="${p.qtyMetersUnit || '米'}" /></div>
      <div class="field"><label>预发货日 *</label><input type="date" data-f="r-due" aria-label="预发货日（必填）" value="${p.preShipDate || ''}" /></div>
      <div class="field"><label>优先级</label><select data-f="r-priority" aria-label="优先级">
        ${raw(['重点客户', '重点订单', '普通'].map(x => html`<option value="${x}"${(p.priority || '重点订单') === x ? ' selected' : ''}>${x}</option>`).join(''))}</select></div>
      <div class="field"><label>交期政策 *</label><select data-f="r-policy" aria-label="交期政策（必填）">
        <option value="hard"${p.duePolicy === 'hard' ? ' selected' : ''}>硬交期（不允许延期）</option>
        <option value="soft"${p.duePolicy === 'soft' ? ' selected' : ''}>软交期（宽限 ≤72h）</option>
        <option value="unknown"${!p.duePolicy || p.duePolicy === 'unknown' ? ' selected' : ''}>待确认（不默认宽限）</option>
      </select></div>
      <div class="field"><label>物料就绪时间</label><input type="datetime-local" data-f="r-ready" aria-label="物料就绪时间" value="${p.preArrivalDate ? p.preArrivalDate + 'T08:00' : ''}" />
        <div class="hint">留空表示计划起点即可开工。</div></div>
    </div>`;
  }
  if (type === 'breakdown') {
    const b = presets?.breakdown || {};
    const planStart = ctx.version?.settings?.planStart || ctx.settings?.planStart || null;
    const from = held['b-from'] || b.from || datetimeLocal(planStart);
    const to = held['b-to'] || b.to || datetimeLocal(planStart ? addHours(planStart, 8) : null);
    return html`<div class="grid g2">
      <div class="field"><label>设备编号 *</label><select data-f="b-machine" aria-label="故障设备编号（必填）">
        ${raw(['stranding', 'closing', 'drawing'].map(p => html`<optgroup label="${PROC_MAP[p].name}">
          ${raw(cap.machines[p].map(m => html`<option value="${p}:${m.id}"${String(b.machineId) === String(m.id) ? ' selected' : ''}>${m.id}${m.name ? ' · ' + m.name : ''}</option>`).join(''))}
        </optgroup>`).join(''))}
      </select></div>
      <div class="field"><label>异常备注</label><input type="text" data-f="b-reason" aria-label="异常备注" value="${held['b-reason'] || b.reason || '设备故障停机'}" /></div>
      <div class="field"><label>不可用开始 *</label><input type="datetime-local" data-f="b-from" aria-label="不可用开始时间（必填）" value="${datetimeLocal(from)}" /></div>
      <div class="field"><label>不可用结束 *</label><input type="datetime-local" data-f="b-to" aria-label="不可用结束时间（必填）" value="${datetimeLocal(to)}" />
        <div class="hint">结束必须晚于开始；若覆盖在制任务，需先处理中断与剩余工时。</div></div>
    </div>`;
  }
  const p = presets?.materialDelay || {};
  const active = (version_of(ctx)?.model.active || []).slice(0, 200);
  return html`<div class="grid g2">
    <div class="field"><label>受影响订单 *</label><select data-f="m-order" aria-label="受影响的订单（必填）">
      ${raw(active.map(o => html`<option value="${o.id}"${p.orderId === o.id ? ' selected' : ''}>${o.id} · ${o.spec || ''}</option>`).join(''))}
    </select></div>
    <div class="field"><label>适用检验时间（小时）</label><input type="number" data-f="m-inspect" aria-label="适用检验时间（小时）" value="${p.inspectionHours || 2}" />
      <div class="hint">到货检测约 2 小时来自赛题手册，但不无条件加给所有订单。</div></div>
    <div class="field"><label>原就绪时间</label><input type="datetime-local" data-f="m-old" aria-label="原就绪时间" value="${(p.oldReadyAt || '').slice(0, 16)}" /></div>
    <div class="field"><label>新就绪时间 *</label><input type="datetime-local" data-f="m-new" aria-label="新就绪时间（必填）" value="${(p.newReadyAt || '').slice(0, 16)}" /></div>
  </div>`;
}
function version_of(ctx) { return ctx.version; }

function impactScope(ctx, type, presets) {
  const { version } = ctx;
  const replan = ctx.state.simulation;
  const frozen = version.tasks.filter(t => t.frozen);
  const locked = version.tasks.filter(t => t.locked && !t.frozen);
  const notStarted = version.tasks.filter(t => t.scheduled && !t.frozen && !t.locked && t.start > Date.now());
  return html`<dl class="kv tight mb">
    <dt>基线版本</dt><dd class="mono">${(ctx.store.baselineVersion || version).id}</dd>
    <dt>已排工序</dt><dd>${version.tasks.filter(t => t.scheduled).length} 条</dd>
    <dt>可自动调整</dt><dd>${notStarted.length} 条（未开工且未锁定）</dd>
    <dt>人工锁定</dt><dd>${locked.length} 条（重算保持不变）</dd>
    <dt>执行冻结</dt><dd>${frozen.length} 条（已开工/完工，不可自动移动）</dd>
    ${replan?.status === 'done' ? html`<dt>直接受影响</dt><dd>${replan.affectedTaskIds?.length || 0} 条</dd>
      <dt>最终释放调整</dt><dd>${replan.releasedTaskIds?.length || 0} 条</dd>
      <dt>渐进扩散轮次</dt><dd>${replan.expansionRounds?.length || 0} 轮</dd>` : ''}
  </dl>
  ${replan?.status === 'done' && replan.expansionRounds?.length ? html`<details class="tiny muted"><summary>查看影响范围扩展记录</summary><div class="mt stack" style="gap:4px">${raw(replan.expansionRounds.map(x => html`<div>第 ${x.index} 轮：${x.reason}（释放 ${x.taskIds.length} 条）</div>`).join(''))}</div></details>` : ''}`;
}

function compareBlock(ctx, base, sim) {
  const cands = sim.candidateIds.map(id => ctx.state.versions.find(v => v.id === id)).filter(Boolean);
  if (!cands.length) return html`<div class="banner block">${raw(icon('alert', 15))}<div>当前条件下未求得候选方案，请调整扰动参数或先处理阻断问题。基线版本已保留。</div></div>`;
  return html`<div class="cmp">${raw(cands.map((v, i) => card(ctx, base, v, i === cands.length - 1)).join(''))}</div>`;
}

function card(ctx, base, v, isLast) {
  const d = v.metrics.delta || {};
  const rows = [
    ['预测准时交付率', (v.metrics.deliveryRate ?? '—') + '%', delta(base.metrics.deliveryRate, v.metrics.deliveryRate, '%')],
    ['延期订单数', v.metrics.lateOrders + ' 单', delta(base.metrics.lateOrders, v.metrics.lateOrders, '', true)],
    ['新增延期', (d.newLate ?? 0) + ' 单', ''],
    ['恢复准时', (d.recovered ?? 0) + ' 单', ''],
    ['硬交期冲突', v.metrics.hardRiskCount + ' 单', delta(base.metrics.hardRiskCount, v.metrics.hardRiskCount, '', true)],
    ['变化原订单数', (d.changedOrders ?? 0) + ' 单', ''],
    ['变化工序数', (d.changedTasks ?? 0) + ' 条', ''],
    ['累计开始时间偏移', (d.shiftH ?? 0) + ' 小时', ''],
    ['换型总时长', v.metrics.totalSetupHours + ' 小时', ''],
    ['新增订单', (d.newOrders ?? 0) + ' 单', ''],
    ['未受影响工序保持不变', (v.replan?.unchangedTaskCount ?? '—') + ' 条', ''],
    ['设备变更', (v.replan?.movedMachineCount ?? 0) + ' 条', ''],
    ['最终调整范围', (v.replan?.releasedTaskIds?.length ?? '—') + ' 条', ''],
  ];
  return html`<div class="cmp-card${isLast ? ' on' : ''}">
    <div class="h"><b>${v.id} · ${v.name}</b>
      <span>基线 ${d.baselineId || base.id} · 共同原订单 ${d.commonOrders ?? '—'} 单
      ${d.newOrders ? '（另有 ' + d.newOrders + ' 张新增订单，单独列示）' : ''}</span></div>
    <div class="b"><table class="tbl"><tbody>
      ${raw(rows.map(r => html`<tr><td class="tiny muted" style="padding:4px 6px">${r[0]}</td>
        <td class="tiny num" style="padding:4px 6px;font-weight:600">${r[1]}</td>
        <td class="tiny num" style="padding:4px 6px">${raw(r[2])}</td></tr>`).join(''))}
    </tbody></table></div>
    <div class="f"><span class="tiny muted">${v.validation.counts.block ? '存在 ' + v.validation.counts.block + ' 项阻断' : '无阻断'}</span>
      <span class="spacer"></span>
      <button class="btn sm primary" data-act="adopt" data-id="${v.id}" ${v.validation.counts.block ? 'disabled' : ''}>采用此方案</button></div>
  </div>`;
}
function delta(a, b, unit, lowerBetter) {
  if (a == null || b == null) return '';
  const d = round(b - a, 1);
  if (Math.abs(d) < 0.05) return html`<span class="delta flat">持平</span>`;
  const good = lowerBetter ? d < 0 : d > 0;
  return html`<span class="delta ${good ? 'up' : 'down'}">${d > 0 ? '+' : ''}${d}${unit}</span>`;
}

function impactTable(ctx, base, sim) {
  const v = ctx.state.versions.find(x => x.id === sim.candidateIds[sim.candidateIds.length - 1]);
  if (!v) return html`<div class="muted tiny">暂无候选方案。</div>`;
  const bFinish = new Map(), bStart = new Map(), candidateTasks = new Map();
  for (const t of base.tasks) { if (!t.scheduled) continue; bStart.set(t.id, t.start); if (t.process === 'closing') bFinish.set(t.orderId, t.end); }
  const nFinish = new Map(), nStart = new Map();
  for (const t of v.tasks) { if (!t.scheduled) continue; nStart.set(t.id, t.start); if (!candidateTasks.has(t.orderId)) candidateTasks.set(t.orderId, []); candidateTasks.get(t.orderId).push(t); if (t.process === 'closing') nFinish.set(t.orderId, t.end); }
  const taskChanges = v.replan?.changedTasks || [];
  const changesByOrder = new Map();
  taskChanges.forEach(change => changesByOrder.set(change.orderId, [...(changesByOrder.get(change.orderId) || []), change]));
  const baselineOrders = new Set((base.model.active || []).map(order => order.id));
  const rows = [];
  for (const [oid, bf] of bFinish) {
    const nf = nFinish.get(oid); if (nf == null) continue;
    const o = (v.model.active || []).find(x => x.id === oid) || {};
    const changes = changesByOrder.get(oid) || [];
    const chg = changes.length > 0 || bStart.get('T:' + oid + ':closing') !== nStart.get('T:' + oid + ':closing');
    if (Math.abs(nf - bf) < 60000 && !chg) continue;
    const shiftH = changes.reduce((sum, change) => sum + Math.abs(change.after.start - change.before.start) / 3600000, 0);
    rows.push({ oid, bf, nf, o, chg, kind: 'existing', changes, shiftH, tasks: candidateTasks.get(oid) || [] });
  }
  for (const order of (v.model.active || [])) {
    if (baselineOrders.has(order.id)) continue;
    const nf = nFinish.get(order.id); if (nf == null) continue;
    const changes = changesByOrder.get(order.id) || [];
    const shiftH = changes.reduce((sum, change) => sum + Math.abs(change.after.start - change.before.start) / 3600000, 0);
    rows.push({ oid: order.id, bf: null, nf, o: order, chg: true, kind: 'new', changes, shiftH, tasks: candidateTasks.get(order.id) || [] });
  }
  rows.sort((a, b) => (a.kind === 'new' ? -1 : 1) - (b.kind === 'new' ? -1 : 1) || (b.changes.length - a.changes.length) || String(a.oid).localeCompare(String(b.oid)));
  if (!rows.length) return html`<div class="empty"><h3>未发现受影响订单</h3><p>本次重排没有新增订单，也没有订单或工序发生变化。</p></div>`;
  const movedMachines = taskChanges.filter(change => change.before.machineId !== change.after.machineId).length;
  // 最终完工未变时，用偏移最大的实际工序说明等待缓冲吸收了多少时间。
  const majorShift = row => {
    if (!row.changes.length) return null;
    const scored = row.changes.map(change => {
      const startDelta = change.after.start - change.before.start;
      const endDelta = change.after.end - change.before.end;
      const deltaMs = Math.abs(startDelta) >= Math.abs(endDelta) ? startDelta : endDelta;
      return { change, deltaMs };
    }).sort((a, b) => Math.abs(b.deltaMs) - Math.abs(a.deltaMs));
    return scored[0];
  };
  // 对比表中的“新预计完成”与“最终完工变化”共用同一口径：
  // 若重排的最终任务未移动，则把实际最大的工序时间偏移折算到预计完成时间，保证两列可直接相减验证。
  const reportedFinish = row => {
    if (row.kind !== 'existing' || Math.abs(row.nf - row.bf) >= 60000) return row.nf;
    const shift = majorShift(row);
    return shift && Math.abs(shift.deltaMs) >= 30000 ? row.bf + shift.deltaMs : row.nf;
  };
  const buffered = rows.filter(row => row.kind === 'existing' && row.changes.length && Math.abs(row.nf - row.bf) < 60000).length;
  const finalChanged = rows.filter(row => row.kind === 'existing' && Math.abs(reportedFinish(row) - row.bf) >= 60000).length;
  const reasonOf = taskId => {
    if ((sim.affectedTaskIds || []).includes(taskId)) return '故障避让：直接受影响任务';
    const roundInfo = (sim.expansionRounds || []).find(roundInfo => (roundInfo.taskIds || []).includes(taskId));
    if (roundInfo?.index === 2) return '同设备冲突释放';
    if (roundInfo?.index === 3) return '工序依赖释放';
    return sim.type === 'rush' ? '紧急插单重排' : '局部排产调整';
  };
  const deliveryTag = row => {
    const due = row.o.due ? new Date(row.o.due).getTime() : null;
    if (!due) return tag('交期待确认', 'gray');
    const wasLate = row.bf != null && row.bf > due, isLate = reportedFinish(row) > due;
    if (row.kind === 'new') return isLate ? tag('新增延期', 'red', 'alert') : tag('新增且准时', 'blue', 'plus');
    if (!wasLate && isLate) return tag('新增延期', 'red', 'alert');
    if (wasLate && !isLate) return tag('恢复准时', 'green', 'check');
    return isLate ? tag('仍延期', 'amber', 'info') : tag('仍准时', 'gray');
  };
  rows.sort((a, b) => reportedFinish(a) - reportedFinish(b) || String(a.oid).localeCompare(String(b.oid)));
  const summary = dataTable({
    columns: [
      { label: '订单号', render: row => html`<span class="mono">${row.oid}</span>${row.kind === 'new' ? ' ' + tag('新增订单', 'blue', 'plus') : ''}`, width: '185px' },
      { label: '交期政策', render: row => dueTag(row.o.duePolicy || 'unknown', row.o.graceHours), width: '170px' },
      { label: '原预计完成', render: row => row.bf == null ? '—' : fmtDateTime(row.bf), width: '165px' },
      { label: '新预计完成', render: row => fmtDateTime(reportedFinish(row)), width: '165px' },
      { label: '最终完工变化', render: row => {
        if (row.kind === 'new') return html`<span class="impact-new">新增排产</span>`;
        const deltaH = (reportedFinish(row) - row.bf) / 3600000;
        if (Math.abs(deltaH) < 0.01) return html`<span class="impact-buffered">不变</span>`;
        return html`<span class="impact-shift-red">${deltaH > 0 ? '晚 ' : '早 '}${fmtDur(Math.abs(deltaH))}</span>`;
      }, width: '175px' },
      { label: '交期影响', render: deliveryTag, width: '130px' },
    ],
    rows: rows.slice(0, 60), rowKey: row => row.oid,
    empty: '本次重排没有新增订单，也没有订单或工序发生变化',
  });
  const changedDetail = taskChanges.length ? html`<details class="mt"><summary class="tiny">查看 ${taskChanges.length} 条工序变更（含换机与起止时间）</summary><div class="tbl-wrap mt" style="max-height:310px"><table class="tbl"><thead><tr><th>订单 / 工序</th><th>原机台 / 原时间</th><th>新机台 / 新时间</th><th>时间偏移</th><th>调整原因</th></tr></thead><tbody>${raw(taskChanges.map(change => {
    const shiftMs = change.after.start - change.before.start;
    const shiftText = Math.abs(shiftMs) < 30000 ? '开工不变' : `${shiftMs > 0 ? '晚 ' : '早 '}${fmtDur(Math.abs(shiftMs) / 3600000)}`;
    const shiftClass = Math.abs(shiftMs) < 30000 ? 'impact-buffered' : (shiftMs > 0 ? 'impact-late' : 'impact-early');
    return html`<tr><td class="mono tiny">${change.orderId} · ${PROC_MAP[change.process]?.name || change.process}</td><td>${change.before.machineId}<br><span class="muted tiny">${fmtDateTime(change.before.start)} → ${fmtDateTime(change.before.end)}</span></td><td>${change.after.machineId}<br><span class="muted tiny">${fmtDateTime(change.after.start)} → ${fmtDateTime(change.after.end)}</span></td><td><span class="${shiftClass}">${shiftText}</span></td><td class="tiny">${reasonOf(change.taskId)}</td></tr>`;
  }).join(''))}</tbody></table></div></details>` : '';
  return html`${raw(summary)}<div class="impact-compact-note"><span>${rows.length} 张受影响订单</span><span>${movedMachines} 条换机工序</span><span>${finalChanged} 张最终完工变化</span><span>${buffered} 张前序调整被缓冲吸收</span></div>${raw(changedDetail)}${rows.length > 60 ? html`<div class="tiny muted mt">仅展示前 60 张受影响订单。</div>` : ''}`;
}

export const SIM_ACTIONS = {
  simType: (ctx, node, ds) => { ctx.ui.simType = ds.v; ctx.ui.simError = null; ctx.__simForm = {}; ctx.rerender(); },
  gotoWorkbench: (ctx) => ctx.navigate('workbench'),
  cancelSim: (ctx) => { ctx.store.cancelSimulation(); ctx.rerender(); },
  resetSim: (ctx) => { ctx.state.simulation = null; ctx.ui.simType = 'rush'; ctx.ui.simError = null; ctx.__simForm = {}; ctx.rerender(); },
  adopt: (ctx, node, ds) => { ctx.store.adoptCandidate(ds.id); ctx.navigate('workbench'); },
  async runSim(ctx) {
    const type = getType(ctx);
    const f = ctx.__simForm || {};
    const err = [];
    if (type === 'rush') {
      if (!f['r-orderNo']) err.push('订单号必填');
      if (!f['r-spec']) err.push('规格必填');
      if (!(Number(f['r-qty']) > 0)) err.push('数量必须为正数');
      if (!f['r-due']) err.push('预发货日必填');
    } else if (type === 'breakdown') {
      if (!f['b-from'] || !f['b-to']) err.push('停机开始与结束时间必填');
      if (f['b-from'] && f['b-to'] && new Date(f['b-to']) <= new Date(f['b-from'])) err.push('停机结束必须晚于开始');
    } else {
      if (!f['m-new']) err.push('新就绪时间必填');
    }
    if (err.length) { ctx.ui.simError = err; ctx.rerender(); ctx.toast(err.join('；'), 'err'); return; }
    ctx.ui.simError = null;
    if (type === 'rush') {
      await ctx.store.runSimulation({ type, payload: { order: buildRushOrder(f) } });
    } else if (type === 'breakdown') {
      const [process, machineId] = String(f['b-machine']).split(':');
      await ctx.store.runSimulation({ type, payload: { process, machineId, from: f['b-from'], to: f['b-to'], reason: f['b-reason'] } });
    } else {
      await ctx.store.runSimulation({ type, payload: { orderId: f['m-order'], oldReadyAt: f['m-old'], newReadyAt: f['m-new'], inspectionHours: Number(f['m-inspect']) || 2 } });
    }
    ctx.rerender();
    const status = ctx.state.simulation?.status;
    ctx.toast(status === 'done' ? '已生成候选方案，基线版本保持不变' : '未生成可行候选方案，请查看受影响范围与冻结任务', status === 'done' ? 'ok' : 'warn');
  },
};

function getType(ctx) { return ctx.ui.simType || ctx.state.simulation?.type || 'rush'; }
function datetimeLocal(value) { const d = toDate(value); return d ? `${fmtDate(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : ''; }

function buildRushOrder(f) {
  const spec = String(f['r-spec'] || '').trim();
  const m = /^(\d+(?:\.\d+)?)\s*mm\s+(.+)$/i.exec(spec);
  let parsed = { parseOk: false };
  if (m) {
    let rest = m[2];
    const g = /^(GT\d+[A-Z]*)\s*\((.*)\)$/i.exec(rest);
    if (g) rest = g[2];
    const st = rest.replace(/\s+/g, '');
    const sm = /^(\d+)\s*[*×xX]\s*(.+)$/.exec(st);
    parsed = { parseOk: true, diameterMm: Number(m[1]), structure: st, strandCount: sm ? Number(sm[1]) : null,
      strandConstruction: sm ? sm[2].split('+')[0].toUpperCase() : null, core: st.includes('+') ? st.split('+')[1] : null };
  }
  return {
    id: String(f['r-orderNo']).trim(), internalNo: null, productName: '（急单）',
    spec, coating: null,
    qtyMeters: Number(f['r-qty']), qtyMetersUnit: f['r-unit'] || '米', qtyKg: null, qtyKgUnit: 'Kg',
    orderDate: fmtDate(new Date()), preShipDate: f['r-due'], preArrivalDate: null,
    endCode: '未结束', lastShipDate: null, parsed, mappingKey: null, matchStatus: 'unknown', mappingCandidates: [],
    priority: f['r-priority'] || '重点订单', duePolicy: f['r-policy'] || 'unknown',
    graceHours: (f['r-policy'] === 'soft') ? 72 : 0, rush: true,
    materialReadyAt: f['r-ready'] || null, wireSpecHint: null,
  };
}

function bindSimForm(ctx, host, type, presets) {
  const form = qs('#view');
  form.querySelectorAll('[data-f]').forEach(n => {
    n.addEventListener('input', () => { ctx.__simForm = ctx.__simForm || {}; ctx.__simForm[n.dataset.f] = n.value; ctx.ui.simError = null; });
    n.addEventListener('change', () => { ctx.__simForm = ctx.__simForm || {}; ctx.__simForm[n.dataset.f] = n.value; ctx.ui.simError = null; });
  });
  // 预填初始值，便于「生成候选方案」直接读取
  ctx.__simForm = ctx.__simForm || {};
  form.querySelectorAll('[data-f]').forEach(n => { if (ctx.__simForm[n.dataset.f] === undefined) ctx.__simForm[n.dataset.f] = n.value; });
}
