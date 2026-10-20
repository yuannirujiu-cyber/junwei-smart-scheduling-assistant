# 数据契约（DATA CONTRACT）

> 本文件说明排产数据集 `dataset` 的完整结构、字段语义与校验方式。
> 结构定义与校验器都在 `web/src/engine/schema.js`：JSON Schema **draft-07**、**纯 JS 对象字面量**、零依赖、零 CDN。
> 最小可运行示例见 `tools/fixtures/minimal-dataset.json`（4 张虚构订单，默认三工序）；
> 任意工序数的示例见 `tools/fixtures/alt-chain-dataset.json`（4 工序）与 `docs/ENGINE_API.md` 第 3 节。

---

## 1. 顶层结构

~~~jsonc
{
  "meta":       { /* 可选：数据来源与版本（缺失只提示，不影响求解） */ },
  "processChain": [ /* 可选：工艺链定义，缺省 = 拉丝 → 捻股 → 合绳 */ ],
  "orders":     [ /* 必填：订单数组 */ ],
  "machines":   { /* 必填：设备台账，键 = 工序 key（drawing/stranding/closing 或自定义） */ },
  "capacity":   { /* 必填：产能矩阵，键 = 矩阵键（与工序 capability.matrix 对应） */ },
  "specIndex":  { /* 可选：规格归一化索引（加速关联与展示统计） */ },
  "simulationPresets": { /* 可选：演示场景参数，引擎不读取 */ }
}
~~~

- `orders` / `machines` / `capacity` 是**必填三张表**（JSON Schema `required`）；缺失 → `REQUIRED` 错误；
- 表内出现契约之外的字段**允许**（`additionalProperties: true`），引擎忽略，便于带业务扩展列；
- 空订单表合法（`EMPTY_ORDERS` 警告），`schedule()` 返回 0 任务、`deliveryRate === null`。

---

## 2. orders（订单）

| 字段 | 必填 | 类型 | 说明 / 缺失后果 |
|---|---|---|---|
| `id` | ✔ | string，非空 | 订单号；重复 → `DUPLICATE_ORDER_ID`（结构错误，会产生同 id 幽灵任务） |
| `spec` | ✔ | string，非空 | 成品规格，建议 `"22mm GT8ZH(8*K26WS+IWRC)"` / `"12mm 6*19S+FC"`；无法解析 → `SPEC_UNPARSED` 警告，工艺映射不完整则阻断该单（R1） |
| `qtyMeters` | ✔ | number > 0 或 null | 订单米数；`null` → `QTY_MISSING` 警告 + 阻断该单（**不按 0 排产**，R7）；`≤ 0` → 结构错误（必须为正） |
| `preShipDate` | ✔ | string 或 null | 预发货日（交期）；`null`/`""` → `DUE_MISSING` 警告 + 阻断该单（R7）；无法解析 → `DUE_UNPARSED` |
| `orderDate` | ✖ | string 或 null | 订单日期（排序第三关键字）；无法解析 → 排序落到最后并给 `ORDER_DATE_UNPARSED` |
| `endCode` | ✖ | string | `已结束` 视为历史订单（不排产、单独计数）；其余值参与排产 |
| `priority` | ✖ | string | `重点客户` / `重点订单` / `紧急` / `普通`（缺省按普通） |
| `duePolicy` | ✖ | `hard` \| `soft` \| `unknown` | 交期政策；缺省 = `unknown`（不默认宽限，仅给警告风险） |
| `graceHours` | ✖ | number ≥ 0 | 软交期宽限小时数（缺省 72） |
| `qtyMetersUnit` | ✖ | string | 数量单位（缺省 `米`） |
| `processMap` | ✖ | object | **工艺映射**：把订单显式映射到各工序的加工规格，避免引擎猜测（见下） |
| `processSpecs` | ✖ | object | 工序 key → 规格字符串（`processMap` 的简化形式，优先级低于 `processMap`） |
| `productName` / `coating` / `qtyKg` / `rush` / `locked` / `parsed` / `mappingKey` | ✖ | 多种 | 业务扩展字段；`parsed` 若已由数据管道解析好（与 `engine/spec.js` 同口径）可直接复用 |

