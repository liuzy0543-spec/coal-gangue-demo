# -*- coding: utf-8 -*-
"""Two-port smoke check: health + port2 detect/predict/recommend + port1 precision."""
from __future__ import annotations
import json
import sys
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "http://127.0.0.1:7880"


def call(path, payload=None, timeout=120):
    url = BASE + path
    if payload is None:
        req = urllib.request.Request(url)
    else:
        req = urllib.request.Request(url, data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def upload_detect(rel="tests/images/case_a.jpg", conf="undefined"):
    boundary = "----DSH" + uuid.uuid4().hex
    img = (ROOT / rel).read_bytes()
    parts = []
    def field(name, value):
        parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n".encode())
    field("conf", conf); field("iou", "0.45")
    parts.append(f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"case_a.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".encode() + img + b"\r\n")
    parts.append(f"--{boundary}--\r\n".encode())
    data = b"".join(parts)
    req = urllib.request.Request(BASE + "/api/detect", data=data,
                                 headers={"Content-Type": "multipart/form-data; boundary=" + boundary})
    with urllib.request.urlopen(req, timeout=240) as r:
        return json.loads(r.read().decode("utf-8"))


def wait_health(seconds=45):
    deadline = time.time() + seconds
    last = None
    while time.time() < deadline:
        try:
            d = call("/api/health", timeout=3)
            if d.get("ok"):
                return d
        except Exception as exc:
            last = exc
        time.sleep(1)
    raise RuntimeError(f"服务未就绪: {last}")


def main():
    report = {"ok": False, "checks": []}
    try:
        h = wait_health()
        report["health"] = h
        report["checks"].append({"name": "服务健康", "ok": True,
                                 "detail": f"models={h.get('models')} kb={h.get('kb_count')}"})
        assert h.get("kb_count", 0) >= 12, "知识库不足 12 条"
        assert len(h.get("models", [])) >= 4, "模型不足 4 个"

        samples = call("/api/demo_samples").get("samples", [])
        assert samples, "没有逐石示例"
        detect = call("/api/detect", {"path": "tests/images/case_a.jpg", "conf": 0.25, "iou": 0.45}, timeout=240)
        stones = [s for s in detect.get("stones", []) if s.get("cls") == 1]
        assert stones, "端口二检测未得到矸石"
        report["health"]["yolo_ready"] = True
        report["checks"].append({"name": "端口二图像识别", "ok": True,
                                 "detail": f"{detect.get('total')} 个目标 / {len(stones)} 块矸石"})
        up = upload_detect(conf="undefined")
        assert up.get("ok") and up.get("gangue_count", 0) > 0, "图片 multipart 上传失败（conf=undefined）"
        report["checks"].append({"name": "端口一/二图片上传（多格式入口）", "ok": True,
                                 "detail": f"multipart conf=undefined 兜底成功；{up.get('total')} 个目标 / {up.get('gangue_count')} 块矸石"})

        sample = samples[0]
        for i, s in enumerate(stones):
            s["inputs"] = samples[i % len(samples)]["inputs"]
            s["meta"] = {k: samples[i % len(samples)].get(k) for k in
                         ("province", "city", "coalfield", "source_type", "color", "petrology")}
        pred = call("/api/predict", {"stones": stones, "inputs": sample["inputs"],
                                     "area": {"province": "山西", "city": "太原市", "coalfield": "西山煤田"}},
                    timeout=120)
        assert pred.get("ok") and len(pred.get("rows", [])) == len(stones), "端口二预测行数不匹配"
        report["checks"].append({"name": "端口二四氧化物预测", "ok": True,
                                 "detail": f"{len(pred.get('rows', []))} 行；SiO2 R2={pred.get('rows', [{}])[0].get('pred', {}).get('SiO2', {}).get('r2')}"})

        rec = call("/api/recommend", {"stones": pred["rows"], "inputs": sample["inputs"], "use_llm": False,
                                      "area": {"province": "山西", "city": "太原市", "coalfield": "西山煤田"}},
                   timeout=120)
        assert rec.get("ok") and all(r.get("primary", {}).get("route_code", "").startswith("R") for r in rec.get("stones", []))
        report["checks"].append({"name": "端口二 R01~R12 推荐", "ok": True,
                                 "detail": [r["primary"]["route_code"] for r in rec.get("stones", [])]})

        tpl = call("/api/precision/template")
        assert len(tpl.get("routes", [])) >= 12, "端口一路线不足"
        assert len(tpl.get("demo_images", [])) >= 3, "端口一默认测试图不足"
        ps = tpl["samples"][0]
        xkeys = ["kaolinite", "quartz", "illite", "chlorite", "calcite", "pyrite"]
        body = {"chemical": ps["inputs"], "industrial": ps["inputs"], "xrd": {k: ps["inputs"].get(k) for k in xkeys},
                "environment": {}, "meta": ps["meta"],
                "requirements": {"port": "precision", "priority": "balanced", "sulfur_control": False,
                                 "fine_grinding": False, "desired_route": ""}}
        pr = call("/api/precision/recommend", body, timeout=120)
        p = pr.get("primary", {})
        assert p.get("route_code", "").startswith("R") and p.get("process_chain"), "端口一未返回完整方案"
        report["checks"].append({"name": "端口一默认测试图", "ok": True,
                                 "detail": [x.get("name") for x in tpl.get("demo_images", [])]})
        report["checks"].append({"name": "端口一精准匹配", "ok": True,
                                 "detail": f"{p.get('route_code')} · {p.get('name')} · {len(p.get('process_chain', []))} 工序 · {len(pr.get('risks', []))} 风险"})

        batch_body = {"thinking_seconds": 0.1, "use_llm": False, "stones": [
            {"id": "S01", "chemical": body["chemical"], "industrial": body["industrial"],
             "xrd": body["xrd"], "environment": {}, "meta": body["meta"],
             "requirements": body["requirements"]}
        ]}
        bt = call("/api/precision/batch", batch_body, timeout=120)
        assert bt.get("ok") and bt.get("results") and bt["results"][0].get("primary", {}).get("process_chain"), "端口一批量方案失败"
        report["checks"].append({"name": "端口一逐石批量方案", "ok": True,
                                 "detail": f"{len(bt['results'])} 份；{bt['results'][0]['primary']['route_code']}；{len(bt['results'][0]['primary']['process_chain'])} 工序"})

        # Hard risk rule checks: high sulfur should be intercepted.
        risky = dict(body)
        risky["chemical"] = dict(ps["inputs"]); risky["chemical"]["SO3"] = 11.55
        risky["industrial"] = dict(ps["inputs"]); risky["industrial"]["St"] = 4.62
        risky["xrd"] = {k: ps["inputs"].get(k) for k in xkeys}
        rr = call("/api/precision/recommend", risky, timeout=120)
        assert any(x.get("id") == "SULFUR_ACID" for x in rr.get("risks", [])), "高硫未触发风险规则"
        report["checks"].append({"name": "高硫强酸性拦截", "ok": True,
                                 "detail": f"已触发；主推 {rr['primary']['route_code']}；blocked={[b['route_code'] for b in rr.get('blocked', [])]}"})
        report["ok"] = True
    except Exception as exc:
        report["error"] = str(exc)
    print(json.dumps(report, ensure_ascii=False, indent=2))
    out = ROOT / "outputs" / "verify_ports.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
