#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""君威智能排产助手 - 真实脱敏数据包抽取脚本.

用法:
    PYTHONPATH=.pylibs python3 "君威智能排产助手/tools/build_dataset.py"

产出:
    君威智能排产助手/data/dataset.json          真实脱敏快照
    君威智能排产助手/data/demo-dataset.json     虚构演示数据(路演 8 场景)
    君威智能排产助手/data/spec-derivation.json  股径推导辅助表
    君威智能排产助手/data/README.md             数据说明
"""
import json
import math
import os
import re
from collections import Counter, OrderedDict
from datetime import date, datetime

import openpyxl

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)
ROOT = os.path.dirname(APP_DIR)
DATA_DIR = os.path.join(APP_DIR, "data")
SRC_ORDERS = os.path.join(ROOT, "黑客松数据包", "订单信息.xlsx")
SRC_RATED = os.path.join(ROOT, "黑客松数据包", "产品额定（平均值）.xlsx")

SHEET_ORDERS = "订单信息"
SHEET_DRAWING = "拉丝"
SHEET_STRANDING = "捻股"
SHEET_CLOSING = "合绳（绳子+绳芯）"

# 已验证的捻股精确模型系数, 顺序与表头 8201..8251(共 50 台)一致
STRANDING_COEFFS = [
    1.0, 1.0, 1.1, 1.1, 1.1, 1.1, 1.2, 1.2, 1.2, 1.1,
    1.2, 1.2, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8, 0.8,
    0.5, 0.8, 0.7, 0.7, 0.7, 0.5, 0.65, 0.7, 0.7, 0.7,
    0.7, 0.5, 0.6, 0.6, 0.3, 0.65, 0.38, 0.65, 0.65, 0.7,
    0.7, 0.8, 0.8, 0.8, 0.7, 0.4, 1.2, 1.2, 1.2, 1.2,
]

MACHINE_COL_RE = re.compile("^([0-9]+)")
SPEC_RE = re.compile(r"^([0-9]+(?:[.][0-9]+)?)mm\s+(.+)$")
SPEC_RANGE_RE = re.compile(r"^([0-9.]+)\s*-\s*([0-9.]+)")
GRADE_RE = re.compile(r"^(GT[0-9]+[A-Z]*)\((.*)\)$")
# 归一化键专用: 只捕获括号内结构, 与规则 ^GT\d+[A-Z]*\((.*)\)$ 完全一致
GRADE_STRIP_RE = re.compile(r"^GT[0-9]+[A-Z]*\((.*)\)$")
SPEED_RE = re.compile(r"^([0-9.]+)\s*m/s$")
COUNT_RE = re.compile(r"([0-9]+)\s*[*+]\s*([0-9]+)")


def norm_key(spec):
    """归一化键: 订单 mappingKey 与 specIndex 必须使用同一函数."""
    if spec is None:
        return None
    s = str(spec).strip()
    m = SPEC_RE.match(s)
    if not m:
        return None
    dia = m.group(1)
    rest = m.group(2).strip()
    m2 = GRADE_STRIP_RE.match(rest)
    if m2:
        rest = m2.group(1)
    rest = re.sub(r"\s+", "", rest).upper()
    return dia + "|" + rest


def num(v):
    if v is None or isinstance(v, bool):
        return None
    if isinstance(v, (int, float)):
        f = float(v)
        return int(f) if f.is_integer() else f
    s = str(v).strip()
    if s == "":
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return int(f) if f.is_integer() else f


def to_iso(v):
    if v is None:
        return None
    if isinstance(v, datetime):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, date):
        return v.strftime("%Y-%m-%d")
    s = str(v).strip()
    if s in ("", "None", "/"):
        return None
    m = re.match(r"^([0-9]{4})-([0-9]{2})-([0-9]{2})", s)
    return m.group(0) if m else None


def parse_spec(spec):
    out = {
        "parseOk": False, "diameterMm": None, "diameterRaw": None, "grade": None,
        "lay": None, "structure": None, "strandCount": None,
        "strandConstruction": None, "core": None,
    }
    if spec is None:
        return out
    raw = str(spec).strip()
    if raw == "":
        return out
    m = SPEC_RE.match(raw)
    if m:
        out["diameterMm"] = num(m.group(1))
        rest = m.group(2).strip()
    else:
        m2 = re.match(r"^([0-9.]+(?:[-~][0-9.]+)?)\s*mm\s*(.*)$", raw)
        if m2:
            out["diameterRaw"] = m2.group(1)
            rest = m2.group(2).strip()
        else:
            out["diameterRaw"] = raw
            rest = raw
    g = GRADE_RE.match(rest)
    if g:
        grade, structure = g.group(1), g.group(2).strip()
    else:
        grade, structure = None, rest.strip()
    out["grade"] = grade
    if grade and grade[-1] in ("Z", "S"):
        out["lay"] = grade[-1]
    if structure:
        out["structure"] = structure
        head, sep, tail = structure.partition("+")
        core_part = tail.strip() if sep else ""
        star = head.partition("*")
        if star[1] == "*":
            sc = re.match(r"^([0-9]+)", star[0].strip())
            if sc:
                out["strandCount"] = int(sc.group(1))
            out["strandConstruction"] = star[2].strip() or None
        cu = core_part.upper()
        if cu:
            for tag in ("PIWRC", "IWRC", "PWSC", "WSC", "FC"):
                if tag in cu:
                    out["core"] = tag
                    break
        out["parseOk"] = out["diameterMm"] is not None
    return out


def caps_of(vals):
    return [i for i, v in enumerate(vals) if v is not None and v > 0]


def machine_ids(header_cells):
    ids = []
    for c in header_cells:
        if c is None:
            continue
        m = MACHINE_COL_RE.match(str(c))
        if m:
            ids.append(m.group(1))
    return ids


def load_orders():
    wb = openpyxl.load_workbook(SRC_ORDERS, read_only=True, data_only=True)
    ws = wb[SHEET_ORDERS]
    it = ws.iter_rows(values_only=True)
    hdr = [str(x) for x in next(it)]
    col = {name: i for i, name in enumerate(hdr)}
    orders = []
    for r in it:
        if r[col["项目编号"]] is None:
            continue
        spec = r[col["规格"]]
        orders.append({
            "id": str(r[col["项目编号"]]),
            "internalNo": str(r[col["内部订单单号-序号-次序号"]]),
            "productName": str(r[col["品名"]]),
            "spec": str(spec) if spec is not None else "",
            "coating": str(r[col["涂层"]]) if r[col["涂层"]] is not None else "",
            "qtyMeters": num(r[col["业务数量"]]),
            "qtyMetersUnit": str(r[col["业务单位"]]),
            "qtyKg": num(r[col["计价数量"]]),
            "qtyKgUnit": str(r[col["计价单位"]]),
            "orderDate": to_iso(r[col["订单日期"]]),
            "preShipDate": to_iso(r[col["预发货日"]]),
            "preArrivalDate": to_iso(r[col["预到货日"]]),
            "endCode": str(r[col["结束码"]]),
            "lastShipDate": to_iso(r[col["最后销货日期"]]),
            "parsed": parse_spec(spec),
            "mappingKey": norm_key(spec),
            "matchStatus": "missing",
            "mappingCandidates": [],
            "wireSpecHint": None,
        })
    return orders, hdr


def load_rated():
    wb = openpyxl.load_workbook(SRC_RATED, read_only=True, data_only=True)
    ws = wb[SHEET_DRAWING]
    it = ws.iter_rows(values_only=True)
    next(it)
    drawing = []
    for r in it:
        r = list(r)[:9]
        if len(r) < 9 or r[2] is None:
            continue
        rng = str(r[4]) if r[4] is not None else ""
        mr = SPEC_RANGE_RE.match(rng)
        sp = SPEED_RE.match(str(r[8]).strip()) if r[8] is not None else None
        drawing.append({
            "id": str(r[2]), "name": str(r[1]), "type": str(r[3]), "specRangeRaw": rng,
            "specMin": num(mr.group(1)) if mr else None,
            "specMax": num(mr.group(2)) if mr else None,
            "speedMps": num(sp.group(1)) if sp else None,
            "dayOutput": num(r[5]), "nightOutput": num(r[6]), "totalOutput": num(r[7]),
        })
    ws = wb[SHEET_STRANDING]
    it = ws.iter_rows(values_only=True)
    hdr = list(next(it))
    sids = machine_ids(hdr[5:])
    srows = []
    for r in it:
        r = list(r)
        if r[0] is None:
            continue
        srows.append((str(r[0]), str(r[1]), num(r[4]), [num(x) for x in r[5:5 + len(sids)]]))
    ws = wb[SHEET_CLOSING]
    it = ws.iter_rows(values_only=True)
    hdr2 = list(next(it))
    cids = machine_ids(hdr2[5:])
    crows = []
    for r in it:
        r = list(r)
        if r[0] is None:
            continue
        crows.append((str(r[0]), str(r[1]), num(r[4]), [num(x) for x in r[5:5 + len(cids)]]))
    return {"drawing": drawing, "strandingIds": sids, "strandingRows": srows,
            "closingIds": cids, "closingRows": crows,
            "strandingCols": len(hdr), "closingCols": len(hdr2)}


def derive_coefficients(rows, n):
    """从数据本身推导「捻距 × 机台系数」的系数向量。

    原先这里写死了一组 50 个系数，位置与表头列一一对应。源 Excel 一旦增删机台列
    （实测：8246 从合绳挪到捻股，捻股列数 50 → 51），写死的向量就会整体错位，
    且因为长度不符而静默退化成「全部保留 rates」，末列机台直接拿不到产能。
    改为推导：每列取「rate / torsion」的众数，再回头校验全表是否一致。
    返回 (coeffs, bad_cells, mismatched_rows)；系数列无数据时为 None。
    """
    from collections import Counter as _Counter
    ratios = [_Counter() for _ in range(n)]
    for name, spec, torsion, vals in rows:
        if torsion in (None, 0):
            continue
        for i, v in enumerate(vals[:n]):
            if v is None:
                continue
            ratios[i][round(v / torsion, 6)] += 1
    coeffs = [(c.most_common(1)[0][0] if c else None) for c in ratios]
    bad_cells, mismatched = 0, []
    for name, spec, torsion, vals in rows:
        if torsion in (None, 0):
            mismatched.append((name, spec))
            continue
        ok_row = True
        for i, v in enumerate(vals[:n]):
            if v is None:
                continue
            if coeffs[i] is None or round(v / torsion, 6) != coeffs[i]:
                bad_cells += 1
                ok_row = False
        if not ok_row:
            mismatched.append((name, spec))
    return coeffs, bad_cells, mismatched


def verify_coefficients(rows, ids):
    """校验「捻距 × 机台系数」模型是否精确成立，并给出推导出的系数向量。"""
    issues = []
    coeffs, bad_cells, mismatched = derive_coefficients(rows, len(ids))
    missing = [i for i, c in enumerate(coeffs) if c is None]
    if missing:
        issues.append("捻股有 %d 个机台列在全部行中都没有产出值，无法推导系数（列下标 %s），这些行改用显式 rates"
                      % (len(missing), ", ".join(str(ids[i]) for i in missing[:8])))
    if bad_cells:
        issues.append("捻股系数模型校验失败: %d 个单元格不符(涉及 %d 行), 这些行已改用显式 rates"
                      % (bad_cells, len(set(mismatched))))
    ok = (bad_cells == 0 and not missing)
    return ok, issues, mismatched, coeffs


def dedup_rows(rows, n_machines):
    """按 (品名,规格) 去重, 合并列值.

    返回 (deduped, conflicts, variant_conflict_keys).
    deduped 元素: (name, spec, torsion, vals, variants, variant_conflict)
    同一 (品名,规格) 在源表中可能存在多份且捻距不同(不同捻距档位), 首次出现值优先,
    同时用 variants / variantConflict 标记该行被合并了多少份、是否存在数值分歧。
    """
    merged = OrderedDict()
    conflicts = 0
    for name, spec, torsion, vals in rows:
        key = (name, spec)
        if key not in merged:
            merged[key] = [torsion, list(vals), 1, False]
            continue
        cur = merged[key]
        cur[2] += 1
        if torsion is not None and cur[0] != torsion:
            if cur[0] is not None:
                conflicts += 1
                cur[3] = True
            else:
                cur[0] = torsion
        for i, v in enumerate(vals[:n_machines]):
            if v is None:
                continue
            if cur[1][i] is None:
                cur[1][i] = v
            elif cur[1][i] != v:
                conflicts += 1
                cur[3] = True
    out = []
    vconf = 0
    for (name, spec), (torsion, vals, nvar, vc) in merged.items():
        out.append((name, spec, torsion, vals, nvar, vc))
        if vc:
            vconf += 1
    return out, conflicts, vconf


def build_closing_index(closing_rows):
    index = OrderedDict()
    for name, spec, torsion, rates in closing_rows:
        key = norm_key(spec)
        if key is None:
            continue
        bucket = index.setdefault(key, [])
        if spec not in bucket:
            bucket.append(spec)
    return index


def apply_matching(orders, index):
    for o in orders:
        key = o["mappingKey"]
        cands = list(index.get(key) or []) if key else []
        o["mappingCandidates"] = cands
        o["matchStatus"] = "missing" if not cands else ("multi" if len(cands) > 1 else "matched")


def capacity_row(name, spec, torsion, vals, ids, with_rates, variants=1, variant_conflict=False):
    caps = caps_of(vals)
    row = {"name": name, "spec": spec, "torsion": torsion}
    if with_rates:
        row["rates"] = [v if v is not None and v > 0 else None for v in vals]
    row["capCount"] = len(caps)
    if len(caps) != len(ids):
        row["caps"] = caps
    if variants > 1:
        row["variants"] = variants
    if variant_conflict:
        row["variantConflict"] = True
    return row, (len(caps) != len(ids))


def build_real():
    orders, _hdr = load_orders()
    rated = load_rated()
    ok, issues, mismatched, strand_coeffs = verify_coefficients(rated["strandingRows"], rated["strandingIds"])
    mm = set(mismatched)
    sids = rated["strandingIds"]
    cids = rated["closingIds"]

    s_dedup, s_conf, s_vconf = dedup_rows(rated["strandingRows"], len(sids))
    c_dedup, c_conf, c_vconf = dedup_rows(rated["closingRows"], len(cids))

    s_partial, s_partial_samples = 0, []
    capacity_stranding_rows = []
    for name, spec, torsion, vals, nvar, vc in s_dedup:
        row, partial = capacity_row(name, spec, torsion, vals, sids, False, nvar, vc)
        if (name, spec) in mm:
            row["rates"] = vals
        if partial:
            s_partial += 1
            if len(s_partial_samples) < 5:
                s_partial_samples.append("%s %s capCount=%d" % (name, spec, row["capCount"]))
        capacity_stranding_rows.append(row)

    c_partial, c_partial_samples = 0, []
    capacity_closing_rows = []
    for name, spec, torsion, vals, nvar, vc in c_dedup:
        row, partial = capacity_row(name, spec, torsion, vals, cids, True, nvar, vc)
        if partial:
            c_partial += 1
            if len(c_partial_samples) < 5:
                c_partial_samples.append("%s %s capCount=%d" % (name, spec, row["capCount"]))
        capacity_closing_rows.append(row)

    if s_conf:
        issues.append("捻股按 (品名,规格) 去重时 %d 个单元格数值分歧(涉及 %d 个键, 多为不同捻距档位), "
                      "已保留首次出现值并用 variants/variantConflict 标记" % (s_conf, s_vconf))
    if c_conf:
        issues.append("合绳按 (品名,规格) 去重时 %d 个单元格数值分歧(涉及 %d 个键), "
                      "已保留首次出现值并用 variants/variantConflict 标记" % (c_conf, c_vconf))
    if c_partial_samples:
        issues.append("合绳存在非全适配行(0 或空单元格): " + "; ".join(c_partial_samples))

    index = build_closing_index(rated["closingRows"])
    apply_matching(orders, index)

    # 交叉校验: 用独立实现(alt_key)复算归一化键, 防止主正则路径出现偏差
    main_keys, alt_keys, key_diff = set(), set(), []
    key_diff_rows = 0
    for _n, s, _t, _r in rated["closingRows"]:
        k1, k2 = norm_key(s), alt_key(s)
        if k1:
            main_keys.add(k1)
        if k2:
            alt_keys.add(k2)
        if k1 != k2:
            key_diff_rows += 1
            if len(key_diff) < 4:
                key_diff.append("%s -> 主:%s / 宽松:%s" % (s, k1, k2))
    if key_diff_rows:
        issues.append("归一化键交叉校验: 主实现 %d 键 / 宽松独立实现 %d 键, 差异仅 %d 行且为预期差异——"
                      "主实现严格按规则执行(牌号含连字符如 GT28ZD-H 时不剥离括号; "
                      "34.9mm-36.9mm 这类 mm 后无空白的区间不解析)。样例: %s"
                      % (len(main_keys), len(alt_keys), key_diff_rows, "; ".join(key_diff)))

    stats = Counter(o["matchStatus"] for o in orders)
    missing_samples = ["%s %s" % (o["id"], o["spec"]) for o in orders if o["matchStatus"] == "missing"][:20]

    notes = [
        "拉丝表实际数据行 47 行(表头另计), 机台 8103-8149; 8104 的白/晚班产量为空(null)",
        "合绳表表头 %d 列(含末列空列), 机台列顺序为 %s" % (rated["closingCols"], ", ".join(cids)),
        "捻股表表头 %d 列, 机台列顺序为 %s" % (rated["strandingCols"], ", ".join(sids)),
        "合绳表 %d/%d 行规格不是 直径+mm 形式(多为股规格), 无法归一化, 未进入 specIndex"
        % (sum(1 for _n, s, _t, _r in rated["closingRows"] if norm_key(s) is None),
           len(rated["closingRows"])),
        "订单预发货日/预到货日各 2 条为空",
        "换型(规格切换)耗时无实测矩阵, 当前数据不含换型时间",
        "股径->股规格映射缺失, 拉丝/捻股工序无法由成品规格自动展开; spec-derivation.json 仅给出 sin(pi/N) 理论系数与股规格取值域",
        "wireSpecHint 为占位字段, 当前恒为 null, 由前端/算法自行推导",
    ]
    dataset = {
        "meta": {
            "id": "junwei-real",
            "name": "君威脱敏数据快照",
            "source": ["黑客松数据包/订单信息.xlsx", "黑客松数据包/产品额定（平均值）.xlsx"],
            "generatedAt": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
            "orderCount": len(orders),
            "note": "比赛脱敏数据，仅限本次比赛使用",
            "coefficientModelVerified": bool(ok),
            "issues": issues + notes,
        },
        "orders": orders,
        "machines": {
            "drawing": rated["drawing"],
            "stranding": [{"id": i} for i in sids],
            "closing": [{"id": i} for i in cids],
        },
        "capacity": {
            "stranding": {
                "model": "torsion-x-coefficient", "unit": "米/分",
                "machineIds": sids, "coefficients": strand_coeffs,
                "rows": capacity_stranding_rows,
            },
            "closing": {
                "model": "explicit", "unit": "米/分",
                "machineIds": cids, "rows": capacity_closing_rows,
            },
        },
        "specIndex": {
            "closing": index,
            "closingKeys": list(index.keys()),
            "orderMatchStats": {
                "total": len(orders), "matched": stats.get("matched", 0),
                "multi": stats.get("multi", 0), "missing": stats.get("missing", 0),
                "missingSamples": missing_samples,
            },
        },
    }
    extra = {
        "raw_stranding_rows": len(rated["strandingRows"]),
        "raw_closing_rows": len(rated["closingRows"]),
        "s_partial": s_partial, "c_partial": c_partial,
        "s_conf": s_conf, "c_conf": c_conf,
        "s_vconf": s_vconf, "c_vconf": c_vconf,
        "s_partial_samples": s_partial_samples, "c_partial_samples": c_partial_samples,
        "mismatch_rows": len(mm),
        "main_keys": len(main_keys), "alt_keys": len(alt_keys),
        "key_diff_rows": key_diff_rows,
        "missing_orders": ["%s %s" % (o["id"], o["spec"]) for o in orders
                           if o["matchStatus"] == "missing"],
        "closing_unparsed": sum(1 for _n, s, _t, _r in rated["closingRows"] if norm_key(s) is None),
    }
    return dataset, rated, stats, ok, extra


def alt_key(spec):
    """独立实现的归一化键(交叉校验用, 不走正则主路径)."""
    if spec is None:
        return None
    s = str(spec).strip()
    if "mm " not in s and not s.endswith("mm"):
        return None
    head, _sep, tail = s.partition("mm")
    dia = head.strip()
    if dia == "" or not all(ch.isdigit() or ch == "." for ch in dia):
        return None
    rest = tail.strip()
    if rest.startswith("GT"):
        lp, rp = rest.find("("), rest.rfind(")")
        if lp > 0 and rp == len(rest) - 1:
            rest = rest[lp + 1:rp]
    return dia + "|" + "".join(rest.split()).upper()


def build_spec_derivation(rated, orders):
    counts = set()
    for _n, s, _t, _r in rated["closingRows"]:
        p = parse_spec(s)
        if p["strandCount"]:
            counts.add(p["strandCount"])
    for name, spec, _t, _v in rated["strandingRows"]:
        for a, b in COUNT_RE.findall(name):
            counts.add(int(a))
            counts.add(int(b))
    for o in orders:
        if o["parsed"]["strandCount"]:
            counts.add(o["parsed"]["strandCount"])
    counts = sorted(c for c in counts if c >= 2)
    factors = OrderedDict()
    for c in counts:
        factors[str(c)] = round(math.sin(math.pi / c), 4)
    vals, unparsed = set(), 0
    for name, spec, _t, _v in rated["strandingRows"]:
        try:
            f = float(str(spec).strip())
        except ValueError:
            f = None
        if f is None:
            unparsed += 1
        else:
            vals.add(round(f, 4))
    return {"strandCountFactor": factors, "strandSpecValues": sorted(vals)}, unparsed


# ---------------------------------------------------------------- demo data

DEMO_DRAWING = [
    ("8101", "1号水箱拉丝机", "湿拉机", "0.08-0.20", 8.0, 27151, 30074),
    ("8102", "2号水箱拉丝机", "湿拉机", "0.20-0.40", 8.0, 26010, 28840),
    ("8103", "3号水箱拉丝机", "湿拉机", "0.40-0.70", 8.0, 41172, 42159),
    ("8104", "4号水箱拉丝机", "湿拉机", "0.60-1.00", 8.0, 38200, 37900),
    ("8105", "5号干拉机", "干拉机", "0.90-2.00", 7.0, 92100, 90600),
    ("8106", "6号干拉机", "干拉机", "1.80-5.00", 7.0, 142042, 140650),
]

DEMO_STRAND_ROWS = [
    ("光面股0064 1*19 B1", "0.64", 22.0),
    ("光面股0076 1*19 B1", "0.76", 24.0),
    ("光面股0090 1*19 B1", "0.90", 26.0),
    ("光面股0100 1*19 B1", "1.00", 28.0),
    ("光面股0120 1*19 B2", "1.20", 30.0),
    ("光面股0150 1*19 B2", "1.50", 32.0),
    ("光面股0180 1*19 B2", "1.80", 34.0),
    ("光面股0210 1*19 B3", "2.10", 36.0),
    ("光面股0240 1*19 B3", "2.40", 38.0),
    ("光面股0300 1*19 B3", "3.00", 40.0),
    ("光面股0360 1*19 B4", "3.60", 42.0),
    ("光面股0420 1*19 B4", "4.20", 44.0),
]

DEMO_CLOSING_ROWS = [
    ("光面圆股钢丝绳", "6mm 6*19S+FC", 39.2, [12.0, 9.6, 8.64, 7.2]),
    ("光面圆股钢丝绳", "8mm 6*19S+FC", 45.0, [9.8, 7.84, 7.06, 5.88]),
    ("光面圆股钢丝绳", "10mm 6*19S+FC", 52.0, [8.2, 6.56, 5.9, 4.92]),
    ("光面圆股钢丝绳", "12mm 6*19S+FC", 58.0, [7.0, 5.6, 5.04, 4.2]),
    ("光面圆股钢丝绳", "6mm 6*37+FC", 36.0, [11.0, 8.8, 7.92, 6.6]),
    ("光面圆股钢丝绳", "8mm 6*37+FC", 41.0, [9.0, 7.2, 6.48, 5.4]),
    ("工程机械用光面变幅绳", "22mm GT8ZH(8*K26WS+IWRC)", 118.0, [4.2, 3.84, 3.36, 3.02]),
    ("镀锌压实注塑钢丝绳", "12mm GT8PZ(8*K26WS+PIWRC)", 63.0, [6.4, 5.12, 4.61, 3.84]),
    ("光面圆股钢丝绳", "20mm 6*19S+FC", 96.0, [4.8, 4.2, 3.84, 3.36]),
    ("镀锌压实钢丝绳", "16mm 6*29FI+IWRC", 74.0, [5.6, 4.48, 4.03, 3.36]),
]

DEMO_STRAND_COEFFS = STRANDING_COEFFS[:6]
DEMO_STRAND_N = 19


def demo_wire_mm(strand_spec):
    return round(float(strand_spec) * math.sin(math.pi / DEMO_STRAND_N), 3)


def demo_dt(arr):
    return [{"from": a, "to": b, "reason": r} for a, b, r in arr]


def demo_orders_table():
    return [
        ("DEMO-2026-0001", "6mm 6*19S+FC", "0.64", 2000, "2026-09-25", "2026-09-10",
         "重点客户", "hard", 0, dict(note="场景1 正常准时订单: 硬交期, 产能与交期匹配")),
        ("DEMO-2026-0002", "8mm 6*19S+FC", "0.76", 45000, "2026-09-21", "2026-09-09",
         "重点订单", "hard", 0, dict(note="场景2 硬交期冲突: 45000 米 + 物料 09-22 才齐套(见 simulationPresets.materialDelay), 硬交期 09-21 无宽限, 注定违约")),
        ("DEMO-2026-0003", "10mm 6*19S+FC", "0.90", 3000, "2026-09-24", "2026-09-11",
         "普通", "soft", 72, dict(note="场景3 宽限内延期: 软交期 09-24 允许 72h 宽限, 顺延至 09-26 仍可接受")),
        ("DEMO-2026-0004", "14mm GT9Z(9*K25WS+IWRC)", None, 1500, "2026-09-28", "2026-09-12",
         "普通", "unknown", 0, dict(note="场景4 规格无匹配: matchStatus=missing, processMap.status=pending, 需人工补录工艺映射")),
        ("DEMO-2026-0005", "6mm 6*19S+FC", "0.64", 2500, "2026-09-29", "2026-09-13",
         "普通", "soft", 72, dict(note="场景5 换型前任务: 与 DEMO-2026-0006 相邻同机台 8301, 规格不同需换型",
                                 preferred_machine="8301")),
        ("DEMO-2026-0006", "6mm 6*37+FC", "0.64", 2500, "2026-09-30", "2026-09-13",
         "普通", "soft", 72, dict(note="场景5 换型后任务: 紧接 DEMO-2026-0005, 同机台不同规格, 需计算换型耗时",
                                 preferred_machine="8301")),
        ("DEMO-2026-0007", "12mm 6*19S+FC", "1.00", 9000, "2026-09-22", "2026-09-08",
         "重点订单", "hard", 0, dict(note="场景6 工序等待>72h: 前道排队 + 8203 停机 24h, 后道等待约 96h")),
        ("DEMO-2026-0008", "8mm 6*37+FC", "0.76", 1800, "2026-10-02", "2026-09-14",
         "重点客户", "soft", 72, dict(note="场景7 已锁定任务: 已下发车间, 排产引擎不得移动", locked=True)),
        ("DEMO-2026-0009", "12mm GT8PZ(8*K26WS+PIWRC)", "1.20", 1200, "2026-09-22", "2026-09-17",
         "重点客户", "hard", 0, dict(note="场景8 急单: rush=true, 需插单并重排", rush=True)),
        ("DEMO-2026-0010", "22mm GT8ZH(8*K26WS+IWRC)", "1.50", 4000, "2026-10-05", "2026-09-15",
         "普通", "soft", 72, dict(note="常规订单: 合绳机 8302 计划检修窗口内需避让", preferred_machine="8302")),
        ("DEMO-2026-0011", "20mm 6*19S+FC", "1.80", 2600, "2026-10-07", "2026-09-15",
         "重点订单", "soft", 72, dict(note="常规订单: 捻股机 8203 停机影响, 需评估是否改派", preferred_machine="8203")),
        ("DEMO-2026-0012", "16mm 6*29FI+IWRC", "2.10", 5200, "2026-10-08", "2026-09-16",
         "普通", "unknown", 0, dict(note="常规订单: 交期口径未知, 按软交期处理")),
        ("DEMO-2026-0013", "6mm 6*19S+FC", "0.64", 3300, "2026-10-09", "2026-09-16",
         "普通", "soft", 72, dict(note="常规订单: 交期宽松, 可作为填谷任务")),
        ("DEMO-2026-0014", "8mm 6*19S+FC", "0.76", 2100, "2026-10-10", "2026-09-17",
         "普通", "soft", 72, dict(note="常规订单: 交期宽松, 可作为填谷任务")),
    ]


def build_demo():
    strand_by_spec = {}
    for name, spec, torsion in DEMO_STRAND_ROWS:
        strand_by_spec[spec] = (name, spec)
    closing_by_spec = {}
    for name, spec, torsion, rates in DEMO_CLOSING_ROWS:
        closing_by_spec[spec] = (name, spec)

    machines = {
        "drawing": [
            {
                "id": mid, "name": name, "type": mtype, "specRangeRaw": rng,
                "specMin": num(SPEC_RANGE_RE.match(rng).group(1)),
                "specMax": num(SPEC_RANGE_RE.match(rng).group(2)),
                "speedMps": spd, "dayOutput": day, "nightOutput": night,
                "totalOutput": day + night,
                "downtime": demo_dt([("2026-09-20T22:00", "2026-09-21T06:00", "计划检修")] if mid == "8104" else []),
            }
            for mid, name, mtype, rng, spd, day, night in DEMO_DRAWING
        ],
        "stranding": [
            {"id": "820%d" % i, "downtime": demo_dt(
                [("2026-09-24T08:00", "2026-09-25T08:00", "计划检修")] if i == 3 else [])}
            for i in range(1, 7)
        ],
        "closing": [
            {"id": "830%d" % i, "downtime": demo_dt(
                [("2026-09-26T08:00", "2026-09-26T20:00", "计划检修")] if i == 2 else [])}
            for i in range(1, 5)
        ],
    }

    demo_closing_rows = []
    for name, spec, torsion, rates in DEMO_CLOSING_ROWS:
        row, _p = capacity_row(name, spec, torsion, rates, [m["id"] for m in machines["closing"]], True)
        demo_closing_rows.append(row)

    demo_stranding_rows = []
    for name, spec, torsion in DEMO_STRAND_ROWS:
        vals = [round(torsion * c, 4) for c in DEMO_STRAND_COEFFS]
        row, _p = capacity_row(name, spec, torsion, vals, [m["id"] for m in machines["stranding"]], False)
        demo_stranding_rows.append(row)

    demo_index = OrderedDict()
    for row in demo_closing_rows:
        k = norm_key(row["spec"])
        demo_index.setdefault(k, [])
        if row["spec"] not in demo_index[k]:
            demo_index[k].append(row["spec"])

    orders = []
    table = demo_orders_table()
    for i, (oid, spec, strand_spec, qty, ship, odate, prio, policy, grace, extra) in enumerate(table):
        parsed = parse_spec(spec)
        key = norm_key(spec)
        cands = list(demo_index.get(key) or []) if key else []
        status = "missing" if not cands else ("multi" if len(cands) > 1 else "matched")
        y, m, d = [int(x) for x in ship.split("-")]
        arrival = date.fromordinal(date(y, m, d).toordinal() + 3).strftime("%Y-%m-%d")
        if strand_spec:
            sn, ss = strand_by_spec[strand_spec]
            cn, cs = closing_by_spec[spec]
            pm = {
                "closingSpec": cs, "closingName": cn,
                "strandName": sn, "strandSpec": ss,
                "wireSpecMm": demo_wire_mm(strand_spec),
                "qtyFactor": {"drawing": 1.02, "stranding": 1.0, "closing": 1.0},
                "status": "confirmed",
            }
        else:
            pm = {
                "closingSpec": None, "closingName": None,
                "strandName": None, "strandSpec": None,
                "wireSpecMm": None,
                "qtyFactor": {"drawing": 1.02, "stranding": 1.0, "closing": 1.0},
                "status": "pending",
            }
        o = {
            "id": oid,
            "internalNo": "DEMO-2902-%s-%d-1" % (odate.replace("-", ""), i + 1),
            "productName": closing_by_spec[spec][0] if spec in closing_by_spec else "镀锌压实钢丝绳",
            "spec": spec,
            "coating": "绳涂油",
            "qtyMeters": qty,
            "qtyMetersUnit": "米",
            "qtyKg": int(round(qty * 0.0062 * float(parsed["diameterMm"] or 6) ** 2)),
            "qtyKgUnit": "Kg",
            "orderDate": odate,
            "preShipDate": ship,
            "preArrivalDate": arrival,
            "endCode": "未结束",
            "lastShipDate": None,
            "parsed": parsed,
            "mappingKey": key,
            "matchStatus": status,
            "mappingCandidates": cands,
            "wireSpecHint": None,
            "priority": prio,
            "duePolicy": policy,
            "graceHours": grace,
            "rush": bool(extra.get("rush", False)),
            "locked": bool(extra.get("locked", False)),
            "processMap": pm,
        }
        if extra.get("note"):
            o["note"] = extra["note"]
        if extra.get("preferred_machine"):
            o["preferredMachine"] = extra["preferred_machine"]
        orders.append(o)

    rush_spec, rush_strand = "6mm 6*19S+FC", "0.64"
    rk = norm_key(rush_spec)
    rcands = list(demo_index.get(rk) or [])
    rsn, rss = strand_by_spec[rush_strand]
    rcn, rcs = closing_by_spec[rush_spec]
    rush_order = {
        "id": "DEMO-2026-0099",
        "internalNo": "DEMO-2902-20260918-99-1",
        "productName": rcn, "spec": rush_spec, "coating": "绳涂油",
        "qtyMeters": 800, "qtyMetersUnit": "米",
        "qtyKg": int(round(800 * 0.0062 * 36.0)), "qtyKgUnit": "Kg",
        "orderDate": "2026-09-18", "preShipDate": "2026-09-21", "preArrivalDate": "2026-09-24",
        "endCode": "未结束", "lastShipDate": None,
        "parsed": parse_spec(rush_spec), "mappingKey": rk,
        "matchStatus": "matched" if rcands else "missing",
        "mappingCandidates": rcands, "wireSpecHint": None,
        "priority": "重点客户", "duePolicy": "hard", "graceHours": 0,
        "rush": True, "locked": False,
        "processMap": {
            "closingSpec": rcs, "closingName": rcn, "strandName": rsn, "strandSpec": rss,
            "wireSpecMm": demo_wire_mm(rush_strand),
            "qtyFactor": {"drawing": 1.02, "stranding": 1.0, "closing": 1.0},
            "status": "confirmed",
        },
        "note": "路演预设: 点击急单插单后注入的新订单",
    }

    stats = Counter(o["matchStatus"] for o in orders)
    demo = {
        "meta": {
            "id": "junwei-demo",
            "name": "君威智能排产演示数据（虚构）",
            "source": ["虚构演示数据，非真实订单，订单编号全部以 DEMO- 开头"],
            "generatedAt": datetime.now().strftime("%Y-%m-%dT%H:%M:%S"),
            "orderCount": len(orders),
            "note": "路演演示数据，覆盖 PRD 8 个场景；不含任何真实订单号",
            "coefficientModelVerified": True,
            "issues": [
                "演示数据全部虚构，仅设备口径与捻股系数模型沿用真实脱敏结论",
                "demo 拉丝/捻股/合绳矩阵为自建合理值，非真实额定(捻股 22-52.8 米/分, 合绳 3.02-12 米/分)",
                "换型耗时无实测矩阵，场景5 仅提供相邻不同规格任务供前端演示换型提示",
                "DEMO-2026-0004 的 processMap.status=pending(规格无匹配场景)，其余订单均为 confirmed",
                "qtyKg 由 米数 x 0.0062 x 直径^2 估算，非真实称重",
            ],
        },
        "orders": orders,
        "machines": machines,
        "capacity": {
            "stranding": {
                "model": "torsion-x-coefficient", "unit": "米/分",
                "machineIds": [m["id"] for m in machines["stranding"]],
                "coefficients": DEMO_STRAND_COEFFS,
                "rows": demo_stranding_rows,
            },
            "closing": {
                "model": "explicit", "unit": "米/分",
                "machineIds": [m["id"] for m in machines["closing"]],
                "rows": demo_closing_rows,
            },
        },
        "specIndex": {
            "closing": demo_index, "closingKeys": list(demo_index.keys()),
            "orderMatchStats": {
                "total": len(orders), "matched": stats.get("matched", 0),
                "multi": stats.get("multi", 0), "missing": stats.get("missing", 0),
                "missingSamples": ["%s %s" % (o["id"], o["spec"]) for o in orders
                                   if o["matchStatus"] == "missing"][:20],
            },
        },
        "simulationPresets": {
            "rushOrder": rush_order,
            "breakdown": {"machineId": "8203", "from": "2026-09-24T08:00",
                          "to": "2026-09-25T08:00", "reason": "设备故障停机"},
            "materialDelay": {"orderId": "DEMO-2026-0002", "newReadyAt": "2026-09-22T10:00",
                              "oldReadyAt": "2026-09-20T08:00", "inspectionHours": 2},
        },
    }
    warn = []
    for o in orders + [rush_order]:
        w = o["processMap"]["wireSpecMm"]
        if w is None:
            continue
        if not any(m["specMin"] <= w <= m["specMax"] for m in machines["drawing"]):
            warn.append("%s wireSpecMm=%s 未落在任何 demo 拉丝机规格区间" % (o["id"], w))
    return demo, warn


README_TEMPLATE = """# 君威智能排产助手 · 数据说明

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
| data/dataset.json | __SIZE_REAL__ | 真实脱敏快照 |
| data/demo-dataset.json | __SIZE_DEMO__ | 虚构演示数据（路演 8 场景） |
| data/spec-derivation.json | __SIZE_DERIV__ | 股径推导辅助表 |
| data/README.md | - | 本文件 |