### 2.1 processMap 的两种写法

**默认三工序（拉丝/捻股/合绳）的历史写法**（`resolveMapping`）：

~~~json
"processMap": {
  "closingSpec": "12mm 6*19S+FC", "closingName": "光面圆股钢丝绳",
  "strandName": "光面股0064 1*7 B1", "strandSpec": "0.64",
  "wireSpecMm": 0.12, "status": "confirmed"
}
~~~

**任意工艺链的通用写法**（键 = ProcessDef.key；自定义链推荐）：

~~~json
"processMap": {
  "wireDraw":    { "specMm": 0.12 },
  "strandTwist": { "spec": "0.64", "name": "光面股0064 1*7 B1" },
  "ropeClose":   { "spec": "12mm 6*19S+FC", "name": "光面圆股钢丝绳" },
  "coilWrap":    { "spec": "12mm 6*19S+FC", "name": "涂塑钢丝绳" }
}
~~~

通用路径的规格解析优先级（**不臆造**）：

1. `processMap[工序key].spec / .specMm`（人工确认，最高优先）；
2. 订单规格归一化键与该工序矩阵行匹配：唯一命中自动关联，多命中取首行并标注「待人工确认」；
3. 该工序矩阵只有一个规格时取唯一候选（标注演示参数）；
4. 都不成立 → 该工序记「规格缺口」，订单进阻断清单并给出修复建议。

`specRange` 工序（如拉丝）必须由 `processMap[key].specMm` 提供加工规格，或工序声明 `specFrom: 'orderDiameter'`。

---

## 3. machines（设备台账）

`machines` 是**对象**：键 = 工序 key，值 = 设备数组。默认三工序必须有 `drawing / stranding / closing`；
自定义工艺链使用与 ProcessDef.key 同名的键（或只给 `machinePrefixes` 让引擎按编号前缀跨组匹配）。

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `id` | ✔ | string 或 number | 设备编号；同组内唯一（重复 → `DUPLICATE_MACHINE_ID`） |
| `name` | ✖ | string | 设备名（解释与导出显示） |
| `specMin` / `specMax` | ✖ | number 或 null | **规格区间**（`specRange` 工序适配判定）；`specMin > specMax` → `MACHINE_RANGE_INVERTED` |
| `speedMps` | ✖ | number 或 null | 加工速度（米/秒），单位产出 = `speedMps × 60` 米/分 |
| `specRangeRaw` | ✖ | string | 区间原文（展示用） |
| `type` / `dayOutput` / `nightOutput` / `downtime` … | ✖ | 多种 | 业务扩展字段，引擎忽略 |

---

## 4. capacity（产能矩阵）

`capacity` 是**对象**：键 = 矩阵键，值 = 矩阵。矩阵工序通过 `capability.matrix` 指向它（缺省 = 工序 key）。

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `machineIds` | ✔ | array<string\|number> | 设备列顺序；与 `rates`、`coefficients` 按下标对齐 |
| `rows` | ✔ | array<object> | 规格行 |
| `coefficients` | ✖ | array<number> | 设备系数（捻股精确模型：`值 = 行捻距均值 × 设备系数`）；长度必须等于 `machineIds`，否则 `COEFF_LENGTH` |
| `model` / `unit` | ✖ | string | 口径说明与单位（展示用） |

矩阵行：

