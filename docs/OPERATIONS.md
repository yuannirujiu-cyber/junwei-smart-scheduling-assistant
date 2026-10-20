# 运维手册 · 君威智能排产助手（静态分发）

> 面向值守与排障：健康检查、日志字段、常见故障、备份恢复、容量与性能基线。
> 部署方式与环境变量见 [DEPLOYMENT.md](./DEPLOYMENT.md)。

---

## 一、健康检查

### 1.1 存活 / 就绪：`GET /healthz`

返回 200 + JSON（`Cache-Control: no-store`）。本服务无外部依赖（不连数据库、不连上游），**能应答即就绪**。

| 字段 | 含义 | 运维用法 |
|---|---|---|
| `status` | 恒为 `ok` | 探针判据：`status==="ok"` |
| `version` | 服务端版本号 | 与 `/version`、发布单核对 |
| `uptimeSec` | 运行秒数（整数） | **突然归零 = 进程重启过**，配合 `shutdown_*` 日志排查 |
| `startedAt` | 启动时刻（ISO8601） | 与发布/重启记录对齐 |
| `root` | 静态根目录（绝对路径） | 确认 ROOT 是否指向本次发布目录 |
| `readOnly` | 是否只读模式 | 生产必须为 `true`；为 `false` 说明启动参数被改过 |
| `compress` / `maxAge` | 压缩开关 / 图片缓存秒数 | 与配置基线核对 |
| `host` / `port` | 实际监听地址与端口 | 端口漂移（`PORT=0`）时用于定位 |
| `pid` / `node` | 进程号 / Node 版本 | 与 `docker top`、systemd 主 PID 对齐 |
| `inflight` | 当前在途请求数 | 长期 > 0 说明有慢请求或连接堆积 |
| `memory.rssMB` / `heapUsedMB` | 进程常驻内存 / 堆使用 | 观察是否随时间单调上涨（见 §五.3） |
| `cacheEntries.files` / `.encoded` | 内容缓存 / 压缩缓存条目数 | 有上限（64 / 64），不会无限增长 |
| `stats.total` / `byStatus` / `bytesOut` | 累计请求数 / 各状态码计数 / 出流量 | 与日志/监控对账；`byStatus["5"]` 类异常升高即告警 |

~~~bash
curl -s http://127.0.0.1:5178/healthz | python3 -m json.tool
docker inspect --format '{{.State.Health.Status}}' jw-scheduler     # healthy
~~~

### 1.2 构建与数据版本：`GET /version`

| 字段 | 说明 |
|---|---|
| `name` / `server` | 分发名称 / 服务器标识（`jw-scheduler-static`） |
| `version` | 服务端版本（与 `--version` 一致） |
| `node` / `env` | Node 版本 / `NODE_ENV` |
| `startedAt` | 启动时刻 |
| `buildTime` / `gitSha` | 构建时间与提交号（由环境变量 `BUILD_TIME`/`GIT_SHA` 注入，未注入为 null） |
| `data.path` / `bytes` / `mtime` | **线上数据快照**的路径、字节数、修改时间——数据更新后必须核对这三项 |

### 1.3 探针配置建议

| 场景 | 配置 |
|---|---|
| Docker | 镜像自带 `HEALTHCHECK`（30s 间隔 / 3s 超时 / 5s 起步 / 3 次失败标记 unhealthy），无需额外配置 |
| systemd | `Restart=on-failure`；如需自愈可加 `ExecStartPost=/usr/bin/curl -fsS http://127.0.0.1:5178/healthz` |
| 监控 | 1 分钟一次 `/healthz`，告警条件：非 200 / `uptimeSec` 回落 / `inflight>0` 持续 5 分钟 / `rssMB` 连续 30 分钟上涨 |
| 负载均衡 | `GET /healthz` 作就绪探针即可（无预热、无连接池） |

## 二、日志字段说明

日志是**一行一条 JSON**（`LOG_FORMAT=json` 时启动信息也是 JSON），直接进 journald / docker logs / Loki / ELK 均可。

### 2.1 访问日志（`msg:"access"`）

~~~json
{"t":"2026-09-18T17:33:51.185Z","level":"info","msg":"access","id":"0001-mu78mitp","method":"GET",
 "path":"/web/index.html","status":200,"bytes":861,"ms":3.49,"ua":"curl/8.7.1","ip":"127.0.0.1",
 "enc":"identity","cache":"miss"}
