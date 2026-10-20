#!/usr/bin/env node
/* 君威智能排产助手 · 生产级静态服务器（零第三方依赖，只用 node: 内置模块）
 *
 * 启动：
 *   node tools/serve.mjs                      默认 http://127.0.0.1:5178/web/index.html
 *   PORT=0 node tools/serve.mjs               随机空闲端口（自检脚本用，启动横幅打印真实端口）
 *   ROOT=/srv/jw node tools/serve.mjs         指向别处的构建产物根目录
 *   node tools/serve.mjs --read-only --max-age 600 --compress off --quiet
 *
 * 能力概览：
 *   缓存   按内容生成强 ETag，If-None-Match 命中返回 304；Cache-Control 按类型（html/js/css → no-cache，
 *          图片与字体 → public, max-age=<--max-age>）
 *   压缩   node:zlib 的 gzip / brotli，按 Accept-Encoding 协商；小于 1KB 不压缩；正确设置
 *          Content-Encoding 与 Vary: Accept-Encoding
 *   方法   GET / HEAD 完整支持；Range 返回 206（大文件下载），非法 Range 返回 416；其余方法 405 + Allow
 *   观测   结构化 JSON 访问日志（时间 / 方法 / 路径 / 状态 / 字节 / 耗时 / UA / 编码 / 缓存），
 *          LOG_LEVEL 或 --quiet 可静音；/healthz 与 /version 返回 JSON
 *   运维   PORT、HOST、ROOT、--read-only（默认开）、--max-age、--compress off、--slow-ms、--log-format
 *   稳定   优雅退出（SIGINT / SIGTERM 停止接收新连接 → 等在途请求 → 超时强退）；未捕获异常只记录不崩溃；
 *          请求体上限 413；超长 URL 414；慢请求日志
 *   安全   realpath 二次校验、nosniff、严格 CSP、X-Frame-Options: DENY、Referrer-Policy、
 *          Cross-Origin-Opener-Policy、无目录列表、错误页不泄露绝对路径
 *
 * 兼容性约定：默认参数下的对外行为与旧版一致——绑定 127.0.0.1:5178、非 GET/HEAD → 405、
 * 畸形百分号编码 → 400、路径穿越与软链逃逸 → 403、目录无 index.html → 404。
 */
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import { gzip as gzipCallback, brotliCompress as brotliCallback, constants as zlibConstants } from 'node:zlib';
import { promisify } from 'node:util';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const gzipAsync = promisify(gzipCallback);
const brotliAsync = promisify(brotliCallback);

const SERVER_NAME = 'jw-scheduler-static';
const SERVER_VERSION = '1.0.0';
const STARTED_AT = Date.now();
const COMPRESS_MIN_BYTES = 1024; // 小于 1KB 不压缩：省不了字节还多耗 CPU

/* ---------------------------------------------------------------- 配置解析 */

function toNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
function toBool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return !/^(0|false|no|off)$/i.test(String(value));
}

const LEVELS = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const opts = {
  port: toNum(process.env.PORT, 5178),
  host: process.env.HOST || '127.0.0.1',
  root: process.env.ROOT || '',
  readOnly: toBool(process.env.READ_ONLY, true),
  maxAge: toNum(process.env.MAX_AGE, 3600),
  compress: toBool(process.env.COMPRESS, true),
  logLevel: String(process.env.LOG_LEVEL || 'info').toLowerCase(),
  logFormat: String(process.env.LOG_FORMAT || 'text').toLowerCase(),
  slowMs: toNum(process.env.SLOW_MS, 1000),
  maxUrlLength: toNum(process.env.MAX_URL_LENGTH, 8192),
  maxBodyBytes: toNum(process.env.MAX_BODY_BYTES, 1024 * 1024),
  maxFileBytes: toNum(process.env.MAX_FILE_BYTES, 32 * 1024 * 1024),
  shutdownMs: toNum(process.env.SHUTDOWN_TIMEOUT_MS, 10000),
};

