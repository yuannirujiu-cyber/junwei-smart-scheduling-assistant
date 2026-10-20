/* 持久化层（IndexedDB）
   目标：把「确认版本」这类审计动作从「刷新即归零」变成可恢复的持久状态。

   设计原则
   1. 绝不因为持久化失败而影响排产主流程：所有 API 都返回 { ok, error }，不向调用方抛异常。
   2. 环境不支持（无 indexedDB / 隐私模式 / 配额耗尽）时降级为内存态，并把原因如实暴露给界面。
   3. 带 schema 版本：版本不匹配时按策略处理（可迁移则迁移，否则丢弃并给出可读原因），不静默读坏数据。
   4. 审计日志只追加：提供 append + 读取 + 导出，不提供修改与删除单条的能力。

   对象仓库
     meta      key: 'schema'          结构版本与写入时间
     snapshots key: <datasetKey>      数据快照（订单 + 设备 + 产能）
     versions  key: <versionId>       方案版本（含 tasks / metrics / validation）
     session   key: 'current'         当前会话指针（datasetKey / 当前版本 / 基线 / 设置）
     audit     autoIncrement          追加式审计日志
*/

export const SCHEMA_VERSION = 1;
export const APP_VERSION = '1.1.0';
export const AUDIT_LIMIT = 2000;      // 内存中保留的审计条数上限（磁盘不设上限）

const DB_NAME = 'junwei-aps';
const STORES = { meta: 'meta', snapshots: 'snapshots', versions: 'versions', session: 'session', audit: 'audit' };

let dbPromise = null;
let unavailableReason = null;

/** 环境能力探测（不抛异常） */
export function capability() {
  if (typeof indexedDB === 'undefined' || indexedDB === null) return { ok: false, reason: '当前环境不支持 IndexedDB（可能处于隐私模式）' };
  return { ok: true, reason: null };
}

function openDb() {
  if (dbPromise) return dbPromise;
  const cap = capability();
  if (!cap.ok) { unavailableReason = cap.reason; return Promise.resolve(null); }
  dbPromise = new Promise(resolve => {
    let req;
    try { req = indexedDB.open(DB_NAME, SCHEMA_VERSION); }
    catch (e) { unavailableReason = '打开本地数据库失败：' + e.message; resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const name of Object.values(STORES)) {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, name === STORES.audit ? { autoIncrement: true } : { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { unavailableReason = '打开本地数据库失败：' + (req.error && req.error.message); resolve(null); };
    req.onblocked = () => { unavailableReason = '本地数据库被其它标签页占用，暂时无法升级'; resolve(null); };
  });
  return dbPromise;
}

function tx(db, store, mode, fn) {
  return new Promise(resolve => {
    let t;
    try { t = db.transaction(store, mode); } catch (e) { resolve({ ok: false, error: e.message }); return; }
    const os = t.objectStore(store);
    let out;
    try { out = fn(os); } catch (e) { resolve({ ok: false, error: e.message }); return; }
    t.oncomplete = () => resolve({ ok: true, value: out && out.result !== undefined ? out.result : out });
    t.onerror = () => resolve({ ok: false, error: (t.error && t.error.message) || '事务失败' });
    t.onabort = () => resolve({ ok: false, error: (t.error && t.error.message) || '事务被中止' });
  });
}

/** 写一条记录；配额不足时返回可读错误（由调用方决定是否降级） */
export async function put(store, value) {
  const db = await openDb();
  if (!db) return { ok: false, error: unavailableReason || '本地数据库不可用' };
  const r = await tx(db, store, 'readwrite', os => os.put(value));
  if (!r.ok && /quota|storage/i.test(String(r.error))) {
    return { ok: false, error: '本地存储配额不足，已暂停持久化', quota: true };
  }
  return r;
}

export async function get(store, key) {
  const db = await openDb();
  if (!db) return { ok: false, error: unavailableReason || '本地数据库不可用' };
  return tx(db, store, 'readonly', os => os.get(key));
}

export async function getAll(store) {
  const db = await openDb();
  if (!db) return { ok: false, error: unavailableReason || '本地数据库不可用' };
  return tx(db, store, 'readonly', os => os.getAll());
}

export async function del(store, key) {
  const db = await openDb();
  if (!db) return { ok: false, error: unavailableReason || '本地数据库不可用' };
  return tx(db, store, 'readwrite', os => os.delete(key));
}

export async function clearStore(store) {
  const db = await openDb();
  if (!db) return { ok: false, error: unavailableReason || '本地数据库不可用' };
  return tx(db, store, 'readwrite', os => os.clear());
}

/** 全量清空（诊断面板的「清空持久化」） */
export async function clearAll() {
  const out = {};
  for (const s of Object.values(STORES)) out[s] = await clearStore(s);
  return out;
}

export async function estimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const e = await navigator.storage.estimate();
      return { usage: e.usage, quota: e.quota, ratio: e.quota ? e.usage / e.quota : null };
    }
  } catch (e) { /* 忽略 */ }
  return null;
}

