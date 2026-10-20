/* 极简视图层：HTML 模板 + 事件委托 + 图标 */

const RAW = Symbol('raw');
/* raw 包装：既带 RAW 标记（模板插值时原样输出），也带 toString/valueOf
   （万一被用于字符串拼接，至少得到原文而不是 "[object Object]"）。 */
export const raw = s => {
  if (isRaw(s)) return s;
  const text = s == null ? '' : String(s);
  const o = { [RAW]: text };
  o.toString = () => text;
  o.valueOf = () => text;
  return o;
};
const isRaw = v => v && typeof v === 'object' && RAW in v;

function str(v) {
  if (v == null || v === false || v === true) return '';
  if (isRaw(v)) return v[RAW];
  if (Array.isArray(v)) return v.map(str).join('');
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/** 自动转义的模板字符串：html\`<b>${name}</b>\` */
export function html(strings, ...vals) {
  let out = strings[0];
  for (let i = 0; i < vals.length; i++) out += str(vals[i]) + strings[i + 1];
  // 返回带 RAW 标记的 String 包装对象：
  //  - 作为 innerHTML 赋值时通过 toString 自动还原为字符串；
  //  - 作为内层模板插入外层模板时被 isRaw 识别，不再被二次转义（关键）
  return markRaw(out);
}
function markRaw(s) {
  const o = new String(s);
  o[RAW] = s;
  o.toString = () => s;
  o.valueOf = () => s;
  return o;
}
export const esc = str;

/** 创建元素 */
export function el(tag, attrs = {}, ...kids) {
  const m = /^([a-zA-Z0-9-]+)([.#][^.#]*)*$/.exec(tag) || [];
  const node = document.createElement(m[1] || 'div');
  const cls = [...tag.matchAll(/\.([^.#]+)/g)].map(x => x[1]);
  const id = /#([^.#]+)/.exec(tag);
  if (cls.length) node.className = cls.join(' ');
  if (id) node.id = id[1];
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = [node.className, v].filter(Boolean).join(' ');
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'html') node.innerHTML = String(v);
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  add(node, kids);
  return node;
}
export function add(node, kids) {
  for (const k of kids.flat(9)) {
    if (k == null || k === false || k === true || k === '') continue;
    node.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return node;
}
export const frag = (...kids) => add(document.createDocumentFragment(), kids);
export const qs = (sel, root = document) => root.querySelector(sel);
export const qsa = (sel, root = document) => [...root.querySelectorAll(sel)];
export function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); return node; }
export function setHTML(node, s) { node.innerHTML = String(s); return node; }

/* 原生可交互元素：这些不需要补 role/tabindex，也不吃 keydown 合成点击 */
const NATIVE_INTERACTIVE = ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY'];

/**
 * 把「可点击但不是原生控件」的 data-act 元素补成可键盘操作：role=button + tabindex=0。
 * 侧边导航、指标卡、风险项、工序链节点都是 div，鼠标能点但键盘永远到不了——
 * 这个函数在每次渲染后统一补齐，避免逐个组件漏改。已有 role/tabindex 的元素不动。
 * 返回补齐的元素个数，便于自检断言。
 */
export function enhanceInteractive(root) {
  if (!root || !root.querySelectorAll) return 0;
  let n = 0;
  qsa('[data-act]', root).forEach(node => {
    if (NATIVE_INTERACTIVE.includes(node.tagName)) return;
    if (node.getAttribute('aria-hidden') === 'true') return;
    if (!node.hasAttribute('role')) node.setAttribute('role', 'button');
    if (!node.hasAttribute('tabindex')) node.setAttribute('tabindex', '0');
    n++;
  });
  return n;
}

/** 事件委托：在 root 上监听 [data-act]，回调 map[act](event, element, dataset)。
    click 通道同时注册 keydown：非原生控件上的 Enter / Space 合成一次点击。 */
export function delegate(root, map, type = 'click') {
  const handler = e => {
    const t = e.target.closest('[data-act]');
    if (!t || !root.contains(t)) return;
    // 表单控件交给 input/change 通道处理：click 阶段读到的是变更前的值
    const tag = t.tagName;
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const fn = map[t.dataset.act];
    if (fn) { e.preventDefault(); fn(e, t, t.dataset); }
  };
  root.addEventListener(type, handler);
  let keyHandler = null;
  if (type === 'click') {
    keyHandler = e => {
      if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
      /* 已经有别的处理器处理过这一次按键（例如甘特图自己把 Enter 合成为 click）就不再重复触发，
         否则同一次 Enter 会开两次抽屉：第二次的 activeElement 已经在抽屉里，
         触发元素被记成 body，关闭时焦点就回不到原处。 */
      if (e.defaultPrevented) return;
      const t = e.target.closest('[data-act]');
      if (!t || !root.contains(t)) return;
      if (NATIVE_INTERACTIVE.includes(t.tagName)) return;
      const fn = map[t.dataset.act];
      if (fn) { e.preventDefault(); fn(e, t, t.dataset); }
    };
    root.addEventListener('keydown', keyHandler);
  }
  return () => {
    root.removeEventListener(type, handler);
    if (keyHandler) root.removeEventListener('keydown', keyHandler);
  };
}
/** 收集表单值：<input data-f="name"> → {name: value} */
export function formValues(root) {
  const o = {};
  qsa('[data-f]', root).forEach(n => {
    const k = n.dataset.f;
    if (n.type === 'checkbox') o[k] = n.checked;
    else if (n.type === 'number' || n.dataset.num !== undefined) o[k] = n.value === '' ? null : Number(n.value);
    else o[k] = n.value;
  });
  return o;
}

/* ---------------- 图标 ---------------- */
const P = {
  gauge: 'M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0-9a9 9 0 0 0-9 9h3a6 6 0 1 1 12 0h3a9 9 0 0 0-9-9Z',
  calendar: 'M7 2v2M17 2v2M3.5 9h17M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2Z',
  layers: 'M12 3 2 8l10 5 10-5-10-5ZM2 13l10 5 10-5M2 17l10 5 10-5',
  db: 'M12 3c4.4 0 8 1.1 8 2.5S16.4 8 12 8 4 6.9 4 5.5 7.6 3 12 3Zm8 4.5v11c0 1.4-3.6 2.5-8 2.5s-8-1.1-8-2.5v-11M20 12c0 1.4-3.6 2.5-8 2.5S4 13.4 4 12',
  list: 'M8 6h13M8 12h13M8 18h13M3.5 6h.01M3.5 12h.01M3.5 18h.01',
  chart: 'M3 3v18h18M7 15v3M12 9v9M17 5v13',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.1l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-1.9-1.1L14.6 3h-4l-.4 2.8c-.7.3-1.3.6-1.9 1.1l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.2l-2 1.6 2 3.4 2.4-1c.6.5 1.2.8 1.9 1.1l.4 2.8h4l.4-2.8c.7-.3 1.3-.6 1.9-1.1l2.4 1 2-3.4-2-1.6c.1-.4.1-.7.1-1.1Z',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6A2 2 0 0 0 22 18L13.7 3.9a2 2 0 0 0-3.4 0Z',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  lock: 'M7 11V7a5 5 0 0 1 10 0v4M5 11h14v10H5z',
  unlock: 'M7 11V7a5 5 0 0 1 9.9-1M5 11h14v10H5z',
  clock: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13v5l3 2',
  play: 'M6 4l14 8-14 8V4Z',
  refresh: 'M3 12a9 9 0 0 1 15.5-6.2M21 12a9 9 0 0 1-15.5 6.2M18 3v5h-5M6 21v-5h5',
  download: 'M12 3v12m0 0 4-4m-4 4-4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  upload: 'M12 15V3m0 0 4 4m-4-4L8 7M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.3-4.3',
  zoomIn: 'M12 5v14M5 12h14',
  zoomOut: 'M5 12h14',
  layers2: 'M4 6h16M4 12h16M4 18h10',
  filter: 'M3 5h18l-7 8v6l-4 2v-8L3 5Z',
  arrowRight: 'M5 12h14m0 0-6-6m6 6-6 6',
  arrowLeft: 'M19 12H5m0 0 6-6m-6 6 6 6',
  chevDown: 'M6 9l6 6 6-6',
  chevRight: 'M9 6l6 6-6 6',
  file: 'M14 3v5h5M6 3h8l5 5v13H6V3Z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-13h.01M11 12h1v5h1',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Zm0-5a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z',
  bolt: 'M13 2 4 14h6l-1 8 9-12h-6l1-8Z',
  factory: 'M3 21V9l5 3V9l5 3V9l5 3V4h3v17H3Zm4-4h2m3 0h2m3 0h2',
  wrench: 'M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.1 2.1 0 0 1-3-3l9.4-9.4ZM14.7 6.3l2.6-2.6a4 4 0 0 1 5 5l-2.6 2.6',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  dot: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10Z',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  box: 'M3 8l9-5 9 5v8l-9 5-9-5V8Zm0 0 9 5 9-5M12 13v8',
  save: 'M5 3h11l3 3v15H5V3Zm3 0v6h8V3M8 21v-7h8v7',
  copy: 'M9 9h11v11H9zM5 15H3V3h12v2',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 8v4l3 2',
  split: 'M12 3v18M5 8l-2 4 2 4M19 8l2 4-2 4',
  ban: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM5.6 5.6l12.8 12.8',
  pause: 'M9 4v16M15 4v16',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  book: 'M4 4h6a3 3 0 0 1 3 3v14a2.5 2.5 0 0 0-2.5-2.5H4V4Zm16 0h-6a3 3 0 0 0-3 3v14a2.5 2.5 0 0 1 2.5-2.5H20V4Z',
};
export function icon(name, size = 16, cls = '') {
  const d = P[name] || P.dot;
  return '<svg class="ico ' + cls + '" width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + d + '"/></svg>';
}