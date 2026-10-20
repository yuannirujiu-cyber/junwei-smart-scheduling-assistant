# 排产引擎 API（可复用独立模块）

> 适用对象：想把本排产引擎接到**其他工厂 / 其他赛题 / 自己的命令行与 CI** 的使用者。
> 引擎为原生 ES Modules，**零第三方运行时依赖、零 CDN**，浏览器与 Node 18+ 都可直接 import。

- 门面入口：`web/src/engine/index.js` → `createScheduler(dataset, options)`
- 数据契约：`web/src/engine/schema.js` → `validateDataset(obj)`（详见 `docs/DATA_CONTRACT.md`）
- 工艺链定义：`web/src/engine/chain.js` → `DEFAULT_PROCESS_CHAIN`、`resolveProcessChain()`
- 无头 CLI：`tools/schedule-cli.mjs`
- 自检：`node tools/check_engine_api.mjs`（149 项，含 2 工序 / 4 工序替代链、R6 全链等待与 CLI 退出码）

---

## 1. 最短用法

~~~js
import { createScheduler } from './web/src/engine/index.js';

const dataset = await (await fetch('../data/dataset.json')).json();   // Node 里用 readFile + JSON.parse
const s = createScheduler(dataset);        // ① 数据契约校验 ② 工艺链解析 ③ 建索引
const r = s.schedule();                    // 建模 → 排产 → R6 等待修复 → 局部优化 → 校验 → 指标（全部同步）

console.log(r.stats.taskCount);            // 任务条数
console.log(r.stats.deliveryRate + '%');   // 预测准时交付率
console.log(s.validate(r).counts);         // { block, warn, info }
console.log(s.explain(r.tasks[0].id));     // 四段式解释
console.log(s.toRows(r).rows);             // 导出用行数据（CSV / Excel）
~~~

Node 中（CommonJS 项目也可用动态 import）：

~~~js
import { readFile } from 'node:fs/promises';
import { createScheduler } from '<项目根>/web/src/engine/index.js';
const dataset = JSON.parse(await readFile('<项目根>/data/dataset.json', 'utf8'));
const s = createScheduler(dataset);
~~~

命令行：

~~~bash
node tools/schedule-cli.mjs --data data/dataset.json
node tools/schedule-cli.mjs --data tools/fixtures/minimal-dataset.json --out /tmp/plan --json
~~~

---

## 2. createScheduler(dataset, options)

`createScheduler` 是**同步工厂**：立即完成「数据校验 → 工艺链解析 → 索引构建 → 默认设置计算」，并返回门面对象。

- 校验不通过（缺表 / 类型错 / 主键重复 / 矩阵行列不对齐 / 工艺链非法）→ 抛 `SchedulerInputError`，
  带 `code`（`DATASET_INVALID` / `CHAIN_INVALID`）与 `errors[]`（逐条含 `path / expected / actual / message / code`）；
- 业务数据缺口（缺数量 / 缺交期 / 规格无法解析 / 矩阵空值）**不抛错**，进入 `describe().dataIssues` 与阻断清单。

### options 字段

| 字段 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `validate` | boolean | `true` | 是否在创建时做数据契约校验；`false` 跳过（不建议，除非数据已自行校验） |
| `processChain` | ProcessDef[] | 无 | 注入工艺链（最高优先级），见第 3 节 |
| `processes` | ProcessDef[] | 无 | 同上，别名 |
| `planStart` | string | 自动 | 计划起点 `YYYY-MM-DDTHH:mm`（本地时间）；默认取未结束订单最早日期（或交货日）当天 00:00 |
| `horizonDays` | number | 自动 | 计划窗口天数（30…200，按最晚交期 + 21 天推算）；非法值回退默认并在结果 `warnings` 里提示 |
| `setupWeight` | number | `0.5` | 换型占用在前置时间中的权重：目标 = 完工时刻 + W × 换型时长。W=0 纯交期优先，W 越大越倾向少换型 |
| `changeoverModel` | object | 见下 | 换型耗时模型（R5）参数 |
| `qtyModel` | object | 见下 | 各工序需求量系数 |
| `calendar` | object | 两班倒 | 日历声明（引擎当前按 24 小时连续产能计算，字段供外部展示与后续扩展） |
| `demoParams` | `{enabled}` | `{enabled:false}` | 兼容旧版「演示参数模式」开关 |
| `downtime` | array | `[]` | 设备停机窗口：`{ process?, machineId, from, to, reason? }`（`process` 缺省时按设备编号全链查找） |
| `duePolicy` | object | `{}` | 逐单交期政策：`{ [orderId]: 'hard' \| 'soft' \| 'unknown' }`（订单字段优先） |
| `includedOrderIds` | string[] | `null` | 只排这些订单（`null` = 全部未结束订单） |
| `locks` | Map \| object | `null` | 人工锁定任务：`{ taskId: task }`，重算时保持机台与时间不变 |
| `frozen` | Map \| object | `null` | 执行冻结任务：`{ taskId: task }`，与锁定同义但语义为「已开工/已完工」 |
| `baseline` | scheduleResult | `null` | 对比基线（上一次 `schedule()` 的返回值），用于 `metrics().delta` |

