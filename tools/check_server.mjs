/* 生产级静态服务器自检：真实子进程 + node:http 探针（零第三方依赖）
 *
 * 覆盖：MIME / HEAD / ETag 与 304 / Cache-Control / gzip 与 brotli 协商 / Range 206 与 416 /
 *       方法与只读 / healthz 与 version / 路径穿越与软链逃逸与畸形编码与超长 URL /
 *       安全响应头 / 结构化访问日志与慢请求标记 / 优雅退出与启动失败原因。
 *
 * 用法：node tools/check_server.mjs
 * 说明：每条断言都能失败——变异测试在 /tmp 副本上逐项注入缺陷验证过（见 README 与交付汇报）。
 *       临时夹具目录建在 os.tmpdir() 下，结束时删除；服务器用 PORT=0 由内核分配随机端口。
 */
import { spawn } from 'node:child_process';
import { request, Agent } from 'node:http';
import { createServer, connect } from 'node:net';
import { mkdtemp, mkdir, writeFile, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync, brotliDecompressSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const SERVE = join(HERE, 'serve.mjs');

let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else {
    fail++;
    failures.push(name);
    console.log('  ✗ ' + name + (extra === undefined || extra === '' ? '' : ' :: ' + String(extra).slice(0, 200)));
  }
}
function group(title) { console.log('\n--- ' + title + ' ---'); }

const servers = [];

class Server {
  constructor(child, label) {
    this.child = child;
    this.label = label;
    this.stdout = '';
    this.stderr = '';
    this.port = 0;
    this.exit = null;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { this.stdout += d; });
    child.stderr.on('data', (d) => { this.stderr += d; });
    child.on('exit', (code, signal) => { this.exit = { code, signal }; });
  }
  static async start(args = [], env = {}, label = 'server', knownPort = 0) {
    const child = spawn(process.execPath, [SERVE, ...args], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { PORT: '0' }, env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const srv = new Server(child, label);
    servers.push(srv);
    // --quiet 会连启动横幅一起静音，此时由调用方指定端口，改用 TCP 连通性判断就绪
    if (knownPort) await srv.waitPort(knownPort);
    else await srv.waitReady();
    return srv;
  }
  waitPort(port, timeoutMs = 15000) {
    this.port = port;
    const deadline = Date.now() + timeoutMs;
    return new Promise((resolve, reject) => {
      const tick = () => {
        if (this.exit) { reject(new Error(this.label + ' 未启动成功（提前退出 code=' + this.exit.code + '）\n  stderr: ' + this.stderr.trim())); return; }
        const socket = connect(port, '127.0.0.1');
        socket.once('connect', () => { socket.destroy(); resolve(); });
        socket.once('error', () => {
          socket.destroy();
          if (Date.now() > deadline) reject(new Error(this.label + ' 在 ' + timeoutMs + 'ms 内没有监听 127.0.0.1:' + port));
          else setTimeout(tick, 50);
        });
      };
      tick();
    });
  }
  waitReady(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(this.label + ' 启动超时：' + timeoutMs + 'ms 内没有打印监听地址')); }, timeoutMs);
      const check = () => {
        const text = /http:\/\/127\.0\.0\.1:(\d+)\//.exec(this.stdout);
        const json = /"msg":"listen"[^}]*"port":(\d+)/.exec(this.stdout);
        if (!text && !json) return;
        cleanup();
        this.port = Number(text ? text[1] : json[1]);
        resolve();
      };
      const onExit = () => {
        cleanup();
        reject(new Error(this.label + ' 未启动成功（提前退出 code=' + (this.exit ? this.exit.code : '?') + '）\n  stdout: ' +
          this.stdout.trim() + '\n  stderr: ' + this.stderr.trim()));
      };
      const cleanup = () => { clearTimeout(timer); this.child.stdout.off('data', check); this.child.off('exit', onExit); };
      this.child.stdout.on('data', check);
      this.child.on('exit', onExit);
      check();
    });
  }
  logs() {
    const out = [];
    for (const line of this.stdout.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) continue;
      try { out.push(JSON.parse(trimmed)); } catch { /* 非 JSON 行忽略 */ }
    }
    return out;
  }
  access() { return this.logs().filter((r) => r.msg === 'access'); }
  async stop(signal = 'SIGTERM', timeoutMs = 6000) {
    if (this.exit) return Object.assign({ ms: 0, timedOut: false }, this.exit);
    const startedAt = Date.now();
    const waitExit = new Promise((res) => this.child.on('exit', (code, sig) => res({ code, signal: sig })));
    this.child.kill(signal);
    const raced = await Promise.race([waitExit, new Promise((res) => setTimeout(() => res(null), timeoutMs))]);
    if (!raced) { this.child.kill('SIGKILL'); return { code: null, signal: 'TIMEOUT', ms: Date.now() - startedAt, timedOut: true }; }
    return Object.assign({ ms: Date.now() - startedAt, timedOut: false }, raced);
  }
  async killIfAlive() {
    if (this.exit) return;
    this.child.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 30));
  }
}

function runOnce(args, env = {}, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SERVE, ...args], {
      cwd: ROOT, env: Object.assign({}, process.env, env), stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal, stdout, stderr }); });
  });
}

