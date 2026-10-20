# 部署手册 · 君威智能排产助手（静态分发）

> 适用对象：交付 / 运维 / 演示保障人员。
> 本服务是**零第三方依赖**的静态分发进程（只用 `node:` 内置模块），没有构建步骤、不联网、不需要 `npm install`。
> 相关文档：运维与排障见 [OPERATIONS.md](./OPERATIONS.md)；演示流程见 [演示脚本.md](./演示脚本.md)。

---

## 一、交付物清单

| 路径 | 说明 | 必须部署 |
|---|---|---|
| `web/` | 前端（原生 ES Modules + `assets/app.css`，无 CDN、无外部字体） | ✅ |
| `data/` | 数据快照：`dataset.json`（真实脱敏 1.18MB）、`demo-dataset.json`、`spec-derivation.json` | ✅ |
| `tools/serve.mjs` | 生产静态服务器（缓存 / 压缩 / Range / 健康检查 / 日志 / 优雅退出） | ✅ |
| `tools/check_server.mjs` | 部署后自检（149 项，起真实子进程 + HTTP 探针） | 建议 |
| `Dockerfile` / `.dockerignore` | 镜像定义（node:24-alpine，非 root，HEALTHCHECK） | 容器方式 |
| `docker-compose.yml` | 单机编排示例（只读根文件系统 + `data/` 只读挂载 + healthcheck） | 容器方式 |
| `tools/check_*.mjs`、`README.md`、`docs/` | 质量自检与文档 | ❌（不进镜像） |

镜像内只包含前三项，共 38 个文件 / 约 1.8MB（实测 `du -sh`）。

## 二、运行前置

- **Node.js ≥ 18.2**（实测 v24.17.0）。优雅退出用到 `server.closeIdleConnections()`（Node 18.2+ 提供，代码里做了存在性判断，更低版本不会崩但空闲连接要等 keep-alive 超时）。
- 一个可用端口，默认 **5178**。
- 根目录需包含 `web/index.html`，否则启动时会打印警告（服务仍能起，首页会 404）。

## 三、三种启动方式

### 3.1 本地 / 演示机（最简）

~~~bash
cd "君威智能排产助手"
node tools/serve.mjs
# 浏览器打开 http://127.0.0.1:5178/web/index.html
# 应用打开时是空白工作台：上传订单文件 + 设备/产能文件后才会有数据与排产结果
# 免上传的演示/巡检入口（显式深链，不是默认行为）：
#   真实脱敏快照 http://127.0.0.1:5178/web/index.html?data=real
#   精简演示场景 http://127.0.0.1:5178/web/index.html?data=demo
~~~

端口被占用时：`PORT=5180 node tools/serve.mjs`。启动横幅会打印真实监听地址、根目录、只读/压缩状态。

### 3.1.1 同一局域网共享给其他设备（手机 / 平板 / 同事电脑）

> 本节是速览版；独立成篇的完整版见 **[局域网部署指南.md](./局域网部署指南.md)**（入口链接矩阵、各屏幕尺寸实测、分层排查清单、安全边界）。

默认只监听 `127.0.0.1`，**其他设备连不上**（这是有意的最小暴露面）。要让同一 Wi-Fi / 交换机下的设备访问，显式绑定到所有网卡：

~~~bash
cd "君威智能排产助手"
node tools/serve.mjs --host 0.0.0.0      # 等价于 HOST=0.0.0.0 node tools/serve.mjs
~~~

然后查本机局域网地址，把地址发给对方：

~~~bash
ipconfig getifaddr en0        # macOS Wi-Fi；有线网卡是 en1
# 例：10.89.133.73  →  http://10.89.133.73:5178/web/index.html
~~~

| 用途 | 链接 |
|---|---|
| 应用首页（空白工作台，需上传文件） | `http://<本机IP>:5178/web/index.html` |
| 免上传：真实脱敏快照 | `http://<本机IP>:5178/web/index.html?data=real` |
| 免上传：精简演示场景（手机演示推荐） | `http://<本机IP>:5178/web/index.html?data=demo` |