~~~

| 字段 | 含义 | 备注 |
|---|---|---|
| `t` | 时间（UTC ISO8601） | 与容器/宿主机时区无关，统一 UTC |
| `level` | `info` / `warn` / `error` | 访问日志恒为 `info` |
| `msg` | 事件名，访问日志恒为 `access` | 见 §2.2 事件表 |
| `id` | 请求编号 | 同时放在响应头 `X-Request-Id`；用户报障时让他提供该编号即可定位 |
| `method` | HTTP 方法 | 非 GET/HEAD 会同时出现 `readonly_block:true` |
| `path` | 请求路径（含查询串，最长 512 字符） | |
| `status` | 响应状态码 | |
| `bytes` | **响应体字节数**（与 `Content-Length` 一致；304/HEAD 记实际发送字节） | 流量对账 |
| `ms` | 处理耗时（毫秒，两位小数） | `ms >= SLOW_MS` 时追加 `slow:true` |
| `ua` | User-Agent（截断 200 字符） | 区分浏览器 / 探针 / 爬虫 |
| `ip` | 对端地址 | `127.0.0.1` 说明是健康检查或本机探针 |
| `enc` | 实际使用的编码：`identity` / `gzip` / `br` | 排「为什么没压缩」看这里 |
| `cache` | `hit`（304 命中）/ `miss`（返回 200）/ `-`（非静态文件） | 缓存命中率 = hit/(hit+miss) |
| `range` | 命中区间请求时的 `起-止` 字节 | 大文件下载排障 |
| `readonly_block` | 写方法被只读模式拦截 | 出现即说明有人/脚本在尝试写 |
| `slow` | 慢请求标记 | 触发阈值 `SLOW_MS`（默认 1000ms） |

### 2.2 事件日志（`msg` 取值表）

| `msg` | level | 含义 | 处置 |
|---|---|---|---|
| `listen` | info | 启动完成（JSON 模式），带 host/port/root/readOnly/compress | 正常 |
| `access` | info | 每次请求一条 | — |
| `shutdown_begin` | info | 收到 SIGTERM/SIGINT，停止接收新连接 | 正常 |
| `shutdown_done` | info | 在途请求已排空，进程以 0 退出 | 正常 |
| `shutdown_forced` | error | 超时（默认 10s）强退，退出码 1 | 检查是否有卡住的长请求/大文件下载 |
| `client_error` | warn | HTTP 报文解析失败（含超长请求行 → 414） | 偶发可忽略；持续出现查客户端/扫描器 |
| `request_failed` | error | 单请求内部异常（附堆栈），已回 500 | **必须查**，堆栈含根因 |
| `file_too_large` | error | 目标文件超过 `MAX_FILE_BYTES`（默认 32MB） | 确认是否误放大文件；必要时调大上限 |
| `uncaught_exception` | error | 进程级未捕获异常（**服务不退出**，记录后继续） | 必须查，可能已影响其它请求 |
| `unhandled_rejection` | error | 未处理的 Promise 拒绝 | 同上 |

### 2.3 日志级别与静音

| 设置 | 效果 |
|---|---|
| `LOG_LEVEL=debug` | 目前与 info 相同（保留扩展位） |
| `LOG_LEVEL=info`（默认） | 启动横幅 + 全部访问日志 + 事件日志 |
| `LOG_LEVEL=warn` | 只留 warn/error（**排障期不要用**） |
| `LOG_LEVEL=error` | 只留错误 |
| `LOG_LEVEL=silent` / `--quiet` | 完全静音（含启动横幅）；仅启动失败时的致命原因仍打到 stderr |

常用检索：

~~~bash
journalctl -u jw-scheduler -f --output=cat | grep '"msg":"access"' | jq -c 'select(.status>=400)'
docker logs -f jw-scheduler | jq -c 'select(.msg=="access" and .slow==true)'
docker logs jw-scheduler | jq -r 'select(.msg=="access") | .status' | sort | uniq -c   # 状态码分布
~~~

