/* 应用状态与业务动作（单一数据源 + 发布订阅） */
import { bus } from './bus.js';
import { deepClone, nowISO, uid, round } from './util.js';
import { buildCapacity } from '../engine/capacity.js';
import { buildModel } from '../engine/model.js';
import { DEFAULT_QTY_MODEL } from '../engine/mapping.js';
import { runSchedule, improveSchedule, repairWaits } from '../engine/scheduler.js';
import { runDispatchSchedule } from '../engine/dispatch.js';
import { validateSchedule } from '../engine/validate.js';
import { computeMetrics } from '../engine/metrics.js';
import { engineDefaults, seedMaterials } from '../engine/index.js';
import * as persist from './persist.js';
import { log, LOG_LIMIT } from './diagnostics.js';

function fmtLocal(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
}
export const OPERATOR = '演示计划员';
/** 生效的操作者：优先取排产设置里填写的操作者（会进审计与版本记录），否则用默认演示账户。 */
export function effectiveOperator(settings) {
  const o = settings && settings.demoParams && settings.demoParams.operator;
  return (o && String(o).trim()) || OPERATOR;
}

/**
 * 界面默认排产设置：在**引擎默认值**之上补界面专有字段。
 * 计划起点与窗口、换型模型、需求量模型、setupWeight 全部来自 engineDefaults()，
 * 这样界面、无头 CLI 与门面用的是同一份默认值，不会各排各的。
 */
function defaultSettings(snapshot) {
  const base = engineDefaults(snapshot, {});
  return {
    ...base,
    planName: '多工序订单自动排产 · 首排',
    /* 排产参考「今天」：null = 跟随系统日期（默认行为不变）；
       数据是历史窗口时，由人工指定，甘特今日高亮 / now 线 / 定位今日都用它。 */
    currentDate: null,
    timezone: 'Asia/Shanghai (UTC+8)', precisionMin: 1,
    /* 排程策略默认用《三工序排产算法设计》的前瞻派单；'order' 可切回按订单排程作对照。
       实测（真实数据 312 单）：两者任务数、准时率、延期单数一致（903 条 / 96.5% / 0 单），
       前瞻派单的换型总时长 1617 h vs 2050 h（低 21.1%），阻断风险 18 项 vs 18 项。 */
    strategy: 'dispatch',
    demoParams: { enabled: true, reason: '数据包未提供换型耗时矩阵与成品→股型工艺映射，按赛题手册「标准工时/产能口径」允许的方式使用演示参数，全部结果持续标注。', operator: OPERATOR, at: nowISO() },
    priority: {},
  };
}

/**
 * 空白数据快照：订单为空，设备与产能随后由内置产品额定数据补齐。
 * 用户只需上传订单文件后即可开始排产。
 * 结构必须与 normalizeDataset 的产物一致，这样所有视图在空白态下也走同一条渲染路径。
 */
export function blankSnapshot(meta) {
  return {
    meta: Object.assign({
      id: 'blank', name: '空白数据集', source: [], generatedAt: null,
      orderCount: 0, deviceSource: null, deviceGeneratedAt: null,
      deviceInherited: false, note: '尚未导入任何文件',
    }, meta || {}),
    orders: [],
    machines: { drawing: [], stranding: [], closing: [] },
    capacity: {
      stranding: { model: 'explicit', unit: '米/分', machineIds: [], rows: [] },
      closing: { model: 'explicit', unit: '米/分', machineIds: [], rows: [] },
    },
    specIndex: { closing: {} },
    simulationPresets: null,
  };
}

function createState() {
  return {
    ready: false,
    datasetKey: null,
    datasets: [],
    snapshot: null,
    settings: null,
    versions: [],
    currentVersionId: null,
    baselineVersionId: null,
    simulation: null,
    importer: null,
    ui: {
      route: 'workbench',
      filters: { order: {}, workbench: { process: 'all', onlyRisk: false, keyword: '' } },
      selection: { orderId: null, taskId: null, machineId: null },
      /* expanded 与 collapsed 必须同时存在：gantt.js 会读 ui.gantt.expanded[订单号] 与 ['idle:工序']，
         缺一个就会在工作台渲染时抛 TypeError（订单视角必崩、DEMO 数据设备视角也崩）。 */
      gantt: { view: 'machine', zoom: 'day', collapsed: {}, expanded: {}, orderLimit: 40, showChangeover: true, showDowntime: true },
      riskOpen: true,
      riskFilter: 'all',
      drawer: null,
      toastSeq: 0,
    },
    solving: { status: 'idle', progress: 0, message: '', startedAt: 0, elapsedMs: 0 },
    /* 生产化状态：持久化健康度、审计尾部、会话恢复提示、多标签页冲突 */
    persistence: { status: 'unknown', message: '', lastSavedAt: null, estimate: null },
    audit: [],
    auditTotal: 0,
    sessionRestored: null,
    conflict: null,
  };
}

