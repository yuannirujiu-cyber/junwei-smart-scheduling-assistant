/* D00 排产设置与规则摘要：让计划员知道本次计算用哪些范围、约束和假设 */
import { html, raw, icon, qs } from '../core/dom.js';
import { section, emptyState } from '../components/ui.js';
import { changeoverBetween } from '../engine/spec.js';
import { readDispatchConfig, setupMinutesFor } from '../engine/dispatch.js';
import { fmtDateTime } from '../core/util.js';

export function renderSettings(host, ctx) {
  const { settings: s, snapshot, cap } = ctx;
  if (!snapshot) { host.innerHTML = emptyState({ icon: 'settings', title: '尚未载入数据', desc: '请先载入数据快照。' }); return; }
  const demoOn = !!s.demoParams?.enabled;
  /* 排程策略（《三工序排产算法设计》）*/
  const dsp = readDispatchConfig(s);
  const dispMode = (s.strategy || 'dispatch') !== 'order';
  const th = dsp.thresholdMin;
  const negMode = dsp.negativeMode;
  host.className = 'view settings-view';
  host.innerHTML = html`
    <div class="settings-layout">
      <div class="stack">
        ${raw(section('排程策略（《三工序排产算法设计》）', html`
          <div class="grid g2">
            <div class="field"><label>排程策略 *</label>
              <select data-f="strategy" aria-label="排程策略（必填）">
                <option value="dispatch"${dispMode ? ' selected' : ''}>前瞻派单（同型号优先 + 下一台前瞻 + 设备预约）</option>
                <option value="order"${dispMode ? '' : ' selected'}>按订单排程（逐单依次做换型感知间隙插入）</option>
              </select>
              <div class="hint">两套算法共用同一套数据契约、校验与指标，切换后重新生成计划即可对比。</div></div>
            <div class="field"><label>负余量处理模式</label>
              <select data-f="negativeMode" aria-label="负余量处理模式">
                <option value="AFTER_URGENT"${negMode === 'AFTER_URGENT' ? ' selected' : ''}>AFTER_URGENT（文档默认：紧急可行 → 负余量 → 普通）</option>
                <option value="DEFER"${negMode === 'DEFER' ? ' selected' : ''}>DEFER（负余量暂缓，不参与普通派单，保留编号与暂缓原因）</option>
              </select></div>
            <div class="field"><label>拉丝紧急余量阈值（分钟）</label>
              <input type="number" data-f="th-drawing" aria-label="拉丝紧急余量阈值（分钟）" value="${th.drawing}" min="0" step="30" />
              <div class="hint">文档默认 1500 min（25 h）。余量 = 交期 − 本工序及下游的名义加工与最坏换型之和。</div></div>
            <div class="field"><label>捻股紧急余量阈值（分钟）</label>
              <input type="number" data-f="th-stranding" aria-label="捻股紧急余量阈值（分钟）" value="${th.stranding}" min="0" step="30" />
              <div class="hint">文档默认 1080 min（18 h）。</div></div>
            <div class="field"><label>合绳紧急余量阈值（分钟）</label>
              <input type="number" data-f="th-closing" aria-label="合绳紧急余量阈值（分钟）" value="${th.closing}" min="0" step="30" />
              <div class="hint">文档默认 600 min（10 h）。</div></div>
            <div class="field"><label>换型公式</label>
              <input type="text" aria-label="换型公式预览（只读）" value="${dispPreview(s)}" disabled />
              <div class="hint">拉丝固定 60 min；捻股/合绳 = 目标订单股数 × 10 min，并夹进赛题 R5 的 1–5 h 区间。</div></div>
            <div class="field"><label>拉丝换型固定时长（分钟）</label>
              <input type="number" data-f="disp-drawingSetupMin" aria-label="拉丝换型固定时长（分钟）" value="${dsp.drawingSetupMin}" min="0" step="10" /></div>
            <div class="field"><label>捻股 / 合绳每股换型（分钟/股）</label>
              <input type="number" data-f="disp-perStrandSetupMin" aria-label="每股换型分钟" value="${dsp.perStrandSetupMin}" min="0" step="1" /></div>
            <label class="chk"><input type="checkbox" data-f="disp-clampToR5"${dsp.clampToR5 ? ' checked' : ''} />
              把 10×股数夹进赛题 R5 的 1–5 h 区间</label>
          </div>
          `, { sub: '算法来源：路演/三工序排产算法设计.docx' }))}

        ${raw(section('工序产出节拍', html`<div class="grid g3">
          <div class="field"><label>拉丝完成间隔（分钟）</label><input type="number" data-f="interval-drawing" aria-label="拉丝完成间隔（分钟）" value="${s.processIntervalMin?.drawing ?? 10}" min="0" step="1" />
            <div class="hint">默认 10 分钟：47 台拉丝设备并行生产后的平均订单完成节拍。</div></div>
          <div class="field"><label>捻股时间间隔（分钟）</label><input type="number" data-f="interval-stranding" aria-label="捻股时间间隔（分钟）" value="${s.processIntervalMin?.stranding ?? 5}" min="0" step="1" />
            <div class="hint">默认 5 分钟；修改后重新生成计划生效。</div></div>
          <div class="field"><label>合绳时间间隔（分钟）</label><input type="number" data-f="interval-closing" aria-label="合绳时间间隔（分钟）" value="${s.processIntervalMin?.closing ?? 10}" min="0" step="1" />
            <div class="hint">默认 10 分钟；修改后重新生成计划生效。</div></div>
        </div>`, { sub: '表示各工序全部设备并行后的订单完成节拍；不占用单台设备，也不增加单台设备两单之间的空档。' }))}
      </div>

    </div>`;

  /* 表单事件 */
  const bind = (sel, ev, fn) => qs(sel, host)?.addEventListener(ev, fn);
  bind('[data-f="setupWeight"]', 'change', e => { s.setupWeight = Number(e.target.value); ctx.rerender(); });
  const bindInterval = (key) => bind('[data-f="interval-' + key + '"]', 'change', e => {
    s.processIntervalMin = { ...(s.processIntervalMin || {}), [key]: Math.max(0, Number(e.target.value) || 0) };
    ctx.rerender();
  });
  bindInterval('drawing'); bindInterval('stranding'); bindInterval('closing');
  bind('[data-f="demoEnabled"]', 'change', e => {
    s.demoParams = { ...(s.demoParams || {}), enabled: e.target.checked, at: new Date().toISOString().slice(0, 16).replace('T', ' ') };
    ctx.rerender();
  });
  /* ---- 排程策略（《三工序排产算法设计》）---- */
  bind('[data-f="strategy"]', 'change', e => { s.strategy = e.target.value; ctx.rerender(); });
  s.dispatch = s.dispatch || {};
  bind('[data-f="negativeMode"]', 'change', e => { s.dispatch.negativeMode = e.target.value; ctx.rerender(); });
  const bindTh = (k, key) => bind('[data-f="th-' + k + '"]', 'change', e => {
    s.dispatch.thresholdMin = { ...(s.dispatch.thresholdMin || {}), [key]: Number(e.target.value) }; ctx.rerender();
  });
  bindTh('drawing', 'drawing'); bindTh('stranding', 'stranding'); bindTh('closing', 'closing');
  bind('[data-f="disp-drawingSetupMin"]', 'change', e => { s.dispatch.drawingSetupMin = Number(e.target.value); ctx.rerender(); });
  bind('[data-f="disp-perStrandSetupMin"]', 'change', e => { s.dispatch.perStrandSetupMin = Number(e.target.value); ctx.rerender(); });
  bind('[data-f="disp-clampToR5"]', 'change', e => { s.dispatch.clampToR5 = e.target.checked; ctx.rerender(); });
  const co = (k, key) => bind('[data-f="' + k + '"]', 'change', e => { s.changeoverModel[key] = Number(e.target.value); ctx.rerender(); });
  co('co-minHours', 'minHours'); co('co-maxHours', 'maxHours'); co('co-magnitudeWeight', 'magnitudeWeight');
  co('co-bothDimsBonus', 'bothDimsBonus'); co('co-structuralBonus', 'structuralBonus');
  const q = (k, key) => bind('[data-f="' + k + '"]', 'change', e => { s.qtyModel[key] = Number(e.target.value); ctx.rerender(); });
  q('q-closingFactor', 'closingFactor'); q('q-strandShrink', 'strandShrink'); q('q-drawShrink', 'drawShrink'); q('q-defaultWireCount', 'defaultWireCount');
  bind('[data-f="demoReason"]', 'input', e => { s.demoParams.reason = e.target.value; });
  bind('[data-f="demoOperator"]', 'input', e => { s.demoParams.operator = e.target.value; });
}