| 字段 | 必填 | 类型 | 说明 |
|---|---|---|---|
| `spec` | ✔ | string，非空 | 规格（合绳如 `"12mm 6*19S+FC"`；捻股股径如 `"0.64"`） |
| `name` | ✖ | string | 品名（与 spec 组成 `name|spec` 精确查找键） |
| `rates` | ✖ | array<number\|null> | 单位产出（米/分），长度必须等于 `machineIds`，否则 `RATES_LENGTH` |
| `torsion` | ✖ | number 或 null | 行捻距均值；与矩阵级 `coefficients` 组合还原产出 |
| `caps` | ✖ | array<string\|number> | 显式适配设备（编号或下标），给出后优先于 rates |
| `capCount` | ✖ | integer | 展示用适配台数 |

### 4.1 空值语义（重要）

```
rates[i] == null  或  rates[i] <= 0   →  该规格在设备 i 上「不适配」（不是 0 产能，也不是可用）
caps 给出时                          →  以 caps 为准（未列入的设备不适配）
行不存在 / 矩阵键不存在               →  不适配（绝不补零、不取均值）
```

校验器对空值给出 `MATRIX_NULL_CELL`（逐行汇总哪些设备列是空的）与 `MATRIX_ROW_INADAPTABLE`
（整行无可用产出）警告；排产时这些设备列不会被使用，若整单因此无设备可加工，会记「未排产」并给阻断风险。

---

## 5. specIndex（可选）

```jsonc
{
  "closing": { "12|6*19S+FC": ["12mm 6*19S+FC"] },   // 归一化键 → 规格（结构由数据管道产出）
  "closingKeys": ["12|6*19S+FC"],
  "orderMatchStats": { "total": 323, "matched": 78, "multi": 235, "missing": 10, "missingSamples": [] }
}
```

- 引擎不依赖它（用产能矩阵的归一化键自行关联），但 `describe().specIndexStats` 会展示命中统计；
- `orderMatchStats.total ≠ orders.length` → `SPEC_INDEX_TOTAL` 警告。

---

## 6. meta 与 processChain（可选）

`meta`：`{ id, name, source[], generatedAt, orderCount, note, issues[] }`；
`orderCount` 与 `orders.length` 不一致 → `ORDER_COUNT_MISMATCH` 警告；`issues[]` 会进入 `describe().dataIssues`。

`processChain`（也可放在 `meta.processChain`）用于替代工艺链，结构见 `docs/ENGINE_API.md` 第 3 节。
注入优先级：`options.processChain > options.processes > dataset.processChain > dataset.meta.processChain > 内置默认链`。

---

## 7. 校验 API

~~~js
import { validateDataset, validateAgainstSchema, DATASET_SCHEMA, formatValidationErrors, SCHEMA_VERSION }
  from './web/src/engine/schema.js';

const report = validateDataset(dataset);
// report = { ok, errors: [...], warnings: [...], stats: {...} }
// 每条：{ path, expected, actual, message, code }
console.log(report.ok, report.errors.length, report.warnings.length);
console.log(formatValidationErrors(report.errors));   // 逐行打印（默认最多 12 条）
~~~

- `validateDataset(obj)`：**结构层**（JSON Schema）+ **语义层**（重复主键、矩阵行列对齐、空值语义、
  规格可解析性、交期可解析性、工艺链 ↔ 设备分组对应）两层校验；
- `ok === (errors.length === 0)`。`createScheduler` 默认调用它，`errors` 非空即抛带明细的
  `SchedulerInputError`（`code: 'DATASET_INVALID'`）；`warnings` 进入 `describe().dataIssues` 并降级为阻断订单；
- `validateAgainstSchema(schema, value)` 是通用入口，可校验任意 draft-07 子集 schema
  （支持 `type / required / properties / additionalProperties / items / enum / const /
  minimum / exclusiveMinimum / maximum / minItems / maxItems / minLength / maxLength / pattern / anyOf / $ref`）；
- `stats`：`{ orders, machines: {组: 台数}, matrices: {键: {machineIds, rows, coefficients, nullCells, allEmptyRows}}, chainKeys, hasSpecIndex, processChainSource }`。

### 7.1 错误码（code）速查