export const store = {
  state: createState(),
  get currentVersion() { return this.state.versions.find(v => v.id === this.state.currentVersionId) || null; },
  get baselineVersion() { return this.state.versions.find(v => v.id === this.state.baselineVersionId) || null; },
  get cap() { return this._cap || (this._cap = buildCapacity(this.state.snapshot)); },
  set(patch, evt = 'state') {
    Object.assign(this.state, patch);
    bus.emit(evt, this.state);
    bus.emit('*', { evt });
  },
  setUI(patch) { Object.assign(this.state.ui, patch); bus.emit('state', this.state); },
  toast(msg, kind = '') { const seq = ++this.state.ui.toastSeq; bus.emit('toast', { msg, kind, seq }); },

  /* ---------------- 持久化、审计与并发 ---------------- */

  /** 启动时尝试恢复上次会话。返回 true 表示已恢复（调用方应跳过首排）。 */
  async initPersistence(opts) {
    const fresh = !!(opts && opts.fresh);
    const cap = persist.status();
    if (!cap.available) {
      this.state.persistence = { status: 'unavailable', message: cap.reason || '本地持久化不可用', lastSavedAt: null };
      log.warn('persist.unavailable', cap.reason);
      bus.emit('state', this.state);
      return false;
    }
    this.initChannel();
    /* 干净启动（?fresh=1）：清空本地持久化，避免出现「新版本 id 与磁盘旧版本撞车」的假冲突。 */
    if (fresh) await persist.clearAll();
    const tail = await persist.listAudit(200);
    if (tail.ok) { this.state.audit = tail.value; this.state.auditTotal = tail.total || tail.value.length; this._auditSeq = this.state.auditTotal; }
    const est = await persist.estimate();
    if (fresh) {
      this.state.persistence = { status: 'ok', message: '已按干净会话启动（本地持久化已清空）', lastSavedAt: null, estimate: est };
      log.info('persist.freshStart', { cleared: true });
      bus.emit('state', this.state);
      return false;
    }
    const sess = await persist.loadSession();
    if (!sess.ok || !sess.value || !sess.value.datasetKey) {
      this.state.persistence = { status: 'ok', message: '已启用本地持久化（无可恢复会话）', lastSavedAt: null, estimate: est };
      log.info('persist.ready', { restored: false });
      bus.emit('state', this.state);
      return false;
    }
    const snap = await persist.loadSnapshot(sess.value.datasetKey);
    if (!snap.ok || !snap.value) {
      this.state.persistence = { status: 'ok', message: '本地快照缺失，已按全新会话启动', lastSavedAt: null, estimate: est };
      bus.emit('state', this.state);
      return false;
    }
    const vers = await persist.loadAllVersions();
    const records = vers.ok ? vers.value : [];
    this._persistedVersionIds = records.map(x => x.id);
    const versions = records.map(x => x.version).filter(Boolean);
    const snapshot = normalizeDataset(snap.value);
    this._cap = buildCapacity(snapshot);
    const keepId = versions.some(v => v.id === sess.value.currentVersionId) ? sess.value.currentVersionId : null;
    this.set({
      datasetKey: sess.value.datasetKey, snapshot,
      settings: sess.value.settings || defaultSettings(snapshot),
      versions, currentVersionId: keepId, baselineVersionId: sess.value.baselineVersionId || null,
      ready: true,
      sessionRestored: { at: sess.value.savedAt, versions: versions.length, datasetKey: sess.value.datasetKey, confirmed: versions.filter(v => v.status === 'confirmed').length },
      persistence: { status: 'ok', message: '已从本地持久化恢复上次会话', lastSavedAt: sess.value.savedAt, estimate: est },
    }, 'dataset');
    log.info('persist.restored', { versions: versions.length, datasetKey: sess.value.datasetKey });
    return true;
  },

  /** 放弃恢复：清空持久化并按全新会话启动（界面上的「放弃恢复」）。 */
  async discardPersistence() {
    await persist.clearAll();
    this.state.audit = []; this.state.auditTotal = 0; this._auditSeq = 0;
    this.set({ sessionRestored: null, versions: [], currentVersionId: null, baselineVersionId: null, conflict: null,
      persistence: { status: 'ok', message: '已清空本地持久化', lastSavedAt: null, estimate: null } });
    this.audit('persistence.clear', { by: 'user' });
  },

  /** 追加一条审计记录（只增不改）。写盘失败只记日志，不影响业务动作。 */
  audit(action, detail) {
    const entry = {
      at: nowISO(), seq: ++this._auditSeq,
      by: effectiveOperator(this.state.settings),
      action, datasetKey: this.state.datasetKey, versionId: this.state.currentVersionId,
      detail: detail === undefined ? null : detail,
    };
    this.state.audit = this.state.audit.concat([entry]).slice(-LOG_LIMIT * 2);
    this.state.auditTotal += 1;
    log.info('audit.' + action, detail);
    persist.appendAudit(entry).then(r => { if (!r.ok) log.warn('audit.persistFailed', r.error); }).catch(() => {});
    return entry;
  },

  /** 落盘：会话指针 + 当前版本。返回 { ok, error }，绝不抛异常。 */
  async persistNow(reason) {
    const st = this.state;
    if (!st.snapshot) return { ok: false, error: '尚无数据快照' };
    let out = { ok: true };
    const rs = await persist.saveSession({
      datasetKey: st.datasetKey, settings: st.settings,
      currentVersionId: st.currentVersionId, baselineVersionId: st.baselineVersionId,
    });
    if (!rs.ok) out = rs;
    const v = this.currentVersion;
    if (v) { const rv = await this.persistVersion(v); if (!rv.ok) out = rv; }
    this.state.persistence = {
      status: out.ok ? 'ok' : (out.quota ? 'quota' : 'error'),
      message: out.ok ? '已保存到本地（' + (reason || '自动') + '）' : out.error,
      lastSavedAt: out.ok ? nowISO() : this.state.persistence.lastSavedAt,
      estimate: await persist.estimate(),
    };
    if (!out.ok) log.warn('persist.saveFailed', { reason, error: out.error });
    bus.emit('state', this.state);
    return out;
  },

  /** 保存单个版本，并做乐观锁校验（磁盘 rev 更大说明别的标签页已写过）。 */
  async persistVersion(v) {
    const fp = persist.versionFingerprint(v);
    v.fingerprint = fp;
    const prev = await persist.loadVersion(v.id);
    const prevRev = prev.ok && prev.value ? (prev.value.rev || 0) : 0;
    const prevSavedAt = prev.ok && prev.value ? prev.value.savedAt : null;
    const myRev = v.rev || 1;
    /* 只有「磁盘记录比本版本对象更晚写入」才是真并发冲突；
       同 id 的旧记录（例如干净启动后重新分配了同一个版本号）按覆盖处理。 */
    const newerOnDisk = prevSavedAt && v.createdAt && String(prevSavedAt).slice(0, 16) > String(v.createdAt).slice(0, 16);
    if (prevRev > myRev && newerOnDisk) {
      this.state.conflict = { at: nowISO(), versionId: v.id, kind: 'rev', diskRev: prevRev, localRev: myRev,
        msg: '版本 ' + v.id + ' 在另一个标签页被更新过（磁盘 rev ' + prevRev + ' > 本地 rev ' + myRev + '），本次保存已跳过以避免覆盖。' };
      bus.emit('state', this.state);
      return { ok: false, error: '版本冲突：磁盘 rev 更新' };
    }
    const next = { ...v, rev: Math.max(myRev, prevRev) + 1 };
    const r = await persist.saveVersion(next);
    if (r.ok) {
      v.rev = next.rev;
      this.broadcast({ type: 'version-saved', versionId: v.id, fingerprint: fp, rev: v.rev, status: v.status });
    }
    return r;
  },

  /* ---- 同源多标签页协同：发广播 + 收到别人的广播时提示冲突 ---- */
  initChannel() {
    if (typeof BroadcastChannel === 'undefined') { log.warn('channel.unavailable', 'BroadcastChannel 不可用'); return; }
    try {
      this._tabId = uid('tab');
      this._chan = new BroadcastChannel('junwei-aps');
      this._chan.onmessage = e => this.onPeerMessage(e.data);
    } catch (e) { log.warn('channel.error', String(e.message)); }
  },
  broadcast(msg) { try { if (this._chan) this._chan.postMessage({ ...msg, tabId: this._tabId, at: nowISO() }); } catch (e) { /* 忽略 */ } },
  onPeerMessage(m) {
    if (!m || m.tabId === this._tabId) return;
    const v = this.state.versions.find(x => x.id === m.versionId);
    if (!v) return;
    if (m.type === 'version-saved') {
      const mine = v.fingerprint || null;
      if (mine && m.fingerprint && mine !== m.fingerprint) {
        this.state.conflict = { at: m.at, versionId: m.versionId, kind: 'content',
          msg: '另一个标签页修改了版本 ' + m.versionId + '（内容指纹已不同）。为避免相互覆盖，请重新载入或基于当前版本复制草稿。' };
        bus.emit('state', this.state);
      }
      return;
    }
    if (m.type === 'version-confirmed') {
      this.state.conflict = { at: m.at, versionId: m.versionId, kind: 'confirmed',
        msg: '另一个标签页确认了版本 ' + m.versionId + '。本地版本列表可能已过期，建议重新载入。' };
      bus.emit('state', this.state);
    }
  },
  clearConflict() { this.state.conflict = null; bus.emit('state', this.state); },

  /* ---------------- 数据加载 ---------------- */
  async loadDataset(key, dataset, meta) {
    const snapshot = normalizeDataset(dataset, meta);
    this._cap = buildCapacity(snapshot);
    /* 不删除既有版本：按 D01 弹窗文案，旧方案标记为「基于旧数据」，其历史输入与确认记录不被覆写。
       当前版本指针置空，避免用旧数据的任务表去渲染新数据快照（审查报告 P1-10）。 */
    const kept = this.state.versions.map(v => (v.datasetKey && v.datasetKey !== key ? { ...v, basedOnOldData: true } : v));
    /* 材料库的「有无」是人工维护的现场状态：切换数据快照 / 重新导入订单时**必须保留**，
       否则每次导入订单都会把「锌锭缺料」这类设置悄悄重置掉。 */
    const nextSettings = defaultSettings(snapshot);
    if (this.state.settings && Array.isArray(this.state.settings.materials)) {
      nextSettings.materials = seedMaterials(this.state.settings.materials);
    }
    this.set({
      datasetKey: key, snapshot, settings: nextSettings,
      versions: kept,
      currentVersionId: kept.length && !kept.some(v => v.basedOnOldData) ? this.state.currentVersionId : null,
      baselineVersionId: null, simulation: null, ready: true,
      ui: { ...this.state.ui, selection: { orderId: null, taskId: null, machineId: null }, drawer: null },
    }, 'dataset');
    this.audit('dataset.load', { key, orders: snapshot.orders.length, source: snapshot.meta && snapshot.meta.name });
    persist.saveSnapshot(key, dataset, meta).then(r => { if (!r.ok) log.warn('persist.snapshotFailed', r.error); });
    this.persistNow('载入数据').catch(() => {});
    return snapshot;
  },
  /**
   * 设置排产参考「今天」。传 null 表示恢复为跟随系统日期。
   * 它只是时间轴参考线：不改排产结果，因此**不**把已有版本标记为「待重算」。
   */
  setCurrentDate(v) {
    this.state.settings.currentDate = v || null;
    bus.emit('settings', this.state);
    bus.emit('state', this.state);
    this.audit('settings.currentDate', { value: this.state.settings.currentDate });
    this.persistNow('修改当前日期').catch(() => {});
    this.toast(v ? '排产参考日期已设为 ' + v + '（仅影响时间轴参考线，不改变排产结果）' : '已恢复为系统日期', 'ok');
  },

  /* ---------------- 材料库（产品扩展） ---------------- */

  /** 整体替换材料目录（含人工维护的「有无」与库存）。 */
  setMaterials(list) {
    if (!Array.isArray(list)) return;
    this.state.settings.materials = list;
    this._mapCache = null;                 // 材料变了，用量估算的缓存必须失效
    bus.emit('settings', this.state);
    bus.emit('state', this.state);
    const off = list.filter(m => !m.available).map(m => m.id);
    /* 材料「有无」变了 → 已有计划是在旧假设下算出来的，必须标记为「存在未重算的修改」，
       否则用户可以在缺料的情况下直接确认一个订单异常的计划。与人工调整的处理口径一致。 */
    const v = this.currentVersion;
    if (v && !v.dirty) {
      v.dirty = true;
      v.status = 'draft';
      v.changes = v.changes || [];
      v.changes.push({ at: nowISO(), by: effectiveOperator(this.state.settings), note: '材料库变更（' + (off.length ? off.join('、') + ' 标记为无' : '全部恢复为有货') + '），当前计划需重算', kind: 'materials' });
      bus.emit('state', this.state);
    }
    this.audit('materials.update', { count: list.length, unavailable: off });
    this.persistNow('材料库变更').catch(() => {});
  },

  /**
   * 按订单号取工艺映射结果（材料库页用单丝直径 × 拉丝需求量估算钢材用量）。
   * 整表构建一次并缓存，避免在渲染里对每张订单重复建模型。
   */
  mappingOf(orderId) {
    const snap = this.state.snapshot;
    if (!snap) return null;
    if (!this._mapCache) {
      const m = new Map();
      try {
        const model = buildModel({ snapshot: snap, settings: this.state.settings, cap: this.cap });
        for (const j of model.jobs) m.set(j.order.id, j.mapping);
        for (const b of model.blocked) m.set(b.order.id, b.mapping);
      } catch (e) {
        log.warn('materials.mappingFailed', String(e.message));
      }
      this._mapCache = m;
    }
    return this._mapCache.get(orderId) || null;
  },

  patchSettings(patch) {
    Object.assign(this.state.settings, patch);
    bus.emit('settings', this.state);
    bus.emit('state', this.state);
  },
  rebuildCap() { this._cap = buildCapacity(this.state.snapshot); },
  /** 启动时把持久化中的版本 id 记下来，避免新版本号与之撞车。 */
  async refreshPersistedVersionIds() {
    const r = await persist.loadAllVersions();
    if (r.ok) this._persistedVersionIds = r.value.map(x => x.id);
    return this._persistedVersionIds || [];
  },
  /** 替换设备与产能数据（内置额定数据初始化）。
      与订单导入一致：既有版本标记为「基于旧数据」、保留不覆写，当前版本指针置空。 */
  applyDeviceData({ machines, capacity, source, sourceId = null, stats }) {
    /* 空白启动：还没有任何快照时，设备文件就是底座（订单槽随后补齐）。
       历史上这里直接 return null，导致「先传设备再传订单」永远无法开始（P0）。 */
    const snap = this.state.snapshot || blankSnapshot();
    const next = {
      ...snap, machines, capacity,
      specIndex: { closing: {} },   // 合绳索引由 capacity 自行按规格归一化键重建
      meta: { ...snap.meta, deviceSource: source, deviceSourceId: sourceId, deviceGeneratedAt: nowISO(), deviceStats: stats, deviceInherited: false },
    };
    this._cap = buildCapacity(next);
    const kept = this.state.versions.map(v => ({ ...v, basedOnOldData: true }));
    this.set({ snapshot: next, versions: kept, currentVersionId: null, baselineVersionId: null, ready: true }, 'dataset');
    this.audit('dataset.deviceReplace', { source, stats });
    persist.saveSnapshot(this.state.datasetKey, next, next.meta).catch(() => {});
    this.persistNow('替换设备数据').catch(() => {});
    return next;
  },

  /* ---------------- 空白启动 ---------------- */

  /** 回到空白状态：清空当前快照与内存版本，不删除已落盘的版本与审计轨迹（历史不被覆写）。 */
  resetToBlank() {
    this._cap = buildCapacity(null);
    this.set({ snapshot: blankSnapshot(), datasetKey: null,
      settings: defaultSettings(null),
      versions: [], currentVersionId: null, baselineVersionId: null, simulation: null, ready: true,
      ui: { ...this.state.ui, route: 'workbench', drawer: null, dataMapped: false,
        selection: { orderId: null, taskId: null, machineId: null } } }, 'dataset');
    this.audit('dataset.blank', {});
  },
  /** 空白启动的就绪度：订单与默认产品额定数据是否都已就位。 */
  intakeStatus() {
    const snap = this.state.snapshot;
    const cap = this.cap;
    const st = cap.stats();
    const orders = snap ? snap.orders.length : 0;
    const devices = st.drawing + st.stranding + st.closing;
    const orderPart = { ready: orders > 0, rows: orders, source: snap && (snap.meta.source || [])[0] || null, at: snap && snap.meta.generatedAt || null };
    const devicePart = { ready: devices > 0, rows: devices, source: snap && snap.meta.deviceSource || null, at: snap && snap.meta.deviceGeneratedAt || null, stats: st };
    const missing = [];
    if (!orderPart.ready) missing.push('订单文件');
    if (!devicePart.ready) missing.push('默认产品额定数据');
    return { ready: missing.length === 0, missing, orders: orderPart, devices: devicePart };
  },

  /** 版本号分配：内存 id ∪ 持久化 id，避免与磁盘上的旧版本撞车（否则会被乐观锁判成冲突而拒绝保存）。 */
  nextVersionId(localVersions) {
    const used = new Set((localVersions || []).map(v => v.id));
    for (const id of (this._persistedVersionIds || [])) used.add(id);
    let n = 1;
    while (used.has('V' + n)) n += 1;
    return 'V' + n;
  },

  /** 生成计划的门禁：D00 页内按钮与顶栏按钮必须用同一判据（审查报告 P1-3）。 */
  gate() {
    const s = this.state.settings, snap = this.state.snapshot;
    if (!snap || !s) return { ok: false, reasons: ['尚未载入数据快照'], includedActive: 0, demoOn: false };
    const active = snap.orders.filter(o => o.endCode !== '已结束');
    const included = new Set(s.includedOrderIds || snap.orders.map(o => o.id));
    const inc = active.filter(o => included.has(o.id));
    const demoOn = !!s.demoParams?.enabled;
    const reasons = [];
    if (!inc.length) reasons.push('纳入订单为 0 张');
    if (!demoOn) {
      const cm = s.changeoverModel || {};
      if (cm.minHours == null || cm.maxHours == null) reasons.push('换型耗时模型参数缺失（R5）');
      if (!active.some(o => o.duePolicy && o.duePolicy !== 'unknown')) reasons.push('客户交期政策未补录（R8）');
      if (!active.some(o => o.priority && o.priority !== '普通')) reasons.push('重点客户 / 重点订单标识缺失（R9）');
    }
    return { ok: reasons.length === 0, reasons, includedActive: inc.length, demoOn };
  },

  /* ---------------- 生成计划 ---------------- */
  async generate({ reason = '生成候选计划', baselineId = null, keepLocksFrom = null, extraOrders = [], downtime = null, settingsPatch = null, silent = false, replan = null, transient = false } = {}) {
    const t0 = performance.now();
    const snapshot = this.state.snapshot;
    /* settingsPatch 只作用于本次求解：绝不写回 state.settings。
       原先的 Object.assign 会让「模拟一下」永久改掉用户的排产设置，并且让同一张对比卡上的
       两个候选用了不同参数却不显示（审查报告 P1-5）。 */
    const s = settingsPatch ? { ...this.state.settings, ...settingsPatch } : this.state.settings;
    if (!snapshot) return null;
    this.state.solving = { status: 'running', progress: 0, message: reason, startedAt: t0, cancelRequested: false };
    bus.emit('solving', this.state.solving);

    let effectiveSnapshot = snapshot;
    if (extraOrders.length) {
      const repl = new Map(extraOrders.map(o => [o.id, o]));
      const kept = snapshot.orders.map(o => repl.get(o.id) || o);
      const added = extraOrders.filter(o => !snapshot.orders.some(x => x.id === o.id));
      effectiveSnapshot = { ...snapshot, orders: kept.concat(added) };
    }
    const included = new Set(s.includedOrderIds || effectiveSnapshot.orders.map(o => o.id));
    for (const e of extraOrders) included.add(e.id);
    const dt = downtime ?? s.downtime ?? [];

    const model = buildModel({ snapshot: effectiveSnapshot, settings: { ...s, includedOrderIds: [...included], downtime: dt, duePolicy: s.duePolicy, priorityMap: s.priority }, cap: buildCapacity(effectiveSnapshot) });

    const locks = new Map();
    const src = keepLocksFrom ? this.state.versions.find(v => v.id === keepLocksFrom) : this.currentVersion;
    /* 快速重排把“未释放”的任务临时锁住：它们保留原设备与原起止时间，
       只有影响分析明确放行的未开工任务才会交回排程器。 */
    const released = new Set(replan?.releasedTaskIds || []);
    if (replan && src) for (const t of src.tasks) {
      if (t.scheduled && !t.frozen && !t.locked && !released.has(t.id)) locks.set(t.id, t);
    }
    if (src) for (const t of src.tasks) if (t.locked && t.scheduled) locks.set(t.id, t);
    const frozen = new Map();
    if (src) for (const t of src.tasks) if (t.frozen && t.scheduled) frozen.set(t.id, t);

    await tick();
    /* 取消检查点：每个阶段之间检查一次，取消则保留旧版本并放弃本次结果（PRD 8.3）。 */
    const cancelled = () => this.state.solving.cancelRequested === true;
    /* 求解阶段统一兜底：任何未预料的异常都要变成「技术失败 + 原计划保留」，
       而不是让 Promise 直接 reject 把整个界面带崩（PRD 8.3）。 */
    let s1;
    try {
      /* 排程策略必须与门面 / CLI 用同一判据：
         原先这里写死 runSchedule，导致「排产设置 → 排程策略」在界面上改了不生效，
         界面、CLI、门面三处会给出不同的计划（典型的实现漂移）。 */
      const scheduleFn = (s.strategy || 'dispatch') === 'order' ? runSchedule : runDispatchSchedule;
      s1 = scheduleFn({ model, settings: { ...s, downtime: dt }, locks, frozen, horizonDays: s.horizonDays,
      onProgress: p => { this.state.solving.progress = p * 0.6; this.state.solving.message = reason + '：正在排产 ' + Math.round(p * 100) + '%'; bus.emit('solving', this.state.solving); } });
    if (cancelled()) { this.state.solving = { status: 'cancelled', progress: 0, message: '本次计算已取消，原计划已保留' }; bus.emit('solving', this.state.solving); this.toast('已取消计算，原计划已保留', 'warn'); return null; }
    await tick();
    this.state.solving.progress = 0.68; this.state.solving.message = reason + '：工序间隔修复（R6）'; bus.emit('solving', this.state.solving);
    } catch (e) {
      log.error('solve.failed', { message: String(e.message), stack: String(e.stack || '').slice(0, 300) });
      this.state.solving = { status: 'failed', progress: 0, message: '本次计算未完成，原计划已保留', error: String(e.message) };
      this.audit('version.failed', { reason, stage: 'schedule', message: String(e.message) });
      bus.emit('solving', this.state.solving);
      if (!silent) this.toast('本次计算未完成，原计划已保留。可在「诊断」面板查看错误详情或重试。', 'err');
      return null;
    }
    const s15 = repairWaits({ model, settings: { ...s, downtime: dt }, tasks: s1.tasks, horizonDays: s.horizonDays });
    await tick();
    this.state.solving.progress = 0.74; this.state.solving.message = reason + '：局部优化中'; bus.emit('solving', this.state.solving);
    const s2 = improveSchedule({ model, settings: { ...s, downtime: dt }, tasks: s15.tasks, horizonDays: s.horizonDays });
    await tick();
    this.state.solving.progress = 0.9; this.state.solving.message = reason + '：约束校验与指标计算'; bus.emit('solving', this.state.solving);

    if (cancelled()) { this.state.solving = { status: 'cancelled', progress: 0, message: '本次计算已取消，原计划已保留' }; bus.emit('solving', this.state.solving); this.toast('已取消计算，原计划已保留', 'warn'); return null; }
    const tasks = s2.tasks.map(t => ({ ...t }));
    // 恢复锁定/冻结标记
    for (const t of tasks) if (locks.has(t.id)) t.locked = true;
    for (const t of tasks) if (frozen.has(t.id)) t.frozen = true;

    /* baseline 必须在 try 之外声明：版本对象在 try 之后构造，块级作用域会让它不可见
       （曾因此在主路径上抛 ReferenceError: baseline is not defined）。 */
    let validation, metrics, baseline = null;
    try {
      validation = validateSchedule({ model, tasks, unscheduled: s1.unscheduled, settings: { ...s, downtime: dt }, horizonDays: s.horizonDays });
      baseline = baselineId ? this.state.versions.find(v => v.id === baselineId) : (this.state.versions.find(v => v.status === 'confirmed') || null);
      metrics = computeMetrics({ model, tasks, unscheduled: s1.unscheduled, validation, settings: { ...s, downtime: dt }, horizonDays: s.horizonDays, baseline });
    } catch (e) {
      /* 技术失败与业务不可行必须区分：这里出错说明是代码或数据结构的意外，
         保留原计划、给出可读提示与诊断线索，绝不产出一个半成品版本（PRD 8.3）。 */
      log.error('solve.postprocessFailed', { message: String(e.message), stack: String(e.stack || '').slice(0, 300) });
      this.state.solving = { status: 'failed', progress: 0, message: '本次计算未完成，原计划已保留', error: String(e.message) };
      this.audit('version.failed', { reason, stage: 'postprocess', message: String(e.message) });
      bus.emit('solving', this.state.solving);
      if (!silent) this.toast('本次计算未完成，原计划已保留。可在「诊断」面板查看错误详情或重试。', 'err');
      return null;
    }

    const version = {
      id: this.nextVersionId(this.state.versions),
      name: reason,
      status: 'draft',
      simulated: !!s.demoParams?.enabled,
      baselineId: baseline?.id ?? null,
      createdAt: nowISO(), createdBy: effectiveOperator(s),
      snapshotId: snapshot.meta?.id ?? this.state.datasetKey,
      datasetKey: this.state.datasetKey,
      dataVersion: snapshot.meta?.name ?? '—',
      settings: deepClone({ ...s, downtime: dt }),
      model: shrinkModel(model),
      tasks, unscheduled: s1.unscheduled, validation, metrics,
      excludedOrders: model.excluded.map(o => o.id),
      blockedOrders: model.blocked.map(b => ({ orderId: b.order.id, gaps: b.gaps })),
      changes: [],
      logs: { scheduleMs: Math.round(s1.elapsedMs), improve: s2.improved, waitFixed: s15.fixed, totalMs: Math.round(performance.now() - t0) },
      solveMs: Math.round(performance.now() - t0),
      simulationOf: null,
      replan: replan ? deepClone(replan) : null,
    };
    version.rev = 1;
    version.fingerprint = persist.versionFingerprint(version);
    this.state.versions.push(version);
    this.state.currentVersionId = version.id;
    this.audit('version.generate', { versionId: version.id, reason, tasks: tasks.length, onTime: metrics.onTimeOrders, block: validation.counts.block, solveMs: version.solveMs });
    if (!transient) {
      this.persistVersion(version).then(r => { if (!r.ok) log.warn('persist.versionFailed', r.error); });
      persist.saveSession({ datasetKey: this.state.datasetKey, settings: this.state.settings, currentVersionId: version.id, baselineVersionId: this.state.baselineVersionId }).catch(() => {});
    }
    this.state.solving = { status: 'done', progress: 1, message: reason + '完成，用时 ' + ((performance.now() - t0) / 1000).toFixed(1) + ' 秒', startedAt: t0, elapsedMs: performance.now() - t0 };
    bus.emit('solving', this.state.solving);
    bus.emit('state', this.state);
    if (!silent) this.toast(reason + '完成：' + metrics.scheduledOrders + ' 张订单已排产，用时 ' + ((performance.now() - t0) / 1000).toFixed(1) + ' 秒', metrics.unscheduledOrders || metrics.blockedOrders ? 'warn' : 'ok');
    return version;
  },

  /* ---------------- 人工干预 ---------------- */
  /** 若当前版本已确认，则按 D05 文案自动派生草稿后再改，已确认版本保持不可变（审查报告 P1-7）。 */
  ensureEditable() {
    const v = this.currentVersion;
    if (!v) return null;
    if (v.status === 'confirmed') {
      const draft = this.copyAsDraft(v.id);
      this.toast('已确认版本不可原地编辑，已基于 ' + v.id + ' 派生草稿 ' + draft.id + ' 并在此修改', 'ok');
      return draft;
    }
    return v;
  },
  updateTask(taskId, patch, note = '人工调整') {
    const v = this.ensureEditable(); if (!v) return;
    const t = v.tasks.find(x => x.id === taskId); if (!t) return;
    const before = { machineId: t.machineId, start: t.start, end: t.end };
    Object.assign(t, patch);
    v.changes.unshift({ at: nowISO(), by: OPERATOR, taskId, orderId: t.orderId, process: t.process,
      before, after: { machineId: t.machineId, start: t.start, end: t.end }, note });
    v.status = 'stale';   // 任何人工改动都让版本回到「待重算」，确认态不再成立
    v.dirty = true;
    this.audit('task.update', { taskId, orderId: t.orderId, process: t.process, before, after: { machineId: t.machineId, start: t.start, end: t.end }, note });
    this.persistNow('人工调整').catch(() => {});
    bus.emit('state', this.state);
  },
  toggleLock(taskId, on) {
    const v = this.ensureEditable(); if (!v) return;
    const t = v.tasks.find(x => x.id === taskId); if (!t) return;
    if (t.frozen) { this.toast('该工序已开工/完工，属于执行冻结，不能用普通解锁解除', 'err'); return; }
    t.locked = on;
    v.changes.unshift({ at: nowISO(), by: OPERATOR, taskId, orderId: t.orderId, process: t.process,
      note: on ? '锁定设备与起止时间' : '解除锁定', before: { locked: !on }, after: { locked: on } });
    this.audit(on ? 'task.lock' : 'task.unlock', { taskId, orderId: t.orderId, machineId: t.machineId, start: t.start });
    this.persistNow('锁定变更').catch(() => {});
    bus.emit('state', this.state);
    this.toast(on ? '已锁定：重算时该任务的机台与起止时间保持不变' : '已解除锁定', 'ok');
  },
  setFrozen(taskId, on) {
    const v = this.ensureEditable(); if (!v) return;
    const t = v.tasks.find(x => x.id === taskId); if (!t) return;
    t.frozen = on; if (on) t.locked = true;
    v.changes.unshift({ at: nowISO(), by: OPERATOR, taskId, orderId: t.orderId, process: t.process, note: on ? '标记为执行冻结（已开工）' : '取消执行冻结' });
    this.audit(on ? 'task.freeze' : 'task.unfreeze', { taskId, orderId: t.orderId });
    this.persistNow('执行冻结变更').catch(() => {});
    bus.emit('state', this.state);
  },
  undoLast() {
    const v = this.currentVersion;
    const c = v?.changes?.shift();
    if (!c || !c.before) { this.toast('没有可撤销的修改', 'warn'); return; }
    const t = v.tasks.find(x => x.id === c.taskId);
    if (t) Object.assign(t, c.before);
    /* 撤销后若该版本已无任何人工变更，且本次改动是唯一让它变脏的原因，则恢复为可确认；
       否则保留「待重算」（审查报告 P2-18）。 */
    const hasManual = v.changes.some(x => x.before);
    if (!hasManual && v.changes.length === 0) { v.dirty = false; v.status = 'draft'; }
    bus.emit('state', this.state);
    this.toast('已撤销：' + c.note + (v.dirty ? '（仍存在其他未重算的修改）' : '（已回到可确认状态）'), 'ok');
  },

  /* ---------------- P1 异常模拟与方案对比 ---------------- */
  async runSimulation({ type, payload }) {
    const baseline = this.baselineVersion || this.currentVersion;
    if (!baseline) { this.toast('请先生成候选计划', 'err'); return null; }
    const s = this.state.settings;
    const scope = buildReplanScope(baseline, type, payload);
    const ids = [];
    this.state.simulation = { type, payload, baselineId: baseline.id, candidateIds: [], status: 'running',
      affectedTaskIds: [...scope.direct], releasedTaskIds: [...scope.direct], expansionRounds: [] };
    bus.emit('state', this.state);
    if (type === 'material' && !this.state.snapshot.orders.some(o => o.id === payload.orderId)) {
      this.toast('未找到订单 ' + payload.orderId, 'err'); return null;
    }
    const opts = type === 'rush'
      ? { extraOrders: [Object.assign({}, payload.order, { rush: true, priority: payload.order.priority || '重点订单' })] }
      : type === 'breakdown'
        ? { downtime: (s.downtime || []).concat([{ machineId: payload.machineId, process: payload.process, from: payload.from, to: payload.to, reason: payload.reason || '设备故障' }]) }
        : { extraOrders: [Object.assign({}, this.state.snapshot.orders.find(o => o.id === payload.orderId), { materialReadyAt: payload.newReadyAt })] };

    let released = new Set(scope.direct), candidate = null;
    for (const round of scope.rounds) {
      for (const id of round.taskIds) released.add(id);
      const replan = { type, affectedTaskIds: [...scope.direct], releasedTaskIds: [...released], expansionRounds: scope.rounds
        .filter(x => x.index <= round.index).map(x => ({ index: x.index, reason: x.reason, taskIds: x.taskIds })), round: round.index };
      const v = await this.generate({ reason: '快速重排 · ' + round.label, baselineId: baseline.id, silent: true, keepLocksFrom: baseline.id, replan, transient: true, ...opts });
      if (!v) break;
      v.simulationOf = baseline.id; v.simulationType = type;
      v.replan = { ...replan, ...summarizeReplan(baseline, v) };
      this.persistVersion(v).catch(() => {});
      const success = replanTargetScheduled(v, type, payload, scope.direct);
      /* 设备故障的首轮只释放了停机窗口内的直接任务。即使它们已经能被排上，
         也必须再释放同机台的后续队列，才能让延误沿资源顺序传递；否则后续任务
         被锁死，直接任务会被错误地塞到很久以后的队尾，造成“少数订单超长延期”。 */
      const needsResourceCascade = type === 'breakdown' && round.index === 1 && (scope.rounds[1]?.taskIds.length || 0) > 0;
      if (success && !needsResourceCascade) { candidate = v; ids.push(v.id); break; }
      this.state.versions = this.state.versions.filter(x => x.id !== v.id);
    }
    const finalReplan = candidate?.replan || { type, affectedTaskIds: [...scope.direct], releasedTaskIds: [...released], expansionRounds: [] };
    this.state.simulation = { type, payload, baselineId: baseline.id, candidateIds: ids, status: ids.length ? 'done' : 'empty', ...finalReplan };
    this.state.currentVersionId = baseline.id;
    this.audit('simulation.quickReplan', { baseline: baseline.id, type, candidateIds: ids, affected: finalReplan.affectedTaskIds.length,
      released: finalReplan.releasedTaskIds.length, rounds: finalReplan.expansionRounds.map(x => ({ index: x.index, reason: x.reason, tasks: x.taskIds.length })) });
    bus.emit('state', this.state);
    return this.state.simulation;
  },
  /**
   * 一键收敛：反复「排除阻断订单 → 重算」，直到可确认或无法再排除（有界）。
   * 排除集合只增不减，因此必然终止；中间版本会被清理，只保留最终版本，
   * 避免版本列表被 5 个中间草稿淹没（审查报告 P0-2 的可操作性修复）。
   */
  async autoResolveBlocks({ maxRounds = 8 } = {}) {
    const all = this.state.snapshot.orders.map(o => o.id);
    const created = [];
    let excluded = 0, rounds = 0, v = this.currentVersion;
    for (let i = 0; i < maxRounds; i++) {
      if (!v || v.validation.canConfirm) break;
      const blockIds = new Set(v.blockedOrders.map(b => b.orderId));
      for (const r of v.validation.risks) if (r.level === 'block' && r.orderId) blockIds.add(r.orderId);
      const cur = new Set(this.state.settings.includedOrderIds || all);
      let n = 0;
      for (const id of blockIds) if (cur.delete(id)) n++;
      if (!n) break;
      excluded += n; rounds++;
      this.state.settings.includedOrderIds = cur.size === all.length ? null : [...cur];
      v = await this.generate({ reason: '自动收敛第 ' + (i + 1) + ' 轮', silent: true });
      if (v) created.push(v.id);
    }
    if (created.length) {
      /* 只保留最后一次自动收敛的版本：中间草稿（含此前调用遗留的）全部清掉，
         否则「一键收敛」跑几次就会把版本列表淹没。 */
      const keep = created[created.length - 1];
      this.state.versions = this.state.versions.filter(x => !x.name.startsWith('自动收敛') || x.id === keep);
      this.state.currentVersionId = keep;
    }
    this.audit('version.autoResolve', { rounds, excluded, canConfirm: !!v?.validation.canConfirm, blockLeft: v?.validation.counts.block ?? 0 });
    this.persistNow('一键收敛').catch(() => {});
    bus.emit('state', this.state);
    return { rounds, excluded, canConfirm: !!v?.validation.canConfirm, version: v, blockLeft: v?.validation.counts.block ?? 0 };
  },
  adoptCandidate(id) {
    const v = this.state.versions.find(x => x.id === id);
    if (!v) return;
    v.status = 'draft'; v.dirty = false;
    v.name = '采用模拟方案（基线 ' + (v.simulationOf || '—') + '）';
    this.state.currentVersionId = id;
    this.state.simulation = null;
    this.audit('simulation.adopt', { versionId: id, baseline: v.simulationOf || null, type: v.simulationType || null });
    this.persistNow('采用模拟方案').catch(() => {});
    bus.emit('state', this.state);
    this.toast('已采用模拟方案 ' + id + '，创建为待确认版本；基线版本保持不变', 'ok');
  },
  requestCancel() { if (this.state.solving.status === 'running') { this.state.solving.cancelRequested = true; bus.emit('solving', this.state.solving); } },
  cancelSimulation() { this.state.simulation = null; bus.emit('state', this.state); this.toast('已取消模拟，保留当前已确认版本', 'ok'); },

  /* ---------------- 版本 ---------------- */
  confirmVersion({ acknowledgeLate = false, note = '' } = {}) {
    const v = this.currentVersion; if (!v) return null;
    if (!v.validation.canConfirm) { this.toast('存在 ' + v.validation.counts.block + ' 项阻断问题，无法确认版本', 'err'); return null; }
    if (v.dirty) { this.toast('存在未重算的修改，请先重算再确认', 'err'); return null; }
    const softLate = v.metrics.lateOrders > 0 || v.validation.risks.some(r => r.type === '宽限内延期');
    if (softLate && !acknowledgeLate) { this.toast('存在延期订单，需勾选「已知晓」后才能确认', 'err'); return null; }
    for (const o of this.state.versions) if (o.status === 'confirmed') o.status = 'superseded';
    v.status = 'confirmed'; v.confirmedAt = nowISO(); v.confirmedBy = effectiveOperator(this.state.settings);
    this.audit('version.confirm', { versionId: v.id, note, acknowledgeLate: !!acknowledgeLate,
      fingerprint: v.fingerprint || persist.versionFingerprint(v), simulated: !!v.simulated,
      onTime: v.metrics.onTimeOrders, total: v.metrics.orderCount, late: v.metrics.lateOrders, block: v.validation.counts.block });
    this.broadcast({ type: 'version-confirmed', versionId: v.id });
    this.persistNow('确认版本').catch(() => {});
    v.confirmNote = note;
    v.acknowledgeLate = acknowledgeLate;
    bus.emit('state', this.state);
    this.toast('版本 ' + v.id + ' 已确认' + (v.simulated ? '（模拟参数版本，导出文件将持续标注）' : ''), 'ok');
    return v;
  },
  copyAsDraft(fromId) {
    const src = this.state.versions.find(v => v.id === fromId); if (!src) return null;
    const v = deepClone(src);
    v.id = 'V' + (this.state.versions.length + 1);
    v.name = src.name + ' · 基于 ' + src.id + ' 调整';
    v.status = 'draft'; v.dirty = true;
    v.baselineId = src.id; v.createdAt = nowISO(); v.confirmedAt = null; v.confirmedBy = null;
    v.changes = [{ at: nowISO(), by: OPERATOR, note: '基于已确认版本 ' + src.id + ' 复制为草稿' }];
    v.rev = 1;
    v.fingerprint = persist.versionFingerprint(v);
    this.state.versions.push(v);
    this.state.currentVersionId = v.id;
    this.audit('version.copyAsDraft', { from: src.id, to: v.id });
    this.persistVersion(v).catch(() => {});
    bus.emit('state', this.state);
    this.toast('已复制为草稿 ' + v.id + '，原版本 ' + src.id + ' 保持不变', 'ok');
    return v;
  },
  setCurrent(id) { this.state.currentVersionId = id; bus.emit('state', this.state); },
  setBaseline(id) { this.state.baselineVersionId = id; bus.emit('state', this.state); },
};