const USAGE = `君威智能排产助手静态服务器 v${SERVER_VERSION}

用法：node tools/serve.mjs [选项]

选项：
  --port <n>              监听端口，0 表示随机空闲端口（默认 5178，环境变量 PORT）
  --host <addr>           监听地址（默认 127.0.0.1，环境变量 HOST；容器内用 0.0.0.0）
  --root <dir>            静态根目录（默认本仓库根，环境变量 ROOT）
  --read-only             只读模式：拦截一切写方法（默认开启；--read-write 关闭）
  --read-write            关闭只读标记（静态分发本身仍不提供写接口）
  --max-age <秒>          图片与字体的 Cache-Control max-age（默认 3600）
  --compress <on|off>     是否启用 gzip / brotli（默认 on）
  --max-url <字节>        超过则返回 414（默认 8192）
  --max-body <字节>       请求体超过则返回 413（默认 1048576）
  --max-file-bytes <n>    单个文件超过则不读写并报错（默认 33554432）
  --slow-ms <毫秒>        超过则在访问日志标记 slow:true（默认 1000）
  --shutdown-timeout <ms> 优雅退出等待在途请求的上限（默认 10000）
  --log-level <级别>      silent | error | warn | info | debug（默认 info）
  --log-format <格式>     text | json（默认 text；容器里建议 json）
  --quiet                 等价于 --log-level silent
  -h, --help              显示本帮助
  -v, --version           显示版本号
`;

function fatal(message, code = 1) {
  process.stderr.write(message + '\n');
  process.exit(code);
}

const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const item = argv[i];
  const eq = item.indexOf('=');
  const key = eq >= 0 ? item.slice(0, eq) : item;
  const inlineValue = eq >= 0 ? item.slice(eq + 1) : null;
  const take = () => {
    if (inlineValue !== null) return inlineValue;
    const next = argv[++i];
    if (next === undefined) fatal('参数 ' + key + ' 缺少取值\n\n' + USAGE, 2);
    return next;
  };
  if (key === '--help' || key === '-h') { process.stdout.write(USAGE); process.exit(0); }
  else if (key === '--version' || key === '-v') { process.stdout.write(SERVER_VERSION + '\n'); process.exit(0); }
  else if (key === '--port') opts.port = toNum(take(), -1);
  else if (key === '--host') opts.host = take();
  else if (key === '--root') opts.root = take();
  else if (key === '--read-only') opts.readOnly = true;
  else if (key === '--read-write') opts.readOnly = false;
  else if (key === '--max-age') opts.maxAge = toNum(take(), -1);
  else if (key === '--compress') opts.compress = !/^(off|false|0|no)$/i.test(take());
  else if (key === '--no-compress') opts.compress = false;
  else if (key === '--max-url') opts.maxUrlLength = toNum(take(), -1);
  else if (key === '--max-body') opts.maxBodyBytes = toNum(take(), -1);
  else if (key === '--max-file-bytes') opts.maxFileBytes = toNum(take(), -1);
  else if (key === '--slow-ms') opts.slowMs = toNum(take(), -1);
  else if (key === '--shutdown-timeout') opts.shutdownMs = toNum(take(), -1);
  else if (key === '--log-level') opts.logLevel = take().toLowerCase();
  else if (key === '--log-format') opts.logFormat = take().toLowerCase();
  else if (key === '--quiet') opts.logLevel = 'silent';
  else fatal('未知参数：' + item + '\n\n' + USAGE, 2);
}

if (!Number.isInteger(opts.port) || opts.port < 0 || opts.port > 65535) fatal('启动失败：端口取值非法（' + opts.port + '），应为 0–65535');
if (opts.maxAge < 0) fatal('启动失败：--max-age 取值非法，应为非负整数秒');
if (opts.maxUrlLength <= 0 || opts.maxBodyBytes < 0 || opts.maxFileBytes <= 0) fatal('启动失败：--max-url / --max-body / --max-file-bytes 取值非法');
if (!(opts.logLevel in LEVELS)) fatal('启动失败：--log-level 只能是 ' + Object.keys(LEVELS).join(' / '));
if (opts.logFormat !== 'text' && opts.logFormat !== 'json') fatal('启动失败：--log-format 只能是 text / json');