**已验证可用**：真浏览器以移动端视口从局域网地址访问，39 条甘特任务正常渲染、IndexedDB 持久化 `ok`、触屏可展开下拉菜单。

注意事项（都是实测过的坑）：

1. **不是安全上下文**：明文 HTTP + 非 localhost 访问时，浏览器会把该来源标记为「不可信」，
   `navigator.clipboard` 等部分 API 受限（本项目已有 `execCommand('copy')` 兜底），`Cross-Origin-Opener-Policy` 响应头会被忽略（仅提示，不影响功能）。
   **不需要 HTTPS 也能完整使用**：ES Modules、IndexedDB、BroadcastChannel 在该场景下均正常。
2. **凭据与会话按来源隔离**：`http://10.x.x.x:5178` 与 `http://127.0.0.1:5178` 是两个来源，
   本地持久化的版本 / 审计不会互通，对方设备是干净的空白工作台。
3. **IP 由 DHCP 分配，可能变化**：路由器重启或长时间后地址会变，重新用上面的命令查即可。
   需要固定地址请在路由器上做 DHCP 保留，或直接用第 3.2 节的内网服务器部署。
4. **主机不能睡**：系统睡眠会断开访问（显示器睡眠不影响）。长时间演示可执行 `caffeinate -s` 保持唤醒。
5. **防火墙**：macOS 若开启「防火墙」，首次监听时系统会弹出「是否允许 node 接受传入连接」，选择允许即可；
   用 `/usr/libexec/ApplicationFirewall/socketfirewall --getglobalstate`（或系统设置 → 网络 → 防火墙）确认。
6. **安全边界**：服务是**只读**的（写方法一律 405）、无需登录、**没有任何认证**。
   它只应暴露在可信局域网内 —— **不要做端口转发或反向代理到公网**，比赛数据虽已脱敏但按约定仅限本次比赛使用。

> **部署提示**：`data/` 目录现在只是「内置示例快照」，不是应用的默认数据源 —— 即使不挂载 `data/`，
> 页面也能正常打开并使用上传流程。若希望访客打开即看到现成计划（展厅 / 巡检大屏），
> 请把书签或入口链接写成 `?data=real`，而不要依赖某个隐式默认值。

### 3.2 内网服务器（systemd 托管）

前端是纯静态资源，**不需要 Nginx 也能直接对外服务**（本服务自带 gzip/brotli、缓存头、健康检查）。

~~~ini
# /etc/systemd/system/jw-scheduler.service
[Unit]
Description=君威智能排产助手 · 静态分发
After=network.target

[Service]
Type=simple
User=jwapp
Group=jwapp
WorkingDirectory=/srv/jw-scheduler
Environment=NODE_ENV=production
Environment=HOST=0.0.0.0
Environment=PORT=5178
Environment=ROOT=/srv/jw-scheduler
Environment=READ_ONLY=true
Environment=MAX_AGE=3600
Environment=LOG_FORMAT=json
Environment=LOG_LEVEL=info
ExecStart=/usr/bin/node /srv/jw-scheduler/tools/serve.mjs
Restart=on-failure
RestartSec=2

# 优雅退出：先 SIGTERM，服务会停止接收新连接、等在途请求（默认最多 10s）
KillSignal=SIGTERM
TimeoutStopSec=20

# 加固
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadOnlyPaths=/srv/jw-scheduler
PrivateTmp=true

[Install]
WantedBy=multi-user.target
~~~

~~~bash
sudo systemctl daemon-reload && sudo systemctl enable --now jw-scheduler
journalctl -u jw-scheduler -f --output=cat     # 访问日志（JSON 一行一条）
curl -s http://127.0.0.1:5178/healthz | head
~~~

内网暴露时的两条硬性建议：
1. `HOST=0.0.0.0` 只在确实需要被其它机器访问时使用；默认 `127.0.0.1` 仅本机可访问。
2. 用防火墙限制来源网段（数据为比赛脱敏数据，仍然禁止外传）：
   ```bash
   sudo ufw allow from 10.20.0.0/16 to any port 5178 proto tcp
   ```

