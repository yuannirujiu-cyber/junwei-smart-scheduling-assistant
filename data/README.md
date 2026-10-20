# 君威智能排产助手 · 数据说明

本目录下的 JSON 由脚本 君威智能排产助手/tools/build_dataset.py 从比赛脱敏数据包自动抽取生成，
前端可直接 fetch 加载，无需后端。

> **注意：本目录不是应用的默认数据源。** 应用打开时是空白工作台，需要上传订单文件与设备/产能文件
> 才会建立数据快照并排产。这里的 JSON 有两个用途：
> 1. 演示 / 自检用的**内置快照**（页面上的两个按钮，或 `?data=real` / `?data=demo` 深链）；
> 2. 作为**对照物**——`tools/check_blank.mjs` 断言「界面导入两条 Excel」与「本目录的预置快照」产出完全相同的任务集合。
> 因此改动本目录的 JSON 时，必须让本脚本与前端解析器（`web/src/engine/spec.js`、`web/src/data/deviceImport.js`）
> 保持同语义，否则该断言会变红。**源 Excel 变化后必须重新运行本脚本**，否则预置快照会与源数据不一致。

## 1. 数据来源

| 文件 | 工作表 | 用途 |
| --- | --- | --- |
| 黑客松数据包/订单信息.xlsx | 订单信息 | 323 条脱敏订单（23 列） |
| 黑客松数据包/产品额定（平均值）.xlsx | 拉丝 | 47 台拉丝机额定产量与拉丝速度 |
| 黑客松数据包/产品额定（平均值）.xlsx | 捻股 | 6475 行原始数据，去重 3211 条 (品名,规格) × 50 台机 |
| 黑客松数据包/产品额定（平均值）.xlsx | 合绳（绳子+绳芯） | 4700 行原始数据，去重 3472 条 (品名,规格)（1537 个不同规格）× 12 台机 |

## 2. 生成方式与复现

    cd "/Users/kazuhamiyo/Desktop/Project/黑客松 0918～0920"
    PYTHONPATH=.pylibs python3 "君威智能排产助手/tools/build_dataset.py"

脚本仅使用 openpyxl（read_only=True, data_only=True），不修改任何源文件。
输出 JSON 使用 ensure_ascii=False + separators=(",", ":")（紧凑单行），UTF-8 无 BOM。

## 3. 产出文件

| 文件 | 体积 | 说明 |
| --- | --- | --- |
| data/dataset.json | 1.25 MB | 真实脱敏快照 |
| data/demo-dataset.json | 20.8 KB | 虚构演示数据（路演 8 场景） |
| data/spec-derivation.json | 4.8 KB | 股径推导辅助表 |
| data/README.md | - | 本文件 |

dataset.json：orderCount = 323，matchStatus 分布
matched=78 / multi=235 / missing=10；
捻股去重行 3211 条（原 6475 行），合绳去重行 3472 条（原 4700 行）；
specIndex 归一化键 707 个。
demo-dataset.json：orderCount = 14（编号全部 DEMO- 前缀，另含 1 条 simulationPresets.rushOrder）。

## 4. Schema 字段含义

### 4.1 meta
- id / name：数据集标识。
- source：源文件相对路径。
- generatedAt：生成本地时间（ISO，秒级）。
- orderCount：订单条数。
- note：使用限制。
- coefficientModelVerified：捻股「捻距 × 系数」模型是否 100% 通过校验。
- issues：抽取过程中的已知问题清单。

### 4.2 orders[]
| 字段 | 含义 |
| --- | --- |
| id | 项目编号（业务主键） |
| internalNo | 内部订单单号-序号-次序号 |
| productName / spec / coating | 品名 / 规格 / 涂层 |
| qtyMeters + qtyMetersUnit | 业务数量与业务单位（米） |
| qtyKg + qtyKgUnit | 计价数量与计价单位（Kg） |
| orderDate / preShipDate / preArrivalDate / lastShipDate | 订单日期 / 预发货日 / 预到货日 / 最后销货日期，YYYY-MM-DD 或 null |
| endCode | 结束码：已结束 / 未结束 / 指定结束 |
| parsed | 规格结构化结果，见下 |
| mappingKey | 归一化键，用于关联 specIndex.closing |
| matchStatus | matched（唯一命中）/ multi（多义）/ missing（无匹配） |
| mappingCandidates | 命中该键的全部合绳规格原文 |
| wireSpecHint | 占位字段，当前恒为 null，由前端/算法推导钢丝直径 |

parsed 子字段：parseOk、diameterMm（规格开头直径，区间规格为 null）、diameterRaw（区间等原文）、
grade（括号前牌号，如 GT8ZH）、lay（牌号末尾捻向 Z/S）、structure（括号内结构，无括号时为整串）、
strandCount（星号前股数）、strandConstruction（星号后股结构，保留前导 K）、
core（绳芯：IWRC / PIWRC / FC / WSC / PWSC）。

### 4.3 machines
- drawing[]：id、name、type（湿拉机/干拉机）、specRangeRaw、specMin、specMax、
  speedMps、dayOutput、nightOutput、totalOutput（产量口径为原始表的平均值）。
- stranding[] / closing[]：{ "id": "8201" } 形式的机台清单。
- 演示数据额外带 downtime[]（from / to / reason）。