以上字段都可以在 `schedule(settingsOverride)` 里逐次覆盖（嵌套对象逐层合并，`changeoverModel / qtyModel / calendar / demoParams` 都是深合并）。

### 默认设置（defaults() 返回）

~~~js
{
  planStart: '2026-08-03T00:00',        // 自动推算
  horizonDays: 130,                      // 自动推算（30…200）
  setupWeight: 0.5,
  changeoverModel: { minHours: 1, maxHours: 5, magnitudeWeight: 4, bothDimsBonus: 0.5, structuralBonus: 0.5 },
  qtyModel: { closingFactor: 1.00, strandShrink: 1.02, drawShrink: 1.02, defaultWireCount: 19 },
  calendar: { shiftsPerDay: 2, hoursPerShift: 12, startHour: 0, workdays: [1,2,3,4,5,6,7], breaks: [], weekendsOff: false },
  demoParams: { enabled: false },
  downtime: [], duePolicy: {}, includedOrderIds: null, locks: null, frozen: null, baseline: null,
}
~~~

#### changeoverModel（R5：换型耗时 1–5 小时，随切换幅度变化）

数据包没有换型耗时矩阵，因此按「规格关键维度的**相对变化率**」建模，属于**演示参数**（界面与导出持续标注）：

~~~
hours = clamp( minHours
             + magnitudeWeight × 最大相对变化率
             + (切换维度 > 1 ? bothDimsBonus : 0)
             + (结构/原料类切换 ? structuralBonus : 0),
             minHours, maxHours )
~~~

结果按 **0.5 小时**分档。相对变化率 = `|a−b| / max(|a|,|b|)`；无法量化的结构类字段按满幅 1（保守取大）。
默认值即 R5 的 1~5 小时区间与「幅度越大越久」的经验口径：
`1 + 4×幅度 + 0.5（双维度）+ 0.5（结构/原料）`，上限 5 小时。

| 字段 | 默认 | 物理含义 |
|---|---|---|
| `minHours` | 1 | 换型耗时下限（同结构小幅度切换） |
| `maxHours` | 5 | 换型耗时上限 |
| `magnitudeWeight` | 4 | 幅度权重（1 小时 / 满幅） |
| `bothDimsBonus` | 0.5 | 同时切换两个维度的附加耗时 |
| `structuralBonus` | 0.5 | 结构 / 原料类切换的附加耗时 |

#### qtyModel（各工序需求量，默认工艺链）

| 字段 | 默认 | 物理含义 |
|---|---|---|
| `closingFactor` | 1.00 | 合绳需求量 = 订单米数 × 1.00 |
| `strandShrink` | 1.02 | 捻缩系数：捻股 = 合绳 × 股数 × 1.02 |
| `drawShrink` | 1.02 | 拉丝损耗/捻缩：拉丝 = 捻股 × 丝数 × 1.02（丝数取股结构推导，未知用 `defaultWireCount`） |
| `defaultWireCount` | 19 | 股结构未知时的丝数缺省值（演示参数） |

#### calendar（R2：两班倒 12 小时）

| 字段 | 默认 | 含义 |
|---|---|---|
| `shiftsPerDay` | 2 | 每天班次数 |
| `hoursPerShift` | 12 | 每班小时数 |
| `startHour` | 0 | 首班开始小时 |
| `workdays` | 1…7 | 工作日（1=周一） |
| `breaks` | `[]` | 计划停机时段 |
| `weekendsOff` | false | 是否周末停产 |

> 引擎按「全天 24 小时连续生产、换班不切断工序」计算（R2 口径）；日历字段是对外声明与后续扩展位，不参与当前求解。

---