### 3.3 容器（Docker / Compose）

~~~bash
# 构建（无网络依赖，镜像只需要 node:24-alpine 基础层）
docker build -t jw-scheduler-static:1.0.0 .

# 直接运行：容器内已设 HOST=0.0.0.0、ROOT=/app、NODE_ENV=production
docker run -d --name jw-scheduler \
  -p 5178:5178 \
  -v "$PWD/data:/app/data:ro" \
  --read-only --tmpfs /tmp \
  --security-opt no-new-privileges:true \
  --restart unless-stopped \
  jw-scheduler-static:1.0.0

# 或者用编排文件（已含 healthcheck 与 data/ 只读挂载）
docker compose up -d --build
docker compose ps                     # STATUS 列会显示 healthy
curl -s http://127.0.0.1:5178/healthz
~~~

镜像特性：
- 基础镜像 `node:24-alpine`，**非 root**（`USER node`，uid 1000）运行；
- 只 `COPY web/ data/ tools/serve.mjs`，自检脚本与文档不进镜像；
- `HEALTHCHECK` 用 `node -e` 请求 `/healthz`（不依赖 curl/wget）；
- `EXPOSE 5178`，`CMD ["node", "tools/serve.mjs"]`；
- `ENV NODE_ENV=production HOST=0.0.0.0 ROOT=/app READ_ONLY=true LOG_FORMAT=json`。

## 四、环境变量与命令行开关全表

环境变量与同名命令行开关等价（命令行优先，因为它在解析时覆盖环境变量）。

| 环境变量 | 命令行 | 默认值 | 说明 |
|---|---|---|---|
| `PORT` | `--port <n>` | `5178` | 监听端口；`0` 表示由内核分配随机空闲端口（启动横幅/JSON 日志会打印真实端口） |
| `HOST` | `--host <addr>` | `127.0.0.1` | 监听地址；容器/内网用 `0.0.0.0` |
| `ROOT` | `--root <dir>` | 脚本上一级目录 | 静态根目录，可指向别处的构建产物 |
| `READ_ONLY` | `--read-only` / `--read-write` | `true` | 只读分发：一切写方法返回 405 + `Allow: GET, HEAD`，响应头带 `X-Read-Only: 1`；`/healthz` 的 `readOnly` 字段同步反映 |
| `MAX_AGE` | `--max-age <秒>` | `3600` | 图片与字体的 `Cache-Control: public, max-age=N`；html/js/css/json 恒为 `no-cache` |
| `COMPRESS` | `--compress on\|off` / `--no-compress` | `on` | gzip + brotli 协商压缩（<1KB 不压缩） |
| `LOG_LEVEL` | `--log-level <级别>` | `info` | `silent\|error\|warn\|info\|debug` |
| `LOG_FORMAT` | `--log-format text\|json` | `text` | `json` 时启动信息也是单行 JSON（容器建议 json） |
| — | `--quiet` | — | 等价 `LOG_LEVEL=silent`：连启动横幅一起静音（排障时不要开） |
| `SLOW_MS` | `--slow-ms <毫秒>` | `1000` | 超过该耗时的请求在访问日志里标 `slow:true` |
| `MAX_URL_LENGTH` | `--max-url <字节>` | `8192` | 超长 URL 返回 414（超过 64KB 由 Node 解析层拦截，同样返回 414） |
| `MAX_BODY_BYTES` | `--max-body <字节>` | `1048576` | 请求体上限，超出返回 413（本服务不消费 body） |
| `MAX_FILE_BYTES` | `--max-file-bytes <n>` | `33554432` | 单文件上限（32MB），超出返回 500 并在日志留 `file_too_large` |
| `SHUTDOWN_TIMEOUT_MS` | `--shutdown-timeout <ms>` | `10000` | 优雅退出等待在途请求的上限，超时强退（退出码 1） |
| `BUILD_TIME` | — | 空 | 构建时间，出现在 `/version`（CI 注入 `date -u +%FT%TZ`） |
| `GIT_SHA` | — | 空 | 构建提交号，出现在 `/version` |
| `NODE_ENV` | — | `development` | 出现在 `/version.env`；生产用 `production` |
| `CHAOS_THROW_MS` | — | 空（关闭） | **混沌演练专用**：设为毫秒数后，服务会在该时间点抛出一次未捕获异常，用于验证「异常只记录、进程不退出」。生产不要设置 |