/* ---------------------------------------------------------------- 日志 */

function emit(level, msg, fields = {}) {
  if (LEVELS[level] > LEVELS[opts.logLevel]) return;
  const record = Object.assign({ t: new Date().toISOString(), level, msg }, fields);
  process.stdout.write(JSON.stringify(record) + '\n');
}
function emitText(level, text) {
  if (LEVELS[level] > LEVELS[opts.logLevel]) return;
  process.stdout.write('[' + new Date().toISOString() + '] ' + level.toUpperCase() + ' ' + text + '\n');
}

/* ---------------------------------------------------------------- 根目录 */

const DEFAULT_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const requestedRoot = opts.root ? resolve(opts.root) : DEFAULT_ROOT;
let ROOT;
try {
  ROOT = await realpath(requestedRoot);
} catch (e) {
  fatal('启动失败：根目录不存在或不可访问 -> ' + requestedRoot + '（' + (e && e.code ? e.code : e.message) + '）');
}
const rootStat = await stat(ROOT).catch(() => null);
if (!rootStat || !rootStat.isDirectory()) fatal('启动失败：根目录不是目录 -> ' + ROOT);
const INDEX_PRESENT = await stat(join(ROOT, 'web', 'index.html')).then(s => s.isFile()).catch(() => false);
if (!INDEX_PRESENT) emitText('warn', '根目录下没有 web/index.html：' + ROOT + '（请确认 ROOT 指向完整构建产物，否则首页会 404）');

/* ---------------------------------------------------------------- 常量表 */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.bmp': 'image/bmp',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pdf': 'application/pdf', '.zip': 'application/zip', '.wasm': 'application/wasm',
};
// 图片与字体走长缓存，其余一律 no-cache（改完刷新即可生效，避免演示时拿到旧壳）
const LONG_CACHE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.bmp', '.woff', '.woff2', '.ttf', '.otf', '.eot']);
const COMPRESSIBLE_EXT = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.map', '.txt', '.md', '.csv', '.xml', '.svg']);
// 本应用零外部资源：CSP 收到最严；style-src 需要 'unsafe-inline'（模板里大量 style= 属性）
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

function securityHeaders() {
  return {
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'content-security-policy': CSP,
    'x-read-only': opts.readOnly ? '1' : '0',
  };
}

const mimeOf = (file) => MIME[extname(file).toLowerCase()] || 'application/octet-stream';
const cacheControlOf = (file) => (LONG_CACHE_EXT.has(extname(file).toLowerCase())
  ? 'public, max-age=' + opts.maxAge
  : 'no-cache');
const isCompressible = (file) => COMPRESSIBLE_EXT.has(extname(file).toLowerCase());

/* ---------------------------------------------------------------- 小工具 */

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function errorPage(code, title, detail, requestId) {
  return '<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>' + code + ' ' + escapeHtml(title) + '</title><style>' +
    'body{margin:0;padding:48px 24px;font:15px/1.7 system-ui,-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;color:#1f2733;background:#f6f7f9}' +
    'main{max-width:680px;margin:0 auto;background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:28px 32px}' +
    'h1{margin:0 0 6px;font-size:22px}code{background:#f0f2f5;padding:2px 6px;border-radius:4px}' +
    '.m{color:#5b6675;font-size:13px;margin-top:18px;border-top:1px solid #eceef1;padding-top:12px}</style></head><body><main>' +
    '<h1>' + code + ' · ' + escapeHtml(title) + '</h1><p>' + escapeHtml(detail) + '</p>' +
    '<p class="m">君威智能排产助手静态服务器 v' + SERVER_VERSION + ' · 请求编号 ' + escapeHtml(requestId) +
    '（服务端访问日志中可用该编号定位详细原因）</p></main></body></html>\n';
}

/* ---------------------------------------------------------------- 缓存 */