### 4.4 capacity（设备—规格适配关系）
- stranding：model = torsion-x-coefficient（捻距 × 系数），unit = 米/分。
  任意规格某机台产出 = rows[].torsion × coefficients[机台下标]。
  machineIds 与 coefficients 一一对应（顺序即原表列顺序 8201-8245、8247-8251）。
- closing：model = explicit，unit = 米/分，每行给 rates[]，与 machineIds 按下标对应。
  合绳不满足系数模型，必须查表。
- 行字段：name（品名）、spec（规格）、torsion（捻距平均值，mm）、
  capCount（该规格可生产的设备台数）、caps（可生产设备的列下标数组，仅当非全适配时出现）。
  空单元格表示「该设备不适配该规格」，一律保留为 null，绝不补 0 或补平均值。
  本次两张矩阵均无空单元格，故全部为全适配（捻股 capCount=50，合绳 capCount=12，caps 省略）。
  非全适配行占比：捻股 1001/3211 (31.17%)，合绳 2/3472 (0.06%)。

### 4.5 specIndex
- closing：归一化键 -> 合绳规格原文数组（多于 1 条即多义，订单 matchStatus = multi）。
- closingKeys：全部归一化键。
- orderMatchStats：订单命中统计与最多 20 条未命中样例。

### 4.6 归一化键规则（订单与索引共用同一函数）

    "22mm GT8ZH(8*K26WS+IWRC)"  ->  "22|8*K26WS+IWRC"
    "6mm 6*19S+FC"              ->  "6|6*19S+FC"
    "9-12mm ..."                ->  null（matchStatus = missing）

去首尾空白，用 ^([0-9]+([.][0-9]+)?)mm[空格]+(.+)$ 取直径与剩余部分；剩余部分若形如 GT+数字+大写字母(括号内容)
则取括号内；删除所有空白并转大写；拼成 直径|结构。

### 4.7 spec-derivation.json
- strandCountFactor：{ 股数 N: sin(pi/N) }，4 位小数，用于 d ≈ D · sin(pi/N) 的股径/丝径换算（D 为股径，d 为丝径）。
- strandSpecValues：捻股表「规格」列的全部 distinct 数值，升序（即可用股径取值域）。

### 4.8 demo-dataset.json 额外字段
orders[]：priority（重点客户/重点订单/普通）、duePolicy（hard/soft/unknown）、graceHours（0/72）、
rush、locked、note（场景说明）、preferredMachine（演示用建议机台）、
processMap（显式工艺映射）：closingSpec / closingName（必须是 demo 合绳矩阵中真实存在的规格）、
strandName / strandSpec（必须是 demo 捻股矩阵中真实存在的品名/规格）、
wireSpecMm（落在 demo 拉丝机规格区间内）、qtyFactor（各工序投料系数）、status（confirmed / pending）。
顶层 simulationPresets：rushOrder（急单插单新订单对象）、breakdown（故障停机）、
materialDelay（物料延期与检验工时）。

演示场景映射：1 正常准时 = DEMO-2026-0001；2 硬交期冲突 = 0002（45000 米 + 硬交期 09-21 + 物料 09-22 才齐套）；
3 宽限内延期 = 0003；4 规格无匹配 = 0004（processMap.status = pending）；5 换型相邻任务 = 0005/0006（同机台 8301，规格不同）；
6 工序等待 > 72h = 0007；7 已锁定 = 0008；8 急单 = 0009，停机 = 8203 与 8302 的 downtime 及 simulationPresets.breakdown。

## 5. 口径与已知缺口

1. 捻股系数模型：值 = 捻距（平均值） × 固定系数，本次逐行断言结果：全部通过（零误差）。
   系数向量按原表列顺序 8201-8245、8247-8251 共 50 台。若出现不符行，该行会额外携带显式 rates[]，
   并在 meta.issues 记录；本次不符行数 2。
2. 合绳不满足系数模型，一律使用显式 rates[]（12 台，列顺序 8301-8310、8246、8312）。
3. 去重口径：按 (品名,规格) 去重。同一 (品名,规格) 在源表中可能有多份且捻距不同（不同捻距档位），
   此时保留首次出现值，并给该行加 variants（合并份数）与 variantConflict: true（存在数值分歧）标记。
   本次捻股 49030 个单元格分歧（437 个键）、合绳 5533 个单元格分歧（257 个键）。
   注意：合绳 distinct (品名,规格) 为 3472 条，而非 distinct 规格数 1537；
   distinct 规格 1537 个中归一化后得到 707 个键（交叉校验：707 键(独立实现宽松, 5 行预期差异)）。
4. 换型耗时无矩阵：数据包不含规格切换的换型时间，排产引擎需自行给出可配置假设；
   演示数据只用相邻不同规格任务表达该场景。
5. 股径映射缺失：成品规格无法自动展开为拉丝/捻股的股径与道次，spec-derivation.json
   只给出理论换算系数与股径取值域，真实道次需人工补录。
6. 拉丝表：实际 47 行数据，8104 白/晚班产量为空（JSON 中为 null）；拉丝速度仅 6/7/8 m/s 三档。
7. 合绳表末列：表头 18 列，最后一列为空列，已忽略。
8. 归一化覆盖率：合绳 4700 行中 2194 行不是「直径+mm」形式（多为股规格），
   不进入 specIndex；订单侧 10 条未命中，需人工补录工艺映射。
9. 日期缺失：2 条订单预发货日/预到货日为空，JSON 中为 null。
10. 演示数据全部虚构，qtyKg 为估算值，不得用于真实对账。