/* ---------------- 辅助 ---------------- */
const tick = () => new Promise(r => setTimeout(r, 16));

/* 快速重排的影响范围。基线之外的任务会被临时锁定；这里仅产出允许释放的任务集合。 */
function buildReplanScope(base, type, payload) {
  const movable = base.tasks.filter(t => t.scheduled && !t.locked && !t.frozen);
  const direct = new Set();
  let anchor = new Date(base.settings?.planStart || 0).getTime();
  if (type === 'breakdown') {
    const from = new Date(payload.from).getTime(), to = new Date(payload.to).getTime(); anchor = from;
    // 仅释放实际与停机窗口相交的任务。此前只按 “结束晚于停机开始” 判断，
    // 会将数天后才开工的同机台任务一并重排，夸大逐单时间影响。
    for (const t of movable) {
      const overlapsDowntime = t.start < to && t.end > from;
      if (String(t.machineId) === String(payload.machineId) && overlapsDowntime) direct.add(t.id);
    }
  } else if (type === 'material') {
    let first = Infinity;
    for (const t of movable) if (t.orderId === payload.orderId) { direct.add(t.id); first = Math.min(first, t.start); }
    if (Number.isFinite(first)) anchor = first;
  } else {
    anchor = new Date(payload.order.preShipDate || base.settings?.planStart || 0).getTime();
  }
  const directTasks = movable.filter(t => direct.has(t.id));
  const machines = new Set(directTasks.map(t => t.machineId));
  const relatedOrders = new Set(directTasks.map(t => t.orderId));
  const resource = new Set();
  for (const t of movable) {
    const rushWindow = type === 'rush' && t.start < anchor;
    if ((machines.has(t.machineId) && t.start >= anchor) || rushWindow) resource.add(t.id);
  }
  const dependencies = new Set();
  for (const t of movable) if (relatedOrders.has(t.orderId) || (machines.has(t.machineId) && t.start >= anchor)) dependencies.add(t.id);
  const without = (set, previous) => [...set].filter(id => !previous.has(id));
  const stage1 = new Set(direct);
  const stage2 = new Set([...stage1, ...resource]);
  const stage3 = new Set([...stage2, ...dependencies]);
  return {
    direct,
    rounds: [
      { index: 1, label: '直接受影响任务', reason: '仅释放异常直接影响的未开工任务', taskIds: [...stage1] },
      { index: 2, label: '同设备冲突任务', reason: '局部无解，释放同设备后续冲突任务', taskIds: without(stage2, stage1) },
      { index: 3, label: '工序依赖任务', reason: '仍无解，释放关联订单与工序依赖任务', taskIds: without(stage3, stage2) },
    ],
  };
}

