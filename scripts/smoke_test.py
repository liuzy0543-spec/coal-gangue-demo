# -*- coding: utf-8 -*-
"""smoke_test.py —— 三步接口冒烟测试（需先启动 app.py）

用法：
    python scripts/smoke_test.py
    python scripts/smoke_test.py --base http://127.0.0.1:7880 --image "D:\\...\\xxx.jpg"
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_IMAGE = str(ROOT / "tests" / "images" / "case_a.jpg")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://127.0.0.1:7880")
    ap.add_argument("--image", default=DEFAULT_IMAGE)
    args = ap.parse_args()
    B = args.base.rstrip("/")

    def call(path, payload, timeout=180):
        r = requests.post(B + path, json=payload, timeout=timeout)
        try:
            return r.status_code, r.json()
        except Exception:
            return r.status_code, {"ok": False, "error": r.text[:300]}

    ok_all = True
    print("1) /api/meta")
    r = requests.get(B + "/api/meta", timeout=20)
    meta = r.json()
    print("   ", r.status_code, "device=", meta.get("device"),
          "models=", [k for k in meta.get("metrics", {}) if k in ("SiO2", "Al2O3", "Al2O3_xrd", "Fe2O3", "CaO")],
          "kb=", meta.get("kb_count"), "llm=", meta.get("llm", {}).get("configured"))
    ok_all &= r.status_code == 200
    ok_all &= meta.get("kb_count", 0) >= 16
    ok_all &= "Al2O3_xrd" in meta.get("metrics", {})

    print("1b) /api/cases")
    r = requests.get(B + "/api/cases", timeout=20)
    cases = r.json().get("cases", [])
    print("   ", r.status_code, [(c["id"], c["sample_id"], c["image_exists"]) for c in cases])
    ok_all &= r.status_code == 200 and len(cases) == 3

    print("2) /api/detect")
    code, d = call("/api/detect", {"path": args.image, "conf": 0.25, "iou": 0.45})
    print("   ", code, "total=", d.get("total"), "counts=", d.get("counts"),
          "image=", d.get("image_url"))
    ok_all &= bool(d.get("ok")) and d.get("total", 0) > 0
    if not d.get("ok"):
        print("   ", d.get("error"))
        sys.exit(1)

    inputs = {"LOI烧失量": 18.5, "K2O": 1.85, "MgO": 1.25, "Na2O": 0.62,
              "TiO2": 1.18, "SO3": 1.45, "高岭石": None}
    area = {"id": "hx_mt", "name": "霍西煤田", "province": "山西", "city": "临汾"}

    print("3) /api/predict")
    code, p = call("/api/predict", {
        "stones": d["stones"], "quality": d["quality"], "inputs": inputs,
        "area": area, "source_type": "煤矸石",
        "stage": "RAW_OR_UNSPECIFIED_GANGUE"})
    print("   ", code, "rows=", len(p.get("rows", [])), "den=", p.get("den"))
    for row in p.get("rows", [])[:2]:
        print("    ", row["id"], {k: v["value"] for k, v in row["pred"].items()})
    ok_all &= bool(p.get("ok")) and len(p.get("rows", [])) > 0

    print("4) /api/recommend（无 Key 时应回退 offline）")
    stones = [{"id": x["id"], "conf": x["conf"], "feature": x["feature"], "pred": x["pred"]}
              for x in p.get("rows", [])]
    code, rec = call("/api/recommend", {
        "stones": stones, "area": area, "inputs": inputs,
        "quality": d["quality"], "use_llm": True}, timeout=150)
    print("   ", code, "mode=", rec.get("mode"), "n=", len(rec.get("stones", [])))
    for x in rec.get("stones", [])[:2]:
        print("    ", x["id"], "→", x["primary"]["name"],
              "| 备选", [y["name"] for y in x.get("secondary", [])])
    ok_all &= bool(rec.get("ok")) and len(rec.get("stones", [])) > 0

    print("\n==>", "全部通过" if ok_all else "存在失败项")
    sys.exit(0 if ok_all else 1)


if __name__ == "__main__":
    main()