## 3. 工艺链（ProcessDef）——换工序数 / 换工厂的关键

内置默认链是**拉丝 → 捻股 → 合绳**（`DEFAULT_PROCESS_CHAIN`，与旧版 `rules.PROCESSES` 完全一致）。
工艺链可以从 `dataset.processChain`、`dataset.meta.processChain` 或 `options.processChain / options.processes` 注入，优先级：

~~~
options.processChain > options.processes > dataset.processChain > dataset.meta.processChain > 内置默认链
~~~

### 3.1 ProcessDef 结构

~~~js
{
  key: 'ropeClose',                  // 唯一键：任务、矩阵键、processMap 键、时间轴 uid 都用它
  name: '合绳', short: '合',          // 中文名与短名（解释与导出文案）
  machinePrefixes: ['73'],           // 设备编号前缀：dataset.machines 没有同键分组时按前缀跨组匹配
  capability: { kind: 'matrix', matrix: 'ropeClose' },
  changeover: { dims: [              // 换型判定维度（相邻任务逐维比对，任一不同即换型）
    { field: 'structure', label: '结构' },
    { field: 'diameter', label: '绳径', unit: 'mm', numeric: true },
  ] },
  qty: { from: 'coilWrap', factorModel: 'closingFactor' },
  waitLimitHours: 72,                // 相邻工序等待上限（R6）
  desc: '把多股捻合成钢丝绳',
}
~~~

### 3.2 capability 两种适配方式

| kind | 语义 | 需要的字段 | 单位产出 |
|---|---|---|---|
| `specRange` | 设备台账的**规格区间**适配（如拉丝机 0.08–0.30mm） | `specField`（默认 `specMm`）、`minField`（默认 `specMin`）、`maxField`（默认 `specMax`）、`speedField`（默认 `speedMps`） | `speedMps × 60` 米/分 |
| `matrix` | 产能**矩阵**：行 = 规格，列 = 设备 | `matrix`（矩阵键，默认 = key） | `rates[设备列]`；无 rates 时 `行捻距 × coefficients[设备列]` |

- 矩阵空值（`null` / `0`）与缺失行一律是**不适配**（绝不补零 / 补均值）；
- `caps` 可显式声明适配设备（编号或下标），给出后优先于 rates；
- `specRange` 工序的加工规格来自 `order.processMap[工序key].specMm`（或 `.spec`）；
  也可声明 `specFrom: 'orderDiameter'` 用订单成品直径推导（标注为演示参数）。

### 3.3 changeover.dims 与 qty 语义

- `changeover.dims[].field` 指向换型比对对象上的字段。引擎为每个工序任务构造规格对象：
  - `specRange` 工序：`{ wireSpec, specMm, outDia, structure, diameter, label }`
  - `matrix` 工序：`{ structure, diameter, spec, name, label }`
- `qty.from` 指向**下游工序 key**（`null` = 订单数量），`qty.by` ∈ `'wireCount' | 'strandCount' | null`，
  `qty.factor` 为数值系数，`qty.factorModel` 为 `qtyModel` 中的系数名；需求量沿链**逆推**：
  `本工序数量 = 下游数量 × factor × (by 对应数量)`。

### 3.4 最小改造步骤：从「拉丝→捻股→合绳」换成任意工序数

1. **准备数据**：`dataset.machines[工序key]`（或给 `machinePrefixes`）、`dataset.capacity[矩阵键]`（矩阵工序）、订单的 `processMap[工序key] = { spec / specMm, name? }`；
2. **写工艺链**（2 工序示例，取自 `tools/fixtures/alt-chain-dataset.json`）：

~~~js
const chain = [
  { key: 'strandTwist', name: '捻股', capability: { kind: 'matrix', matrix: 'strandTwist' },
    changeover: { dims: [{ field: 'structure', label: '结构' }, { field: 'diameter', label: '股径', unit: 'mm', numeric: true }] },
    qty: { from: 'ropeClose', by: 'strandCount', factorModel: 'strandShrink' } },
  { key: 'ropeClose', name: '合绳', capability: { kind: 'matrix', matrix: 'ropeClose' },
    changeover: { dims: [{ field: 'structure', label: '结构' }, { field: 'diameter', label: '绳径', unit: 'mm', numeric: true }] },
    qty: { from: null, factorModel: 'closingFactor' } },
];
const s = createScheduler(dataset, { processChain: chain });   // 或把 chain 写进 dataset.processChain
~~~