**日志量估算**：一条访问日志约 250–320 字节。首屏加载约 12 个请求（HTML + CSS + 12 个 JS 模块 + 1 个数据快照，模块走 304 后仍会计一条日志），
即一次刷新 ≈ 14 条 ≈ 4KB。按 50 人/天、每人 60 次刷新估算：`50×60×14×0.3KB ≈ 12.6MB/天`，需要长期留存时按此规划轮转（`logrotate` 或 Docker `max-size`）。

## 三、常见故障排查

### 3.1 端口被占用（EADDRINUSE）

现象：进程立刻退出，退出码 1，stderr 打印
`启动失败：端口 5178 已被占用（EADDRINUSE）。请换端口，例如 PORT=5180 node tools/serve.mjs，或先用 lsof -i :5178 找到占用进程。`

~~~bash
lsof -nP -i :5178                 # macOS / Linux
ss -lntp | grep 5178              # Linux 备选
PORT=5180 node tools/serve.mjs    # 临时换端口
kill -TERM <pid>                  # 优雅停掉旧进程（本服务 SIGTERM 退出码 0）
~~~

容器内端口冲突通常是**宿主端口被别的容器占用**（容器内 5178 不会冲突）：`docker ps --format '{{.Names}} {{.Ports}}'`。

### 3.2 权限问题（EACCES / EROFS / 读不到文件）

| 现象 | 原因 | 处置 |
|---|---|---|
| `启动失败：没有权限绑定 0.0.0.0:80（EACCES）` | 1024 以下端口需特权 | 换高位端口，或由 Nginx 反代到 5178 |
| `启动失败：根目录不存在或不可访问 -> …（EACCES）` | 运行用户对 ROOT 无 `x` 权限 | `chmod o+rx` 各级父目录，或把产物放到运行用户可读的路径 |
| 首页 404 但进程健康 | `ROOT` 指错（少了 `web/`） | 看启动日志的「根目录」行与 `/healthz` 的 `root`；ROOT 必须指向含 `web/index.html` 的目录 |
| `EROFS: read-only file system` | 容器 `read_only: true` 且服务试图写盘 | 本服务只读运行，正常不会写盘；出现即说明有人开了 `--read-write` 之外的写逻辑 |
| 单个文件 500 + 日志 `file_too_large` | 文件超过 32MB | 确认文件用途；用 `--max-file-bytes` 调整并重启 |

### 3.3 大文件与区间下载

- 响应 200 且带 `Accept-Ranges: bytes`；带 `Range: bytes=a-b` 的请求返回 **206** + `Content-Range`。
- **416** 表示区间不合法：语法错误（`bytes=abc`）、越界（`bytes=99999999-`）、多区间（`bytes=0-1,5-6`，本服务不支持 multipart，统一按非法处理）。
- 区间请求**不做压缩**（必须与原文逐字节一致），因此大文件断点续传不会被编码干扰。
- 下载中断/速度慢：先看访问日志的 `ms`/`slow`；若 `Range` 请求频繁且 `status=200`，说明客户端没发 Range（服务端无责）。
- 32MB 上限来自「整文件读入内存后哈希 + 压缩」的实现选择：本仓库最大文件 1.18MB，正常不会触及。

### 3.4 编码问题

| 现象 | 原因 / 处置 |
|---|---|
| 请求 `/web/%zz` → **400**（可读 HTML） | 畸形百分号编码，属预期行为，不是故障 |
| 请求含 `%00` → **400** | 空字节路径，安全拒绝 |
| URL 超过 8192 字节 → **414** | 预期行为；超过 64KB 由 Node 解析层拦截，同样 414 |
| 中文路径 404 | 根目录下没有该文件；路径经 `decodeURIComponent` 后再校验，中文文件名本身受支持 |
| 页面中文乱码 | 所有文本类型都带 `charset=utf-8`；若经 Nginx 二次处理，确认不要改写 `Content-Type` |
| 导入 xlsx 报「字段缺失」 | 与服务器无关（浏览器内解析），见 D01 的错误清单 |

### 3.5 「页面还是旧的」

顺序排查：
1. 看响应头：html/js/css/json **恒为 `Cache-Control: no-cache`**（每次带 ETag 回源校验，不会拿到陈旧内容）。
2. 看 `ETag`：数据更新后 ETag 必然变化（按内容哈希）。若 ETag 没变，说明文件没换成功 → 回到 DEPLOYMENT §七 的原子替换步骤。
3. 图片/字体是 `public, max-age=3600`，最长 1 小时陈旧；紧急时可 `?v=xxx` 破缓存或调小 `MAX_AGE`。
4. 浏览器强刷（Cmd/Ctrl+Shift+R）；nginx 层若有缓存，`proxy_buffering off` 或清缓存。

