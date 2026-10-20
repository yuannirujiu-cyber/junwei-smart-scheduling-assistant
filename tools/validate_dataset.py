#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""数据快照自检（审查报告 §六 / P2-20）。本脚本修正：

1) 结尾原先缺少 sys.exit：失败也只 print("VALIDATION: FAIL") 并返回 0，无法进 CI；现在失败返回 1。
2) 路径原先写死相对 CWD（D = "君威智能排产助手/data"），在 君威智能排产助手/ 目录内运行会
   FileNotFoundError；现在基于 __file__ 解析，任何 CWD 下都能跑。
3) 删除恒真/无意义断言（原 :16 的 «... or True» 与 :85 的 «"orders" == "orders"»），
   替换为真实断言：JSON 重复键、顶层类型、换行规范、订单号唯一性。
"""
import json, math, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
D = os.path.join(os.path.dirname(HERE), "data")   # 基于脚本位置的绝对路径，与 CWD 无关
fails, warns, dup_keys = [], [], []

def chk(cond, msg):
    if not cond:
        fails.append(msg)

def _no_dup_keys(pairs):
    """object_pairs_hook：json 默认静默保留重复键的最后一个，这里显式记录以便报错。"""
    seen = set()
    for k, v in pairs:
        if k in seen:
            dup_keys.append(k)
        seen.add(k)
    return dict(pairs)

def load(p):
    raw = open(p, "rb").read()
    chk(not raw.startswith(b"\xef\xbb\xbf"), p + " 带 BOM")
    txt = raw.decode("utf-8")
    # 原为恒真断言 chk("\n" not in txt.strip() or True, "")，这里换成真实检查
    before = len(dup_keys)
    obj = json.loads(txt, object_pairs_hook=_no_dup_keys)
    dup = sorted(set(dup_keys[before:]))
    chk(not dup, p + " JSON 含重复键: " + ", ".join(dup[:5]))
    chk(isinstance(obj, dict), p + " 顶层不是 JSON 对象")
    chk(b"\r" not in raw, p + " 含 CR（换行应为 LF）")
    chk(not raw.endswith(b"\n\n"), p + " 末尾存在多余空行")
    return obj, len(raw)

ds, sz_real = load(os.path.join(D, "dataset.json"))
dm, sz_demo = load(os.path.join(D, "demo-dataset.json"))
sd, sz_sd = load(os.path.join(D, "spec-derivation.json"))

# ---------- dataset.json ----------
meta = ds["meta"]
for k in ["id","name","source","generatedAt","orderCount","note","coefficientModelVerified","issues"]:
    chk(k in meta, "dataset.meta 缺字段 " + k)
chk(meta["id"] == "junwei-real", "meta.id")
chk(meta["coefficientModelVerified"] is True, "coefficientModelVerified 应为 true")
chk(isinstance(meta["issues"], list) and all(isinstance(x, str) for x in meta["issues"]), "issues 非字符串数组")
chk(meta["orderCount"] == len(ds["orders"]) == 323, "orderCount/orders 数量")
o_req = ["id","internalNo","productName","spec","coating","qtyMeters","qtyMetersUnit","qtyKg","qtyKgUnit",
         "orderDate","preShipDate","preArrivalDate","endCode","lastShipDate","parsed","mappingKey",
         "matchStatus","mappingCandidates"]
p_req = ["parseOk","diameterMm","diameterRaw","grade","lay","structure","strandCount","strandConstruction","core"]
for o in ds["orders"]:
    for k in o_req:
        chk(k in o, "order %s 缺 %s" % (o["id"], k))
    for k in p_req:
        chk(k in o["parsed"], "order %s parsed 缺 %s" % (o["id"], k))
    chk(o["matchStatus"] in ("matched","multi","missing"), "matchStatus 非法 " + o["id"])
    chk("wireSpecHint" in o and o["wireSpecHint"] is None, "wireSpecHint 缺失/非 null " + o["id"])
idx = ds["specIndex"]["closing"]
chk(len(idx) == len(ds["specIndex"]["closingKeys"]) == 707, "specIndex 键数")
st = ds["specIndex"]["orderMatchStats"]
from collections import Counter
real_stats = Counter(o["matchStatus"] for o in ds["orders"])
chk(st["total"] == 323 and st["matched"] == real_stats["matched"] and st["multi"] == real_stats["multi"]
    and st["missing"] == real_stats["missing"], "orderMatchStats 与实际不符: %s vs %s" % (st, real_stats))
chk(len(st["missingSamples"]) == 10, "missingSamples 数量")
for o in ds["orders"]:
    if o["mappingKey"]:
        chk(o["mappingCandidates"] == idx.get(o["mappingKey"], []), "mappingCandidates 与索引不一致 " + o["id"])
    else:
        chk(o["matchStatus"] == "missing", "mappingKey 为 null 但 status != missing " + o["id"])
m = ds["machines"]
chk(len(m["drawing"]) == 47, "drawing 机台数")
cap = ds["capacity"]
chk(cap["stranding"]["model"] == "torsion-x-coefficient" and cap["stranding"]["unit"] == "米/分", "stranding model")
# 机台数从数据本身推导，不写死：源 Excel 的机台列会变
# （8246 曾属于合绳、现属于捻股），写死会让「源数据更新」直接判成
# 「校验失败」，把真问题掩盖成脚本问题。
ST_N = len(cap["stranding"]["machineIds"])
CL_N = len(cap["closing"]["machineIds"])
chk(ST_N > 0 and CL_N > 0, "机台数为 0")
# 设备清单与产能矩阵的机台编号必须一一对应（两个文件同源，不一致就是抽取错了）
chk([x["id"] for x in m["stranding"]] == cap["stranding"]["machineIds"], "stranding 设备清单 != 产能矩阵机台列")
chk([x["id"] for x in m["closing"]] == cap["closing"]["machineIds"], "closing 设备清单 != 产能矩阵机台列")
chk(len(cap["stranding"]["coefficients"]) == ST_N, "stranding 系数长度 != 机台数")
chk(cap["closing"]["model"] == "explicit", "closing model")
sr = cap["stranding"]["rows"]
chk(len(sr) == 3211, "stranding rows != 3211 (%d)" % len(sr))
bad_caps = 0
# capCount 是「该规格可生产的机台数」，不是机台总数：
# 某台机在该规格上没有产出值时，capCount < 机台数，并给出 caps 列下标数组。
for r in sr:
    has_caps = "caps" in r
    if r["capCount"] != (len(r["caps"]) if has_caps else ST_N) or has_caps != (r["capCount"] < ST_N):
        bad_caps += 1
    if r["torsion"] is None:
        warns.append("stranding row torsion null: " + r["spec"])
chk(bad_caps == 0, "stranding caps/capCount 异常 %d 行" % bad_caps)
cr = cap["closing"]["rows"]
chk(len(cr) == 3472, "closing rows != 3472 (%d)" % len(cr))
partial = 0
for r in cr:
    nn = sum(1 for v in r["rates"] if v is not None)
    chk(len(r["rates"]) == CL_N, "closing rates 长度 != 机台数")
    chk(r["capCount"] == nn, "closing capCount != 非空 rates 数")
    chk(("caps" in r) == (nn < CL_N), "closing caps 出现条件不符")
    if nn < CL_N:
        partial += 1
chk(partial == 2, "closing 非全适配行数 %d" % partial)

# ---------- demo ----------
chk(dm["meta"]["id"] == "junwei-demo" and dm["meta"]["orderCount"] == 14, "demo meta")
chk(len(dm["orders"]) == 14, "demo orders != 14")
# 原为 chk("orders" == "orders" and ..., "x")：前半句恒真。换成真实断言。
real_id_list = [o["id"] for o in ds["orders"]]
demo_id_list = [o["id"] for o in dm["orders"]]
chk(len(set(real_id_list)) == len(real_id_list), "dataset.json 订单号存在重复")
chk(len(set(demo_id_list)) == len(demo_id_list), "demo-dataset.json 订单号存在重复")
chk(real_id_list[0] != demo_id_list[0], "真实数据与 demo 的首个订单号相同")
real_ids = set(o["id"] for o in ds["orders"])
demos = dm["orders"]
chk(all(o["id"].startswith("DEMO") for o in demos), "demo 订单号未全部 DEMO 前缀")
chk(not (set(o["id"] for o in demos) & real_ids), "demo 出现真实订单号")
dstrand = dm["capacity"]["stranding"]
dclose = dm["capacity"]["closing"]
chk(dstrand["machineIds"] == ["820%d" % i for i in range(1,7)], "demo 捻股机台")
chk(dclose["machineIds"] == ["830%d" % i for i in range(1,5)], "demo 合绳机台")
chk(len(dstrand["coefficients"]) == 6, "demo 系数长度")
chk(len(dstrand["rows"]) == 12, "demo 捻股行数 %d" % len(dstrand["rows"]))
chk(len(dclose["rows"]) == 10, "demo 合绳行数 %d" % len(dclose["rows"]))
smap = {}
for r in dstrand["rows"]:
    chk(r["capCount"] == 6 and "caps" not in r, "demo 捻股 caps")
    chk("rates" not in r, "demo 捻股不应有 rates")
    lo = r["torsion"] * min(dstrand["coefficients"]); hi = r["torsion"] * max(dstrand["coefficients"])
    chk(20 <= lo and hi <= 60, "demo 捻股速率越界 %s: %s-%s" % (r["spec"], lo, hi))
    smap[(r["name"], r["spec"])] = r
cmap = {}
for r in dclose["rows"]:
    chk(r["capCount"] == 4 and "caps" not in r, "demo 合绳 caps")
    chk(len(r["rates"]) == 4 and all(v is not None for v in r["rates"]), "demo 合绳 rates")
    chk(all(3 <= v <= 12 for v in r["rates"]), "demo 合绳速率越界 %s: %s" % (r["spec"], r["rates"]))
    cmap[r["spec"]] = r
draw = dm["machines"]["drawing"]
for o in demos:
    for k in ["priority","duePolicy","graceHours","rush","locked","processMap"]:
        chk(k in o, "demo order %s 缺 %s" % (o["id"], k))
    chk(o["priority"] in ("重点客户","重点订单","普通"), "priority 非法")
    chk(o["duePolicy"] in ("hard","soft","unknown"), "duePolicy 非法")
    chk(o["graceHours"] in (0,72), "graceHours 非法")
    pm = o["processMap"]
    for k in ["closingSpec","closingName","strandName","strandSpec","wireSpecMm","qtyFactor","status"]:
        chk(k in pm, "processMap 缺 %s" % k)
    chk(pm["qtyFactor"] == {"drawing":1.02,"stranding":1.0,"closing":1.0}, "qtyFactor")
    if pm["status"] == "confirmed":
        chk(pm["closingSpec"] in cmap, "processMap.closingSpec 不在 demo 合绳矩阵: %s" % pm["closingSpec"])
        chk(cmap[pm["closingSpec"]]["name"] == pm["closingName"], "closingName 不匹配")
        chk((pm["strandName"], pm["strandSpec"]) in smap, "strand 组合不在 demo 捻股矩阵")
        chk(any(mm["specMin"] <= pm["wireSpecMm"] <= mm["specMax"] for mm in draw), "wireSpecMm 不在任何拉丝区间")
    chk(2026 == int(o["preShipDate"][:4]), "preShipDate 年份")
for mm in dm["machines"]["drawing"] + dm["machines"]["stranding"] + dm["machines"]["closing"]:
    chk("downtime" in mm and isinstance(mm["downtime"], list), "machine 缺 downtime")
sim = dm["simulationPresets"]
chk(set(sim.keys()) == {"rushOrder","breakdown","materialDelay"}, "simulationPresets 键: %s" % list(sim.keys()))
chk(sim["rushOrder"]["rush"] is True and sim["rushOrder"]["id"].startswith("DEMO"), "rushOrder")
chk(sim["breakdown"]["machineId"] == "8203", "breakdown machineId")
chk(sim["materialDelay"]["inspectionHours"] == 2, "materialDelay")
# 场景覆盖
chk(any(o["duePolicy"] == "hard" and o["graceHours"] == 0 for o in demos), "缺硬交期")
chk(any(o["duePolicy"] == "soft" and o["graceHours"] == 72 for o in demos), "缺软交期宽限")
chk(any(o["matchStatus"] == "missing" for o in demos), "缺无匹配订单")
chk(any(o["locked"] for o in demos), "缺锁定任务")
chk(any(o["rush"] for o in demos), "缺急单")
pair = [o for o in demos if o.get("preferredMachine") == "8301"]
chk(len(pair) == 2 and len(set(p["spec"] for p in pair)) == 2, "缺换型相邻任务对")
r2 = [o for o in demos if o["id"] == "DEMO-2026-0002"][0]
chk(r2["qtyMeters"] == 45000 and r2["duePolicy"] == "hard" and r2["preShipDate"] == "2026-09-21", "硬交期冲突语义")
chk(sim["materialDelay"]["orderId"] == r2["id"], "materialDelay 未指向硬冲突订单")

# ---------- spec-derivation ----------
chk(set(sd.keys()) == {"strandCountFactor","strandSpecValues"}, "spec-derivation 键: %s" % list(sd.keys()))
for k, v in sd["strandCountFactor"].items():
    chk(v == round(math.sin(math.pi / int(k)), 4), "sin 系数不符 N=%s: %s" % (k, v))
sv = sd["strandSpecValues"]
chk(sv == sorted(sv) and len(sv) == len(set(sv)), "strandSpecValues 未升序去重")
chk(all(isinstance(x, (int, float)) for x in sv), "strandSpecValues 非数值")
print("dataset.json      : %d bytes (%.2f MB)" % (sz_real, sz_real/1048576.0))
print("demo-dataset.json : %d bytes (%.1f KB)" % (sz_demo, sz_demo/1024.0))
print("spec-derivation   : %d bytes" % sz_sd)
print("closing 键/行     : %d / %d | stranding 行: %d" % (len(idx), len(cr), len(sr)))
print("demo 矩阵         : 捻股 %d 行 x %d 台, 合绳 %d 行 x %d 台" % (len(dstrand["rows"]), len(dstrand["machineIds"]), len(dclose["rows"]), len(dclose["machineIds"])))
print("WARN:", warns if warns else "none")
print("FAILS(%d):" % len(fails))
for f in fails[:25]:
    print("  -", f)
print("VALIDATION:", "PASS" if not fails else "FAIL")
# 原先没有退出码：失败也返回 0，无法进 CI。现在失败返回 1。
sys.exit(0 if not fails else 1)
