/* 通用工具：时间、数值、格式化、ID */
export const HOUR = 3600000;
export const DAY = 86400000;
export const WAIT_LIMIT_H = 72;          // R6：相邻工序等待上限（连续小时）

let _seq = 0;
export const uid = (p = 'id') => p + '-' + (++_seq).toString(36) + '-' + Math.random().toString(36).slice(2, 7);

/* ---------- 时间 ---------- */
export function toDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) return isNaN(v) ? null : v;
  if (typeof v === 'number') return new Date(v);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
export const isValidDate = v => toDate(v) !== null;
const p2 = n => String(n).padStart(2, '0');
export function fmtDate(d) { d = toDate(d); return d ? d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()) : '—'; }
export function fmtDateTime(d) { d = toDate(d); return d ? fmtDate(d) + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()) : '—'; }
export function fmtTime(d) { d = toDate(d); return d ? p2(d.getHours()) + ':' + p2(d.getMinutes()) : '—'; }
export function fmtMD(d) { d = toDate(d); return d ? (d.getMonth() + 1) + '/' + d.getDate() : '—'; }
/** 交期展示：仅日期时按工厂本地当日 24:00 排他边界（PRD 5.3） */
export function dueBoundary(preShipDate) {
  const d = toDate(preShipDate);
  if (!d) return null;
  if (/[T ]\d{2}:\d{2}/.test(String(preShipDate))) return d;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 0, 0);
}
export function startOfDay(d) { d = toDate(d) || new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
export function addDays(d, n) { const x = new Date(toDate(d)); x.setDate(x.getDate() + n); return x; }
export function addHours(d, h) { return new Date(toDate(d).getTime() + h * HOUR); }
export function isWeekend(d) { const w = toDate(d).getDay(); return w === 0 || w === 6; }
export function diffHours(a, b) { const x = toDate(a), y = toDate(b); return (x && y) ? (x - y) / HOUR : null; }
/**
 * 排产参考「今天」。
 *
 * 数据是历史窗口（例如 2026-08 的计划）时，系统真实日期往往落在窗口之外，
 * 甘特图的今日高亮、now 线与「定位今日」就全都没有落点。
 * 因此允许人工指定一个参考日期（settings.currentDate，YYYY-MM-DD）；
 * 未指定时使用本项目的默认排产参考日期 2026-08-03，保证演示数据的时间轴始终落在计划窗口内。
 *
 * 注意它是**参考线**：只影响时间轴的显示与定位，不参与排产约束、不改变任何任务。
 */
export function todayOf(settings) {
  const raw = settings && settings.currentDate;
  if (raw) {
    const d = toDate(raw);
    if (d && !isNaN(d.getTime())) return d;
  }
  return new Date(2026, 7, 3);
}

/** 参考日期是否为人工指定（用于界面标注「模拟」） */
export function isTodaySimulated(settings) {
  const raw = settings && settings.currentDate;
  if (!raw) return false;
  const d = toDate(raw);
  return !!(d && !isNaN(d.getTime()) && fmtDate(d) !== fmtDate(new Date()));
}

export function nowISO() { return fmtDateTime(new Date()); }

export function fmtDur(hours) {
  if (hours == null || isNaN(hours)) return '—';
  const neg = hours < 0; let h = Math.abs(hours);
  const d = Math.floor(h / 24); h -= d * 24;
  const hh = Math.floor(h); const mm = Math.round((h - hh) * 60);
  let s = '';
  if (d) s += d + '天';
  if (hh) s += hh + '小时';
  if (mm && !d) s += mm + '分';
  if (!s) s = '0';
  return (neg ? '-' : '') + s;
}
export function fmtMin(min) {
  if (min == null || isNaN(min)) return '—';
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? (m ? h + '小时' + m + '分' : h + '小时') : m + '分';
}

/* ---------- 数值 ---------- */
export const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[,，\s]/g, '')); return isNaN(n) ? null : n; };
export const round = (v, n = 2) => { const f = 10 ** n; return Math.round((v + Number.EPSILON) * f) / f; };
export const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
export const sum = a => a.reduce((x, y) => x + y, 0);
export const avg = a => a.length ? sum(a) / a.length : null;
export const pct = (a, b, d = 1) => (b ? round(a / b * 100, d) : null);
export const fmtNum = (v, d = 0) => (v == null || isNaN(v)) ? '—' : Number(v).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
export const fmtPct = (v, d = 1) => v == null || isNaN(v) ? '—' : round(v, d) + '%';
export function uniqBy(arr, fn) { const s = new Set(); return arr.filter(x => { const k = fn(x); if (s.has(k)) return false; s.add(k); return true; }); }
export function groupBy(arr, fn) { const m = new Map(); for (const x of arr) { const k = fn(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); } return m; }
export function sortBy(arr, fn, dir = 1) { return arr.slice().sort((a, b) => { const x = fn(a), y = fn(b); if (x == null && y == null) return 0; if (x == null) return 1; if (y == null) return -1; return x < y ? -dir : x > y ? dir : 0; }); }
export function debounce(fn, ms = 220) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
/** 深拷贝：必须保留 Set/Map/Date。原先的 JSON 往返会把 Set 变成 {}（空对象为真值），
    导致 capacity.js 里 `row.caps.has(...)` 抛 TypeError —— 见审查报告 P1-6。 */
export function deepClone(o) {
  if (o == null || typeof o !== 'object') return o;
  if (typeof structuredClone === 'function') {
    try { return structuredClone(o); } catch (e) { /* 含不可克隆值时退回手写实现 */ }
  }
  return cloneDeep(o, new WeakMap());
}
function cloneDeep(v, seen) {
  if (v == null || typeof v !== 'object') return v;
  if (v instanceof Date) return new Date(v.getTime());
  if (v instanceof Set) return new Set([...v].map(x => cloneDeep(x, seen)));
  if (v instanceof Map) return new Map([...v].map(([k, x]) => [k, cloneDeep(x, seen)]));
  if (Array.isArray(v)) return v.map(x => cloneDeep(x, seen));
  if (seen.has(v)) return seen.get(v);
  const out = {};
  seen.set(v, out);
  for (const k of Object.keys(v)) out[k] = cloneDeep(v[k], seen);
  return out;
}
export function seeded(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
export const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function downloadBlob(blob, filename) {
  const a = document.createElement('a'); const url = URL.createObjectURL(blob);
  a.href = url; a.download = filename; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 400);
}
export function pick(obj, keys) { const o = {}; for (const k of keys) o[k] = obj?.[k]; return o; }
/** CSV 单元格：必须同时处理 \r（否则孤立 CR 会把 1 条记录切成 2 条），
    并对以 = + - @ 制表符开头的值做公式注入中和（审查报告 §5.2）。 */
export function csvCell(v) {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
export function toCSV(rows) { return '\ufeff' + rows.map(r => r.map(csvCell).join(',')).join('\r\n'); }