/* ---------------- 内容指纹 ----------------
   用途：版本变更比对与「同一版本内容是否被改过」的自检。
   算法：FNV-1a 32 位，对规范化 JSON 串取两轮（不同偏移）拼成 64 位十六进制。
   说明：这是**内容指纹**，不是加密签名——界面上如实标注，不声称防篡改。 */
export function fingerprint(value) {
  const text = canonical(value);
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** 规范化 JSON：对象键排序，保证同一内容得到同一指纹 */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value instanceof Set) return '[' + [...value].map(canonical).join(',') + ']';
  if (value instanceof Map) return '{' + [...value.entries()].map(([k, v]) => JSON.stringify(String(k)) + ':' + canonical(v)).join(',') + '}';
  const keys = Object.keys(value).filter(k => typeof value[k] !== 'function' && value[k] !== undefined).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

/** 版本内容指纹：只覆盖「会进入导出与审计」的部分，避免把运行时噪声算进去 */
export function versionFingerprint(v) {
  if (!v) return null;
  return fingerprint({
    id: v.id, status: v.status, simulated: !!v.simulated,
    tasks: (v.tasks || []).map(t => [t.id, t.machineId, t.start, t.end, t.setupHours || 0, !!t.locked, !!t.frozen]),
    excludedOrders: (v.excludedOrders || []).slice().sort(),
    settings: { planStart: v.settings && v.settings.planStart, horizonDays: v.settings && v.settings.horizonDays },
  });
}

/* ---------------- 便捷封装 ---------------- */

export async function saveSnapshot(key, dataset, meta) {
  return put(STORES.snapshots, { id: key, savedAt: new Date().toISOString(), meta: meta || {}, dataset });
}
export async function loadSnapshot(key) {
  const r = await get(STORES.snapshots, key);
  if (!r.ok) return r;
  if (!r.value) return { ok: true, value: null };
  return { ok: true, value: r.value.dataset, savedAt: r.value.savedAt, meta: r.value.meta };
}
export async function listSnapshots() {
  const r = await getAll(STORES.snapshots);
  if (!r.ok) return r;
  return { ok: true, value: (r.value || []).map(x => ({ id: x.id, savedAt: x.savedAt, orders: x.dataset && x.dataset.orders ? x.dataset.orders.length : 0, meta: x.meta })) };
}

export async function saveVersion(v) {
  return put(STORES.versions, { id: v.id, savedAt: new Date().toISOString(), rev: v.rev || 1, fingerprint: versionFingerprint(v), version: v });
}
export async function loadVersion(id) {
  const r = await get(STORES.versions, id);
  if (!r.ok) return r;
  return { ok: true, value: r.value || null };
}
export async function loadAllVersions() {
  const r = await getAll(STORES.versions);
  if (!r.ok) return r;
  return { ok: true, value: (r.value || []).sort((a, b) => String(a.id).localeCompare(String(b.id))) };
}
export async function deleteVersionRecord(id) { return del(STORES.versions, id); }

export async function saveSession(s) {
  return put(STORES.session, Object.assign({ id: 'current', savedAt: new Date().toISOString() }, s));
}
export async function loadSession() {
  const r = await get(STORES.session, 'current');
  if (!r.ok) return r;
  return { ok: true, value: r.value || null };
}

/** 追加审计条目（只增不改） */
export async function appendAudit(entries) {
  const list = Array.isArray(entries) ? entries : [entries];
  const db = await openDb();
  if (!db) return { ok: false, error: unavailableReason || '本地数据库不可用' };
  return tx(db, STORES.audit, 'readwrite', os => { for (const e of list) os.add(e); return list.length; });
}
export async function listAudit(limit) {
  const r = await getAll(STORES.audit);
  if (!r.ok) return r;
  const all = (r.value || []).sort((a, b) => String(a.at).localeCompare(String(b.at)) || (a.seq || 0) - (b.seq || 0));
  return { ok: true, value: limit ? all.slice(-limit) : all, total: all.length };
}
export async function clearAudit() { return clearStore(STORES.audit); }

export function status() {
  return { available: capability().ok, reason: unavailableReason, schemaVersion: SCHEMA_VERSION, appVersion: APP_VERSION };
}