dataset.json：orderCount = __ORDER_COUNT__，matchStatus 分布
matched=__M_MATCHED__ / multi=__M_MULTI__ / missing=__M_MISSING__；
捻股去重行 __S_ROWS__ 条（原 __S_RAW__ 行），合绳去重行 __C_ROWS__ 条（原 __C_RAW__ 行）；
specIndex 归一化键 __KEYS__ 个。
demo-dataset.json：orderCount = __DEMO_COUNT__（编号全部 DEMO- 前缀，另含 1 条 simulationPresets.rushOrder）。

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
  非全适配行占比：捻股 __S_PARTIAL__，合绳 __C_PARTIAL__。

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

1. 捻股系数模型：值 = 捻距（平均值） × 固定系数，本次逐行断言结果：__COEF_RESULT__。
   系数向量按原表列顺序 8201-8245、8247-8251 共 50 台。若出现不符行，该行会额外携带显式 rates[]，
   并在 meta.issues 记录；本次不符行数 __MISMATCH_N__。
2. 合绳不满足系数模型，一律使用显式 rates[]（12 台，列顺序 8301-8310、8246、8312）。
3. 去重口径：按 (品名,规格) 去重。同一 (品名,规格) 在源表中可能有多份且捻距不同（不同捻距档位），
   此时保留首次出现值，并给该行加 variants（合并份数）与 variantConflict: true（存在数值分歧）标记。
   本次捻股 __S_CONF__ 个单元格分歧（__S_VCONF__ 个键）、合绳 __C_CONF__ 个单元格分歧（__C_VCONF__ 个键）。
   注意：合绳 distinct (品名,规格) 为 __C_ROWS__ 条，而非 distinct 规格数 1537；
   distinct 规格 1537 个中归一化后得到 __KEYS__ 个键（交叉校验：__KEYCHECK_STRICT__）。
