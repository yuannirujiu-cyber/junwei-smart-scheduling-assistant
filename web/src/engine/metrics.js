/* 指标口径（PRD 第 10 章）——界面、版本列表与导出共用同一套计算 */
import { HOUR, round, sum } from '../core/util.js';
import { DEFAULT_PROCESS_CHAIN } from './chain.js';

export function computeMetrics({ model, tasks, unscheduled = [], validation, settings, horizonDays = 45, baseline = null }) {
  const cap = model.cap;
  const chain = (model.chain && model.chain.length) ? model.chain : DEFAULT_PROCESS_CHAIN;
  const chainKeys = chain.map(p => p.key);
  const lastKey = chainKeys.length ? chainKeys[chainKeys.length - 1] : null;
  const isComplete = ch => !!ch && chainKeys.every(p => ch[p]);
  const planStart = new Date(settings.planStart).getTime();
  const horizonEnd = planStart + horizonDays * 24 * HOUR;
  /* 负荷口径窗口：默认取「计划执行期」（计划起点 → 计划完成日 24:00）。
     全计划窗口通常远长于实际生产跨度，直接相除会把占用率稀释成无意义的低值。 */
  const schedAll = tasks.filter(t => t.scheduled);
  const rawEnd = schedAll.length ? Math.max.apply(null, schedAll.map(t => t.end)) : planStart;
  const endDay = new Date(rawEnd); endDay.setHours(24, 0, 0, 0);
  const utilWinTo = Math.min(horizonEnd, Math.max(planStart + 24 * HOUR, endDay.getTime()));
  const fullWinH = (horizonEnd - planStart) / HOUR;
  const U = model.active;                                   // 纳入排产的未结束订单集合
  const sched = tasks.filter(t => t.scheduled);
  const byOrder = new Map();
  for (const t of sched) { if (!byOrder.has(t.orderId)) byOrder.set(t.orderId, {}); byOrder.get(t.orderId)[t.process] = t; }

  let onTime = 0, late = 0, unknown = 0, lateHours = 0, hardRisk = 0, hardViolation = 0, hardUnverifiable = 0;
  const lateOrders = [];
  for (const o of U) {
    const ch = byOrder.get(o.id);
    const finish = lastKey ? (ch?.[lastKey]?.end ?? null) : null;
    const complete = isComplete(ch);
    if (!finish || !complete) { unknown++; if (o.duePolicy === 'hard') { hardRisk++; hardUnverifiable++; } continue; }
    const due = o.due ? o.due.getTime() : null;
    if (!due) { unknown++; continue; }
    const tard = Math.max(0, (finish - due) / HOUR);
    if (tard <= 1e-6) onTime++;
    else {
      late++; lateHours += tard; lateOrders.push({ order: o, finish, tardH: tard });
      if (o.duePolicy === 'hard') { hardRisk++; hardViolation++; }
    }
  }
  const denom = U.length;
  const deliveryRate = denom ? round(onTime / denom * 100, 1) : null;

  /* 设备占用 */
  const occByMachine = new Map(), runByMachine = new Map();
  for (const t of sched) {
    const s = Math.max(t.start, planStart), e = Math.min(t.end, utilWinTo);
    if (e > s) runByMachine.set(t.machineUid, (runByMachine.get(t.machineUid) || 0) + (e - s) / HOUR);
    const ss = t.setupHours > 0 ? Math.max(t.start - t.setupHours * HOUR, planStart) : null;
    if (ss != null) { const se = Math.min(t.start, utilWinTo); if (se > ss) occByMachine.set(t.machineUid + ':setup', (occByMachine.get(t.machineUid + ':setup') || 0) + (se - ss) / HOUR); }
  }
  const downByMachine = new Map();
  for (const d of (settings.downtime || [])) {
    const m = cap.machineById(d.process || 'stranding', d.machineId) || cap.machines.drawing.find(x => x.id === d.machineId) || cap.machines.closing.find(x => x.id === d.machineId);
    if (!m) continue;
    const s = Math.max(planStart, new Date(d.from).getTime()), e = Math.min(utilWinTo, new Date(d.to).getTime());
    if (e > s) downByMachine.set(m.uid, (downByMachine.get(m.uid) || 0) + (e - s) / HOUR);
  }
  const machineLoad = [];
  for (const p of chainKeys) {
    for (const m of (cap.machines[p] || [])) {
      const avail = Math.max(0, (utilWinTo - planStart) / HOUR - (downByMachine.get(m.uid) || 0));
      const run = runByMachine.get(m.uid) || 0;
      const setup = occByMachine.get(m.uid + ':setup') || 0;
      machineLoad.push({ process: p, machineId: m.id, uid: m.uid, runH: round(run, 2), setupH: round(setup, 2),
        occH: round(run + setup, 2), availH: round(avail, 2), idleH: round(Math.max(0, avail - run - setup), 2),
        occRate: avail > 0 ? round((run + setup) / avail * 100, 1) : null,
        runRate: avail > 0 ? round(run / avail * 100, 1) : null });
    }
  }
  const totalAvail = sum(machineLoad.map(m => m.availH));
  const totalOcc = sum(machineLoad.map(m => m.occH));
  const totalRun = sum(machineLoad.map(m => m.runH));
  const totalSetup = sum(machineLoad.map(m => m.setupH));

  const byProcess = {};
  for (const p of chainKeys) {
    const ms = machineLoad.filter(m => m.process === p);
    const a = sum(ms.map(m => m.availH)), o = sum(ms.map(m => m.occH)), r = sum(ms.map(m => m.runH)), s = sum(ms.map(m => m.setupH));
    byProcess[p] = { machines: ms.length, availH: round(a, 1), runH: round(r, 1), setupH: round(s, 1), occH: round(o, 1),
      occRate: a ? round(o / a * 100, 1) : null, runRate: a ? round(r / a * 100, 1) : null };
  }

  const m = {
    orderCount: U.length,
    scheduledOrders: U.filter(o => isComplete(byOrder.get(o.id))).length,
    unscheduledOrders: U.filter(o => !isComplete(byOrder.get(o.id))).length,
    blockedOrders: model.blocked.length,
    excludedOrders: model.excluded.length,
    historyOrders: model.history.length,
    deliveryRate, onTimeOrders: onTime, lateOrders: late, unknownOrders: unknown,
    lateHours: round(lateHours, 1), lateOrderList: lateOrders.slice().sort((a, b) => b.tardH - a.tardH),
    hardRiskCount: hardRisk, hardViolation, hardUnverifiable,
    taskCount: sched.length,
    totalSetupHours: round(totalSetup, 1),
    machineOccRate: totalAvail ? round(totalOcc / totalAvail * 100, 1) : null,
    machineRunRate: totalAvail ? round(totalRun / totalAvail * 100, 1) : null,
    machineLoad, byProcess,
    makespan: sched.length ? Math.max.apply(null, sched.map(t => t.end)) : null,
    planStart: planStart,
    windowHours: Math.round((utilWinTo - planStart) / HOUR * 10) / 10,
    windowFrom: planStart,
    windowTo: utilWinTo,
    windowLabel: '计划执行期 ' + fmtShort(planStart) + ' ~ ' + fmtShort(utilWinTo),
    fullWindowHours: Math.round(fullWinH * 10) / 10,
  };

  /* 相对基线的变化（PRD 10：共同原订单集合比较，避免分母变化被包装成优化） */
  m.delta = null;
  if (baseline) {
    const baseFinish = new Map(), baseStart = new Map();
    for (const t of baseline.tasks || []) {
      if (!t.scheduled) continue;
      baseStart.set(t.id, t.start);
      if (t.process === lastKey && (!baseFinish.has(t.orderId) || t.end > baseFinish.get(t.orderId))) baseFinish.set(t.orderId, t.end);
    }
    const common = U.filter(o => baseFinish.has(o.id));
    let newLate = 0, recovered = 0, changedOrders = 0, changedTasks = 0, shiftH = 0, addedLate = 0;
    for (const o of common) {
      const ch = byOrder.get(o.id);
      const nf = lastKey ? (ch?.[lastKey]?.end ?? null) : null;
      if (nf == null) continue;
      const bf = baseFinish.get(o.id);
      const due = o.due?.getTime() ?? null;
      if (due) {
        const wasLate = bf > due, isLate = nf > due;
        if (!wasLate && isLate) newLate++;
        if (wasLate && !isLate) recovered++;
        if (wasLate && isLate && nf > bf) addedLate++;
      }
      let ch2 = false;
      for (const p of chainKeys) {
        const t = ch?.[p]; const old = (baseline.tasks || []).find(x => x.id === t?.id);
        if (!t || !old) continue;
        if (t.machineId !== old.machineId || Math.abs(t.start - old.start) > 60000 || Math.abs(t.end - old.end) > 60000) {
          changedTasks++; shiftH += Math.abs(t.start - old.start) / HOUR; ch2 = true;
        }
      }
      if (ch2) changedOrders++;
    }
    m.delta = { commonOrders: common.length, newLate, recovered, addedLate, changedOrders, changedTasks, shiftH: round(shiftH, 1),
      newOrders: U.length - common.length, baselineId: baseline.id, baselineName: baseline.name };
  }
  return m;
}
function fmtShort(ms) {
  const d = new Date(ms); const p = n => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '-' + p(d.getDate());
}
