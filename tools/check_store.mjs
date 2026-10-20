/* store 全流程自检：真实 store + 真实引擎，走通
   载入 → 生成 → 锁定 → 重算 → 调整 → 撤销 → 确认门禁（拒绝 / 成功）→ 版本状态机
   → 复制为草稿 → 模拟插单/故障/物料延迟 → 采用方案

   审查报告 §六 指出的问题与本次修正：
   - 原 :56 `const blocked = …canConfirm` 变量名与语义**相反**，:59 `if (blocked)` 使
     「排除阻断 → 确认 → 旧版本转已替代 → 复制为草稿」在随包两份数据上**静默跳过**（P0-2/P1-6 的盲区）。
     现在「确认被拒」与「确认成功」两条分支**都必须被执行到**：先用拒绝分支核对原因，
     再用**累积排除（只增不减）+ 重算**让真实数据走到可确认，然后走成功分支。
   - 原 :53 是 `x === x` 恒真断言（after 就是被 updateTask 原地改过的同一对象）；
     现在对**独立的深拷贝快照**做前后比对。
   - 新增回归断言：P0-2（排除阻断可收敛）、P0-3（锁定重算重复任务）、P1-5（模拟污染全局设置）、
     P1-6（深拷贝破坏 Set）、P1-7（已确认版本被原地改写）、P2-18（撤销后可确认性不恢复）。

   两份随包数据都要跑：dataset.json 没有 simulationPresets，模拟相关断言只能在 demo 数据上覆盖。 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function stubEl() {
  return { innerHTML: '', textContent: '', className: '', style: {}, dataset: {}, value: '', checked: false,
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    addEventListener() {}, appendChild() {}, remove() {}, click() {}, contains() { return false; }, closest() { return null; },
    querySelector() { return stubEl(); }, querySelectorAll() { return []; } };
}
globalThis.document = { createElement: () => stubEl(), querySelector: () => stubEl(), body: stubEl(), addEventListener() {} };
globalThis.window = globalThis;

const { store } = await import(resolve(ROOT, 'web/src/core/store.js'));
const { bus } = await import(resolve(ROOT, 'web/src/core/bus.js'));

let pass = 0, fail = 0;
const ok = (n, c, e = '') => { if (c) pass++; else { fail++; console.log('  FAIL: ' + n + (e ? ' :: ' + e : '')); } };
/** 独立的深拷贝快照：与被测对象不共享任何引用，避免"拿被改过的对象跟自己比" */
const snap = (o) => JSON.parse(JSON.stringify(o));
/** 与 confirmVersion 的放行条件同源：无阻断且无未重算修改 */
const confirmable = (v) => !!(v && v.validation && v.validation.canConfirm && !v.dirty);