其他命令行开关：`-h/--help`（打印用法后退出 0）、`-v/--version`（打印版本号后退出 0）；未知参数退出码 **2** 并打印用法。

## 五、Nginx 反向代理示例

两种模式**二选一**，不要同时压缩（会二次压缩、并让 `Content-Length` 与 `Content-Encoding` 语义混乱）。

**模式 A（推荐）：后端压缩，Nginx 只透传**

~~~nginx
upstream jw_scheduler { server 127.0.0.1:5178; keepalive 16; }

server {
  listen 80;
  server_name scheduler.example.internal;

  # 后端已经做 gzip/br 协商，这里必须关闭 Nginx 自身的 gzip
  gzip off;

  # 只读分发不接受上传
  client_max_body_size 1m;

  location / {
    proxy_pass http://jw_scheduler;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    # 关键：把浏览器的 Accept-Encoding 原样透传，才能拿到 br/gzip 变体
    proxy_set_header Accept-Encoding $http_accept_encoding;
    # Range 透传（大 xlsx/数据文件下载）
    proxy_set_header Range $http_range;
    proxy_set_header If-Range $http_if_range;
    proxy_buffering off;
  }

  # 缓存头由后端给出（html/js/css → no-cache；图片/字体 → public, max-age=3600）。
  # 若希望 Nginx 直接接管图片与字体缓存，可显式补一条（值要与 MAX_AGE 保持一致）：
  location ~* \.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf)$ {
    proxy_pass http://jw_scheduler;
    proxy_http_version 1.1;
    proxy_set_header Connection "";
    proxy_set_header Accept-Encoding $http_accept_encoding;
    expires 1h;
    add_header Cache-Control "public, max-age=3600";
  }

  # 健康检查只给监控网段
  location = /healthz {
    allow 10.20.0.0/16;
    allow 127.0.0.1;
    deny all;
    proxy_pass http://jw_scheduler;
  }

  # 生产环境建议加 HSTS（本服务只跑 HTTP，HSTS 由 TLS 终结层加）
  # add_header Strict-Transport-Security "max-age=31536000" always;
}
~~~

**模式 B：Nginx 压缩（后端请求 identity）**

~~~nginx
gzip on;
gzip_comp_level 6;
gzip_min_length 1024;
gzip_types text/plain text/css text/javascript application/javascript application/json image/svg+xml;
# 去掉 Accept-Encoding 再转发，后端就返回原文
proxy_set_header Accept-Encoding "";
~~~

> 注意：安全响应头（CSP / X-Frame-Options / Referrer-Policy / COOP / nosniff）由本服务发出并会被 Nginx 透传；
> 若在 Nginx 上继续 `add_header`，请确认不要覆盖掉 `Content-Security-Policy`。

## 六、升级与回滚

**推荐做法：版本目录 + 原子软链**（服务零依赖，升级就是把新产物放进去再切链接）。

~~~bash
# 目录约定
/srv/jw-scheduler/
├─ releases/2026-09-19T0130/   # 每次交付解包一份（web/ data/ tools/）
├─ releases/2026-09-18T2210/
└─ current -> releases/2026-09-19T0130

# 升级
tar -xzf jw-scheduler-2026-09-19T0130.tar.gz -C /srv/jw-scheduler/releases/2026-09-19T0130
ln -sfn /srv/jw-scheduler/releases/2026-09-19T0130 /srv/jw-scheduler/current
sudo systemctl restart jw-scheduler          # 静态服务重启 < 1s，无预热
curl -s http://127.0.0.1:5178/version        # 确认 version / data.mtime 是新快照
node /srv/jw-scheduler/current/tools/check_server.mjs   # 149 项自检（可选，但建议在预发环境跑）