function probe(port, options = {}) {
  const { method = 'GET', path = '/', headers = {}, body = null, agent = false } = options;
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, headers, agent }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(15000, () => req.destroy(new Error('探针请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/* 子进程的 stdout 是异步管道：断言日志前先轮询等待，避免把「还没写到」误判成「没写」 */
async function waitFor(fn, timeoutMs = 3000, intervalMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) return null;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => { const port = srv.address().port; srv.close(() => resolve(port)); });
  });
}

async function makeFixture() {
  const base = await mkdtemp(join(tmpdir(), 'jw-serve-check-'));
  const rootDir = join(base, 'root');
  const sibling = join(base, 'root-x');
  await mkdir(join(rootDir, 'sub'), { recursive: true });
  await mkdir(join(rootDir, 'dirindex', 'index.html'), { recursive: true });
  await mkdir(sibling, { recursive: true });
  await writeFile(join(rootDir, 'index.html'), '<!doctype html><html lang="zh-CN"><body><h1>FIXTURE-HOME</h1></body></html>');
  const smallText = 'tiny-body';
  await writeFile(join(rootDir, 'small.txt'), smallText);
  const jsonText = JSON.stringify({ rows: Array.from({ length: 200 }, (_, i) => ({ i, name: 'row-' + i, text: '重复内容重复内容' })) });
  await writeFile(join(rootDir, 'data.json'), jsonText);
  const big = Buffer.alloc(64 * 1024);
  for (let i = 0; i < big.length; i++) big[i] = (i * 31 + 7) & 0xff;
  await writeFile(join(rootDir, 'big.bin'), big);
  await writeFile(join(rootDir, 'font.woff2'), Buffer.from([0, 1, 2, 3, 4, 5, 6, 7]));
  await writeFile(join(rootDir, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]));
  await writeFile(join(rootDir, 'sub', 'secret-name.txt'), 'should-not-be-listed');
  await writeFile(join(sibling, 'secret.txt'), 'TOP-SECRET-SIBLING');
  await symlink(join(sibling, 'secret.txt'), join(rootDir, 'escape.txt'));
  return { base, rootDir, sibling, smallText, jsonText, big };
}

const looksLikeHtml = (res) => String(res.headers['content-type'] || '').includes('text/html');
const jsonOf = (res) => JSON.parse(res.body.toString('utf8'));