### 3.6 页面白屏 / 控制台报 CSP 错误

本服务下发**严格 CSP**：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`。

- 判定：浏览器控制台出现 `Refused to load/execute …` 且响应头有 `Content-Security-Policy`。
- 本应用零外部资源、无内联脚本，已实测：真浏览器回归 38/38 通过；`a[download]` + `blob:` 导出下载在 CSP 下可用且无控制台错误（2026-09-19 实测）。
- 若引入了新的外部资源（CDN、外链字体、外部接口），必须同步放宽对应指令——**优先改代码不引外部依赖**。
- 临时放宽：加 `--` 无此开关，需改 `tools/serve.mjs` 的 `CSP` 常量后重启（不建议在生产放宽，先在本机验证）。

### 3.7 反向代理后 502 / 504 / 压缩失效

- 502：后端没起或端口不对 → `curl -s http://127.0.0.1:5178/healthz` 直连验证。
- 504：`proxy_read_timeout` 太短或后端在传大文件 → 调大并确认后端 `timeout=120s`（本服务默认 120s 空闲超时）。
- 压缩失效：Nginx 用了模式 B（`Accept-Encoding ""`）却期望 br → 改为模式 A 透传（见 DEPLOYMENT §五）。
- 响应头丢失：`add_header` 覆盖 → 用 `proxy_pass` 透传，别在 location 里重复 `add_header Cache-Control`。

## 四、备份与恢复

### 4.1 需要备份的内容

| 对象 | 位置 | 是否随镜像/仓库 | 备份频率 |
|---|---|---|---|
| 数据快照 | `data/dataset.json`、`data/demo-dataset.json`、`data/spec-derivation.json` | 随交付包 | 每次数据更新前必做（这是**唯一不可再生**的输入） |
| 前端与服务器代码 | `web/`、`tools/serve.mjs` | 随交付包 | 每个发布版本留档 |
| 运行时产物 | 无（服务不写盘、无状态、无数据库） | — | 不需要 |

> 服务本身**不落任何文件**（无上传、无缓存文件、无日志文件——日志只进 stdout）。所以「备份」= 备份 `data/` 与版本目录。

### 4.2 备份

~~~bash
# 数据快照 + 当前版本（一次打包，带校验清单）
BK=/var/backups/jw; mkdir -p "$BK"
tar -czf "$BK/jw-$(date +%F-%H%M).tgz" data/ web/ tools/serve.mjs
sha256sum "$BK"/jw-*.tgz > "$BK/SHA256SUMS"      # macOS 用 shasum -a 256
~~~

### 4.3 恢复

~~~bash
tar -xzf /var/backups/jw/jw-2026-09-19-0130.tgz -C /srv/jw-scheduler/releases/2026-09-19-0130
cd /srv/jw-scheduler/releases/2026-09-19-0130
PYTHONPATH=../.pylibs python3 tools/validate_dataset.py     # 校验数据完整性（若有 tools/）
ln -sfn /srv/jw-scheduler/releases/2026-09-19-0130 /srv/jw-scheduler/current
sudo systemctl restart jw-scheduler
curl -s http://127.0.0.1:5178/version | grep -E '"version"|"bytes"|"mtime"'
~~~

### 4.4 浏览器端持久化

- **服务端不保存任何用户操作**：排产、锁定、调整、确认全部在浏览器内存里，刷新即重置（界面侧栏已如实标注）。
- 会话持久化（`localStorage`）是**正在进行的能力**，尚未纳入本次交付；上线后仍建议以下面的方式留痕。
- 需要留痕/交接时，用 D03 导出面板产出 **xlsx / csv / png**（导出文件抬头写明版本、数据快照、导出范围与确认状态），或使用「诊断包」JSON。
- 浏览器数据清理（清除站点数据、换浏览器、隐身窗口）会**丢失未导出的会话**，演示前务必导出一次。

## 五、容量与性能基线

### 5.1 实测环境