| code | 级别 | 含义 |
|---|---|---|
| `REQUIRED` | error | 缺必填表 / 字段 |
| `SCHEMA` | error | 类型 / 枚举 / 数值范围 / 字符串格式不符 |
| `DUPLICATE_ORDER_ID` / `DUPLICATE_MACHINE_ID` | error | 主键重复 |
| `MACHINE_ID_MISSING` / `MACHINE_RANGE_INVERTED` | error | 设备缺编号 / 区间颠倒 |
| `RATES_LENGTH` / `COEFF_LENGTH` | error | 矩阵列数与 deviceIds 不一致 |
| `CAPS_UNKNOWN_MACHINE` / `CAPS_OUT_OF_RANGE` | error | caps 指向不存在的设备 |
| `MATRIX_MISSING` / `NO_MACHINES_FOR_PROCESS` | error | 工艺链引用的矩阵 / 设备不存在 |
| `MATRIX_ROW_SPEC_MISSING` / `MATRIX_TYPE` / `MATRIX_ROW_TYPE` | error | 矩阵结构错误 |
| `CHAIN` | error | 工艺链定义非法（重复 key、capability 非法…） |
| `QTY_MISSING` / `DUE_MISSING` / `DUE_UNPARSED` / `SPEC_UNPARSED` | warn | 业务缺口 → 该单阻断 |
| `MATRIX_NULL_CELL` / `MATRIX_ROW_INADAPTABLE` / `MATRIX_ROW_NO_CAPACITY` / `MATRIX_COEFF_MISSING` | warn | 空值 / 整行不适配语义 |
| `MATRIX_DUPLICATE_ROWS` / `MATRIX_IDS_EMPTY` / `NO_SPEC_RANGE` | warn | 数据质量提示 |
| `EMPTY_ORDERS` / `META_MISSING` / `ORDER_COUNT_MISMATCH` / `SPEC_INDEX_TOTAL` / `ORDER_DATE_UNPARSED` | warn | 合法但需注意 |

---

## 8. 接自己的数据：准备清单

以 `tools/fixtures/minimal-dataset.json` 为准（4 张订单即可跑通）：

1. **设备表** `machines`：按工序分组，给出 `id`；规格区间工序补 `specMin / specMax / speedMps`；
2. **产能矩阵** `capacity`：`machineIds` + `rows[{ spec, rates }]`（或 `torsion + coefficients`）；
   空值 `null` 就是「不适配」，**不要用 0 表示可用、也不要用均值填充**；
3. **订单表** `orders`：`id / spec / qtyMeters / preShipDate` 四件套；
   想让引擎不猜规格，就补 `processMap`（默认三工序用历史写法，自定义链用 `{工序key: {spec, name}}`）；
4. **（可选）`meta`**：写清数据来源、生成时间、已知问题（会显示在 `describe().dataIssues`）；
5. **（可选）`specIndex`**：数据管道若能产出规格归一化索引，可加速关联并给出命中统计。

自检：

~~~bash
# 1) 直接跑：打印指标与风险；有阻断风险时退出码 1（参数/数据错误退出码 2）
node tools/schedule-cli.mjs --data <你的数据.json>

# 2) 只看数据体检（不排产）
node --input-type=module -e "
import { readFile } from 'node:fs/promises';
import { validateDataset, formatValidationErrors } from './web/src/engine/schema.js';
const ds = JSON.parse(await readFile('<你的数据.json>', 'utf8'));
const r = validateDataset(ds);
console.log('ok=' + r.ok, 'errors=' + r.errors.length, 'warnings=' + r.warnings.length);
console.log(formatValidationErrors(r.errors));
"

# 3) 引擎回归（含 2 / 4 工序替代链与 CLI 退出码）
node tools/check_engine_api.mjs
~~~

> 数据使用提示：本仓库随包数据均经脱敏，仅限本次比赛使用；演示数据全部为虚构编号。