/* 小容量 LRU：既缓存文件内容与 ETag，也缓存压缩结果，避免每个请求重复读盘 / 重复压缩。 */
class ByteCache {
  constructor(maxEntries, maxBytes) { this.maxEntries = maxEntries; this.maxBytes = maxBytes; this.map = new Map(); this.bytes = 0; }
  get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    this.map.delete(key); this.map.set(key, hit); // 命中后提到队尾
    return hit;
  }
  set(key, record, size) {
    if (size > this.maxBytes) return;
    if (this.map.has(key)) { this.bytes -= this.map.get(key).size; this.map.delete(key); }
    const entry = { record, size };
    this.map.set(key, entry);
    this.bytes += size;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value;
      this.bytes -= this.map.get(oldest).size;
      this.map.delete(oldest);
    }
  }
  get size() { return this.map.size; }
}
const FILE_CACHE = new ByteCache(64, 64 * 1024 * 1024);
const ENCODED_CACHE = new ByteCache(64, 48 * 1024 * 1024);

async function loadFile(file, size, mtimeMs) {
  const key = file + '|' + size + '|' + mtimeMs;
  const hit = FILE_CACHE.get(key);
  if (hit) return hit.record;
  const buffer = await readFile(file);
  const record = { buffer, etag: '"' + createHash('sha1').update(buffer).digest('hex').slice(0, 32) + '"' };
  FILE_CACHE.set(key, record, buffer.length);
  return record;
}

async function encodeBody(buffer, encoding, versionKey) {
  const key = versionKey + '|' + encoding;
  const hit = ENCODED_CACHE.get(key);
  if (hit) return hit.record;
  const body = encoding === 'br'
    ? await brotliAsync(buffer, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 5 } })
    : await gzipAsync(buffer, { level: 6 });
  ENCODED_CACHE.set(key, body, body.length);
  return body;
}

/* ---------------------------------------------------------------- 协商 */

function acceptsEncoding(header, name) {
  if (!header) return false;
  for (const part of String(header).split(',')) {
    const pieces = part.trim().split(';');
    const token = pieces[0].trim().toLowerCase();
    if (token !== name && token !== '*') continue;
    let quality = 1;
    for (const piece of pieces.slice(1)) {
      const m = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(piece);
      if (m) quality = Number(m[1]);
    }
    if (quality > 0) return true;
  }
  return false;
}