function replanTargetScheduled(version, type, payload, direct) {
  if (type === 'rush') {
    const closing = version.tasks.find(t => t.scheduled && t.orderId === payload.order.id && t.process === 'closing');
    const due = new Date(payload.order.preShipDate).getTime();
    return !!closing && (!Number.isFinite(due) || closing.end <= due);
  }
  if (type === 'material') return version.tasks.some(t => t.scheduled && t.orderId === payload.orderId && t.process === 'closing');
  const from = new Date(payload.from).getTime(), to = new Date(payload.to).getTime();
  return [...direct].every(id => {
    const t = version.tasks.find(x => x.scheduled && x.id === id);
    return t && (t.end <= from || t.start >= to);
  });
}

function summarizeReplan(base, candidate) {
  const before = new Map(base.tasks.filter(t => t.scheduled).map(t => [t.id, t]));
  const changed = [], changedOrders = new Set(); let movedMachines = 0;
  for (const t of candidate.tasks.filter(t => t.scheduled)) {
    const b = before.get(t.id);
    if (!b) continue;
    if (b.machineId !== t.machineId || b.start !== t.start || b.end !== t.end) {
      changed.push({ taskId: t.id, orderId: t.orderId, process: t.process, before: { machineId: b.machineId, start: b.start, end: b.end }, after: { machineId: t.machineId, start: t.start, end: t.end } });
      changedOrders.add(t.orderId);
      if (b.machineId !== t.machineId) movedMachines++;
    }
  }
  return { changedTaskIds: changed.map(x => x.taskId), changedOrderIds: [...changedOrders], changedTasks: changed,
    unchangedTaskCount: before.size - changed.length, movedMachineCount: movedMachines };
}

export function normalizeDataset(raw, meta) {
  const orders = (raw.orders || []).map(o => ({ ...o, id: String(o.id), endCode: o.endCode || '未结束' }));
  return {
    meta: { ...(raw.meta || {}), ...(meta || {}) },
    orders,
    machines: raw.machines || { drawing: [], stranding: [], closing: [] },
    capacity: raw.capacity || { stranding: {}, closing: {} },
    specIndex: raw.specIndex || { closing: {} },
    simulationPresets: raw.simulationPresets || null,
  };
}
function shrinkModel(model) {
  return {
    qtyModel: model.qtyModel,
    active: model.active.map(o => ({ ...o })),
    blocked: model.blocked.map(b => ({ orderId: b.order.id, gaps: b.gaps })),
    excluded: model.excluded.map(o => o.id),
    historyCount: model.history.length,
  };
}
