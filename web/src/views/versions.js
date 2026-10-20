/* D05 方案版本、确认与导出 */
import { html, raw, icon, qs } from '../core/dom.js';
import { dataTable, tag, versionTag, section, emptyState, openModal, metricCards, riskList } from '../components/ui.js';
import { fmtDateTime, fmtNum, round } from '../core/util.js';
import { PROCESSES } from '../engine/rules.js';

export function renderVersions(host, ctx) {
  const { state } = ctx;
  const vs = state.versions;
  host.className = 'view';
  if (!vs.length) {
    host.innerHTML = emptyState({ icon: 'layers', title: '还没有方案版本', desc: '生成候选计划后会在这里留下版本记录，包含交付指标与风险摘要。',
      actions: [{ label: '生成候选计划', act: 'generate', cls: 'primary', icon: 'play' }] });
    return;
  }
  const cur = ctx.version;

  const cols = [
    { label: '版本', render: v => html`<b>${v.id}</b>${v.id === state.baselineVersionId ? ' ' + tag('模拟基线', 'blue') : ''}
        <div class="tiny muted ellip" style="max-width:220px">${v.name}</div>`, width: '230px' },
    { label: '状态', render: v => versionTag(v, state.datasetKey) + (v.simulated ? ' ' + tag('模拟参数', 'amber', 'info', '含未验证参数，不进入正式已确认状态') : ''), width: '190px' },
    { label: '基线', render: v => v.baselineId ? html`<span class="mono tiny">${v.baselineId}</span>` : html`<span class="muted tiny">—</span>`, width: '76px' },
    { label: '创建', render: v => html`<div class="tiny">${v.createdAt}</div><div class="tiny2 muted">${v.createdBy}</div>`, width: '132px' },
    { label: '数据快照', render: v => html`<span class="tiny">${v.dataVersion}</span>`, width: '160px' },
    { label: '交付指标', render: v => html`<div class="tiny">准时率 <b>${v.metrics.deliveryRate == null ? '—' : v.metrics.deliveryRate + '%'}</b></div>
        <div class="tiny2 muted">延期 ${v.metrics.lateOrders} · 硬风险 ${v.metrics.hardRiskCount} · 未排 ${v.metrics.unscheduledOrders + v.metrics.blockedOrders}</div>`, width: '190px' },
    { label: '风险摘要', render: v => html`${tag('阻断 ' + v.validation.counts.block, v.validation.counts.block ? 'red' : 'gray')}
        ${tag('警告 ' + v.validation.counts.warn, v.validation.counts.warn ? 'amber' : 'gray')}`, width: '150px' },
    { label: '确认', render: v => v.confirmedAt ? html`<div class="tiny">${v.confirmedAt}</div><div class="tiny2 muted">${v.confirmedBy}</div>` : html`<span class="muted tiny">未确认</span>`, width: '132px' },
    { label: '操作', render: v => html`<div class="btn-row">
        <button class="btn sm" data-act="vOpen" data-id="${v.id}">查看</button>
        <button class="btn sm" data-act="vCopy" data-id="${v.id}">复制为草稿</button>
        <button class="btn sm" data-act="vBase" data-id="${v.id}">设为基线</button>
      </div>`, width: '250px' },
  ];

  host.innerHTML = html`
    <div class="banner info mb">${raw(icon('info', 16))}
      <div>确认后版本不可原地编辑；如需调整，用「复制为草稿」派生新版本。新版本确认后旧版留存并标为「已替代」。
      「确认版本」仅表示本产品内的人工认可，由于未接 ERP/MES，不显示「已下发生产」。</div></div>

    <div class="card mb"><div class="card-h"><h3>版本列表</h3>
      <span class="sub">${vs.length} 个版本</span>
      <div class="right"><button class="btn sm primary" data-act="generate">${raw(icon('play', 13))}生成新候选</button></div></div>
      <div class="card-b flush">${raw(dataTable({ columns: cols, rows: vs.slice().reverse(), rowKey: v => v.id,
        rowAttrs: v => v.id === cur?.id ? 'sel' : '' }))}</div>
    </div>

    ${cur ? html`
    <div class="split">
      <div class="stack">
        ${raw(section('当前版本 ' + cur.id + ' · ' + cur.name,
          (cur.basedOnOldData || (state.datasetKey && cur.datasetKey !== state.datasetKey)
            ? html`<div class="banner gray" style="margin-bottom:12px">${raw(icon('info', 15))}<div><b>该版本基于已替换的数据快照。</b>其任务表、指标与确认记录均保留原样、未被覆写；如需按当前数据排产，请重新生成候选计划。</div></div>`
            : '') + metricCards(cur.metrics, { stale: !!cur.dirty }),
          { sub: '指标与当前版本绑定；局部筛选不改变全局指标', flush: true }))}
        ${raw(section('求解信息', html`<dl class="kv">
          <dt>排程耗时</dt><dd>${cur.logs?.scheduleMs ?? '—'} ms${cur.logs?.improve ? '（局部优化 ' + cur.logs.improve + ' 处）' : ''}</dd>
          <dt>总计算耗时</dt><dd>${cur.logs?.totalMs ?? '—'} ms</dd>
          <dt>生成任务数</dt><dd>${cur.tasks.filter(t => t.scheduled).length} 条（订单 × 三工序）</dd>
          <dt>换型总时长</dt><dd>${cur.metrics.totalSetupHours} 小时</dd>
          <dt>计划跨度</dt><dd>${cur.metrics.makespan ? fmtDateTime(cur.metrics.makespan) : '—'} 结束</dd>
          <dt>排除订单</dt><dd>${cur.excludedOrders.length} 单${cur.excludedOrders.length ? '（' + cur.excludedOrders.slice(0, 6).join('、') + (cur.excludedOrders.length > 6 ? ' 等' : '') + '）' : ''}</dd>
          <dt>阻断订单</dt><dd>${cur.blockedOrders.length} 单</dd>
        </dl>`))}
        ${raw(section('风险清单', riskList(cur.validation.risks, { filter: 'all' }), { flush: true }))}
      </div>
      <div class="stack">
        ${raw(section('确认前检查', confirmPanel(cur), {}))}
        ${raw(section('导出', html`
          <button class="btn primary" style="width:100%" data-act="export">${raw(icon('download', 14))}打开导出面板</button>
          <div class="tiny muted2 mt">导出不因存在风险而隐藏；草稿与模拟参数版本会带上明确标识。</div>`))}
      </div>
    </div>` : ''}`;
}