/* 兼容弱校验：If-None-Match 允许 W/"..." 形式与逗号列表，* 表示任意。 */
function ifNoneMatchHit(header, etag) {
  if (!header) return false;
  const raw = String(header).trim();
  if (raw === '*') return true;
  const bare = (v) => v.trim().replace(/^W\//i, '');
  return raw.split(',').some((item) => bare(item) === bare(etag));
}

/* 只支持单区间；语法非法、越界、多区间一律按需求返回 416。 */
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return 'invalid';
  const startText = m[1], endText = m[2];
  if (startText === '' && endText === '') return 'invalid';
  if (startText === '') {
    const suffix = Number(endText);
    if (!Number.isFinite(suffix) || suffix <= 0 || size === 0) return 'invalid';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(startText);
  if (!Number.isFinite(start) || start >= size) return 'invalid';
  let end = endText === '' ? size - 1 : Number(endText);
  if (!Number.isFinite(end) || end < start) return 'invalid';
  if (end > size - 1) end = size - 1;
  return { start, end };
}

/* ---------------------------------------------------------------- 指标 */

const stats = { total: 0, byStatus: Object.create(null), bytesOut: 0, startedAt: new Date(STARTED_AT).toISOString() };
let inflight = 0;
let requestSeq = 0;
const nextRequestId = () => (++requestSeq).toString(36).padStart(4, '0') + '-' + Date.now().toString(36);

/* ---------------------------------------------------------------- 响应 */

function send(req, res, ctx, status, body, headers) {
  if (res.writableEnded) return; // 已经回过（例如优雅退出期间），不重复写
  const payload = body === null || body === undefined ? Buffer.alloc(0) : Buffer.from(body);
  const finalHeaders = Object.assign({}, securityHeaders(), headers);
  if (status !== 304 && status !== 204) finalHeaders['content-length'] = String(payload.length);
  ctx.status = status;
  ctx.bytes = status === 204 || status === 304 ? 0 : payload.length;
  res.writeHead(status, finalHeaders);
  if (req.method === 'HEAD' || status === 304 || status === 204) res.end();
  else res.end(payload);
}

function sendError(req, res, ctx, status, title, detail, headers) {
  const body = errorPage(status, title, detail, ctx.id);
  send(req, res, ctx, status, Buffer.from(body, 'utf8'), Object.assign({ 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, headers));
}

/* ---------------------------------------------------------------- 文件解析 */

/* 返回 { code, file, size, mtimeMs }；code 为 200 时其余字段可用。 */
async function resolveTarget(pathname) {
  let p = pathname;
  if (p.endsWith('/')) p += 'index.html';
  const target = normalize(join(ROOT, p));
  // 前缀判断必须带分隔符，避免兄弟目录（…-x）绕过
  if (target !== ROOT && !target.startsWith(ROOT + sep)) return { code: 403 };
  let info = await stat(target).catch(() => null);
  if (!info) return { code: 404 };
  let file = target;
  if (info.isDirectory()) {
    file = join(target, 'index.html');
    info = await stat(file).catch(() => null);
    if (!info) return { code: 404 };
  }
  // 解析真实路径后再校验一次：阻止根目录内的软链指向外部
  const real = await realpath(file).catch(() => null);
  if (!real || (real !== ROOT && !real.startsWith(ROOT + sep))) return { code: 403 };
  return { code: 200, file: real, size: info.size, mtimeMs: info.mtimeMs };
}

/* ---------------------------------------------------------------- 端点 */

async function datasetInfo() {
  const file = join(ROOT, 'data', 'dataset.json');
  const info = await stat(file).catch(() => null);
  if (!info || !info.isFile()) return null;
  return { path: 'data/dataset.json', bytes: info.size, mtime: new Date(info.mtimeMs).toISOString() };
}

async function versionPayload() {
  return {
    name: '君威智能排产助手 · 静态分发',
    server: SERVER_NAME,
    version: SERVER_VERSION,
    node: process.version,
    env: process.env.NODE_ENV || 'development',
    startedAt: stats.startedAt,
    buildTime: process.env.BUILD_TIME || null,
    gitSha: process.env.GIT_SHA || null,
    root: ROOT,
    data: await datasetInfo(),
  };
}

function healthPayload() {
  return {
    status: 'ok',
    name: '君威智能排产助手 · 静态分发',
    version: SERVER_VERSION,
    uptimeSec: Math.round((Date.now() - STARTED_AT) / 1000),
    startedAt: stats.startedAt,
    root: ROOT,
    readOnly: opts.readOnly,
    compress: opts.compress,
    maxAge: opts.maxAge,
    host: opts.host,
    port: actualPort(),
    pid: process.pid,
    node: process.version,
    inflight,
    // 内存与缓存命中情况：容量规划与「内存是否随时间上涨」排查都看这里
    memory: (() => { const m = process.memoryUsage(); return { rssMB: Number((m.rss / 1048576).toFixed(1)), heapUsedMB: Number((m.heapUsed / 1048576).toFixed(1)) }; })(),
    cacheEntries: { files: FILE_CACHE.size, encoded: ENCODED_CACHE.size },
    stats: { total: stats.total, byStatus: Object.assign({}, stats.byStatus), bytesOut: stats.bytesOut },
  };
}

function sendJson(req, res, ctx, payload) {
  const body = Buffer.from(JSON.stringify(payload, null, 2) + '\n', 'utf8');
  send(req, res, ctx, 200, body, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
}

/* ---------------------------------------------------------------- 主流程 */

async function handle(req, res, ctx) {
  const method = req.method || 'GET';
  ctx.method = method;
  ctx.path = req.url || '/';

  // 请求体上限：先看声明长度，避免读入超大 body（本服务不消费任何 body）
  const declared = Number(req.headers['content-length'] || 0);
  if (Number.isFinite(declared) && declared > opts.maxBodyBytes) {
    req.resume();
    return sendError(req, res, ctx, 413, '请求体过大', '请求体超过 ' + opts.maxBodyBytes + ' 字节上限；本服务是只读静态分发，不接受上传。');
  }
  if (method !== 'GET' && method !== 'HEAD') {
    req.resume(); // 排空请求体，保持连接可复用
    ctx.readonlyBlock = opts.readOnly;
    return sendError(req, res, ctx, 405, '方法不被允许',
      '本服务为只读静态分发，只支持 GET 与 HEAD。' + (opts.readOnly ? '（当前处于 --read-only 模式，所有写方法被拦截）' : ''),
      { allow: 'GET, HEAD' });
  }
  if (ctx.path.length > opts.maxUrlLength) {
    return sendError(req, res, ctx, 414, '请求地址过长', 'URL 超过 ' + opts.maxUrlLength + ' 字节上限。');
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(ctx.path, 'http://localhost').pathname);
  } catch {
    return sendError(req, res, ctx, 400, '请求地址无效', 'URL 百分号编码无效，无法解析。');
  }
  if (pathname.includes('\u0000')) {
    return sendError(req, res, ctx, 400, '请求地址无效', 'URL 中含空字节，已拒绝。');
  }
  ctx.route = pathname;

  if (pathname === '/healthz') return sendJson(req, res, ctx, healthPayload());
  if (pathname === '/version') return sendJson(req, res, ctx, await versionPayload());

  const resolved = await resolveTarget(pathname);
  if (resolved.code === 403) return sendError(req, res, ctx, 403, '禁止访问', '该路径不在静态根目录允许的范围内。');
  if (resolved.code === 404) return sendError(req, res, ctx, 404, '页面或文件不存在', '没有找到 ' + pathname + '，请检查地址是否正确。');

  const { file, size, mtimeMs } = resolved;
  const type = mimeOf(file);
  const cacheControl = cacheControlOf(file);
  const vary = isCompressible(file) ? { vary: 'accept-encoding' } : {};
  if (size > opts.maxFileBytes) {
    emit('error', 'file_too_large', { id: ctx.id, file: file.slice(ROOT.length + 1), size, limit: opts.maxFileBytes });
    return sendError(req, res, ctx, 500, '服务器内部错误', '目标文件超过单文件读取上限，请联系运维查看服务端日志。', { 'cache-control': 'no-store' });
  }

  const loaded = await loadFile(file, size, mtimeMs);
  const encoding = (opts.compress && req.headers.range === undefined && size >= COMPRESS_MIN_BYTES && isCompressible(file))
    ? (acceptsEncoding(req.headers['accept-encoding'], 'br') ? 'br'
      : acceptsEncoding(req.headers['accept-encoding'], 'gzip') ? 'gzip' : 'identity')
    : 'identity';
  const etag = encoding === 'identity' ? loaded.etag : loaded.etag.slice(0, -1) + '-' + encoding + '"';
  ctx.encoding = encoding;

  if (ifNoneMatchHit(req.headers['if-none-match'], etag)) {
    ctx.cache = 'hit';
    return send(req, res, ctx, 304, null, Object.assign({
      etag, 'cache-control': cacheControl, 'content-type': type,
    }, vary));
  }
  ctx.cache = 'miss';

  const range = parseRange(req.headers.range, loaded.buffer.length);
  if (range === 'invalid') {
    return sendError(req, res, ctx, 416, '请求范围不合法',
      'Range 头无法解析或超出文件大小（当前文件 ' + loaded.buffer.length + ' 字节）。',
      { 'content-range': 'bytes */' + loaded.buffer.length, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
  }

  if (range) {
    const slice = loaded.buffer.subarray(range.start, range.end + 1);
    ctx.range = range.start + '-' + range.end;
    return send(req, res, ctx, 206, slice, Object.assign({
      'content-type': type,
      'cache-control': cacheControl,
      etag,
      'accept-ranges': 'bytes',
      'content-range': 'bytes ' + range.start + '-' + range.end + '/' + loaded.buffer.length,
    }, vary));
  }

  const body = encoding === 'identity' ? loaded.buffer : await encodeBody(loaded.buffer, encoding, file + '|' + size + '|' + mtimeMs);
  return send(req, res, ctx, 200, body, Object.assign({
    'content-type': type,
    'cache-control': cacheControl,
    etag,
    'accept-ranges': 'bytes',
  }, encoding === 'identity' ? {} : { 'content-encoding': encoding }, vary));
}

/* ---------------------------------------------------------------- 访问日志 */

function accessLog(ctx, status) {
  stats.total++;
  stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
  stats.bytesOut += ctx.bytes || 0;
  const ms = Number((Number(process.hrtime.bigint() - ctx.hrStart) / 1e6).toFixed(2));
  const fields = {
    id: ctx.id,
    method: ctx.method || '-',
    path: String(ctx.path || '-').slice(0, 512),
    status,
    bytes: ctx.bytes || 0,
    ms,
    ua: String(ctx.ua || '-').slice(0, 200),
    ip: ctx.ip,
    enc: ctx.encoding || 'identity',
    cache: ctx.cache || '-',
  };
  if (ctx.range) fields.range = ctx.range;
  if (ctx.readonlyBlock) fields.readonly_block = true;
  if (ms >= opts.slowMs) fields.slow = true;
  emit('info', 'access', fields);
}

/* ---------------------------------------------------------------- 服务器 */

const server = createServer({ maxHeaderSize: 64 * 1024 }, (req, res) => {
  const ctx = {
    id: nextRequestId(),
    hrStart: process.hrtime.bigint(),
    ip: req.socket && req.socket.remoteAddress ? req.socket.remoteAddress : '-',
    ua: req.headers['user-agent'] || '-',
    bytes: 0,
    status: 500,
  };
  res.setHeader('x-request-id', ctx.id);
  inflight++;
  res.on('finish', () => {
    inflight--;
    accessLog(ctx, res.statusCode);
  });
  res.on('close', () => { if (!res.writableFinished) inflight--; });
  handle(req, res, ctx).catch((err) => {
    // 未捕获异常不使进程崩溃：记录完整堆栈，对外只回可读错误页（不含绝对路径）
    emit('error', 'request_failed', { id: ctx.id, path: String(ctx.path || '-').slice(0, 512), message: err && err.message, stack: err && err.stack });
    try {
      sendError(req, res, ctx, 500, '服务器内部错误', '处理该请求时发生内部错误，请稍后重试；若持续出现请联系运维并提供请求编号。', { 'cache-control': 'no-store' });
    } catch { /* 响应已结束，忽略 */ }
  });
});

server.keepAliveTimeout = 5000;
server.headersTimeout = 20000;
server.requestTimeout = 60000;
server.timeout = 120000;
server.maxHeadersCount = 100;
server.on('clientError', (err, socket) => {
  // 解析阶段就失败的请求（超长请求行 / 畸形报文）走这里，保证也有可读响应
  const overflow = err && err.code === 'HPE_HEADER_OVERFLOW';
  emit('warn', 'client_error', { code: err && err.code, message: err && err.message });
  if (!socket.writable) { socket.destroy(); return; }
  const status = overflow ? 414 : 400;
  const title = overflow ? '请求地址过长' : '请求报文无效';
  const body = errorPage(status, title, overflow ? '请求行或请求头超过服务端上限。' : 'HTTP 报文无法解析。', '-');
  socket.end('HTTP/1.1 ' + status + ' ' + title + '\r\nConnection: close\r\nContent-Type: text/html; charset=utf-8\r\n' +
    'Content-Length: ' + Buffer.byteLength(body) + '\r\nX-Content-Type-Options: nosniff\r\n\r\n' + body);
});
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    fatal('启动失败：端口 ' + opts.port + ' 已被占用（EADDRINUSE）。请换端口，例如 PORT=5180 node tools/serve.mjs，' +
      '或先用 lsof -i :' + opts.port + ' 找到占用进程。');
  }
  if (err && err.code === 'EACCES') {
    fatal('启动失败：没有权限绑定 ' + opts.host + ':' + opts.port + '（EACCES）。1024 以下端口通常需要管理员权限。');
  }
  if (err && err.code === 'EADDRNOTAVAIL') {
    fatal('启动失败：地址不可用 ' + opts.host + '（EADDRNOTAVAIL）。请检查 HOST/--host 是否为本机网卡地址。');
  }
  fatal('启动失败：' + (err && err.message ? err.message : String(err)));
});

function actualPort() {
  const addr = server.address();
  return addr && typeof addr === 'object' ? addr.port : opts.port;
}

/* ---------------------------------------------------------------- 生命周期 */

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) { emitText('warn', '已经在退出流程中，忽略重复信号 ' + signal); return; }
  shuttingDown = true;
  const startedAt = Date.now();
  emit('info', 'shutdown_begin', { signal, inflight });
  server.close(() => {
    emit('info', 'shutdown_done', { signal, ms: Date.now() - startedAt });
    process.exit(0);
  });
  // 空闲 keep-alive 连接不会自己断开，必须主动关闭，否则 close 回调要等到超时
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  const timer = setTimeout(() => {
    emit('error', 'shutdown_forced', { signal, inflight, timeoutMs: opts.shutdownMs });
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    process.exit(1);
  }, opts.shutdownMs);
  timer.unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (err) => {
  // 按运维要求：记录后继续服务，不让整个演示环境因单点异常整体消失
  emit('error', 'uncaught_exception', { message: err && err.message, stack: err && err.stack });
});
process.on('unhandledRejection', (reason) => {
  emit('error', 'unhandled_rejection', { message: reason && reason.message ? reason.message : String(reason), stack: reason && reason.stack });
});

