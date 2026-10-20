/* 组件与转义自检：真实 dom.js / ui.js。

   审查报告 §六 指出的问题与本次修正：
   原 :7 的 clean() 只查输出里有没有 &lt;，**空字符串也算通过**，导致约 10 条组件断言没有效力
   （变异测试：lockTag/dueTag/versionTag 全返回空串、dataTable 空态守卫删掉、hbar 去掉 clamp，仍然 15/0 通过）。
   现在每条组件断言分三步：① 输出非空且长度合理 → ② 必须命中的关键 class/选择器 → ③ 无转义泄漏。
   并补 hbar 的 clamp（上溢/下溢/零分母）与 lockTag / versionTag 合法空态的显式断言。 */
import { html, raw, icon } from '../web/src/core/dom.js';
import { tag, chainView, dataTable, riskList, metricCards, emptyState, section, ruleTags, hbar, dueTag, lockTag, versionTag, evidenceBlock } from '../web/src/components/ui.js';

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) pass++; else { fail++; console.log('FAIL: ' + n + ' :: ' + e); } };
const R = (x) => String(html`${x}`);

/** 组件断言：非空 → 长度合理 → 关键选择器必须出现 → 转义检查。
    空字符串在第 1、2 步就会失败，不再出现「查不到 &lt; 就算通过」的恒真断言。 */
function checkComp(name, out, musts, minLen = 20) {
  const s = R(out);
  ok(name + ' 输出非空', s.trim().length > 0, 'len=' + s.length);
  ok(name + ' 输出长度合理（≥' + minLen + '）', s.length >= minLen, 'len=' + s.length + ' :: ' + s.slice(0, 90));
  for (const sel of [].concat(musts)) ok(name + ' 含关键选择器 ' + sel, s.includes(sel), s.slice(0, 150));
  /* raw() 返回的是普通对象（不是 String 包装），一旦在 html 模板外做字符串拼接就会渲染成 [object Object] */
  ok(name + ' 无 [object Object] 泄漏', !s.includes('[object Object]'), s.slice(0, 150));
  ok(name + ' 无转义泄漏', !s.includes('&lt;') && !s.includes('&amp;lt;'), s.slice(0, 150));
}

/* ---------------- dom.js：转义只做一次 ---------------- */
ok('内层模板只转义一次', String(html`<div>${html`<b>${'<script>'}</b>`}</div>`) === '<div><b>&lt;script&gt;</b></div>');
ok('raw 不被转义', String(html`<i>${raw(icon('check', 12))}</i>`).startsWith('<i><svg'));
ok('raw 幂等', R(raw(raw('<b>x</b>'))) === '<b>x</b>', R(raw(raw('<b>x</b>'))));
ok('数组插值', String(html`<ul>${[1, 2, 3].map(n => html`<li>${n}</li>`)}</ul>`) === '<ul><li>1</li><li>2</li><li>3</li></ul>');

/* ---------------- 原子组件 ---------------- */
checkComp('tag', tag('硬交期', 'red', 'alert', 'x'), ['class="tag red"', '硬交期', '<svg'], 40);
checkComp('ruleTags', ruleTags(['R1', 'R5']), ['class="rule-ref"', 'R1', 'R5'], 60);
checkComp('riskList', riskList([{ id: 'R1', level: 'block', title: '测试', why: '原因', fix: '修复', rule: 'R8' }], {}),
  ['class="risk-item block"', 'sev-pill block', '原因', '修复'], 150);

/* ---------------- 表格：非空态与空态都要有实体内容 ---------------- */
const dt = dataTable({ columns: [{ label: 'A', render: r => html`<b>${r.a}</b>` }], rows: [{ a: 1 }, { a: 2 }] });
checkComp('dataTable 表头/行', dt, ['class="tbl"', '<th', '<td class=""><b>1</b>', '<td class=""><b>2</b>', '<tbody>'], 200);
const dtEmpty = dataTable({ columns: [{ label: 'A', render: () => '' }], rows: [] });
checkComp('dataTable 空态', dtEmpty, ['class="empty sm"', '<p>'], 60);
ok('dataTable 空态不得渲染表格骨架', !R(dtEmpty).includes('<table'), R(dtEmpty).slice(0, 120));
const dtCustomEmpty = dataTable({ columns: [{ label: 'A', render: () => '' }], rows: [], empty: '没有符合当前筛选的记录' });
checkComp('dataTable 空态文案', dtCustomEmpty, ['没有符合当前筛选的记录'], 60);

