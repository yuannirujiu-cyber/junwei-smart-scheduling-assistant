/* 诊断与可观测：结构化日志环形缓冲、全局错误边界、诊断包
   目标：生产环境下出问题时能拿到「发生了什么、什么数据、哪个版本、哪个操作者」的可复现证据，
   而不是只看到一句「页面渲染失败」。 */
import { APP_VERSION, SCHEMA_VERSION, status as persistStatus, estimate, listAudit } from './persist.js';
import { nowISO } from './util.js';

export const LOG_LIMIT = 300;
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLog() {
  const buf = [];
  let seq = 0;
  const push = (level, event, data) => {
    seq += 1;
    buf.push({ seq, at: nowISO(), level, event, data: data === undefined ? null : data });
    if (buf.length > LOG_LIMIT) buf.splice(0, buf.length - LOG_LIMIT);
  };
  return {
    debug: (e, d) => push('debug', e, d),
    info: (e, d) => push('info', e, d),
    warn: (e, d) => push('warn', e, d),
    error: (e, d) => push('error', e, d),
    list: (minLevel) => {
      const min = LEVELS[minLevel] || 0;
      return buf.filter(x => LEVELS[x.level] >= min).slice();
    },
    clear: () => { buf.length = 0; },
    counts: () => buf.reduce((a, x) => { a[x.level] = (a[x.level] || 0) + 1; return a; }, {}),
    size: () => buf.length,
  };
}
export const log = createLog();

/* ---------------- 全局错误边界 ----------------
   只记录与提示，不吞异常、不阻塞交互；同一错误去重，避免刷屏。 */
const seen = new Map();
let installed = false;

export function installErrorBoundary(onError) {
  if (installed || typeof window === 'undefined') return () => {};
  installed = true;
  const report = (kind, message, stack) => {
    const key = kind + '|' + String(message).slice(0, 160);
    const hit = seen.get(key) || 0;
    seen.set(key, hit + 1);
    log.error(kind, { message: String(message).slice(0, 400), stack: String(stack || '').split('\n').slice(0, 4).join(' | '), count: hit + 1 });
    if (hit < 3 && typeof onError === 'function') onError({ kind, message, stack, count: hit + 1 });
  };
  window.addEventListener('error', e => {
    // 资源加载失败（img/script）也走这里，统一记录
    if (e.target && e.target !== window && e.target.tagName) {
      report('resource', e.target.tagName + ' 加载失败：' + (e.target.src || e.target.href || ''), '');
      return;
    }
    report('error', e.message || '未知错误', e.error && e.error.stack);
  }, true);
  window.addEventListener('unhandledrejection', e => {
    const r = e.reason;
    report('unhandledrejection', (r && r.message) || String(r), r && r.stack);
  });
  return () => { installed = false; };
}

/* ---------------- 诊断包 ---------------- */
export async function buildDiagnosticsReport(ctx) {
  const st = ctx && ctx.store ? ctx.store.state : null;
  const v = ctx && ctx.store ? ctx.store.currentVersion : null;
  const snap = st ? st.snapshot : null;
  const cap = ctx && ctx.store ? ctx.store.cap : null;
  const est = await estimate().catch(() => null);
  const audit = await listAudit(20).catch(() => ({ ok: false, value: [] }));
  const stats = cap && cap.stats ? cap.stats() : null;
  return {
    reportAt: nowISO(),
    app: { version: APP_VERSION, schemaVersion: SCHEMA_VERSION, userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : null, language: typeof navigator !== 'undefined' ? navigator.language : null },
    /* 合并两侧状态：persistStatus 给的是「环境能力」，store.persistence 给的是「最近一次写入结果」。
       只取前者会导致面板上显示 status=undefined（实测踩过）。 */
    persistence: Object.assign({}, persistStatus(), (st && st.persistence) ? st.persistence : {}, { estimate: est }),
    dataset: snap ? {
      key: st.datasetKey, name: snap.meta && snap.meta.name, orders: (snap.orders || []).length,
      deviceSource: snap.meta && snap.meta.deviceSource, stats,
    } : null,
    settings: st ? st.settings : null,
    versions: st ? st.versions.map(x => ({ id: x.id, status: x.status, simulated: !!x.simulated, dirty: !!x.dirty, rev: x.rev || 1, fingerprint: x.fingerprint || null, tasks: (x.tasks || []).length, deliveryRate: x.metrics ? x.metrics.deliveryRate : null })) : [],
    currentVersion: v ? { id: v.id, status: v.status, tasks: (v.tasks || []).length, risks: v.validation ? v.validation.counts : null, solveMs: v.logs ? v.logs.totalMs : null } : null,
    solving: st ? st.solving : null,
    logs: log.list('debug'),
    logCounts: log.counts(),
    auditTail: audit.ok ? audit.value.slice(-20) : [],
    auditTotal: audit.ok ? audit.total : null,
  };
}

/** 诊断包序列化（默认打码订单号，避免把真实业务数据带出到工单系统） */
export function serializeDiagnostics(report, mask) {
  const clone = JSON.parse(JSON.stringify(report, (k, val) => {
    if (mask && typeof val === 'string' && /^\d{6,}/.test(val)) return val.slice(0, 3) + '***' + val.slice(-2);
    return val;
  }));
  return JSON.stringify(clone, null, 2);
}