async function main() {
  const fixture = await makeFixture();
  const A = await Server.start([], {}, '默认实例');
  const home = '/web/index.html';
  const jsonPath = '/data/dataset.json';
  const pngPath = '/docs/shot-demo.png';

  group('启动与基础响应');
  ok('启动横幅打印监听地址与首页地址（旧版行为兼容）',
    /127\.0\.0\.1:\d+\/web\/index\.html/.test(A.stdout) && A.stdout.includes('君威智能排产助手'), A.stdout.split('\n')[0]);
  const r1 = await probe(A.port, { path: home });
  ok('GET /web/index.html 返回 200', r1.status === 200, r1.status);
  ok('HTML 的 Content-Type 为 text/html; charset=utf-8', r1.headers['content-type'] === 'text/html; charset=utf-8', r1.headers['content-type']);
  ok('HTML 内容包含应用标题', r1.body.toString('utf8').includes('<title>') && r1.body.toString('utf8').includes('君威'), r1.body.length);
  ok('Content-Length 与响应体长度一致', Number(r1.headers['content-length']) === r1.body.length, r1.headers['content-length'] + ' vs ' + r1.body.length);
  ok('HTML 响应带 Accept-Ranges: bytes', r1.headers['accept-ranges'] === 'bytes', r1.headers['accept-ranges']);
  const rjs = await probe(A.port, { path: '/web/src/main.js' });
  ok('JS 的 Content-Type 为 text/javascript', rjs.status === 200 && String(rjs.headers['content-type']).startsWith('text/javascript'), rjs.headers['content-type']);
  const rcss = await probe(A.port, { path: '/web/assets/app.css' });
  ok('CSS 的 Content-Type 为 text/css', rcss.status === 200 && String(rcss.headers['content-type']).startsWith('text/css'), rcss.headers['content-type']);
  const rjson = await probe(A.port, { path: jsonPath });
  ok('JSON 的 Content-Type 为 application/json', rjson.status === 200 && String(rjson.headers['content-type']).startsWith('application/json'), rjson.headers['content-type']);
  const rpng = await probe(A.port, { path: pngPath });
  ok('PNG 的 Content-Type 为 image/png', rpng.status === 200 && rpng.headers['content-type'] === 'image/png', rpng.headers['content-type']);
  const r404 = await probe(A.port, { path: '/' });
  ok('项目根没有 index.html，GET / 返回 404', r404.status === 404, r404.status);
  ok('404 返回可读 HTML（含 404 与中文说明）',
    looksLikeHtml(r404) && r404.body.toString('utf8').includes('404') && r404.body.toString('utf8').includes('不存在'), r404.body.length);
  ok('404 页面不泄露服务器绝对路径', !r404.body.toString('utf8').includes(ROOT), 'body 含 ROOT');
  const r404b = await probe(A.port, { path: '/web/definitely-missing.js' });
  ok('缺失静态文件同样返回可读 404', r404b.status === 404 && looksLikeHtml(r404b), r404b.status);

  group('HEAD 请求');
  const head = await probe(A.port, { method: 'HEAD', path: home });
  ok('HEAD 返回 200', head.status === 200, head.status);
  ok('HEAD 响应体为空', head.body.length === 0, head.body.length);
  ok('HEAD 的 Content-Length 与 GET 一致', Number(head.headers['content-length']) === r1.body.length, head.headers['content-length'] + ' vs ' + r1.body.length);
  const headCss = await probe(A.port, { method: 'HEAD', path: '/web/assets/app.css' });
  ok('HEAD 保留正确 Content-Type 与 Content-Length', String(headCss.headers['content-type']).startsWith('text/css') && Number(headCss.headers['content-length']) > 0, JSON.stringify(headCss.headers['content-length']));

  group('ETag 与条件请求');
  const etag = r1.headers.etag;
  ok('ETag 是强校验（"32位十六进制"，无 W/ 前缀）', /^"[0-9a-f]{32}"$/.test(String(etag)), etag);
  const r1again = await probe(A.port, { path: home });
  ok('两次 GET 的 ETag 稳定不变', r1again.headers.etag === etag, r1again.headers.etag + ' vs ' + etag);
  const r304 = await probe(A.port, { path: home, headers: { 'if-none-match': String(etag) } });
  ok('If-None-Match 命中返回 304', r304.status === 304, r304.status);
  ok('304 响应体为空', r304.body.length === 0, r304.body.length);
  ok('304 仍带 ETag 与 Cache-Control', r304.headers.etag === etag && r304.headers['cache-control'] === 'no-cache', JSON.stringify([r304.headers.etag, r304.headers['cache-control']]));
  const r304weak = await probe(A.port, { path: home, headers: { 'if-none-match': 'W/' + String(etag) } });
  ok('弱校验形式 W/"..." 也能命中 304', r304weak.status === 304, r304weak.status);
  const r304star = await probe(A.port, { path: home, headers: { 'if-none-match': '*' } });
  ok('If-None-Match: * 命中 304', r304star.status === 304, r304star.status);
  const r200bogus = await probe(A.port, { path: home, headers: { 'if-none-match': '"deadbeef"' } });
  ok('If-None-Match 不匹配返回 200', r200bogus.status === 200, r200bogus.status);

  group('Cache-Control 策略');
  ok('HTML 使用 no-cache', r1.headers['cache-control'] === 'no-cache', r1.headers['cache-control']);
  ok('JS 使用 no-cache', rjs.headers['cache-control'] === 'no-cache', rjs.headers['cache-control']);
  ok('CSS 使用 no-cache', rcss.headers['cache-control'] === 'no-cache', rcss.headers['cache-control']);
  ok('JSON 数据使用 no-cache（改完即可见）', rjson.headers['cache-control'] === 'no-cache', rjson.headers['cache-control']);
  ok('图片使用 public, max-age=3600', rpng.headers['cache-control'] === 'public, max-age=3600', rpng.headers['cache-control']);

  group('压缩协商（gzip / brotli）');
  const gz = await probe(A.port, { path: jsonPath, headers: { 'accept-encoding': 'gzip' } });
  ok('Accept-Encoding: gzip 时返回 Content-Encoding: gzip', gz.headers['content-encoding'] === 'gzip', gz.headers['content-encoding']);
  ok('gzip 解压后与原文逐字节一致', gunzipSync(gz.body).equals(rjson.body), gz.body.length + ' -> ' + gunzipSync(gz.body).length);
  ok('压缩响应带 Vary: Accept-Encoding', String(gz.headers.vary || '').toLowerCase().includes('accept-encoding'), gz.headers.vary);
  ok('压缩响应 Content-Length 等于压缩后字节数', Number(gz.headers['content-length']) === gz.body.length, gz.headers['content-length'] + ' vs ' + gz.body.length);
  ok('gzip 确实变小了（1.1MB JSON）', gz.body.length < rjson.body.length, rjson.body.length + ' -> ' + gz.body.length);
  const br = await probe(A.port, { path: jsonPath, headers: { 'accept-encoding': 'br' } });
  ok('Accept-Encoding: br 时返回 Content-Encoding: br', br.headers['content-encoding'] === 'br', br.headers['content-encoding']);
  ok('brotli 解压后与原文逐字节一致', brotliDecompressSync(br.body).equals(rjson.body), br.body.length);
  ok('brotli 体积小于 gzip（真的用了 br 而非退化）', br.body.length < gz.body.length, br.body.length + ' vs ' + gz.body.length);
  const identity = await probe(A.port, { path: jsonPath, headers: { 'accept-encoding': 'identity' } });
  ok('Accept-Encoding: identity 时不压缩', identity.headers['content-encoding'] === undefined && identity.body.length === rjson.body.length, identity.headers['content-encoding']);
  ok('gzip 变体的 ETag 与 identity 不同（按表示区分）', gz.headers.etag !== rjson.headers.etag, gz.headers.etag + ' vs ' + rjson.headers.etag);
  const pngGz = await probe(A.port, { path: pngPath, headers: { 'accept-encoding': 'gzip' } });
  ok('图片类型不做压缩', pngGz.headers['content-encoding'] === undefined, pngGz.headers['content-encoding']);
  const nogzip = await probe(A.port, { path: jsonPath, headers: { 'accept-encoding': 'gzip;q=0' } });
  ok('Accept-Encoding: gzip;q=0 视为不接受', nogzip.headers['content-encoding'] === undefined, nogzip.headers['content-encoding']);

  group('Range 区间请求');
  const size = rjson.body.length;
  const range = await probe(A.port, { path: jsonPath, headers: { range: 'bytes=0-9' } });
  ok('bytes=0-9 返回 206', range.status === 206, range.status);
  ok('206 的 Content-Range 正确', range.headers['content-range'] === 'bytes 0-9/' + size, range.headers['content-range']);
  ok('206 返回的字节区间正确', range.body.equals(rjson.body.subarray(0, 10)), range.body.length);
  ok('206 的 Content-Length 等于区间长度', Number(range.headers['content-length']) === 10, range.headers['content-length']);
  const suffix = await probe(A.port, { path: jsonPath, headers: { range: 'bytes=-8' } });
  ok('bytes=-8 返回末尾 8 字节', suffix.status === 206 && suffix.body.equals(rjson.body.subarray(size - 8)), suffix.headers['content-range']);
  const open = await probe(A.port, { path: jsonPath, headers: { range: 'bytes=' + (size - 8) + '-' } });
  ok('bytes=N- 返回末尾区间', open.status === 206 && open.body.equals(rjson.body.subarray(size - 8)), open.headers['content-range']);
  const over = await probe(A.port, { path: jsonPath, headers: { range: 'bytes=99999999-' } });
  ok('越界 Range 返回 416', over.status === 416, over.status);
  ok('416 带 Content-Range: bytes */<size>', over.headers['content-range'] === 'bytes */' + size, over.headers['content-range']);
  const bad = await probe(A.port, { path: jsonPath, headers: { range: 'bytes=abc' } });
  ok('语法非法 Range 返回 416', bad.status === 416, bad.status);
  const multi = await probe(A.port, { path: jsonPath, headers: { range: 'bytes=0-1,5-6' } });
  ok('多区间（不支持）按非法处理返回 416', multi.status === 416, multi.status);
  const rangeGz = await probe(A.port, { path: jsonPath, headers: { range: 'bytes=0-9', 'accept-encoding': 'gzip' } });
  ok('Range 请求不做压缩，返回原文区间', rangeGz.status === 206 && rangeGz.headers['content-encoding'] === undefined && rangeGz.body.equals(rjson.body.subarray(0, 10)), rangeGz.headers['content-encoding']);
  const headRange = await probe(A.port, { method: 'HEAD', path: jsonPath, headers: { range: 'bytes=0-9' } });
  ok('HEAD + Range 返回 206 且无响应体', headRange.status === 206 && headRange.body.length === 0 && Number(headRange.headers['content-length']) === 10, headRange.status + '/' + headRange.body.length);

  group('方法与只读');
  for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS']) {
    const m = await probe(A.port, { method, path: home });
    ok(method + ' 返回 405', m.status === 405, m.status);
    if (method === 'POST') {
      ok('405 带 Allow: GET, HEAD', String(m.headers.allow || '').includes('GET') && String(m.headers.allow || '').includes('HEAD'), m.headers.allow);
      ok('405 是可读 HTML', looksLikeHtml(m) && m.body.toString('utf8').includes('405'), m.body.length);
      ok('--read-only 默认开启：405 带 x-read-only: 1', m.headers['x-read-only'] === '1', m.headers['x-read-only']);
    }
  }
  const postWithBody = await probe(A.port, { method: 'POST', path: home, headers: { 'content-type': 'application/json' }, body: Buffer.from('{"x":1}') });
  ok('带请求体的 POST 仍是 405（连接未被写坏）', postWithBody.status === 405, postWithBody.status);
  const afterPost = await probe(A.port, { path: home });
  ok('写方法之后服务仍正常响应 GET', afterPost.status === 200 && afterPost.body.equals(r1.body), afterPost.status);

  group('/healthz 与 /version');
  const health1 = await probe(A.port, { path: '/healthz' });
  ok('/healthz 返回 200 + JSON', health1.status === 200 && String(health1.headers['content-type']).startsWith('application/json'), health1.headers['content-type']);
  const healthJson = jsonOf(health1);
  ok('/healthz 字段齐全（版本 / 运行时长 / 根目录 / 只读）',
    healthJson.status === 'ok' && typeof healthJson.version === 'string' && typeof healthJson.uptimeSec === 'number' &&
    healthJson.root === ROOT && healthJson.readOnly === true, JSON.stringify(healthJson).slice(0, 160));
  ok('/healthz 根目录为 realpath 后的项目根', healthJson.root === ROOT, healthJson.root);
  ok('/healthz 标记 no-store（健康检查不被缓存）', String(health1.headers['cache-control'] || '').includes('no-store'), health1.headers['cache-control']);
  const vz = await probe(A.port, { path: '/version' });
  ok('/version 返回 200 + JSON', vz.status === 200 && String(vz.headers['content-type']).startsWith('application/json'), vz.status);
  const versionJson = jsonOf(vz);
  ok('/version 含名称 / 版本 / Node 版本 / 服务器标识',
    typeof versionJson.name === 'string' && /^\d+\.\d+\.\d+$/.test(versionJson.version) && versionJson.node === process.version && typeof versionJson.server === 'string',
    JSON.stringify([versionJson.name, versionJson.version, versionJson.node]));
  ok('/version 带数据快照信息（data/dataset.json 字节数）', versionJson.data && versionJson.data.bytes > 0, JSON.stringify(versionJson.data));
  const headHealth = await probe(A.port, { method: 'HEAD', path: '/healthz' });
  ok('/healthz 支持 HEAD 且无响应体', headHealth.status === 200 && headHealth.body.length === 0 && Number(headHealth.headers['content-length']) > 0, headHealth.status);

  group('安全响应头');
  const sec = r1.headers;
  ok('200 带 X-Content-Type-Options: nosniff', sec['x-content-type-options'] === 'nosniff', sec['x-content-type-options']);
  ok('200 带 X-Frame-Options: DENY', sec['x-frame-options'] === 'DENY', sec['x-frame-options']);
  ok('200 带 Referrer-Policy', /no-referrer/.test(String(sec['referrer-policy'])), sec['referrer-policy']);
  ok('200 带 Cross-Origin-Opener-Policy: same-origin', sec['cross-origin-opener-policy'] === 'same-origin', sec['cross-origin-opener-policy']);
  ok('CSP 存在且为严格策略（default-src self / object-src none / frame-ancestors none）',
    /default-src 'self'/.test(String(sec['content-security-policy'])) &&
    /object-src 'none'/.test(String(sec['content-security-policy'])) &&
    /frame-ancestors 'none'/.test(String(sec['content-security-policy'])), sec['content-security-policy']);
  const errHeaders = await probe(A.port, { path: '/nope-not-here' });
  ok('404 错误页也带 nosniff 与 CSP',
    errHeaders.headers['x-content-type-options'] === 'nosniff' && /default-src 'self'/.test(String(errHeaders.headers['content-security-policy'])), '404 缺安全头');
  const m405 = await probe(A.port, { method: 'POST', path: home });
  ok('405 也带 nosniff', m405.headers['x-content-type-options'] === 'nosniff', m405.headers['x-content-type-options']);

  group('路径穿越 / 畸形输入 / 超长 URL');
  const trav1 = await probe(A.port, { path: '/..%2f..%2fetc%2fpasswd' });
  ok('编码路径穿越返回 403', trav1.status === 403, trav1.status);
  ok('穿越响应不含 /etc/passwd 内容', !trav1.body.toString('utf8').includes('root:'), trav1.body.length);
  const trav2 = await probe(A.port, { path: '/%2e%2e%2f%2e%2e%2fetc%2fpasswd' });
  ok('%2e%2e 形式的穿越返回 403', trav2.status === 403, trav2.status);
  const enc = await probe(A.port, { path: '/web/%zz' });
  ok('畸形百分号编码返回 400', enc.status === 400, enc.status);
  const nul = await probe(A.port, { path: '/web/%00index.html' });
  ok('路径含空字节返回 400', nul.status === 400, nul.status);
  const longRes = await probe(A.port, { path: '/' + 'a'.repeat(9000) });
  ok('超长 URL（9000 字节）返回 414', longRes.status === 414, longRes.status);
  const longer = await probe(A.port, { path: '/' + 'a'.repeat(20000) });
  ok('超长 URL（20000 字节）返回 414', longer.status === 414, longer.status);
  ok('414 是可读 HTML', looksLikeHtml(longRes) && longRes.body.toString('utf8').includes('414'), longRes.body.length);

  group('结构化访问日志');
  const health2 = await probe(A.port, { path: '/healthz' });
  ok('/healthz 的运行时长单调不减', jsonOf(health2).uptimeSec >= healthJson.uptimeSec, healthJson.uptimeSec + ' -> ' + jsonOf(health2).uptimeSec);
  const last = await waitFor(() => {
    const rows = A.access();
    const tail = rows[rows.length - 1];
    return tail && tail.path === '/healthz' && tail.status === 200 ? tail : null;
  });
  ok('访问日志是单行 JSON 且字段齐全（时间 / 方法 / 路径 / 状态 / 字节 / 耗时 / UA）',
    !!last && typeof last.t === 'string' && typeof last.method === 'string' && typeof last.path === 'string' &&
    typeof last.status === 'number' && typeof last.bytes === 'number' && typeof last.ms === 'number' && typeof last.ua === 'string',
    JSON.stringify(last));
  ok('访问日志的状态与字节数跟实际响应一致', !!last && last.bytes === health2.body.length, JSON.stringify([last && last.status, last && last.path, last && last.bytes, health2.body.length]));
  const homeLog = await waitFor(() => A.access().filter((r) => r.path === home && r.method === 'GET').pop());
  ok('200 访问日志记录实际响应字节数', !!homeLog && homeLog.bytes === r1.body.length, homeLog && homeLog.bytes);
  const headLog = await waitFor(() => A.access().filter((r) => r.method === 'HEAD' && r.path === home).pop());
  ok('HEAD 日志的字节数与 GET 一致', !!headLog && headLog.bytes === r1.body.length, headLog && headLog.bytes);
  const postLog = await waitFor(() => A.access().filter((r) => r.method === 'POST' && r.readonly_block === true).pop());
  ok('写方法日志标记 readonly_block', !!postLog && postLog.readonly_block === true, JSON.stringify(postLog));

  group('ROOT 指向别处 + --max-age / --compress off / --read-write / 慢请求');
  const B = await Server.start(['--root', fixture.rootDir, '--max-age', '60', '--slow-ms', '0', '--port', '0'], {}, '夹具实例');
  const fixHome = await probe(B.port, { path: '/index.html' });
  ok('ROOT 指向夹具目录后返回夹具首页', fixHome.status === 200 && fixHome.body.toString('utf8').includes('FIXTURE-HOME'), fixHome.status);
  const font = await probe(B.port, { path: '/font.woff2' });
  ok('字体文件 Content-Type 为 font/woff2', font.headers['content-type'] === 'font/woff2', font.headers['content-type']);
  ok('--max-age 60 生效（字体 public, max-age=60）', font.headers['cache-control'] === 'public, max-age=60', font.headers['cache-control']);
  const png2 = await probe(B.port, { path: '/img.png' });
  ok('--max-age 60 生效（图片 public, max-age=60）', png2.headers['cache-control'] === 'public, max-age=60', png2.headers['cache-control']);
  const smallGz = await probe(B.port, { path: '/small.txt', headers: { 'accept-encoding': 'gzip' } });
  ok('小于 1KB 的文件不压缩', smallGz.headers['content-encoding'] === undefined && smallGz.body.toString('utf8') === fixture.smallText, smallGz.headers['content-encoding']);
  const bigJson = await probe(B.port, { path: '/data.json', headers: { 'accept-encoding': 'gzip' } });
  ok('大于 1KB 的文本文件压缩', bigJson.headers['content-encoding'] === 'gzip' && gunzipSync(bigJson.body).toString('utf8') === fixture.jsonText, bigJson.headers['content-encoding']);
  const bigRange = await probe(B.port, { path: '/big.bin', headers: { range: 'bytes=1000-1099' } });
  ok('大文件 Range 取中段字节正确', bigRange.status === 206 && bigRange.body.equals(fixture.big.subarray(1000, 1100)), bigRange.status + '/' + bigRange.body.length);
  const bigFull = await probe(B.port, { path: '/big.bin' });
  ok('不可压缩扩展名（.bin）不做 gzip', bigFull.headers['content-encoding'] === undefined && bigFull.headers['content-type'] === 'application/octet-stream', bigFull.headers['content-encoding']);
  const etagBefore = (await probe(B.port, { path: '/data.json' })).headers.etag;
  const stat1 = await import('node:fs/promises').then((m) => m.stat(join(fixture.rootDir, 'data.json')));
  await utimes(join(fixture.rootDir, 'data.json'), stat1.atime, new Date(Date.now() + 5000));
  const etagAfterTouch = (await probe(B.port, { path: '/data.json' })).headers.etag;
  ok('只改 mtime 不改内容：ETag 不变（证明按内容生成）', etagAfterTouch === etagBefore, etagBefore + ' -> ' + etagAfterTouch);
  const sameLength = fixture.jsonText.slice(0, -2) + 'XX';
  await writeFile(join(fixture.rootDir, 'data.json'), sameLength);
  const etagAfterEdit = (await probe(B.port, { path: '/data.json' })).headers.etag;
  ok('同长度但内容变化：ETag 改变（不是按大小生成）', etagAfterEdit !== etagBefore, etagBefore + ' -> ' + etagAfterEdit);
  const travSibling = await probe(B.port, { path: '/..%2froot-x%2fsecret.txt' });
  ok('兄弟目录前缀（…-x）穿越返回 403', travSibling.status === 403, travSibling.status);
  ok('兄弟目录机密内容没有泄露', !travSibling.body.toString('utf8').includes('TOP-SECRET-SIBLING'), '泄露了兄弟目录内容');
  const linkEscape = await probe(B.port, { path: '/escape.txt' });
  ok('根目录内软链指向外部时返回 403（realpath 二次校验）', linkEscape.status === 403, linkEscape.status);
  ok('软链目标内容没有泄露', !linkEscape.body.toString('utf8').includes('TOP-SECRET-SIBLING'), '泄露了软链目标内容');
  const dirList = await probe(B.port, { path: '/sub/' });
  ok('目录没有 index.html 时返回 404（不做目录列表）', dirList.status === 404, dirList.status);
  ok('404 页面不含目录内文件名（不泄露目录结构）', !dirList.body.toString('utf8').includes('secret-name.txt'), '列出了目录内容');
  const dirEscape = await probe(B.port, { path: '/dirindex/' });
  ok('目录里再套目录（index.html 是目录）不抛异常，返回 404', dirEscape.status === 404, dirEscape.status);
  const slowLogs = B.access();
  ok('--slow-ms 0 时访问日志标记 slow:true', slowLogs.length > 0 && slowLogs.every((r) => r.slow === true), slowLogs.length + ' 条');
  ok('夹具实例访问日志记录 enc 字段（gzip 请求）', slowLogs.some((r) => r.enc === 'gzip'), JSON.stringify(slowLogs.map((r) => r.enc).slice(0, 6)));

  group('--compress off / --read-write / --max-body');
  const C = await Server.start(['--root', fixture.rootDir, '--compress', 'off', '--read-write', '--max-body', '100', '--max-file-bytes', '32768', '--port', '0'], {}, '运维开关实例');
  const noGz = await probe(C.port, { path: '/data.json', headers: { 'accept-encoding': 'gzip' } });
  ok('--compress off 时不返回 Content-Encoding', noGz.headers['content-encoding'] === undefined, noGz.headers['content-encoding']);
  ok('--compress off 时仍返回完整原文', noGz.body.toString('utf8').length > 1024, noGz.body.length);
  const healthC = jsonOf(await probe(C.port, { path: '/healthz' }));
  ok('--read-write 时 /healthz readOnly 为 false', healthC.readOnly === false, healthC.readOnly);
  const post405 = await probe(C.port, { method: 'POST', path: '/index.html' });
  ok('--read-write 时写方法仍被拒（静态分发不提供写接口）', post405.status === 405, post405.status);
  ok('--read-write 时 405 带 x-read-only: 0', post405.headers['x-read-only'] === '0', post405.headers['x-read-only']);
  const tooBig = await probe(C.port, { method: 'POST', path: '/index.html', headers: { 'content-length': '500' }, body: Buffer.alloc(500, 97) });
  ok('--max-body 100 时超大请求体返回 413', tooBig.status === 413, tooBig.status);
  ok('413 是可读 HTML', looksLikeHtml(tooBig) && tooBig.body.toString('utf8').includes('413'), tooBig.body.length);
  const huge = await probe(C.port, { path: '/big.bin' });
  ok('--max-file-bytes 限制内的读盘失败返回可读 500', huge.status === 500 && looksLikeHtml(huge) && huge.body.toString('utf8').includes('500'), huge.status);
  ok('500 页面不泄露绝对路径', !huge.body.toString('utf8').includes(fixture.rootDir) && !huge.body.toString('utf8').includes(ROOT), 'body 含绝对路径');
  ok('500 页面也带 nosniff', huge.headers['x-content-type-options'] === 'nosniff', huge.headers['x-content-type-options']);
  ok('500 在服务端日志里留下可定位的 error 记录', C.logs().some((r) => r.level === 'error' && r.msg === 'file_too_large'), JSON.stringify(C.logs().filter((r) => r.level === 'error').slice(0, 2)));
  ok('500 响应正文不含服务端日志里的文件名细节', !huge.body.toString('utf8').includes('big.bin'), '泄露了文件名');

  group('--quiet / --log-format json');
  const quietPort = await freePort();
  const D = await Server.start(['--root', fixture.rootDir, '--quiet', '--port', String(quietPort)], {}, '静音实例', quietPort);
  await probe(D.port, { path: '/index.html' });
  await new Promise((r) => setTimeout(r, 150));
  ok('--quiet 时没有任何标准输出（含启动横幅与访问日志）', D.stdout === '', JSON.stringify(D.stdout.slice(0, 120)));
  ok('--quiet 时服务仍正常响应', (await probe(D.port, { path: '/index.html' })).status === 200, 'quiet 实例异常');
  const sigintExit = await D.stop('SIGINT');
  ok('SIGINT 优雅退出（退出码 0）', sigintExit.code === 0 && sigintExit.timedOut === false, JSON.stringify(sigintExit));
  const E = await Server.start(['--root', fixture.rootDir, '--log-format', 'json', '--port', '0'], {}, 'JSON 日志实例');
  const listenLog = E.logs().find((r) => r.msg === 'listen');
  ok('--log-format json 时启动信息为 JSON（含监听端口）', !!listenLog && listenLog.port === E.port, JSON.stringify(listenLog));
  await probe(E.port, { path: '/index.html' });
  const eLog = await waitFor(() => E.access().find((r) => r.path === '/index.html' && r.status === 200 && r.msg === 'access'));
  ok('JSON 日志模式下访问日志同为单行 JSON', !!eLog, '日志条数 ' + E.access().length);
  await E.stop('SIGTERM');

  group('未捕获异常不使进程崩溃 / LOG_LEVEL 静音');
  const F = await Server.start(['--root', fixture.rootDir, '--port', '0'], { CHAOS_THROW_MS: '300' }, '混沌演练实例');
  const beforeThrow = await probe(F.port, { path: '/index.html' });
  await new Promise((r) => setTimeout(r, 1200));
  ok('演练实例在抛出未捕获异常前正常服务', beforeThrow.status === 200, beforeThrow.status);
  const chaosLog = await waitFor(() => F.logs().find((r) => r.msg === 'uncaught_exception'));
  ok('未捕获异常被记录为 uncaught_exception（含信息）', !!chaosLog && /混沌演练/.test(String(chaosLog.message)), JSON.stringify(chaosLog && chaosLog.message));
  ok('未捕获异常后进程仍存活（不崩溃）', F.exit === null, JSON.stringify(F.exit));
  const afterThrow = await probe(F.port, { path: '/index.html' });
  ok('未捕获异常后继续正常响应请求', afterThrow.status === 200 && afterThrow.body.equals(beforeThrow.body), afterThrow.status);
  await F.stop('SIGTERM');

  const errorPort = await freePort();
  const G = await Server.start(['--root', fixture.rootDir, '--log-level', 'error', '--port', String(errorPort)], {}, 'LOG_LEVEL=error 实例', errorPort);
  await probe(G.port, { path: '/index.html' });
  await new Promise((r) => setTimeout(r, 150));
  ok('LOG_LEVEL=error 时不输出 info 访问日志（静音生效）', !G.stdout.includes('"msg":"access"'), JSON.stringify(G.stdout.slice(0, 120)));
  await G.stop('SIGTERM');

  group('启动失败的可读原因');
  const conflict = await runOnce(['--port', String(A.port)]);
  ok('端口被占用时退出码为 1', conflict.code === 1, JSON.stringify(conflict.code));
  ok('端口被占用时给出可读原因（EADDRINUSE / 占用）', conflict.stderr.includes('EADDRINUSE') && conflict.stderr.includes('占用'), conflict.stderr.trim().slice(0, 120));
  const noRoot = await runOnce([], { ROOT: join(tmpdir(), 'jw-not-exist-' + Date.now()) });
  ok('ROOT 不存在时退出码为 1', noRoot.code === 1, JSON.stringify(noRoot.code));
  ok('ROOT 不存在时给出可读原因（根目录）', noRoot.stderr.includes('根目录'), noRoot.stderr.trim().slice(0, 120));
  const badArg = await runOnce(['--definitely-unknown']);
  ok('未知参数退出码为 2', badArg.code === 2, JSON.stringify(badArg.code));
  ok('未知参数给出可读提示（未知参数 + 用法）', badArg.stderr.includes('未知参数') && badArg.stderr.includes('用法'), badArg.stderr.trim().slice(0, 120));
  const help = await runOnce(['--help']);
  ok('--help 退出码 0 且打印用法', help.code === 0 && help.stdout.includes('用法：node tools/serve.mjs'), JSON.stringify(help.code));

  group('优雅退出与退出码');
  const keepAliveAgent = new Agent({ keepAlive: true, maxSockets: 1 });
  const kaRes = await probe(A.port, { path: home, agent: keepAliveAgent });
  ok('keep-alive 长连接下请求正常', kaRes.status === 200, kaRes.status);
  const t0 = Date.now();
  const aExit = await A.stop('SIGTERM');
  ok('SIGTERM 下进程在 5 秒内退出', Date.now() - t0 < 5000 && aExit.timedOut === false, JSON.stringify([Date.now() - t0, aExit.timedOut]));
  ok('SIGTERM 优雅退出码为 0（不是被信号强杀）', aExit.code === 0 && aExit.signal === null, JSON.stringify(aExit));
  ok('优雅退出时打印 shutdown_done 日志', A.logs().some((r) => r.msg === 'shutdown_done'), A.logs().map((r) => r.msg).slice(-4).join(','));
  keepAliveAgent.destroy();
  let refused = null;
  try { await probe(A.port, { path: home }); } catch (e) { refused = e; }
  ok('退出后端口不再接受连接（ECONNREFUSED）', !!refused && refused.code === 'ECONNREFUSED', refused && refused.code);

  group('超时强退（在途连接不放手时必须有兜底）');
  const H = await Server.start(['--root', fixture.rootDir, '--shutdown-timeout', '600', '--port', '0'], {}, '强退演练实例');
  const halfOpen = connect(H.port, '127.0.0.1');
  await new Promise((r) => halfOpen.once('connect', r));
  halfOpen.write('GET /index.html HTTP/1.1\r\nHost: 127.0.0.1\r\n'); // 故意不发送结束空行，制造半开请求
  await new Promise((r) => setTimeout(r, 150));
  const forced = await H.stop('SIGTERM', 6000);
  ok('半开连接导致无法排空时，超时强退（退出码 1）', forced.code === 1 && forced.timedOut === false, JSON.stringify(forced));
  ok('强退在日志里留下 shutdown_forced（含在途数）', H.logs().some((r) => r.msg === 'shutdown_forced' && typeof r.inflight === 'number'), JSON.stringify(H.logs().map((r) => r.msg).slice(-3)));
  halfOpen.destroy();

  await B.stop('SIGTERM');
  await C.stop('SIGTERM');
  await rm(fixture.base, { recursive: true, force: true });
}

let fatalError = null;
try {
  await main();
} catch (e) {
  fatalError = e;
}

for (const s of servers) await s.killIfAlive();

if (fatalError) {
  console.log('\n✗ 自检未能跑完：' + (fatalError && fatalError.message ? fatalError.message : fatalError));
  console.log('\n通过 ' + pass + ' / 失败 ' + (fail + 1));
  process.exit(1);
}
console.log('\n通过 ' + pass + ' / 失败 ' + fail);
if (fail) console.log('失败项：\n  - ' + failures.join('\n  - '));
process.exit(fail ? 1 : 0);
