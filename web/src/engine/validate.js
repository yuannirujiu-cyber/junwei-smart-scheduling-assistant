/* 约束校验与风险分级（PRD 5 / 8.2）
   阻断：数据不足、设备不适配、占用重叠、工序倒置、等待超 72h、硬交期违约、
        超软交期上限、缺料导致不可执行
   警告：明确授权宽限内延期、计划窗口内高负荷
   提示：换型较多、其他方案可能更优、历史数据更新 */
import { HOUR, WAIT_LIMIT_H, round } from '../core/util.js';
import { RULE_MAP } from './rules.js';
import { DEFAULT_PROCESS_CHAIN } from './chain.js';

export const SEV = { block: '阻断', warn: '警告', info: '提示' };

export function validateSchedule({ model, tasks, unscheduled, settings, horizonDays = 45 }) {
  const risks = [];
  const cap = model.cap;
  const chain = (model.chain && model.chain.length) ? model.chain : DEFAULT_PROCESS_CHAIN;
  const chainKeys = chain.map(p => p.key);
  const lastKey = chainKeys.length ? chainKeys[chainKeys.length - 1] : null;
  const procName = k => (chain.find(p => p.key === k) || {}).name || k;
  const planStart = new Date(settings.planStart).getTime();
  const horizonEnd = planStart + horizonDays * 24 * HOUR;
  const byOrder = new Map();
  const byTaskId = new Map();
  for (const t of tasks) {
    if (!t.scheduled) continue;
    byTaskId.set(t.id, t);
    if (!byOrder.has(t.orderId)) byOrder.set(t.orderId, {});
    byOrder.get(t.orderId)[t.process] = t;
  }
  const add = (r) => risks.push({ id: 'R' + (risks.length + 1), ...r });

  /* --- 1. 工艺映射缺口（数据不足 → 阻断）--- */
  for (const b of model.blocked) {
    /* 同一订单的多条缺口聚合为一条风险，避免同一原因刷屏；缺失字段与规则逐条列出。 */
    const gaps = b.gaps || [];
    if (!gaps.length) continue;
    const fields = [...new Set(gaps.map(g => g.field).filter(Boolean))];
    const rules = [...new Set(gaps.map(g => g.rule || 'R1'))];
    const fixes = [...new Set(gaps.map(g => g.fix).filter(Boolean))];
    const whys = [...new Set(gaps.map(g => g.why).filter(Boolean))];
    add({ level: 'block', type: '数据不足', rule: rules[0], ruleRefs: rules, orderId: b.order.id,
      title: (fields.length > 1 ? fields.length + ' 项工艺映射缺口' : (fields[0] || '工艺映射') + '缺失') + '，订单无法排产',
      why: b.order.id + '：' + whys.join('；'),
      fix: fixes.join('；') || '在订单中心补录工艺映射',
      target: { kind: 'order', orderId: b.order.id } });
  }

  /* --- 2. 未排工序 --- */
  for (const u of unscheduled) {
    add({ level: 'block', type: '未排产', rule: 'R1', orderId: u.orderId,
      title: '存在未安排工序，交期无法验证',
      why: u.orderId + ' 的工序因「' + u.reason + '」未排入计划窗口',
      fix: '扩大计划窗口 / 补充设备 / 检查适配关系', target: { kind: 'order', orderId: u.orderId } });
  }

  /* --- 3. 逐单：工序链完整性、等待、交期 --- */
  const orderStats = new Map();
  for (const job of model.jobs) {
    const o = job.order;
    const ch = byOrder.get(o.id);
    const has = chainKeys.map(p => ch?.[p]).filter(Boolean);
    const complete = has.length === chainKeys.length;
    const waits = [];
    for (let i = 1; i < chainKeys.length; i++) {
      const a = ch?.[chainKeys[i - 1]];
      const b = ch?.[chainKeys[i]];
      if (a && b) {
        const w = (b.start - a.end) / HOUR;
        waits.push({ from: a.process, to: b.process, hours: w });
        if (w > WAIT_LIMIT_H + 1e-6) {
          add({ level: 'block', type: '工序间隔超限', rule: 'R6', orderId: o.id, taskId: b.id,
            title: '工序等待 ' + round(w, 1) + ' 小时，超过 72 小时上限',
            why: procName(a.process) + '完工（' + fmt(a.end) + '）到' + procName(b.process) + '开工（' + fmt(b.start) + '）等待 ' + round(w, 1) + ' 小时',
            fix: '为下游工序预留产能，或调整前序完工时间', target: { kind: 'task', taskId: b.id } });
        }
        if (b.start < a.end - 1e-6) {
          add({ level: 'block', type: '工序倒置', rule: 'R6', orderId: o.id, taskId: b.id,
            title: '后序开工早于前序完工', why: '违反工序先后约束', fix: '重算', target: { kind: 'task', taskId: b.id } });
        }
      }
    }
    const finish = lastKey ? (ch?.[lastKey]?.end ?? null) : null;
    const due = o.due ? o.due.getTime() : null;
    const latest = o.allowLatest ? o.allowLatest.getTime() : due;
    let tardH = null, statusTag = 'unknown';
    if (finish && due) {
      tardH = Math.max(0, (finish - due) / HOUR);
      if (tardH <= 1e-6) statusTag = 'ontime';
      else if (o.duePolicy === 'hard') statusTag = 'hard-violation';
      else if (o.duePolicy === 'soft' && finish <= latest) statusTag = 'soft-grace';
      else if (o.duePolicy === 'soft') statusTag = 'soft-over';
      else statusTag = 'unknown-policy';
    } else if (!finish) statusTag = 'unverifiable';
    orderStats.set(o.id, { order: o, tasks: ch, complete, finish, tardH, statusTag, waits });

    if (statusTag === 'hard-violation') {
      add({ level: 'block', type: '硬交期违约', rule: 'R8', orderId: o.id, taskId: ch?.[lastKey]?.id,
        title: '硬交期订单预计延期 ' + round(tardH, 1) + ' 小时',
        why: '承诺交期 ' + fmt(due) + '，预计合绳完工 ' + fmt(finish) + '；该客户不允许延期（罚款客户）',
        fix: '提升优先级 / 增加产能 / 与客户协商交期', target: { kind: 'order', orderId: o.id } });
    } else if (statusTag === 'soft-grace') {
      add({ level: 'warn', type: '宽限内延期', rule: 'R8', orderId: o.id, taskId: ch?.[lastKey]?.id,
        title: '宽限内延期 ' + round(tardH, 1) + ' 小时（未超 ' + (o.graceHours || 72) + ' 小时上限）',
        why: '承诺交期 ' + fmt(due) + '，预计完工 ' + fmt(finish) + '；企业已授权宽限，仍记为延期',
        fix: '可确认，但需勾选「已知晓延期」', target: { kind: 'order', orderId: o.id } });
    } else if (statusTag === 'soft-over') {
      add({ level: 'block', type: '超宽限上限', rule: 'R8', orderId: o.id, taskId: ch?.[lastKey]?.id,
        title: '延期 ' + round(tardH, 1) + ' 小时，已超过软交期宽限上限',
        why: '承诺交期 ' + fmt(due) + '，允许最晚完工 ' + fmt(latest) + '，预计完工 ' + fmt(finish),
        fix: '调整计划或重新确认客户政策', target: { kind: 'order', orderId: o.id } });
    } else if (statusTag === 'unknown-policy') {
      add({ level: 'warn', type: '交期政策待确认', rule: 'R8', orderId: o.id,
        title: '交期政策待确认，无法判定是否允许宽限',
        why: '订单 ' + o.id + ' 未标注硬/软交期政策，默认不给予宽限；预计完工 ' + fmt(finish) + '，承诺交期 ' + fmt(due),
        fix: '在订单中心补录交期政策', target: { kind: 'order', orderId: o.id } });
    } else if (statusTag === 'unverifiable') {
      add({ level: 'block', type: '交期无法验证', rule: 'R8', orderId: o.id,
        title: '订单未完整排产，交期无法验证',
        why: o.id + ' 缺少最终合绳完工时间，不能当作准时或确定延期',
        fix: '处理未排工序', target: { kind: 'order', orderId: o.id } });
    }
  }

  /* --- 4. 设备占用重叠校验（确定性阻断）--- */
  const tl = new Map();
  for (const t of tasks) {
    if (!t.scheduled) continue;
    const arr = tl.get(t.machineUid) || [];
    if (t.setupHours > 0) arr.push({ s: t.start - t.setupHours * HOUR, e: t.start, t, kind: 'setup' });
    arr.push({ s: t.start, e: t.end, t, kind: 'run' });
    tl.set(t.machineUid, arr);
  }
  for (const d of (settings.downtime || [])) {
    const m = cap.machineByIdAny(d.machineId, d.process);
    if (!m) continue;
    const arr = tl.get(m.uid) || [];
    arr.push({ s: new Date(d.from).getTime(), e: new Date(d.to).getTime(), kind: 'down', reason: d.reason });
    tl.set(m.uid, arr);
  }
  for (const [uid, arr] of tl) {
    arr.sort((a, b) => a.s - b.s);
    for (let i = 1; i < arr.length; i++) {
      const a = arr[i - 1], b = arr[i];
      if (b.s < a.e - 1000) {
        const t = b.t || a.t;
        add({ level: 'block', type: a.kind === 'down' || b.kind === 'down' ? '停机冲突' : '占用重叠', rule: 'R1',
          orderId: t?.orderId, taskId: t?.id,
          title: '设备 ' + uid.split(':')[1] + ' 上存在时间重叠',
          why: (a.kind === 'down' ? '停机窗口 ' : '任务 ' + (a.t?.orderId || '')) + ' 与 ' + (b.kind === 'down' ? '停机窗口' : '任务 ' + (b.t?.orderId || '')) + ' 重叠',
          fix: '重算或调整任务时间', target: t ? { kind: 'task', taskId: t.id } : null });
      }
    }
  }

  /* --- 5. 负荷警告（窗口内高负荷）--- */
  const winH = (horizonEnd - planStart) / HOUR;
  const loadByMachine = new Map();
  for (const t of tasks) {
    if (!t.scheduled) continue;
    const occ = ((t.end - t.start) / HOUR) + (t.setupHours || 0);
    loadByMachine.set(t.machineUid, (loadByMachine.get(t.machineUid) || 0) + occ);
  }
  const downByMachine = new Map();
  for (const d of (settings.downtime || [])) {
    const m = cap.machineByIdAny(d.machineId, d.process);
    if (!m) continue;
    const s = Math.max(planStart, new Date(d.from).getTime()), e = Math.min(horizonEnd, new Date(d.to).getTime());
    if (e > s) downByMachine.set(m.uid, (downByMachine.get(m.uid) || 0) + (e - s) / HOUR);
  }
  const hotspots = [];
  for (const [uid, occ] of loadByMachine) {
    const avail = winH - (downByMachine.get(uid) || 0);
    if (avail <= 0) continue;
    const r = occ / avail;
    if (r > 0.9) hotspots.push({ uid, rate: r });
  }
  hotspots.sort((a, b) => b.rate - a.rate);
  for (const h of hotspots.slice(0, 8)) {
    const [p, id] = h.uid.split(':');
    add({ level: 'warn', type: '高负荷', rule: 'R2', machineId: id,
      title: '设备 ' + id + ' 计划占用率 ' + round(h.rate * 100, 1) + '%',
      why: '窗口内加工+换型占用接近或超过可用时长，后续插单容易被迫顺延',
      fix: '在负荷分析中查看占用构成，必要时分流到同型号设备', target: { kind: 'machine', process: p, machineId: id } });
  }
  const setupTotal = tasks.reduce((s, t) => s + (t.setupHours || 0), 0);
  if (setupTotal > 0) {
    const tierCount = tasks.filter(t => t.setupHours >= 5).length;
    if (tierCount > tasks.length * 0.15) {
      add({ level: 'info', type: '换型较多', rule: 'R5',
        title: '双维度换型 ' + tierCount + ' 次，累计换型 ' + round(setupTotal, 1) + ' 小时',
        why: '同规格连排可减少换型，但可能牺牲交期；当前策略以交期优先',
        fix: '在负荷分析中查看换型构成，或锁定关键任务后重算', target: null });
    }
  }

  const blocks = risks.filter(r => r.level === 'block');
  const warns = risks.filter(r => r.level === 'warn');
  return {
    risks, orderStats,
    counts: { block: blocks.length, warn: warns.length, info: risks.length - blocks.length - warns.length },
    canConfirm: blocks.length === 0,
  };
}
function fmt(ms) {
  const d = new Date(ms); const p = n => String(n).padStart(2, '0');
  return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}