# 回滚（分钟级）
ln -sfn /srv/jw-scheduler/releases/2026-09-18T2210 /srv/jw-scheduler/current
sudo systemctl restart jw-scheduler
curl -s http://127.0.0.1:5178/version | grep -E '"version"|"mtime"'
~~~

**容器方式**：

~~~bash
docker build -t jw-scheduler-static:1.0.1 .
docker compose up -d                 # 或 docker stop/rm + docker run 新 tag
docker compose ps                    # 等待 healthy
# 回滚
sed -i 's/:1.0.1/:1.0.0/' docker-compose.yml && docker compose up -d
~~~

回滚检查清单：`/healthz` 200 → `/version` 的 `version` 与 `data.mtime` 符合预期 → 浏览器强刷（Ctrl/Cmd+Shift+R）确认页面与数据一致 → 抽查一次导出。

## 七、只读部署与数据更新流程

**只读体现在三层**（任意一层单独失效也不会写坏数据）：

| 层 | 手段 | 效果 |
|---|---|---|
| 应用 | `--read-only`（默认开启） | POST/PUT/DELETE/PATCH/OPTIONS 一律 405，响应头 `X-Read-Only: 1`，日志记 `readonly_block:true` |
| 容器 | `read_only: true` + `tmpfs /tmp` | 容器根文件系统只读，进程无法在 `/app` 落任何文件 |
| 挂载 | `-v ./data:/app/data:ro` | 即使进程被替换也改不动数据快照 |

**数据更新四步（不能直接把文件覆盖写进正在服务的 `data/`）**

1. **校验**：新快照先在临时目录跑数据校验，失败就不上线
   ~~~bash
   PYTHONPATH=../.pylibs python3 tools/validate_dataset.py     # 退出码 0 才算通过
   node -e "JSON.parse(require('fs').readFileSync('/tmp/new/dataset.json','utf8'));console.log('JSON OK')"
   ~~~
2. **备份**：`tar -czf /var/backups/jw/data-$(date +%F-%H%M).tgz data/`
3. **原子替换**：`install -m 644 /tmp/new/dataset.json data/dataset.json.new && mv -f data/dataset.json.new data/dataset.json`
   （`mv` 在同一文件系统内是原子 rename；服务端 `readFile` 永远读到完整文件，不会读到半个 JSON）
4. **复验**：`curl -s http://127.0.0.1:5178/version` 看 `data.bytes` / `data.mtime` 是否更新；`curl -s -D- -o /dev/null http://127.0.0.1:5178/data/dataset.json | grep -i etag` 确认 ETag 变了；
   浏览器强刷后确认 D01/D03 数据一致。**ETag 是按内容算的，数据换了 ETag 必换**，不会被缓存挡住。

> 容器方式更新数据：`data/` 是只读挂载，更新宿主机目录后 `docker compose restart`（或 `docker kill -s HUP` 无效，直接 restart）即可。

## 八、部署后验收（照着敲）

~~~bash
node tools/check_server.mjs                                          # 149 项，全绿才交付
curl -sI  http://127.0.0.1:5178/web/index.html | head -20            # 200 + 安全头 + ETag + Vary
curl -s   http://127.0.0.1:5178/healthz                              # status ok / readOnly true
curl -s   http://127.0.0.1:5178/version                              # version + data 快照信息
curl -sD- -o /dev/null -H 'Accept-Encoding: br' http://127.0.0.1:5178/data/dataset.json | grep -i content-encoding
curl -sD- -o /dev/null -H 'Range: bytes=0-9'    http://127.0.0.1:5178/data/dataset.json | grep -i content-range
curl -s -o /dev/null -w '%{http_code}\n' -X POST http://127.0.0.1:5178/web/index.html   # 405
~~~

> 说明：`/healthz` 会返回服务器上的绝对根目录（便于确认 ROOT 指向是否正确）。若安全要求不允许暴露路径，
> 请在 Nginx 层把 `/healthz` 限制到监控网段（见第五节示例），或只在容器内探测。