/** 换型公式预览：用真实引擎函数算，避免「界面能调但看不出效果」。 */
function dispPreview(s) {
  const cfg = readDispatchConfig(s);
  const parts = [4, 8, 10, 19, 35].map(n => {
    const r = setupMinutesFor('stranding', 'x', 'y', { count: n }, cfg);
    return n + '股 ' + r.minutes + 'min' + (r.clamped ? '(夹紧自' + r.raw + ')' : '');
  });
  return '拉丝固定 ' + cfg.drawingSetupMin + ' min ｜ 捻股/合绳：' + parts.join(' · ');
}

/** 用真实引擎函数给出参数预览，避免「界面能调但看不出效果」。 */
function coPreview(model) {
  const a = { wireSpec: 1.2, outSpec: 'A', outDia: 20 };
  const b = { wireSpec: 1.8, outSpec: 'B', outDia: 32 };
  const same = changeoverBetween('drawing', { structure: '6*19S', diameter: 20 }, { structure: '6*19S', diameter: 22 }, model);
  const both = changeoverBetween('drawing', a, b, model);
  const two = changeoverBetween('stranding', { structure: '6*19S', diameter: 3 }, { structure: '6*36WS', diameter: 5 }, model);
  return '同结构换径 ' + same.hours + 'h · 双维度切换 ' + both.hours + 'h · 结构+股径 ' + two.hours + 'h';
}

export const SETTINGS_ACTIONS = {};