macOS 笔记本 / Node **v24.17.0** / 单进程 / 单线程 HTTP / 本机回环；客户端为同机 Node 探针（keep-alive，禁用连接建立开销）。
数字用于**判断数量级**，不是承诺值；生产按 1/3 折算即可（内网 50–100 人规模远低于此）。

### 5.2 吞吐与延迟（实测）

| 场景 | 并发 | 请求数 | 吞吐 | 平均 | p95 |
|---|---|---|---|---|---|
| `/web/index.html`（861B，no-cache） | 20 | 2000 | 21,228 req/s | 0.93ms | 1.96ms |
| `/web/src/main.js`（约 60KB） | 20 | 2000 | 29,609 req/s | 0.67ms | 1.38ms |
| `/data/dataset.json` 原文（1.18MB） | 8 | 400 | 3,599 req/s | 2.21ms | 4.59ms |
| 同上，`Accept-Encoding: gzip`（135KB） | 8 | 400 | 10,180 req/s | 0.78ms | 1.34ms |
| 同上，`Accept-Encoding: br`（100KB） | 8 | 400 | 13,005 req/s | 0.61ms | 0.70ms |
| 条件请求命中 304 | 20 | 2000 | 44,353 req/s | 0.45ms | 0.70ms |

结论：瓶颈在**首包体积**而非 CPU；压缩 + 304 让数据快照的重复加载成本降到 1/11 ~ 1/8。

### 5.3 体积与内存

| 项目 | 实测值 |
|---|---|
| `data/dataset.json` 原文 | 1,178,863 B |
| 同上 gzip | 134,626 B（**11.4%**） |
| 同上 brotli（quality 5） | 99,649 B（**8.5%**） |
| 进程 RSS（空闲） | 58.7 MB |
| 进程 RSS（加载 1.18MB 数据 + br 缓存后） | 69.5 MB |
| 堆使用 | 7.7 MB → 8.2 MB |
| 内存缓存上限 | 文件内容 64 项 / 64MB；压缩结果 64 项 / 48MB（LRU 淘汰，**不会无限增长**） |
| 单文件上限 | 32MB（`MAX_FILE_BYTES`） |
| 镜像内容 | 38 个文件 / 约 1.8MB（基础镜像另计） |

内存上涨的判定：连续观察 `/healthz` 的 `memory.rssMB`，若 30 分钟内持续单调上涨且 `cacheEntries` 已达上限，属于异常，收集 `request_failed`/`uncaught_exception` 日志后再重启。

### 5.4 压测与复现

~~~bash
node tools/check_server.mjs     # 149 项：压缩一致性、Range 字节级校验、并发无关的协议行为
# 自建压测（零依赖）：见交付汇报中的 /tmp/jw_bench.mjs，或直接用 curl 循环
for i in $(seq 1 200); do curl -s -o /dev/null -H 'Accept-Encoding: br' http://127.0.0.1:5178/data/dataset.json; done
curl -s http://127.0.0.1:5178/healthz | grep -E 'rssMB|cacheEntries' -A2
~~~

## 六、变更与演练建议

| 演练 | 步骤 | 期望 |
|---|---|---|
| 优雅重启 | `kill -TERM <pid>` | 5s 内退出，退出码 0，日志 `shutdown_begin` → `shutdown_done`；期间已建立的请求全部得到完整响应 |
| 强制退出保护 | 造一个慢请求后立刻 SIGTERM | 10s 内强退，退出码 1，日志 `shutdown_forced`（用于验证「不会无限期挂着」） |
| 端口冲突 | 占用 5178 后再启动 | 退出码 1 + 可读原因（EADDRINUSE） |
| 只读校验 | `curl -X POST` / `PUT` / `DELETE` | 全部 405 + `Allow: GET, HEAD` + `X-Read-Only: 1` |
| 数据回滚 | 替换 `data/dataset.json` 为旧版本 | `/version` 的 `data.bytes/mtime` 变化，ETag 变化，页面强刷后数据回退 |
| 健康探针 | `docker kill -s STOP` 后看探针 | 容器转为 unhealthy（30s 间隔 × 3 次失败后） |
| 未捕获异常演练 | `CHAOS_THROW_MS=300 node tools/serve.mjs` | 日志出现 `uncaught_exception`（含堆栈），**进程不退出**，随后请求仍 200；验证完毕请重启一次进程 |