/* 混沌演练：CHAOS_THROW_MS=300 时，300ms 后在定时器里抛一个未捕获异常，
   用于验证「未捕获异常只记录、不让进程崩溃」。仅演练用，生产不要设置该变量。 */
const CHAOS_THROW_MS = toNum(process.env.CHAOS_THROW_MS, 0);
if (CHAOS_THROW_MS > 0) {
  setTimeout(() => { throw new Error('混沌演练：故意抛出的未捕获异常（来自 CHAOS_THROW_MS=' + CHAOS_THROW_MS + '）'); }, CHAOS_THROW_MS);
}

server.listen(opts.port, opts.host, () => {
  const port = actualPort();
  if (opts.logFormat === 'json') {
    emit('info', 'listen', { host: opts.host, port, root: ROOT, readOnly: opts.readOnly, compress: opts.compress, maxAge: opts.maxAge, logLevel: opts.logLevel, node: process.version });
    return;
  }
  if (LEVELS.info > LEVELS[opts.logLevel]) return; // --quiet / LOG_LEVEL=silent 时连启动横幅一起静音
  process.stdout.write('君威智能排产助手静态服务器 v' + SERVER_VERSION + ' 已启动：\n' +
    '  http://127.0.0.1:' + port + '/web/index.html\n' +
    '  （DEMO 场景数据：http://127.0.0.1:' + port + '/web/index.html?data=demo）\n' +
    '  健康检查：http://127.0.0.1:' + port + '/healthz    构建信息：http://127.0.0.1:' + port + '/version\n' +
    '  监听：' + opts.host + ':' + port + '   根目录：' + ROOT + '\n' +
    '  只读：' + (opts.readOnly ? '是' : '否') + '   压缩：' + (opts.compress ? '开' : '关') +
    '   图片缓存：' + (opts.maxAge ? 'max-age=' + opts.maxAge : '关闭') + '   日志级别：' + opts.logLevel + '\n');
});