function confirmPanel(v) {
  const c = v.validation.counts;
  const items = [
    ['纳入订单数', v.metrics.orderCount + ' 单'],
    ['明确排除订单数', v.metrics.excludedOrders + ' 单'],
    ['未排订单', v.metrics.unscheduledOrders + ' 单'],
    ['硬约束冲突', c.block + ' 项'],
    ['政策/参数缺口', v.simulated ? '使用演示参数' : '无'],
    ['软交期风险', c.warn + ' 项'],
    ['人工锁定任务', v.tasks.filter(t => t.locked).length + ' 个'],
    ['当前数据是否更新', v.dirty ? '存在未重算修改' : '已是最新计算'],
  ];
  const canConfirm = v.validation.canConfirm && !v.dirty && v.status !== 'confirmed';
  return html`<dl class="kv tight mb">${raw(items.map(i => html`<dt>${i[0]}</dt><dd>${i[1]}</dd>`).join(''))}</dl>
    ${v.status === 'confirmed'
      ? html`<div class="banner ok">${raw(icon('check', 15))}<div>已于 ${v.confirmedAt} 由 ${v.confirmedBy} 确认${v.simulated ? '（模拟参数版本）' : ''}。</div></div>`
      : html`<button class="btn dark" style="width:100%" data-act="confirm" ${canConfirm ? '' : 'disabled'}>
          ${raw(icon('check', 14))}${v.validation.canConfirm ? (v.dirty ? '需先重算再确认' : '确认版本') : '存在阻断，无法确认'}</button>`}`;
}

export const VERSION_ACTIONS = {
  vOpen: (ctx, node, ds) => { ctx.store.setCurrent(ds.id); ctx.navigate('workbench'); },
  vCopy: (ctx, node, ds) => { ctx.store.copyAsDraft(ds.id); ctx.rerender(); },
  vBase: (ctx, node, ds) => { ctx.store.setBaseline(ds.id); ctx.toast('已设为模拟基线 ' + ds.id, 'ok'); ctx.rerender(); },
};