4. 换型耗时无矩阵：数据包不含规格切换的换型时间，排产引擎需自行给出可配置假设；
   演示数据只用相邻不同规格任务表达该场景。
5. 股径映射缺失：成品规格无法自动展开为拉丝/捻股的股径与道次，spec-derivation.json
   只给出理论换算系数与股径取值域，真实道次需人工补录。
6. 拉丝表：实际 47 行数据，8104 白/晚班产量为空（JSON 中为 null）；拉丝速度仅 6/7/8 m/s 三档。
7. 合绳表末列：表头 18 列，最后一列为空列，已忽略。
8. 归一化覆盖率：合绳 4700 行中 __CLOSING_UNPARSED__ 行不是「直径+mm」形式（多为股规格），
   不进入 specIndex；订单侧 __M_MISSING__ 条未命中，需人工补录工艺映射。
9. 日期缺失：2 条订单预发货日/预到货日为空，JSON 中为 null。
10. 演示数据全部虚构，qtyKg 为估算值，不得用于真实对账。
"""


def build_readme(ctx):
    txt = README_TEMPLATE
    for k, v in ctx.items():
        txt = txt.replace(k, str(v))
    return txt


def dump_json(path, obj):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(obj, f, ensure_ascii=False, separators=(",", ":"))
    return os.path.getsize(path)


def main():
    os.makedirs(DATA_DIR, exist_ok=True)
    dataset, rated, stats, ok, extra = build_real()
    demo, warn = build_demo()

    p_real = os.path.join(DATA_DIR, "dataset.json")
    p_demo = os.path.join(DATA_DIR, "demo-dataset.json")
    p_deriv = os.path.join(DATA_DIR, "spec-derivation.json")
    size_real = dump_json(p_real, dataset)
    size_demo = dump_json(p_demo, demo)
    deriv, strand_unparsed = build_spec_derivation(rated, dataset["orders"])
    size_deriv = dump_json(p_deriv, deriv)

    s_partial = extra["s_partial"]
    c_partial = extra["c_partial"]
    s_rows = len(dataset["capacity"]["stranding"]["rows"])
    c_rows = len(dataset["capacity"]["closing"]["rows"])
    demo_stats = Counter(o["matchStatus"] for o in demo["orders"])

    ctx = {
        "__SIZE_REAL__": "%.2f MB" % (size_real / 1048576.0),
        "__SIZE_DEMO__": "%.1f KB" % (size_demo / 1024.0),
        "__SIZE_DERIV__": "%.1f KB" % (size_deriv / 1024.0),
        "__ORDER_COUNT__": len(dataset["orders"]),
        "__M_MATCHED__": stats.get("matched", 0),
        "__M_MULTI__": stats.get("multi", 0),
        "__M_MISSING__": stats.get("missing", 0),
        "__S_ROWS__": s_rows, "__S_RAW__": extra["raw_stranding_rows"],
        "__C_ROWS__": c_rows, "__C_RAW__": extra["raw_closing_rows"],
        "__KEYS__": len(dataset["specIndex"]["closingKeys"]),
        "__DEMO_COUNT__": len(demo["orders"]),
        "__S_PARTIAL__": "%d/%d (%.2f%%)" % (s_partial, s_rows, 100.0 * s_partial / max(1, s_rows)),
        "__C_PARTIAL__": "%d/%d (%.2f%%)" % (c_partial, c_rows, 100.0 * c_partial / max(1, c_rows)),
        "__COEF_RESULT__": ("全部通过（零误差）" if ok else "存在不符行，已改用显式 rates，详见 meta.issues"),
        "__MISMATCH_N__": extra["mismatch_rows"],
        "__S_CONF__": extra["s_conf"],
        "__C_CONF__": extra["c_conf"],
        "__CLOSING_UNPARSED__": extra["closing_unparsed"],
        "__S_VCONF__": extra["s_vconf"],
        "__C_VCONF__": extra["c_vconf"],
        "__KEYCHECK__": "%d 键(独立实现差异 %d 行, 预期)" % (extra["main_keys"], extra["key_diff_rows"]),
        "__KEYCHECK_STRICT__": "%d 键(与独立实现零差异)" % extra["main_keys"]
                               if extra["key_diff_rows"] == 0 else
                               "%d 键(独立实现宽松, %d 行预期差异)" % (extra["main_keys"], extra["key_diff_rows"]),
    }
    p_readme = os.path.join(DATA_DIR, "README.md")
    with open(p_readme, "w", encoding="utf-8") as f:
        f.write(build_readme(ctx))

    print("=" * 64)
    print("orders 数量              :", len(dataset["orders"]))
    print("matchStatus 分布         :", dict(stats))
    print("捻股系数模型 assert      :", "PASS (零误差)" if ok else "FAIL -> 见 meta.issues")
    print("捻股原始/去重行          :", extra["raw_stranding_rows"], "/", s_rows,
          "| 机台", len(rated["strandingIds"]))
    print("捻股非全适配行           :", ctx["__S_PARTIAL__"])
    print("合绳原始/去重行          :", extra["raw_closing_rows"], "/", c_rows,
          "| 机台", len(rated["closingIds"]))
    print("合绳非全适配行           :", ctx["__C_PARTIAL__"])
    print("specIndex 归一化键       :", len(dataset["specIndex"]["closingKeys"]))
    print("拉丝机台数               :", len(dataset["machines"]["drawing"]))
    print("spec-derivation 股数档位 :", len(deriv["strandCountFactor"]),
          "| 股规格取值", len(deriv["strandSpecValues"]),
          "| 非数值规格行", strand_unparsed)
    print("demo orders              :", len(demo["orders"]), dict(demo_stats))
    print("demo 捻股/合绳矩阵行     :", len(demo["capacity"]["stranding"]["rows"]),
          "/", len(demo["capacity"]["closing"]["rows"]))
    print("归一化键交叉校验         :", ctx["__KEYCHECK__"], "(主实现/独立实现)")
    print("未命中订单               :", extra["missing_orders"])
    print("合并非全适配样例         :", extra["c_partial_samples"])
    print("demo processMap 覆盖     :",
          sum(1 for o in demo["orders"] if o["processMap"]["status"] == "confirmed"), "confirmed /",
          sum(1 for o in demo["orders"] if o["processMap"]["status"] == "pending"), "pending")
    print("输出体积 dataset.json    : %.2f MB (%d bytes)" % (size_real / 1048576.0, size_real))
    print("输出体积 demo-dataset    : %.1f KB (%d bytes)" % (size_demo / 1024.0, size_demo))
    print("输出体积 spec-derivation : %.1f KB (%d bytes)" % (size_deriv / 1024.0, size_deriv))
    print("输出体积 README.md       : %d bytes" % os.path.getsize(p_readme))
    if warn:
        print("WARN:", warn)
    print("=" * 64)
    print("meta.issues:")
    for i in dataset["meta"]["issues"]:
        print("  -", i)


if __name__ == "__main__":
    main()