/* ---------------- 指标卡 / 空态 / 卡片 / 工序链 / 依据块 ---------------- */
const mc = metricCards({ deliveryRate: 96.5, orderCount: 312, onTimeOrders: 301, lateOrders: 0, lateHours: 0, hardRiskCount: 0, hardViolation: 0, hardUnverifiable: 0, unscheduledOrders: 10, blockedOrders: 10, machineOccRate: 35.8, machineRunRate: 32.7, totalSetupHours: 2125 }, {});
checkComp('metricCards', mc, ['class="metrics"', 'class="metric ', '预测准时交付率', '纳入 312 单', '96.5'], 600);
checkComp('emptyState actions', emptyState({ title: 'T', desc: 'D', actions: [{ label: '生成', act: 'generate', cls: 'primary', icon: 'play' }] }),
  ['class="empty"', 'data-act="generate"', '生成', 'T', 'D'], 150);
checkComp('emptyState 无 actions', emptyState({ title: 'T', desc: 'D' }), ['class="empty"', 'T'], 60);
checkComp('section', section('T', html`<div>x</div>`, { sub: 's', right: html`<button>b</button>` }),
  ['class="card"', 'class="card-h"', 'class="card-b"', '<h3>T</h3>', 'class="sub"'], 120);
const cv = chainView({ id: 'X' }, [{ id: 't1', process: 'drawing', machineId: '8101', start: Date.now(), end: Date.now() + 3600000, locked: true }]);
checkComp('chainView', cv, ['class="chain"', 'class="node draw', 'class="node strand', 'class="node close', '8101'], 300);
checkComp('evidenceBlock', evidenceBlock([{ k: 'K', v: 'V', src: 'S', rule: 'R1' }]),
  ['class="evidence"', 'class="rule-ref"', 'K', 'V', '来源：S'], 150);

/* ---------------- 交期 / 锁定 / 版本标签 ---------------- */
checkComp('dueTag 硬交期', dueTag('hard'), ['class="tag red"', '硬交期'], 40);
checkComp('dueTag 软交期', dueTag('soft', 72), ['class="tag amber"', '软交期（宽限 72h）'], 50);
checkComp('dueTag 未知政策', dueTag('unknown'), ['class="tag gray"', '交期政策待确认'], 40);
checkComp('lockTag 执行冻结', lockTag({ frozen: true }), ['class="tag violet"', '执行冻结'], 40);
checkComp('lockTag 已锁定', lockTag({ locked: true }), ['class="tag violet"', '已锁定'], 30);
ok('lockTag 未锁定任务返回空（合法空态）', R(lockTag({ locked: false })) === '', JSON.stringify(R(lockTag({ locked: false }))));
checkComp('versionTag 已确认', versionTag({ status: 'confirmed' }), ['class="tag green"', '已确认'], 30);
checkComp('versionTag 已确认（模拟参数）', versionTag({ status: 'confirmed', simulated: true }), ['class="tag amber"', '已确认（模拟参数）'], 45);
checkComp('versionTag 已替代', versionTag({ status: 'superseded' }), ['class="tag gray"', '已替代'], 30);
checkComp('versionTag 待重算', versionTag({ status: 'stale' }), ['class="tag amber"', '待重算'], 30);
checkComp('versionTag 待重算（dirty）', versionTag({ status: 'draft', dirty: true }), ['class="tag amber"', '待重算'], 30);
checkComp('versionTag 可确认', versionTag({ status: 'draft', validation: { canConfirm: true } }), ['class="tag blue"', '可确认'], 30);
checkComp('versionTag 基于旧数据', versionTag({ status: 'confirmed', basedOnOldData: true }), ['class="tag gray"', '基于旧数据'], 30);
checkComp('versionTag 草稿有阻断', versionTag({ status: 'draft', validation: { canConfirm: false } }), ['class="tag red"', '草稿（存在阻断）'], 45);
ok('versionTag 空版本返回空（合法空态）', R(versionTag(null)) === '', JSON.stringify(R(versionTag(null))));

/* ---------------- hbar：clamp 必须生效 ---------------- */
checkComp('hbar', hbar('a', 1, 2), ['class="hbar"', 'class="tr"', 'style="width:50%'], 80);
const hOver = R(hbar('超限', 200, 100));
ok('hbar 上溢 clamp 到 100%', /style="width:100%/.test(hOver), hOver);
const hUnder = R(hbar('负值', -5, 100));
ok('hbar 下溢 clamp 到 0%', /style="width:0%/.test(hUnder), hUnder);
const hZeroMax = R(hbar('零分母', 5, 0));
ok('hbar 分母为 0 时宽度 0%', /style="width:0%/.test(hZeroMax), hZeroMax);

console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