3. **跑通**：`s.schedule()` → `s.validate(r)` → `s.metrics(r)` → `s.toRows(r)`；CLI 亦可直接验证；
4. **校准**：按现场数据调整 `qtyModel`（各工序需求量系数）与 `changeoverModel`（换型耗时模型）；
5. **回归**：`node tools/check_engine_api.mjs` 用的是 2 工序与 4 工序两套替代链，可直接参考。

### 3.5 换工厂（字段名不同）怎么办

引擎只认 `orders / machines / capacity` 三张表与 ProcessDef 契约，**不要改引擎**，在数据侧做一次字段映射即可：

1. 订单：`id / spec / qtyMeters / preShipDate / orderDate / priority / duePolicy / processMap`；
2. 设备：`id / name / specMin / specMax / speedMps`（`specRange` 工序）或仅 `id / name`（矩阵工序）；
3. 产能矩阵：`machineIds[] + rows[{ name, spec, rates[] | torsion + coefficients }]`；
4. 用 `validateDataset(mapped)` 先体检，错误会逐条给出字段路径与期望值。

---

## 4. 门面方法

所有方法**全部同步**，且**不会向调用方抛裸异常**：内部意外异常会被捕获并返回带 `error` 字段的降级结果。

### 4.1 `describe()`

~~~js
{
  engine: { version, schemaVersion, chainSource, legacyChain },
  dataset: { id, name, orderCount, activeOrders, historyOrders },
  processes: [{ key, name, short, machinePrefixes, machineCount, capability, changeover, qty, waitLimitHours,
                matrix?: { key, machineIds, rows, specs }, specRange?: { machines, min, max } }],
  machines: { total, byProcess: { [工序key]: 台数 } },
  specIndexStats: { available, closingKeys?, orderMatchStats? } | { available:false, note },
  dataIssues: [{ level:'warn'|'info', code, path, message, actual? }],
}
~~~

### 4.2 `buildModel(settingsOverride?)`

返回可求解模型：`{ cap, chain, chainKeys, procMap, legacy, jobs, blocked, excluded, history, active, qtyModel, settings }`。
`jobs[].ops` 按工艺链顺序排列；`blocked[].gaps` 是逐单的可读缺口（字段 / 原因 / 修复建议 / 命中规则）。

### 4.3 `schedule(settingsOverride?)`

返回：

~~~js
{
  tasks: [ { id:'T:<orderId>:<process>', orderId, process, machineId, machineUid, machineName,
             qty, unit, rate, durationMin, start, end, setupHours, setupReasons, setupTier, setupStart,
             spec, specCtx, specLabel, candidateCount, considered, alternative, scheduled, locked, frozen } ],
  unscheduled: [ { orderId, process, qty, reason } ],
  stats: { orderCount, jobCount, blockedOrders, excludedOrders, historyOrders, taskCount, unscheduledTasks,
           scheduledOrders, unscheduledOrders, makespan, totalSetupHours, deliveryRate, lateOrders, lateHours,
           machineOccRate, machineRunRate, risks:{block,warn,info}, canConfirm,
           firstPassMs, totalMs, repairedWaits, movedTasks, improvedTasks },
  model, settings, validation, metrics, processKeys, elapsedMs, warnings,
}
~~~

结果会被缓存：之后 `validate()` / `metrics()` / `explain()` / `toRows()` 不传参时复用最近一次结果。

### 4.4 `validate(scheduleResult?)`

返回 `{ risks[], orderStats: Map, counts:{block,warn,info}, canConfirm }`；
`risks[]` 每条含 `level / type / rule / orderId / taskId / title / why / fix / target`。
未排产或传入非法结果时返回一条「尚未排产 / 输入无效」的阻断风险，而不是抛异常。

### 4.5 `metrics(scheduleResult?, baseline?)`

返回 PRD 第 10 章口径的指标：准时率（`deliveryRate`）、准时/延期/无法验证单数、累计延期小时、
硬交期风险、任务数、换型总时长、设备计划占用率 / 加工利用率、分设备 `machineLoad`、分工序 `byProcess`、
`makespan`、负荷窗口，以及与 `baseline` 的 `delta`（共同订单集合比较）。

### 4.6 `explain(taskId)`

返回四段式：`{ conclusion, evidence[], constraints[], actions[], caveats[], rules[], ruleTexts[] }`。
`taskId` 也可以是任务对象。未找到任务 → `{ error: '未找到任务「…」…' }`。

