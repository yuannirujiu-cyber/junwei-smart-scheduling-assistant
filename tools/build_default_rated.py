#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""将固定的《产品额定（平均值）(1).xlsx》编译为浏览器可直接加载的默认产能数据。"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
APP_DIR = os.path.dirname(HERE)
ROOT = os.path.dirname(APP_DIR)
sys.path.insert(0, HERE)

import build_dataset as source

SOURCE_FILE = os.path.join(ROOT, "产品额定（平均值）(1).xlsx")
OUTPUT_FILE = os.path.join(APP_DIR, "data", "default-rated-capacity.json")


def main():
    if not os.path.isfile(SOURCE_FILE):
        raise SystemExit("找不到默认产品额定工作簿：" + SOURCE_FILE)

    source.SRC_RATED = SOURCE_FILE
    rated = source.load_rated()
    ok, issues, mismatched, coefficients = source.verify_coefficients(
        rated["strandingRows"], rated["strandingIds"]
    )
    mismatched = set(mismatched)
    strand_rows, closing_rows = [], []

    strand_dedup, strand_conflicts, strand_variant_conflicts = source.dedup_rows(
        rated["strandingRows"], len(rated["strandingIds"])
    )
    for name, spec, torsion, values, variants, conflict in strand_dedup:
        row, _ = source.capacity_row(name, spec, torsion, values, rated["strandingIds"], False, variants, conflict)
        if (name, spec) in mismatched:
            row["rates"] = values
        strand_rows.append(row)

    closing_dedup, closing_conflicts, closing_variant_conflicts = source.dedup_rows(
        rated["closingRows"], len(rated["closingIds"])
    )
    for name, spec, torsion, values, variants, conflict in closing_dedup:
        row, _ = source.capacity_row(name, spec, torsion, values, rated["closingIds"], True, variants, conflict)
        closing_rows.append(row)

    output = {
        "meta": {
            "id": "product-rated-default-20260919",
            "name": "产品额定（平均值）(1).xlsx",
            "source": "内置产品额定数据",
            "stats": {
                "drawing": len(rated["drawing"]),
                "stranding": len(rated["strandingIds"]),
                "closing": len(rated["closingIds"]),
                "strandRows": len(strand_rows),
                "closingRows": len(closing_rows),
            },
            "issues": issues,
            "coefficientModelVerified": bool(ok),
            "dedup": {
                "strandingCellConflicts": strand_conflicts,
                "strandingVariantConflicts": strand_variant_conflicts,
                "closingCellConflicts": closing_conflicts,
                "closingVariantConflicts": closing_variant_conflicts,
            },
        },
        "machines": {
            "drawing": rated["drawing"],
            "stranding": [{"id": machine_id} for machine_id in rated["strandingIds"]],
            "closing": [{"id": machine_id} for machine_id in rated["closingIds"]],
        },
        "capacity": {
            "stranding": {
                "model": "torsion-x-coefficient",
                "unit": "米/分",
                "machineIds": rated["strandingIds"],
                "coefficients": coefficients,
                "rows": strand_rows,
            },
            "closing": {
                "model": "explicit",
                "unit": "米/分",
                "machineIds": rated["closingIds"],
                "rows": closing_rows,
            },
        },
    }
    source.dump_json(OUTPUT_FILE, output)
    print("已生成", OUTPUT_FILE)
    print(output["meta"]["stats"])


if __name__ == "__main__":
    main()