async function runFlow(label, file) {
  console.log('=== ' + label + '（' + file + '）');
  const ds = JSON.parse(await readFile(resolve(ROOT, file), 'utf8'));
  const keptBefore = store.state.versions.length;
  await store.loadDataset('check-' + label, ds, { id: 'check-' + label, name: '自检快照 ' + label });
  ok(label + ' 载入数据快照', store.state.snapshot.orders.length === ds.orders.length, store.state.snapshot.orders.length);
  ok(label + ' 计划窗口自适应', store.state.settings.horizonDays >= 30, 'horizon=' + store.state.settings.horizonDays + ' start=' + store.state.settings.planStart);
  /* 切换数据不再清空版本（旧方案标记为「基于旧数据」），但当前版本指针不得沿用，
     否则新快照会拿旧数据集的锁定任务去预置排产。 */
  ok(label + ' 切换数据快照后不沿用旧数据集的当前版本', store.state.currentVersionId === null,
    'currentVersionId=' + store.state.currentVersionId + '（载入前保留 ' + keptBefore + ' 个旧版本）');
  /* 夹具约定：本脚本需要干净起点，显式清空版本后开始（不是被测行为断言） */
  store.state.versions = []; store.state.currentVersionId = null; store.state.baselineVersionId = null;
  ok(label + ' 夹具：版本起点为空', store.state.versions.length === 0 && store.state.currentVersionId === null,
    store.state.versions.length + ' 个版本 / current=' + store.state.currentVersionId);

  const t0 = Date.now();
  const v1 = await store.generate({ reason: '自检首排' });
  ok(label + ' 生成候选计划', !!v1 && v1.tasks.length > 0, v1 && v1.tasks.length + ' 任务');
  ok(label + ' 版本已登记', store.state.versions.length === 1 && store.state.currentVersionId === v1.id);
  ok(label + ' 指标已计算', v1.metrics.deliveryRate != null, '准时率 ' + v1.metrics.deliveryRate + '%');
  ok(label + ' 风险已计算', Array.isArray(v1.validation.risks) && v1.validation.risks.length > 0,
    v1.validation.counts.block + ' 阻断 / ' + v1.validation.risks.length + ' 条风险');
  ok(label + ' 模拟参数标记', v1.simulated === true);
  console.log('  首排：' + v1.tasks.length + ' 任务 · 准时率 ' + v1.metrics.deliveryRate + '% · 阻断 ' + v1.validation.counts.block + ' · 用时 ' + (Date.now() - t0) + 'ms');

  /* ---------------- 锁定 → 重算保持 ---------------- */
  const movable = v1.tasks.filter(t => t.scheduled && !t.frozen)[0];
  store.toggleLock(movable.id, true);
  ok(label + ' 锁定写入', store.currentVersion.tasks.find(t => t.id === movable.id).locked === true);
  const beforeStart = movable.start, beforeMachine = movable.machineId;
  const v2 = await store.generate({ reason: '自检重算', keepLocksFrom: v1.id });

  /* a) P0-3：预置锁定任务后，排产循环不得再把同一任务排一遍（lockedIds 死变量 → 同 id 幽灵任务） */
  const v2Ids = v2.tasks.map(t => t.id);
  const v2Dup = [...new Set(v2Ids.filter((id, i) => v2Ids.indexOf(id) !== i))];
  ok(label + ' [P0-3] 锁定重算后任务 id 唯一（无重复任务）',
    v2Dup.length === 0 && new Set(v2Ids).size === v2Ids.length,
    '任务 ' + v2Ids.length + ' 条 / 唯一 ' + new Set(v2Ids).size + ' 个' + (v2Dup.length ? ' / 重复 ' + v2Dup.slice(0, 3).join('、') : ''));

  const after = v2.tasks.find(t => t.id === movable.id);
  ok(label + ' 重算后锁定任务机台与起止不变', !!(after && after.machineId === beforeMachine && after.start === beforeStart),
    after ? (after.machineId + '@' + after.start + ' vs ' + beforeMachine + '@' + beforeStart) : 'locked task missing');
  ok(label + ' 锁定标记继承', after && after.locked === true);

  /* 独立快照必须在 updateTask 之前取，作为"调整前"的唯一真值来源 */
  const origStart = after.start, origEnd = after.end;
  const beforeTask = snap({ machineId: after.machineId, start: origStart, end: origEnd, locked: !!after.locked });

  /* ---------------- 人工调整 → 待重算 ---------------- */
  store.updateTask(after.id, { start: origStart + 3600000, end: origEnd + 3600000 }, '自检调整');
  ok(label + ' 独立快照未被原地改写（updateTask 不得改动快照对象）',
    beforeTask.start === origStart && beforeTask.end === origEnd,
    '快照 ' + beforeTask.start + '~' + beforeTask.end + ' vs 原值 ' + origStart + '~' + origEnd);
  const moved = store.currentVersion.tasks.find(t => t.id === after.id);
  ok(label + ' 调整已生效（与独立快照比对）', !!moved && moved.start === origStart + 3600000,
    moved ? moved.start + ' vs 期望 ' + (origStart + 3600000) : '任务缺失');
  ok(label + ' 调整后标记待重算', store.currentVersion.status === 'stale' || store.currentVersion.dirty === true,
    'status=' + store.currentVersion.status + ' dirty=' + store.currentVersion.dirty);
  ok(label + ' 变更记录写入', store.currentVersion.changes.length > 0);
  store.undoLast();
  const undone = store.currentVersion.tasks.find(t => t.id === after.id);
  ok(label + ' 撤销生效（与独立快照比对）', !!undone && undone.start === beforeTask.start && undone.end === beforeTask.end,
    undone ? undone.start + '~' + undone.end + ' vs 快照 ' + beforeTask.start + '~' + beforeTask.end : '任务缺失');

  /* 注：P2-18 必须放在**可确认**的版本上验证，否则会被 canConfirm=false 掩盖（见下方强断言）。 */

  /* ---------------- 确认门禁：拒绝分支与成功分支都必须执行到 ---------------- */
  const vGate = store.currentVersion;
  ok(label + ' [前置] 当前版本存在阻断（用于覆盖"确认被拒"分支）', vGate.validation.canConfirm === false,
    'canConfirm=' + vGate.validation.canConfirm + ' 阻断=' + vGate.validation.counts.block);
  const gateToasts = [];
  const offGate = bus.on('toast', t => gateToasts.push(t));
  const rejected = store.confirmVersion({ acknowledgeLate: true });
  offGate();
  ok(label + ' 存在阻断时确认被拒绝', rejected === null, '返回 ' + (rejected ? rejected.id + ':' + rejected.status : 'null'));
  ok(label + ' 拒绝时给出可核对的原因（toast）',
    gateToasts.some(t => t && t.kind === 'err' && t.msg && /阻断/.test(t.msg)),
    JSON.stringify(gateToasts.map(t => t.msg || '')));

  /* 累积排除：把「映射缺口订单 ∪ 版本内全部 block 级风险涉单」只增不减地排除后重算 */
  const allOrderIds = store.state.snapshot.orders.map(o => o.id);
  const excluded = new Set();
  let vOpen = store.currentVersion, prevExcluded = -1, rounds = 0;
  while (!vOpen.validation.canConfirm && excluded.size !== prevExcluded && rounds < 20) {
    prevExcluded = excluded.size;
    for (const b of (vOpen.blockedOrders || [])) excluded.add(b.orderId);
    for (const r of vOpen.validation.risks) if (r.level === 'block' && r.orderId) excluded.add(r.orderId);
    if (excluded.size === prevExcluded) break;
    store.patchSettings({ includedOrderIds: allOrderIds.filter(id => !excluded.has(id)) });
    vOpen = await store.generate({ reason: '自检：累积排除阻断订单（第 ' + (rounds + 1) + ' 轮）' });
    rounds++;
  }
  ok(label + ' [P0-2] 累积排除阻断订单并重算后可确认（不收敛即红）', vOpen.validation.canConfirm,
    '轮数 ' + rounds + ' · 累计排除 ' + excluded.size + ' 单 · 剩余阻断 ' + vOpen.validation.counts.block + ' · 纳入 ' + vOpen.metrics.orderCount);
  /* e) P2-18：在「可确认」的版本上做 调整 → 撤销，可确认性必须回到调整前。
     原脚本在不可确认的版本上做这一步，dirty 即使没被回滚也看不出来（审查报告 P2-18 的盲区）。 */
  const vAdj = store.currentVersion;
  const adjTask = vAdj.tasks.find(t => t.scheduled && !t.frozen);
  const adjSnap = snap({ start: adjTask.start, end: adjTask.end });
  const okBefore = confirmable(vAdj);
  store.updateTask(adjTask.id, { start: adjSnap.start + 3600000, end: adjSnap.end + 3600000 }, '自检：可确认版本上调整');
  const okDirty = confirmable(store.currentVersion);
  store.undoLast();
  const okUndone = confirmable(store.currentVersion);
  ok(label + ' [P2-18] 可确认版本「调整后不可确认 → 撤销后恢复可确认」',
    okBefore && !okDirty && okUndone,
    '调整前 ' + okBefore + ' / 调整后 ' + okDirty + ' / 撤销后 ' + okUndone
    + '（status=' + store.currentVersion.status + ' dirty=' + store.currentVersion.dirty + '）');

  const c2 = store.confirmVersion({ acknowledgeLate: true, note: '自检确认' });
  ok(label + ' 确认成功', !!c2 && c2.status === 'confirmed', c2 ? c2.status : 'null');
  ok(label + ' 确认记录操作者', !!c2 && c2.confirmedBy === '演示计划员', c2 && c2.confirmedBy);

  /* 版本状态机：新草稿 → 再次确认 → 旧确认版本转「已替代」 */
  const v4 = await store.generate({ reason: '自检再生成' });
  ok(label + ' 新版本为草稿', v4.status === 'draft' && store.state.currentVersionId === v4.id, v4.status + ' / current=' + store.state.currentVersionId);
  const c3 = store.confirmVersion({ acknowledgeLate: true });
  ok(label + ' 再次确认成功', !!c3 && c3.status === 'confirmed', c3 ? c3.status : 'null');
  ok(label + ' 确认新版本后旧确认版本转为已替代',
    !!c2 && (store.state.versions.find(v => v.id === c2.id) || {}).status === 'superseded',
    (store.state.versions.find(v => v.id === c2.id) || {}).status);

  /* c) P1-7：已确认版本可被原地改写而状态仍显示"已确认"、指标/校验不再更新。
     不变的判据（对"原地转 stale"和"自动派生草稿"两种修法都成立）：
     承载这次人工调整的那个版本，绝不允许仍是 confirmed。 */
  const live = store.currentVersion;
  const liveId = live.id, liveStatus = live.status;
  const liveTask = live.tasks.find(t => t.scheduled && !t.frozen);
  const liveStart = liveTask.start, liveEnd = liveTask.end;
  store.updateTask(liveTask.id, { start: liveStart + 3600000, end: liveEnd + 3600000 }, '自检：调整已确认版本');
  const adjustedStart = liveStart + 3600000;
  const holders = store.state.versions.filter(v => (v.tasks || []).some(t => t.id === liveTask.id && t.start === adjustedStart));
  ok(label + ' [P1-7] 承载人工调整的版本不得仍是「已确认」',
    holders.length > 0 && holders.every(v => v.status !== 'confirmed'),
    '承载版本 ' + (holders.map(v => v.id + ':' + v.status).join('、') || '无')
    + ' · 调整前当前版本 ' + liveId + '(' + liveStatus + ')');

  /* d) P1-6：copyAsDraft 的 JSON 深拷贝把产能行 caps（Set）变成 {} → capableMachines 抛异常 */
  const srcClosing = (c2 ? c2.tasks : []).find(t => t.process === 'closing' && t.jobRef && t.jobRef.row && t.jobRef.row.caps instanceof Set);
  let srcCands = -1;
  if (srcClosing) srcCands = store.cap.capableMachines('closing', { row: srcClosing.jobRef.row }).length;
  ok(label + ' [前置] 找到持 Set 型 caps 的合绳任务', !!srcClosing, srcClosing ? '可用机台 ' + srcCands + ' 台' : '未找到（无法覆盖 P1-6）');
  const draft = store.copyAsDraft(c2.id);
  ok(label + ' 复制为草稿', !!draft && draft.id !== c2.id && draft.status === 'draft', draft && (draft.id + ':' + draft.status));
  const draftClosing = (srcClosing && draft) ? draft.tasks.find(t => t.id === srcClosing.id) : null;
  let capsErr = null, draftCands = -1;
  try { draftCands = store.cap.capableMachines('closing', { row: draftClosing.jobRef.row }).length; } catch (e) { capsErr = e; }
  ok(label + ' [P1-6] 复制为草稿后合绳工序仍可查询可用机台（Set 未被破坏）', !!draftClosing && !capsErr,
    capsErr ? capsErr.message : (draftClosing ? '复制前 ' + srcCands + ' 台 / 复制后 ' + draftCands + ' 台' : '未找到对应合绳任务'));

  /* ---------------- P1 模拟 ---------------- */
  const presets = store.state.snapshot.simulationPresets;
  if (!presets?.rushOrder) { console.log('  SKIP: 本数据集无 simulationPresets，模拟断言未覆盖'); return; }
  /* b) P1-5：模拟只是"看看结果"，不得永久改写全局排产设置 */
  const settingsBefore = snap(store.state.settings);
  const sim = await store.runSimulation({ type: 'rush', payload: { order: presets.rushOrder } });
  ok(label + ' 插单模拟产出候选', sim && sim.candidateIds.length >= 1, sim && sim.candidateIds.join(','));
  const cand = store.state.versions.find(v => v.id === sim.candidateIds[sim.candidateIds.length - 1]);
  ok(label + ' 候选含基线对比', !!cand && !!cand.metrics.delta, cand && cand.metrics.delta && JSON.stringify(cand.metrics.delta).slice(0, 90));
  ok(label + ' 候选标记模拟来源', !!cand && cand.simulationOf === sim.baselineId);
  const settingsAfter = snap(store.state.settings);
  const diffKeys = Object.keys(settingsBefore).filter(k => JSON.stringify(settingsBefore[k]) !== JSON.stringify(settingsAfter[k]));
  ok(label + ' [P1-5] 模拟前后 settings 深度相等（全局参数无污染）', diffKeys.length === 0,
    diffKeys.map(k => k + ': ' + JSON.stringify(settingsBefore[k]) + ' → ' + JSON.stringify(settingsAfter[k])).join('；'));
  store.adoptCandidate(cand.id);
  ok(label + ' 采用方案创建待确认版本', store.state.currentVersionId === cand.id && store.state.simulation === null);
  if (presets.breakdown) {
    const sb = await store.runSimulation({ type: 'breakdown', payload: Object.assign({}, presets.breakdown) });
    ok(label + ' 故障模拟产出候选', sb && sb.candidateIds.length >= 1);
  }
  if (presets.materialDelay) {
    const sm = await store.runSimulation({ type: 'material', payload: Object.assign({}, presets.materialDelay) });
    ok(label + ' 物料延迟模拟产出候选', sm && sm.candidateIds.length >= 1);
  }
}

const primary = process.argv[2] || 'data/dataset.json';
const demo = 'data/demo-dataset.json';
await runFlow('dataset', primary);
if (primary !== demo) await runFlow('demo', demo);

console.log('=== 版本清单（最后一个数据集的 store 状态）');
console.log('  ' + store.state.versions.map(v => v.id + ':' + v.status).join(' '));
console.log('通过 ' + pass + ' / 失败 ' + fail);
process.exit(fail ? 1 : 0);