### 4.7 `toRows(scheduleResult?, opts?)`

导出用行数据（CSV / Excel / CLI 共用，**不要在调用方重复拼装**）：

~~~js
const { kind, columns, rows, meta } = s.toRows(r, { kind: 'plan' });   // kind: plan | unscheduled | risk | load
const csv = [columns.map(c => c.header), ...rows.map(x => columns.map(c => x[c.key]))];
~~~

- `columns[]`：`{ key, header, type? }`，`type` ∈ `number | decimal | datetime`（datetime 为 `YYYY-MM-DD HH:mm` 本地时间字符串）；
- `plan` 行含任务号 / 订单号 / 品名 / 工序 / 设备 / 数量 / 单位产出 / 加工分钟 / 换型 / 加工规格 / 起止 / 交期 / 延期 / 状态，
  并按开始时间升序；`opts.excludeBlockedOrders=true` 可剔除阻断订单的预置任务；
- 无排产结果时返回空行 + 可读 `error`。

### 4.8 `defaults()`

返回默认 settings 的**深拷贝**（见第 2 节），可直接改字段后传给 `schedule()`。

### 4.9 `engineDefaults(dataset, options?)`（具名导出）

```js
import { engineDefaults } from './web/src/engine/index.js';
const settings = engineDefaults(dataset, { horizonDays: 60 });   // 与 defaults() 同源，但无需先 createScheduler
```

界面（`web/src/core/store.js`）与无头 CLI 都用它取得同一份默认值，避免各处漂移；
`createScheduler(dataset, options).defaults()` 返回的是同一份默认设置的深拷贝。

### 4.10 只读附属字段

`facade.cap`（产能索引）、`facade.chain`、`facade.processKeys`、`facade.version`、`facade.dataset`
用于高级场景（例如自定义导出、二次求解）；它们不参与门面语义稳定性承诺。

---

## 5. 错误与降级行为

| 场景 | 行为 |
|---|---|
| 缺 `orders` / `machines` / `capacity` 表 | `createScheduler` 抛 `SchedulerInputError(DATASET_INVALID)`，消息列出字段路径 + 期望 + 实际 |
| 字段类型错（`orders` 非数组、`qtyMeters` 非数值…） | 同上，`errors[].path` 精确到 `orders[2].qtyMeters` |
| 主键重复（订单号 / 设备编号） | 同上（重复订单号会产生同 id 幽灵任务，属结构错误） |
| 矩阵行列不对齐、caps 指向不存在设备 | 同上（无法判定适配关系） |
| 工艺链非法（重复 key、矩阵不存在、不是数组） | `SchedulerInputError(CHAIN_INVALID)` |
| 订单数量缺失（`null`） | 警告 `QTY_MISSING` + 该订单进阻断清单（**不按 0 排产**） |
| 订单数量 ≤ 0 | 结构错误（`qtyMeters` 必须 > 0） |
| 规格无法解析 | 警告 `SPEC_UNPARSED`；工艺映射不完整 → 该订单阻断并给出修复建议 |
| 交期缺失 / 无法解析 | 警告 `DUE_MISSING` / `DUE_UNPARSED` + 该订单阻断（R7） |
| 产能矩阵空值 / 整行空值 | 警告 `MATRIX_NULL_CELL` / `MATRIX_ROW_INADAPTABLE`；该设备列（或整行）**不适配**，订单若因此无设备可加工则记未排产 + 阻断风险 |
| 订单表为空 | 合法：`schedule()` 返回 0 任务，`metrics().deliveryRate === null`（不是 0，也不是 NaN） |
| `planStart / horizonDays / setupWeight` 非法 | 回退默认值，并在结果的 `warnings` 里说明 |
| 方法内部意外异常 | 捕获并返回带 `error` 的降级结果（如 `metrics()` 返回全 null 指标 + error） |

---

## 6. 与旧接口的兼容

- `web/src/engine/rules.js` 仍导出 `PROCESSES / PROC_MAP / procName / procCls`，内容由默认工艺链派生（字段与历史一致）；
- `capacity.js / model.js / scheduler.js / validate.js / metrics.js / explain.js` 的既有导出签名不变，
  原有调用方（`web/src/core/store.js`、各视图）行为不变；
- 默认三工序（drawing / stranding / closing）永远走历史专用代码路径，**逐字节保持既有排产结果**；
  只有非内置 key 才走通用工艺链路径。
