# -*- coding: utf-8 -*-
"""app.py —— 煤矸石「图像识别 → 成分预测 → 工艺推荐」三步式演示系统

技术栈：Flask + Ultralytics YOLOv8 + scikit-learn + 智谱 GLM（可选）

启动：
    python app.py                  # http://127.0.0.1:7880
    python app.py --port 7881

目录：
    models/   YOLO 权重、四个氧化物模型、指标与输入 schema
    data/     261 行建模数据（只读，供复训）
    kb/       工艺知识库 + 山西矿区清单（可增补）
    static/   前端页面
    outputs/  上传图与标注结果图
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import subprocess
import threading
import time
import traceback
import uuid
import webbrowser
from pathlib import Path
from typing import Dict, List, Optional, Tuple

import numpy as np
import pandas as pd
from PIL import Image, ImageDraw, ImageFont
from flask import Flask, jsonify, request, send_from_directory, render_template

ROOT = Path(__file__).resolve().parent
MODELS = ROOT / "models"
MODELS_V2 = ROOT / "models_v2"
KB_DIR = ROOT / "kb"
OUT = ROOT / "outputs"
UPLOADS = OUT / "uploads"
ANNOTATED = OUT / "annotated"
TESTS = ROOT / "tests"
for d in (OUT, UPLOADS, ANNOTATED, TESTS / "images"):
    d.mkdir(parents=True, exist_ok=True)

YOLO_PATH = MODELS / "yolo_coal_gangue.pt"
CONF_STATS_PATH = MODELS / "conf_stats.json"
METRICS_PATH = MODELS / "metrics.json"
SCHEMA_PATH = MODELS / "input_schema.json"
DATA_DIR = ROOT / "data"
DEMO_PATH = DATA_DIR / "demo_sample.json"
DEMO_SAMPLES_PATH = DATA_DIR / "demo_samples.json"
AREAS_PATH = KB_DIR / "mining_areas.json"
PROCESS_KB_PATH = KB_DIR / "process_kb.json"
PROCESS_KB_V3_PATH = KB_DIR / "process_kb_v3.json"
DEMO_SAMPLES_V2_PATH = DATA_DIR / "demo_samples_v2.json"
V2_DATA_PATH = DATA_DIR / "新数据库_635.xlsx"
CONFIG_PATH = ROOT / "config.json"

from kb_engine_v3 import recommend as kb_recommend, load_kb as load_kb_v3, ratios as kb_ratios

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 32 * 1024 * 1024
app.json.ensure_ascii = False

CN_LABELS = ["煤块", "矸石", "其他杂石"]
RGB_COLORS = [(34, 197, 94), (239, 68, 68), (59, 130, 246)]
HEX_COLORS = ["#22c55e", "#ef4444", "#3b82f6"]
ROCK_CLS, MISC_CLS = 1, 2
DEFAULT_ROCK_LOW_CONF = 0.70

EDGES = {"L": [0.404, 0.460, 0.514], "G": [0.005, 0.025],
         "T": [0.042, 0.060], "S": [1.20, 1.55],
         "D": [4.3, 7.5, 11.0]}
LETTER = {"L": ["L1", "L2", "L3", "L4"], "G": ["G0", "G1", "G2"],
          "T": ["T1", "T2", "T3"], "S": ["S1", "S2", "S3"],
          "D": ["D1", "D2", "D3", "D4"]}
FEATURE_NAMES = {
    "L": ["L1 深黑", "L2 深灰", "L3 灰", "L4 浅灰/白矸"],
    "G": ["G0 土状", "G1 弱光泽", "G2 明显光泽"],
    "T": ["T1 细腻", "T2 中等", "T3 粗糙"],
    "S": ["S1 近等轴", "S2 次棱角", "S3 片状长条"],
    "D": ["D1 细小", "D2 中粒", "D3 粗粒", "D4 大块"],
}
FEATURE_TIPS = {
    "L": "框内灰度均值。深黑偏炭质，浅灰偏白矸；现场煤粉/照度会干扰，只作参考。",
    "G": "高光像素占比。煤的镜煤光泽强、矸石多土状光泽，抗照度干扰能力较好。",
    "T": "灰度梯度均值。泥质/致密矸石细腻，砂质/棱面矸石粗糙；模糊图会失真。",
    "S": "框长边/短边。片状对应层理发育的页岩类，块状对应砂岩/灰岩。",
    "D": "框面积占全图百分比。硬岩破碎后仍偏大块；决定破碎解离与利用途径。",
}

app_state: Dict = {"model": None, "device": "cpu", "models": {}, "ready": False,
                   "yolo_error": None, "cases_v2": None}
_YOLO_LOCK = threading.Lock()


# ---------------------------------------------------------------------------
# 基础工具
# ---------------------------------------------------------------------------
def load_json(path: Path, default=None):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def save_json(path: Path, data) -> None:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def conf_stats() -> Dict:
    return load_json(CONF_STATS_PATH, {}) or {}


def rock_low_conf() -> float:
    return float(conf_stats().get("threshold_rock", DEFAULT_ROCK_LOW_CONF))


def to_code(key: str, v: float) -> int:
    c = 0
    for e in EDGES[key]:
        if v > e:
            c += 1
        else:
            break
    return c


def _load_font(size: int = 18):
    for p in [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\msyhbd.ttc",
              r"C:\Windows\Fonts\simhei.ttf", r"C:\Windows\Fonts\simsun.ttc"]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


FONT = _load_font(18)
FONT_SMALL = _load_font(15)


# ---------------------------------------------------------------------------
# 图像质量 + 五特征
# ---------------------------------------------------------------------------
def image_quality(rgb: np.ndarray) -> Dict:
    """清晰度（梯度能量）、噪声 σ、光照均匀度、饱和度、过曝/欠曝比例。"""
    g = rgb.astype(np.float32).mean(2) / 255.0
    gy, gx = np.gradient(g)
    sharp = float(np.mean(gx ** 2 + gy ** 2))

    lap = (np.roll(g, 1, 0) + np.roll(g, -1, 0) + np.roll(g, 1, 1) +
           np.roll(g, -1, 1) - 4 * g)[2:-2, 2:-2]
    med = np.median(lap)
    noise = float(1.4826 * np.median(np.abs(lap - med)) / np.sqrt(6.0))

    h, w = g.shape
    bh, bw = max(1, h // 8), max(1, w // 8)
    blocks = [g[i * bh:(i + 1) * bh, j * bw:(j + 1) * bw].mean()
              for i in range(8) for j in range(8)]
    blocks = np.asarray(blocks)
    uniformity = float(np.clip(1.0 - blocks.std() / (blocks.mean() + 1e-6), 0, 1))

    mx, mn = rgb.max(2).astype(np.float32), rgb.min(2).astype(np.float32)
    sat = float(np.mean((mx - mn) / (mx + 1e-6)))
    over = float(np.mean(g > 0.98))
    under = float(np.mean(g < 0.02))

    if sharp >= 0.0012:
        sharp_level, sharp_note = "清晰", "纹理特征可用"
    elif sharp >= 0.0006:
        sharp_level, sharp_note = "一般", "纹理特征略失真，建议补拍"
    else:
        sharp_level, sharp_note = "偏模糊", "纹理/形状特征仅供参考"

    if noise <= 0.012:
        noise_level = "低"
    elif noise <= 0.028:
        noise_level = "中"
    else:
        noise_level = "高"

    return {
        "sharpness": round(sharp, 5),
        "sharpness_level": sharp_level,
        "sharpness_note": sharp_note,
        "noise": round(noise, 4),
        "noise_level": noise_level,
        "uniformity": round(uniformity, 3),
        "uniformity_level": "均匀" if uniformity >= 0.75 else ("一般" if uniformity >= 0.55 else "不均"),
        "saturation": round(sat, 4),
        "color_usable": bool(sat > 0.12),
        "overexposed": round(over, 4),
        "underexposed": round(under, 4),
    }


def compute_features(gray: np.ndarray, W: int, H: int, x1: float, y1: float,
                     x2: float, y2: float) -> Dict:
    x1, y1 = max(0, int(round(x1))), max(0, int(round(y1)))
    x2, y2 = min(W, int(round(x2))), min(H, int(round(y2)))
    pw, ph = max(1, x2 - x1), max(1, y2 - y1)
    crop = gray[y1:y2, x1:x2]
    if crop.size < 9:
        crop = np.zeros((4, 4), dtype=np.float32)
    fL = float(crop.mean())
    fG = float(np.mean(crop > 0.85))
    fT = float(np.mean(np.abs(np.diff(crop, axis=0))) + np.mean(np.abs(np.diff(crop, axis=1))))
    fS = float(max(pw, ph) / max(1e-6, min(pw, ph)))
    fD = float((pw * ph) / float(W * H) * 100.0)
    vals = {"L": fL, "G": fG, "T": fT, "S": fS, "D": fD}
    out = {}
    for k, v in vals.items():
        c = to_code(k, v)
        out[k] = {"value": round(v, 4), "code": LETTER[k][c], "name": FEATURE_NAMES[k][c],
                  "tip": FEATURE_TIPS[k]}
    return out


def annotate(rgb: np.ndarray, stones: List[Dict]) -> Image.Image:
    img = Image.fromarray(rgb).convert("RGB")
    draw = ImageDraw.Draw(img)
    for s in stones:
        x1, y1, x2, y2 = s["box"]
        color = HEX_COLORS[s["cls"]]
        draw.rectangle([x1, y1, x2, y2], outline=color, width=3)
        label = f'{s["id"]} {s["cls_name"]} {s["conf"]:.2f}'
        tb = draw.textbbox((0, 0), label, font=FONT)
        tw, th = tb[2] - tb[0], tb[3] - tb[1]
        ty = max(0, y1 - th - 8)
        draw.rectangle([x1, ty, x1 + tw + 12, ty + th + 8], fill=color)
        draw.text((x1 + 6, ty + 4), label, fill=(255, 255, 255), font=FONT)
    return img


# ---------------------------------------------------------------------------
# 模型加载
# ---------------------------------------------------------------------------
def load_cases_v2() -> List[Dict]:
    if not V2_DATA_PATH.exists():
        return []
    d = pd.read_excel(V2_DATA_PATH, sheet_name="煤矸石全量数据库_标准输入总表",
                      header=3, skiprows=[4])
    rename = {"SiO2_wt%": "SiO2", "Al2O3_wt%": "Al2O3", "Fe2O3_wt%": "Fe2O3", "CaO_wt%": "CaO",
              "MgO_wt%": "MgO", "TiO2_wt%": "TiO2", "K2O_wt%": "K2O", "Na2O_wt%": "Na2O",
              "SO3_wt%": "SO3", "烧失量LOI_wt%": "LOI", "全硫St_wt%": "St",
              "发热量Qnet_MJ_kg": "Qnet", "灰分A_wt%": "ash", "挥发分V_wt%": "volatile",
              "固定碳FC_wt%": "FC", "高岭石_wt%": "kaolinite", "石英_wt%": "quartz",
              "伊利石与云母_wt%": "illite", "绿泥石与蒙脱石_wt%": "chlorite",
              "方解石与白云石_wt%": "calcite", "黄铁矿与菱铁矿_wt%": "pyrite"}
    rows = []
    for _, r in d.iterrows():
        rec = {k: _num(r.get(src)) for src, k in rename.items()}
        if any(rec.get(k) is None for k in ("SiO2", "Al2O3", "Fe2O3", "CaO")):
            continue
        row = {
            "sample_id": str(r.get("样品原始代号") or ""),
            "city": str(r.get("城市") or ""), "province": str(r.get("省份") or ""),
            "coalfield": str(r.get("所属煤田或聚煤区") or ""),
            "source_type": str(r.get("样品原始状态分类") or ""),
            "color": str(r.get("外观颜色分类") or ""),
            "petrology": str(r.get("岩石学与矿物类型") or ""),
            "route_code": str(r.get("12大标准组合处理工艺路线编码") or ""),
            "route_name": str(r.get("12大标准组合处理工艺路线名称") or ""),
            "doi": str(r.get("DOI或文献标准号") or ""),
            "strength_28d": _num(r.get("抗压强度_28d_MPa")),
            "activity_28d": _num(r.get("28d活性指数或保持率_%")),
            "carbon_reduction": _num(r.get("碳减排潜力_kgCO2_t")),
            **rec,
        }
        rows.append(row)
    return rows


def load_models() -> None:
    import joblib

    use_v2 = (MODELS_V2 / "sio2_model.joblib").exists()
    base = MODELS_V2 if use_v2 else MODELS
    app_state["models"] = {
        "SiO2": joblib.load(base / "sio2_model.joblib"),
        "Al2O3": joblib.load(base / "al2o3_model.joblib"),
        "Fe2O3": joblib.load(base / "fe2o3_model.joblib"),
        "CaO": joblib.load(base / "cao_model.joblib"),
    }
    if not use_v2:
        xrd_path = MODELS / "al2o3_xrd_model.joblib"
        if xrd_path.exists():
            app_state["models"]["Al2O3_xrd"] = joblib.load(xrd_path)
    app_state["metrics"] = load_json(base / "metrics.json", {})
    app_state["schema"] = load_json(base / "input_schema.json", [])
    app_state["model_source"] = "models_v2" if use_v2 else "models"
    # full 635-record table for precision-port case retrieval
    try:
        app_state["cases_v2"] = load_cases_v2()
    except Exception:
        app_state["cases_v2"] = None
        traceback.print_exc()
    app_state["ready"] = True


def get_yolo():
    if app_state["model"] is not None:
        return app_state["model"]
    with _YOLO_LOCK:
        if app_state["model"] is not None:
            return app_state["model"]
        if app_state["yolo_error"]:
            raise RuntimeError(app_state["yolo_error"])
        try:
            import torch
            from ultralytics import YOLO

            device = "0" if torch.cuda.is_available() else "cpu"
            app_state["device"] = device
            print(f"[INFO] 加载 YOLO：{YOLO_PATH}（device={device}）")
            m = YOLO(str(YOLO_PATH))
            m.predict(np.zeros((640, 640, 3), dtype=np.uint8), device=device, verbose=False)
            app_state["model"] = m
            print("[INFO] YOLO 就绪")
            return m
        except Exception as exc:
            app_state["yolo_error"] = f"YOLO 加载失败：{exc}"
            raise


# ---------------------------------------------------------------------------
# 检测
# ---------------------------------------------------------------------------
def run_detect(pil_img: Image.Image, conf_th: float = 0.25, iou_th: float = 0.45) -> Dict:
    model = get_yolo()
    rgb = np.asarray(pil_img.convert("RGB"))
    H, W = rgb.shape[:2]
    gray = rgb.astype(np.float32).mean(2) / 255.0
    with _YOLO_LOCK:
        results = model.predict(pil_img, conf=conf_th, iou=iou_th, imgsz=640,
                                device=app_state["device"], verbose=False)
    boxes = results[0].boxes if results else None
    raw = []
    if boxes is not None and len(boxes) > 0:
        xyxy = boxes.xyxy.cpu().numpy()
        confs = boxes.conf.cpu().numpy()
        clses = boxes.cls.cpu().numpy().astype(int)
        order = np.argsort(xyxy[:, 1] + 0.15 * xyxy[:, 0])
        for k in order:
            x1, y1, x2, y2 = [float(v) for v in xyxy[k]]
            c = int(clses[k])
            raw.append({"cls": c, "conf": float(confs[k]), "box": [x1, y1, x2, y2],
                        "cx": (x1 + x2) / 2, "cy": (y1 + y2) / 2})

    stats = conf_stats()
    std_by_cls = {
        0: float(stats.get("coal_tp", {}).get("std", 0.09)),
        1: float(stats.get("rock_tp", {}).get("std", 0.033)),
        2: float(stats.get("rock_fp", {}).get("std", 0.30)),
    }
    low = rock_low_conf()
    stones: List[Dict] = []
    for i, r in enumerate(raw):
        c = r["cls"]
        conf = r["conf"]
        if c == ROCK_CLS and conf < low:
            c = MISC_CLS
            reason = f"矸石置信度 {conf:.2f} < {low:.2f}，归为其他杂石"
        elif c == MISC_CLS:
            reason = "置信度不足，归为其他杂石"
        else:
            reason = ""
        half = 1.645 * std_by_cls.get(c, 0.05)
        feat = compute_features(gray, W, H, *r["box"])
        stones.append({
            "id": f"S{i + 1:02d}",
            "cls": c,
            "cls_name": CN_LABELS[c],
            "color": HEX_COLORS[c],
            "conf": round(conf, 3),
            "conf_lo": round(max(0.0, conf - half), 3),
            "conf_hi": round(min(1.0, conf + half), 3),
            "box": [round(v, 1) for v in r["box"]],
            "area_pct": feat["D"]["value"],
            "feature": feat,
            "included": bool(c != MISC_CLS),
            "excluded_reason": reason,
        })

    annotated = annotate(rgb, stones)
    name = f"det_{int(time.time())}_{uuid.uuid4().hex[:6]}.jpg"
    annotated.save(ANNOTATED / name, quality=92)

    counts = {CN_LABELS[i]: 0 for i in range(3)}
    for s in stones:
        counts[s["cls_name"]] += 1
    gangue_n = sum(1 for s in stones if s["cls"] == ROCK_CLS)
    return {
        "ok": True,
        "image_url": f"/outputs/annotated/{name}",
        "width": W, "height": H,
        "stones": stones,
        "counts": counts,
        "total": len(stones),
        "gangue_count": gangue_n,
        "excluded_count": counts["其他杂石"],
        "quality": image_quality(rgb),
        "rule": f"矸石置信度 < {low:.2f} → 其他杂石（不纳入后续预测）",
        "conf_std": std_by_cls,
        "device": "GPU" if app_state["device"] != "cpu" else "CPU",
    }


# ---------------------------------------------------------------------------
# 成分预测
# ---------------------------------------------------------------------------
def _num(v) -> Optional[float]:
    if v is None or v == "":
        return None
    try:
        return float(v)
    except Exception:
        return None


def _float_or(v, default: float) -> float:
    try:
        x = float(v)
        return x if np.isfinite(x) else float(default)
    except Exception:
        return float(default)


CITY_ALIAS = {
    "太原": "太原市", "晋中": "晋中市", "晋城": "晋城市", "长治": "长治市",
    "大同": "大同市", "朔州": "朔州市", "运城": "运城市", "临汾": "临汾市",
    "吕梁": "吕梁市", "阳泉": "阳泉市", "忻州": "忻州市",
}


def _pick(inputs: Dict, *keys):
    for k in keys:
        if k in inputs and inputs.get(k) not in (None, ""):
            return _num(inputs.get(k))
    return None


def _city_name(city: str) -> str:
    city = str(city or "").strip()
    if not city or city == "缺失":
        return "缺失"
    return CITY_ALIAS.get(city, city if city.endswith("市") else city + "市")


def _source_name(source_type: str, stage: str = "") -> str:
    s = f"{source_type or ''} {stage or ''}"
    if "洗" in s:
        return "洗选煤矸石(WASHED)"
    if "自燃" in s:
        return "自燃煤矸石(BURNT)"
    if "煅烧" in s or "改性" in s:
        return "实验室煅烧或改性矸(MODIFIED)"
    if "风化" in s:
        return "风化陈化矸石(WEATHERED)"
    return "新鲜原矸(RAW)"


def build_row(inputs: Dict, area: Dict, source_type: str, stage: str,
              meta: Optional[Dict] = None) -> Dict:
    """Map the UI model into the columns used by the 2026-11 v2 models."""
    meta = meta or {}
    area = area or {}
    row = {
        "LOI": _pick(inputs, "LOI", "LOI烧失量", "烧失量LOI_wt%"),
        "K2O": _pick(inputs, "K2O", "K2O_wt%"),
        "MgO": _pick(inputs, "MgO", "MgO_wt%"),
        "Na2O": _pick(inputs, "Na2O", "Na2O_wt%"),
        "TiO2": _pick(inputs, "TiO2", "TiO2_wt%"),
        "SO3": _pick(inputs, "SO3", "SO3_wt%"),
        "ash": _pick(inputs, "ash", "灰分A_wt%", "灰分"),
        "volatile": _pick(inputs, "volatile", "挥发分V_wt%", "挥发分"),
        "FC": _pick(inputs, "FC", "固定碳FC_wt%", "固定碳"),
        "St": _pick(inputs, "St", "全硫St_wt%", "全硫"),
        "Qnet": _pick(inputs, "Qnet", "发热量Qnet_MJ_kg", "发热量"),
        "kaolinite": _pick(inputs, "kaolinite", "高岭石_wt%", "高岭石"),
        "quartz": _pick(inputs, "quartz", "石英_wt%", "石英"),
        "illite": _pick(inputs, "illite", "伊利石与云母_wt%", "伊利石"),
        "chlorite": _pick(inputs, "chlorite", "绿泥石与蒙脱石_wt%"),
        "calcite": _pick(inputs, "calcite", "方解石与白云石_wt%"),
        "pyrite": _pick(inputs, "pyrite", "黄铁矿与菱铁矿_wt%"),
        "P2O5": _pick(inputs, "P2O5", "P2O5_MnO等其他_wt%"),
        "province": meta.get("province") or area.get("province") or "山西",
        "city": _city_name(meta.get("city") or area.get("city") or "晋中"),
        "coalfield": meta.get("coalfield") or area.get("coalfield") or "缺失",
        "source_type": meta.get("source_type") or _source_name(source_type, stage),
        "color": meta.get("color") or "缺失",
        "petrology": meta.get("petrology") or "缺失",
    }
    vals = [row.get(k) for k in ("LOI", "K2O", "MgO", "Na2O", "TiO2", "SO3")]
    row["_den"] = float(sum(v for v in vals if v is not None)) if any(v is not None for v in vals) else np.nan
    row["_codes"] = meta.get("codes") or []
    return row


def _predict_artifact(m: Dict, df: pd.DataFrame) -> float:
    for feat in m.get("features", []) + m.get("cat_feats", []):
        if feat not in df.columns:
            df[feat] = np.nan
    if "models" in m:
        val = 0.0
        for kind, weight in (m.get("weights") or {}).items():
            if float(weight) <= 0:
                continue
            val += float(weight) * float(m["models"][kind].predict(df)[0])
        return val
    return float(m["pipeline"].predict(df)[0])


def predict_values(row: Dict) -> Dict:
    df = pd.DataFrame([row])
    models = app_state["models"]
    metrics = app_state.get("metrics", {})
    out = {}
    for t in ["SiO2", "Al2O3", "Fe2O3", "CaO"]:
        mt = metrics.get(t, {})
        conditional = False
        # legacy fallback: old Al2O3 XRD conditional model
        if (t == "Al2O3" and "Al2O3_xrd" in models
                and (_num(row.get("kaolinite")) or _num(row.get("高岭石")) or 0) > 0):
            m = models["Al2O3_xrd"]
            mt = metrics.get("Al2O3_xrd", mt)
            conditional = True
        else:
            m = models[t]
        try:
            val = _predict_artifact(m, df)
        except Exception:
            val = float("nan")
        if conditional:
            kaol = _num(row.get("kaolinite")) or _num(row.get("高岭石")) or 0.0
            ill = _num(row.get("illite")) or _num(row.get("伊利石")) or 0.0
            ub = (kaol * 0.395 + ill * 0.30) * 1.8 + 8.0
            val = min(val, ub)
        val = float(np.clip(val, 0, 100))
        dom = (m.get("domain") or {}).get(t)
        domain_ok = True
        if dom:
            domain_ok = bool(dom[0] <= val <= dom[1])
        out[t] = {
            "value": round(val, 2),
            "r2": mt.get("R2_mean"),
            "rmse": mt.get("RMSE_mean"),
            "mae": mt.get("MAE_mean"),
            "model": mt.get("model"),
            "conditional": conditional,
            "coverage": mt.get("coverage"),
            "domain": dom,
            "domain_ok": domain_ok,
        }
    return out

def predict_for_stones(payload: Dict) -> Dict:
    default_inputs = payload.get("inputs") or {}
    area = payload.get("area") or {}
    source_type = payload.get("source_type") or "煤矸石"
    stage = payload.get("stage") or "RAW_OR_UNSPECIFIED_GANGUE"
    stones = payload.get("stones") or []
    quality = payload.get("quality") or {}

    def _inputs_for(s: Dict) -> Dict:
        raw = s.get("inputs")
        if isinstance(raw, dict) and raw:
            merged = dict(default_inputs)
            merged.update(raw)
            return merged
        return dict(default_inputs)

    sharp = float(quality.get("sharpness") or 0.0015)
    sharp_norm = float(np.clip(sharp / 0.002, 0, 1))
    low = rock_low_conf()
    rows = []

    rock_stones = [s for s in stones if s.get("cls") == ROCK_CLS]
    if not rock_stones:
        loi = _num(default_inputs.get("LOI")) if _num(default_inputs.get("LOI")) is not None else _num(default_inputs.get("LOI烧失量"))
        if loi is None:
            return {"ok": False, "error": "请至少填写 LOI 烧失量（马弗炉可测的必需指标）"}
        row = build_row(default_inputs, area, source_type, stage, meta=payload.get("meta"))
        base = predict_values(row)
        return {
            "ok": True,
            "area": area, "source_type": source_type, "stage": stage,
            "inputs": default_inputs,
            "den": round(float(row["_den"]), 2)
            if np.isfinite(row["_den"]) else None,
            "base": base, "rows": [],
            "metrics": app_state.get("metrics", {}),
            "note": "没有可参与预测的矸石；图像只用于识别与物理特征。",
        }

    for s in rock_stones:
        inputs = _inputs_for(s)
        loi = _num(inputs.get("LOI")) if _num(inputs.get("LOI")) is not None else _num(inputs.get("LOI烧失量"))
        if loi is None:
            return {"ok": False, "error": f"{s.get('id', '矸石')} 缺少 LOI 烧失量"}
        row = build_row(inputs, area, source_type, stage, meta=s.get("meta"))
        base = predict_values(row)
        conf = float(s.get("conf") or 0)
        conf_norm = float(np.clip((conf - low) / max(1e-6, 0.95 - low), 0, 1))
        factor = (0.90 + 0.50 * (1 - conf_norm)) * (1 + 0.30 * (1 - sharp_norm))
        preds = {}
        for t, info in base.items():
            rmse = float(info.get("rmse") or 5.0)
            half = 1.645 * rmse * factor
            preds[t] = {
                "value": info["value"],
                "lo": round(max(0.0, info["value"] - half), 2),
                "hi": round(min(100.0, info["value"] + half), 2),
                "r2": info.get("r2"),
                "rmse": info.get("rmse"),
                "mae": info.get("mae"),
                "conditional": info.get("conditional"),
            }
        rows.append({
            "id": s["id"], "cls_name": s.get("cls_name"), "conf": conf,
            "feature": s.get("feature"), "inputs": inputs, "meta": s.get("meta") or {},
            "den": round(float(row["_den"]), 2)
            if np.isfinite(row["_den"]) else None,
            "pred": preds, "base": base,
        })

    first = rows[0] if rows else None
    return {
        "ok": True,
        "area": area, "source_type": source_type, "stage": stage,
        "inputs": first["inputs"] if first else default_inputs,
        "den": first["den"] if first else None,
        "base": first["base"] if first else {},
        "rows": rows,
        "per_stone": True,
        "metrics": app_state.get("metrics", {}),
        "note": "每块矸石使用各自的现场指标独立预测，因此中心值和误差可以不同；"
                "图像只用于识别类别与物理特征，不用于反演化学成分。",
    }


# ---------------------------------------------------------------------------
# 知识库 + 推荐
# ---------------------------------------------------------------------------
def load_process_kb() -> List[Dict]:
    d = load_json(PROCESS_KB_V3_PATH, {}) or load_json(PROCESS_KB_PATH, {}) or {}
    return d.get("entries", [])


RATIO_LABELS = {
    "SI_AL": "SiO₂/Al₂O₃", "AL_SI": "Al₂O₃/SiO₂",
    "FE_AL": "Fe₂O₃/Al₂O₃", "CA_SI": "CaO/SiO₂",
    "FE_SI": "Fe₂O₃/SiO₂", "SO3_CA": "SO₃/CaO",
    "LOI_ASH": "LOI/(SiO₂+Al₂O₃)",
}
COND_LABELS = {
    "SiO2": "SiO₂", "Al2O3": "Al₂O₃", "Fe2O3": "Fe₂O₃",
    "CaO": "CaO", "MgO": "MgO", "TiO2": "TiO₂", "SO3": "SO₃",
    "LOI": "LOI", "K2O": "K₂O", "Na2O": "Na₂O", "ALK": "K₂O+Na₂O",
}


def composition_ratios(preds: Dict) -> Dict:
    """把成分换算成工艺判断常用的比值，缺失值按 0 处理。"""
    si = float(preds.get("SiO2") or 0.0)
    al = float(preds.get("Al2O3") or 0.0)
    fe = float(preds.get("Fe2O3") or 0.0)
    ca = float(preds.get("CaO") or 0.0)
    so3 = float(preds.get("SO3") or 0.0)
    loi = float(preds.get("LOI") or 0.0)
    return {
        "SI_AL": round(si / max(al, 0.01), 2),
        "AL_SI": round(al / max(si, 0.01), 2),
        "FE_AL": round(fe / max(al, 0.01), 2),
        "CA_SI": round(ca / max(si, 0.01), 2),
        "FE_SI": round(fe / max(si, 0.01), 2),
        "SO3_CA": round(so3 / max(ca, 0.01), 2),
        "LOI_ASH": round(loi / max(si + al, 0.01), 2),
        "ALK": round(float(preds.get("K2O") or 0.0) + float(preds.get("Na2O") or 0.0), 2),
    }


def dominant_regime(preds: Dict) -> str:
    """按主量成分给物料一个主导特征，避免宽区间条目“通吃”。"""
    si = float(preds.get("SiO2") or 0.0)
    al = float(preds.get("Al2O3") or 0.0)
    fe = float(preds.get("Fe2O3") or 0.0)
    ca = float(preds.get("CaO") or 0.0)
    so3 = float(preds.get("SO3") or 0.0)
    loi = float(preds.get("LOI") or 0.0)
    if loi >= 35 and loi / max(si + al, 1.0) >= 0.50:
        return "carbon"
    if al >= 32 and al / max(si, 1.0) >= 0.45:
        return "high_al"
    if fe >= 10:
        return "high_fe"
    if ca >= 12 or (ca >= 7 and so3 >= 4):
        return "calcareous"
    if si >= 60 and si / max(al, 1.0) >= 2.3:
        return "high_si"
    if 16 <= al <= 34 and 38 <= si <= 64:
        return "aluminosilicate"
    return "low_grade"


def score_entry(entry: Dict, preds: Dict, regime: str) -> Tuple[float, List[str]]:
    conds = dict(entry.get("conditions", {}))
    ratios = dict(entry.get("ratios", {}))
    allc = {**conds, **ratios}
    if not allc:
        return 0.0, []
    hits, total = 0.0, 0.0
    reasons = []
    for key, (lo, hi) in allc.items():
        v = preds.get(key)
        if v is None:
            continue
        weight = 1.2 if key in ratios else 1.0
        total += weight
        label = RATIO_LABELS.get(key) or COND_LABELS.get(key) or key
        if lo <= v <= hi:
            hits += weight
            if key in ratios:
                reasons.append(f"{label}={v:.2f} 在 {lo:g}~{hi:g}")
            else:
                reasons.append(f"{label}={v:.1f}% 在 {lo:g}~{hi:g}% 区间内")
        else:
            dist = (lo - v) if v < lo else (v - hi)
            span = max(1e-6, hi - lo)
            hits += max(0.0, 1.0 - dist / (0.6 * span + 1e-6)) * 0.35 * weight
    if total == 0:
        return 0.0, []
    score = hits / total

    # 定义性指标门控：如高铝提取看 Al/Si、燃料看 LOI/灰分，不命中大幅降权。
    gate_keys = entry.get("gate") or [next(iter(allc))]
    gate_failed = False
    for key in gate_keys:
        if key in allc and preds.get(key) is not None:
            lo, hi = allc[key]
            if not (lo <= preds[key] <= hi):
                gate_failed = True
                reasons.insert(0, f"门控 {RATIO_LABELS.get(key) or COND_LABELS.get(key) or key} 未命中")
                break
    if gate_failed:
        score *= 0.35

    allowed = entry.get("regime") or []
    if allowed:
        if regime in allowed:
            score += 0.05
            reasons.insert(0, f"主导特征={regime} 与工艺匹配")
        else:
            score *= 0.55
            reasons.insert(0, f"主导特征={regime} 与工艺不匹配")
    score += float(entry.get("bias") or 0.0)
    return max(0.0, min(score, 1.40)), reasons


def offline_recommend(stones: List[Dict], area: Dict, inputs: Dict) -> Dict:
    kb = load_process_kb()
    out = []
    for s in stones:
        stone_inputs = s.get("inputs") or inputs or {}
        preds = {k: v["value"] for k, v in (s.get("pred") or {}).items()}
        loi = _num(stone_inputs.get("LOI烧失量"))
        so3 = _num(stone_inputs.get("SO3"))
        k2o = _num(stone_inputs.get("K2O"))
        na2o = _num(stone_inputs.get("Na2O"))
        if loi is not None:
            preds["LOI"] = loi
        if so3 is not None:
            preds["SO3"] = so3
        if k2o is not None:
            preds["K2O"] = k2o
        if na2o is not None:
            preds["Na2O"] = na2o
        ratios = composition_ratios(preds)
        preds.update(ratios)
        regime = dominant_regime(preds)

        feat = s.get("feature") or {}
        codes = {(feat.get(k) or {}).get("code") for k in ("D", "L", "G", "T", "S")}
        scored = []
        for e in kb:
            sc, reasons = score_entry(e, preds, regime)
            bonus = sum(float(b) for code, b in (e.get("physical") or {}).items() if code in codes)
            bonus = min(bonus, 0.15)
            scored.append((sc + bonus, sc, e, reasons))
        scored.sort(key=lambda x: -x[0])
        top = [x for x in scored if x[1] >= 0.55][:3]
        if len(top) < 2:
            for x in scored:
                if x not in top and x[1] >= 0.30:
                    top.append(x)
                if len(top) >= 3:
                    break
        if not top:
            top = [x for x in scored if x[1] > 0.30][:3]
        if not top:
            top = [x for x in scored if x[2]["id"] == "aggregate_fill"] or scored[:1]
        primary = top[0]
        secondary = top[1:3]
        out.append({
            "id": s["id"],
            "regime": regime,
            "feature": s.get("feature") or {},
            "ratios": {k: ratios[k] for k in ("SI_AL", "CA_SI", "FE_AL", "LOI_ASH")},
            "primary": {
                "kb_id": primary[2]["id"], "name": primary[2]["name"],
                "why": "；".join(primary[3][:4]) or primary[2]["basis"],
                "basis": primary[2].get("basis", ""),
                "process": primary[2]["process"],
                "products": primary[2]["products"],
                "risk": primary[2]["risk"],
                "ref": primary[2]["ref"],
                "score": round(primary[0], 2),
            },
            "secondary": [{
                "kb_id": x[2]["id"], "name": x[2]["name"],
                "why": "；".join(x[3][:2]) or x[2].get("basis", ""),
                "score": round(x[0], 2),
            } for x in secondary],
            "confidence": "高" if primary[1] >= 0.75 else ("中" if primary[1] >= 0.50 else "低"),
        })
    return {
        "ok": True, "mode": "offline",
        "summary": f"离线知识库按成分区间 + 特征比值 + 物性档位匹配，共 {len(kb)} 条工艺；矿区：{area.get('name', '未选择')}。",
        "stones": out,
    }


def get_llm_config() -> Dict:
    cfg = load_json(CONFIG_PATH, {}) or {}
    key = cfg.get("api_key") or os.environ.get("GLM_API_KEY") or os.environ.get("ZHIPU_API_KEY") or ""
    base = cfg.get("base_url") or os.environ.get("GLM_BASE_URL") or "https://open.bigmodel.cn/api/paas/v4"
    model = cfg.get("model") or os.environ.get("GLM_MODEL") or "glm-4.5-flash"
    provider = cfg.get("provider") or "zhipu"
    base = base.rstrip("/")
    protocol = cfg.get("protocol") or ("anthropic" if "anthropic" in base else "openai")
    return {"api_key": key, "base_url": base, "model": model,
            "provider": provider, "protocol": protocol, "configured": bool(key)}


def _anthropic_url(base: str) -> str:
    b = base.rstrip("/")
    if b.endswith("/messages"):
        return b
    if b.endswith("/v1"):
        return b + "/messages"
    return b + "/v1/messages"


def call_anthropic(cfg: Dict, messages: List[Dict], timeout: int = 90) -> Dict:
    """Anthropic 协议适配（ZCode / BigModel / Z.ai 的 /anthropic 端点）。"""
    import requests

    system = "\n".join(m["content"] for m in messages if m.get("role") == "system")
    user_msgs = [{"role": m.get("role", "user"), "content": m.get("content", "")}
                 for m in messages if m.get("role") != "system"]
    url = _anthropic_url(cfg["base_url"])
    payload = {
        "model": cfg["model"],
        "max_tokens": 2048,
        "temperature": 0.3,
        "system": system,
        "messages": user_msgs or [{"role": "user", "content": "hi"}],
    }
    headers = {
        "x-api-key": cfg["api_key"],
        "Authorization": f"Bearer {cfg['api_key']}",
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
    }
    t0 = time.time()
    resp = requests.post(url, json=payload, headers=headers, timeout=timeout)
    dt = time.time() - t0
    if resp.status_code >= 400:
        raise RuntimeError(f"API {resp.status_code}: {resp.text[:400]}")
    data = resp.json()
    blocks = data.get("content") or []
    content = "".join(b.get("text", "") for b in blocks if b.get("type") == "text")
    usage = data.get("usage") or {}
    return {"content": content, "latency": round(dt, 2), "usage": usage,
            "protocol": "anthropic"}


def call_llm(cfg: Dict, messages: List[Dict], timeout: int = 90) -> Dict:
    if (cfg.get("protocol") or ("anthropic" if "anthropic" in cfg["base_url"] else "openai")) == "anthropic":
        return call_anthropic(cfg, messages, timeout)

    import requests

    url = cfg["base_url"] + "/chat/completions"
    payload = {
        "model": cfg["model"],
        "messages": messages,
        "temperature": 0.3,
        "stream": False,
        "response_format": {"type": "json_object"},
    }
    headers = {"Authorization": f"Bearer {cfg['api_key']}",
               "Content-Type": "application/json"}
    t0 = time.time()
    resp = None
    for attempt in range(2):
        resp = requests.post(url, json=payload, headers=headers, timeout=timeout)
        # 少数兼容端点不支持 response_format，去掉后重试一次
        if resp.status_code == 400 and attempt == 0 and "response_format" in resp.text:
            payload.pop("response_format", None)
            continue
        break
    dt = time.time() - t0
    if resp.status_code >= 400:
        detail = resp.text[:400]
        raise RuntimeError(f"API {resp.status_code}: {detail}")
    data = resp.json()
    content = data["choices"][0]["message"]["content"]
    usage = data.get("usage", {})
    return {"content": content, "latency": round(dt, 2), "usage": usage}


def build_messages(stones: List[Dict], area: Dict, inputs: Dict, kb: List[Dict],
                   quality: Dict) -> List[Dict]:
    compact_kb = [{"id": e["id"], "name": e["name"], "conditions": e["conditions"],
                   "ratios": e.get("ratios", {}), "regime": e.get("regime", []),
                   "process": e["process"], "basis": e.get("basis", ""), "risk": e["risk"]} for e in kb]
    stone_lines = []
    for s in stones:
        preds = {k: v["value"] for k, v in (s.get("pred") or {}).items()}
        si = s.get("inputs") or inputs or {}
        for k_src, k_dst in (("LOI烧失量", "LOI"), ("SO3", "SO3"), ("K2O", "K2O"), ("Na2O", "Na2O")):
            v = _num(si.get(k_src))
            if v is not None:
                preds[k_dst] = v
        ratios = composition_ratios(preds)
        preds.update(ratios)
        feat = s.get("feature") or {}
        fdesc = "，".join(f"{feat[k]['code']} {feat[k]['name']}" for k in ["L", "G", "T", "S", "D"]
                          if k in feat)
        stone_lines.append({
            "id": s["id"], "composition_wt%": {k: preds[k] for k in ("SiO2", "Al2O3", "Fe2O3", "CaO") if k in preds},
            "field_indicators": si,
            "composition_ratios": ratios,
            "dominant_regime": dominant_regime(preds),
            "physical_features": fdesc,
            "detection_conf": s.get("conf"),
        })
    system = (
        "你是煤矸石资源化利用工艺工程师。只依据用户给出的成分预测、矿区信息和知识库条目做判断，"
        "不得编造未给出的检测数据、标准号或经济指标。成分预测本身有误差（R² 见用户消息），"
        "结论要标注不确定性。输出必须是合法 JSON，不要 markdown 代码块。"
    )
    user = (
        f"【矿区】{json.dumps(area, ensure_ascii=False)}\n"
        f"【现场可测指标】{json.dumps(inputs, ensure_ascii=False)}\n"
        f"【图像质量】{json.dumps(quality, ensure_ascii=False)}\n"
        f"【待推荐矸石】{json.dumps(stone_lines, ensure_ascii=False)}\n"
        f"【知识库候选】{json.dumps(compact_kb, ensure_ascii=False)}\n\n"
        "请为每块矸石给出 1 个主推工艺 + 最多 2 个备选工艺。要求：\n"
        "1) 主推必须来自知识库（填 kb_id），理由必须引用该石头的具体成分数值；\n"
        "2) 物理特征（粒径大→骨料/充填，纹理细腻→陶瓷/高岭土）只能用于工艺可行性排序，"
        "禁止用图像特征推断化学成分；\n"
        "3) 若成分接近多个工艺边界，明确说明并给备选；\n"
        "4) 每块石头给出 risk（落地风险）与 confidence（高/中/低）；\n"
        "5) 输出 JSON：{\"summary\":\"一句话总览\",\"stones\":[{\"id\":\"S01\","
        "\"primary\":{\"kb_id\":\"\",\"name\":\"\",\"why\":\"\"},"
        "\"secondary\":[{\"kb_id\":\"\",\"name\":\"\",\"why\":\"\"}],"
        "\"products\":\"\",\"risk\":\"\",\"confidence\":\"高\"}]}"
    )
    return [{"role": "system", "content": system}, {"role": "user", "content": user}]


def _extract_json(text: str) -> Optional[Dict]:
    text = text.strip()
    text = re.sub(r"^```(?:json)?", "", text).strip()
    text = re.sub(r"```$", "", text).strip()
    try:
        return json.loads(text)
    except Exception:
        m = re.search(r"\{.*\}", text, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return None
    return None


def llm_recommend(stones: List[Dict], area: Dict, inputs: Dict, quality: Dict,
                  cfg: Dict) -> Dict:
    kb = load_process_kb()
    messages = build_messages(stones, area, inputs, kb, quality)
    res = call_llm(cfg, messages)
    data = _extract_json(res["content"])
    if not data or "stones" not in data:
        raise RuntimeError("模型返回内容无法解析为 JSON")
    by_id = {e["id"]: e for e in kb}
    out = []
    for item in data.get("stones", []):
        prim = item.get("primary") or {}
        kb_id = prim.get("kb_id") or prim.get("id") or ""
        e = by_id.get(kb_id, {})
        out.append({
            "id": item.get("id"),
            "primary": {
                "kb_id": kb_id, "name": prim.get("name") or e.get("name", ""),
                "why": prim.get("why", ""),
                "process": e.get("process", ""), "products": e.get("products", item.get("products", "")),
                "risk": item.get("risk") or e.get("risk", ""), "ref": e.get("ref", ""),
            },
            "secondary": [{
                "kb_id": x.get("kb_id", ""), "name": x.get("name", ""),
                "why": x.get("why", ""),
            } for x in (item.get("secondary") or [])][:2],
            "confidence": item.get("confidence", "中"),
        })
    return {
        "ok": True, "mode": "llm",
        "provider": cfg.get("provider"), "model": cfg.get("model"),
        "latency": res["latency"], "usage": res.get("usage", {}),
        "summary": data.get("summary", ""), "stones": out,
    }



# ---------------------------------------------------------------------------
# v3 双端口：R01~R12 知识库 + 端口一高精匹配
# ---------------------------------------------------------------------------
def _values_from_inputs(pred: Dict, inputs: Dict, feature: Dict = None) -> Dict:
    vals = {}
    for k, v in (pred or {}).items():
        if isinstance(v, dict):
            vals[k] = _num(v.get("value"))
        else:
            vals[k] = _num(v)
    aliases = {
        "LOI": ("LOI", "LOI烧失量", "烧失量LOI_wt%"),
        "St": ("St", "全硫St_wt%", "全硫"),
        "Qnet": ("Qnet", "发热量Qnet_MJ_kg", "发热量"),
        "SO3": ("SO3", "SO3_wt%"),
        "MgO": ("MgO", "MgO_wt%"),
        "TiO2": ("TiO2", "TiO2_wt%"),
        "K2O": ("K2O", "K2O_wt%"),
        "Na2O": ("Na2O", "Na2O_wt%"),
        "ash": ("ash", "灰分A_wt%", "灰分"),
        "volatile": ("volatile", "挥发分V_wt%", "挥发分"),
        "FC": ("FC", "固定碳FC_wt%", "固定碳"),
        "kaolinite": ("kaolinite", "高岭石_wt%", "高岭石"),
        "quartz": ("quartz", "石英_wt%", "石英"),
        "illite": ("illite", "伊利石与云母_wt%", "伊利石"),
        "chlorite": ("chlorite", "绿泥石与蒙脱石_wt%"),
        "calcite": ("calcite", "方解石与白云石_wt%"),
        "pyrite": ("pyrite", "黄铁矿与菱铁矿_wt%"),
        "P2O5": ("P2O5", "P2O5_MnO等其他_wt%"),
        "pH": ("pH", "浸出液pH值"),
        "heavy_metal": ("heavy_metal", "重金属浸出合规等级"),
        "radioactivity": ("radioactivity", "放射性核素分类"),
    }
    for target, keys in aliases.items():
        for k in keys:
            if k in (inputs or {}) and inputs.get(k) not in (None, ""):
                vals[target] = inputs.get(k) if target in ("heavy_metal", "radioactivity") else _num(inputs.get(k))
                break
    codes = []
    for k in ("D", "L", "G", "T", "S"):
        v = (feature or {}).get(k)
        if isinstance(v, dict) and v.get("code"):
            codes.append(v["code"])
    vals["_codes"] = codes
    return vals


def _shape_route(res: Dict, stone_id: str, feature: Dict = None, inputs: Dict = None) -> Dict:
    p = res.get("primary", {})
    p_out = {
        "name": p.get("route_name", ""), "route_code": p.get("route_code", ""),
        "category": p.get("category", ""), "score": p.get("score"),
        "why": "；".join(p.get("why", [])), "basis": p.get("basis", ""),
        "process": " → ".join(p.get("process_chain") or []),
        "process_chain": p.get("process_chain") or [], "parameters": p.get("parameters") or {},
        "products": p.get("products", ""), "risk": p.get("risk", ""),
        "ref": p.get("standard", ""), "standard": p.get("standard", ""),
        "requirements": p.get("requirements") or [],
        "confidence": p.get("confidence", "中"),
    }
    secondary = [{
        "name": x.get("route_name", ""), "route_code": x.get("route_code", ""),
        "why": "；".join(x.get("why", [])), "score": x.get("score"),
    } for x in (res.get("alternatives") or [])]
    return {
        "id": stone_id, "regime": res.get("regime", ""), "ratios": res.get("ratios", {}),
        "feature": feature or {}, "inputs": inputs or {},
        "primary": p_out, "secondary": secondary,
        "blocked": res.get("blocked", []), "risks": res.get("risks", []),
        "required_tests": res.get("required_tests", []),
        "confidence": p.get("confidence", "中"),
    }


def recommend_stones_v3(stones: List[Dict], area: Dict, inputs: Dict, requirements: Dict | None = None) -> Dict:
    req = dict(requirements or {})
    req.setdefault("port", "vision")
    out = []
    for s in stones:
        pred = s.get("pred") or {}
        vals = _values_from_inputs(pred, s.get("inputs") or inputs or {}, s.get("feature"))
        res = kb_recommend(vals, req)
        out.append(_shape_route(res, s.get("id", ""), s.get("feature"), s.get("inputs") or inputs))
    kb = load_kb_v3()
    return {
        "ok": True, "mode": "offline", "summary": f"按 R01~R12 知识库（{len(kb.get('entries', []))} 条路线）逐石匹配；先执行含硫/高钙/重金属等风险门控，再做成分-比值-物性打分。",
        "stones": out, "kb_version": kb.get("version", ""),
        "risk_rule_count": len(kb.get("risk_rules", [])),
    }


def find_similar_cases(values: Dict, route_code: str = "", k: int = 3) -> List[Dict]:
    rows = app_state.get("cases_v2") or []
    if not rows:
        return []
    fields = ["SiO2", "Al2O3", "Fe2O3", "CaO", "LOI", "SO3", "St", "Qnet"]
    import numpy as np
    arr = np.array([[r.get(f) if r.get(f) is not None else np.nan for f in fields] for r in rows], dtype=float)
    med = np.nanmedian(arr, axis=0)
    arr = np.where(np.isfinite(arr), arr, med)
    std = np.nanstd(arr, axis=0)
    std[std < 1e-9] = 1.0
    z = (arr - np.nanmean(arr, axis=0)) / std
    q = np.array([values.get(f) if values.get(f) is not None else med[i] for i, f in enumerate(fields)], dtype=float)
    qz = (q - np.nanmean(arr, axis=0)) / std
    weights = np.array([1.2, 1.2, 1.0, 1.0, 1.0, 0.8, 0.8, 0.5])
    d = np.sqrt((((z - qz) ** 2) * weights).sum(axis=1))
    order = np.argsort(d)
    picked = []
    for idx in order:
        r = rows[int(idx)]
        if route_code and r.get("route_code") != route_code and len(picked) < k:
            continue
        picked.append({
            "sample_id": r.get("sample_id"), "city": r.get("city"), "province": r.get("province"),
            "route_code": r.get("route_code"), "route_name": r.get("route_name"),
            "distance": round(float(d[int(idx)]), 3),
            "measured": {kk: r.get(kk) for kk in ("SiO2", "Al2O3", "Fe2O3", "CaO", "LOI", "SO3", "St", "Qnet")},
            "performance": {"strength_28d": r.get("strength_28d"), "activity_28d": r.get("activity_28d"),
                            "carbon_reduction": r.get("carbon_reduction")},
            "doi": r.get("doi", ""),
        })
        if len(picked) >= k:
            break
    return picked


def _json_safe(obj):
    """Replace NaN/Inf with None so the browser's JSON.parse accepts the payload."""
    if isinstance(obj, float):
        return obj if np.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    return obj


def _extract_json(text: str):
    t = (text or "").strip()
    if t.startswith("```"):
        t = re.sub(r"^```(?:json)?\s*", "", t)
        t = re.sub(r"\s*```$", "", t)
    try:
        return json.loads(t)
    except Exception:
        m = re.search(r"\{.*\}", t, re.S)
        if m:
            try:
                return json.loads(m.group(0))
            except Exception:
                return None
    return None


def llm_precision_plan(cfg: Dict, values: Dict, shaped: Dict, requirements: Dict) -> Dict:
    """Call GLM for a final plan only; deliberately exclude rationale/reasoning in the output schema."""
    p = shaped.get("primary", {})
    prompt = {
        "task": "根据已确定的煤矸石处理路线，输出可执行处理方案",
        "rules": [
            "只输出处理方案，不解释为什么选这条路线，不输出推理过程",
            "不得编造未给出的标准号、检测值或经济指标",
            "按给定路线和工序链组织，不要改路线",
        ],
        "route": {"code": p.get("route_code"), "name": p.get("name"), "standard": p.get("standard")},
        "process_chain": p.get("process_chain") or [],
        "parameters": p.get("parameters") or {},
        "product": p.get("products"),
        "route_requirements": p.get("requirements") or [],
        "risk_findings": [{"title": r.get("title"), "message": r.get("message")} for r in shaped.get("risks", [])],
        "indicators": values,
        "user_requirements": requirements,
        "output_schema": {
            "summary": "一句到两句方案概述（只写做什么）",
            "process_chain": ["八工序，按顺序"],
            "parameters": {"参数名": "参数值"},
            "quality_control": ["质量控制要点"],
            "risk_control": ["风险控制/环保措施"],
            "required_tests": ["必须补检项"],
        },
    }
    msg = [
        {"role": "system", "content": "你是煤矸石处理工艺工程师。严格按已确定路线输出 JSON；只写处理方案，不写原因、不写分析、不写推理。"},
        {"role": "user", "content": json.dumps(prompt, ensure_ascii=False)},
    ]
    res = call_llm(cfg, msg, timeout=90)
    obj = _extract_json(res.get("content", ""))
    if not isinstance(obj, dict):
        raise RuntimeError("模型返回不是合法 JSON")
    out = {}
    for k in ("summary", "process_chain", "parameters", "quality_control", "risk_control", "required_tests"):
        if k in obj:
            out[k] = obj[k]
    if not out.get("summary") and not out.get("process_chain"):
        raise RuntimeError("模型未返回方案字段")
    out["_model"] = cfg.get("model")
    out["_latency"] = res.get("latency")
    return out


def _precision_values(data: Dict) -> Dict:
    """Flatten the precision form; accepts chemical/industrial/xrd/environment or flat keys."""
    flat = {}
    for section in ("chemical", "industrial", "xrd", "environment", "inputs", "meta"):
        obj = data.get(section)
        if isinstance(obj, dict):
            flat.update(obj)
    flat.update({k: v for k, v in data.items() if not isinstance(v, (dict, list))})
    return _values_from_inputs(flat, flat)


# ---------------------------------------------------------------------------
# Flask 路由
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return send_from_directory(str(ROOT / "static"), "index.html")


@app.route("/outputs/<path:sub>")
def outputs(sub):
    return send_from_directory(str(OUT), sub)


@app.route("/tests/<path:sub>")
def tests_static(sub):
    return send_from_directory(str(TESTS), sub)


@app.route("/api/cases")
def api_cases():
    data = load_json(TESTS / "cases.json", {}) or {}
    cases = []
    for c in data.get("cases", []):
        img_rel = c.get("image", "")
        c = dict(c)
        c["image_url"] = "/tests/" + img_rel.lstrip("/")
        c["image_path"] = str(TESTS / img_rel)
        c["image_exists"] = (TESTS / img_rel).exists()
        cases.append(c)
    return jsonify({"ok": True, "note": data.get("note", ""), "cases": cases})


@app.route("/api/demo_samples")
def api_demo_samples():
    doc = load_json(DEMO_SAMPLES_V2_PATH, {}) or load_json(DEMO_SAMPLES_PATH, {}) or {}
    samples = doc.get("samples") or []
    if not samples:
        return jsonify({"ok": False, "error": "逐石示例文件缺失"}), 404
    areas = (load_json(AREAS_PATH, {}) or {}).get("areas", [])
    by_id = {a.get("id"): a for a in areas}
    out = []
    for s in samples:
        area = by_id.get(s.get("area_id"))
        if area is None:
            area = {
                "id": s.get("area_id") or "demo_area",
                "name": f"{s.get('city', '')}矿区" if s.get("city") else "示例矿区",
                "province": s.get("province", "山西"),
                "city": s.get("city", ""),
            }
        out.append({**s, "area": area})
    return jsonify({"ok": True, "note": doc.get("note", ""), "samples": out})


@app.route("/api/demo_sample")
def api_demo_sample():
    doc = load_json(DEMO_PATH, {}) or {}
    if not doc:
        return jsonify({"ok": False, "error": "示例样品文件缺失"}), 404
    areas = (load_json(AREAS_PATH, {}) or {}).get("areas", [])
    area = next((a for a in areas if a.get("id") == doc.get("area_id")), None)
    if area is None:
        area = {
            "id": doc.get("area_id") or "demo_area",
            "name": f"{doc.get('city', '')}矿区" if doc.get("city") else "示例矿区",
            "province": doc.get("province", "山西"),
            "city": doc.get("city", ""),
        }
    return jsonify({"ok": True, "sample": {**doc, "area": area}})


@app.route("/precision")
def precision_page():
    return send_from_directory(str(ROOT / "static"), "precision.html")


@app.route("/api/precision/template")
def api_precision_template():
    doc = load_json(DEMO_SAMPLES_V2_PATH, {}) or {}
    kb = load_kb_v3()
    samples = []
    for i, s in enumerate(doc.get("samples") or []):
        samples.append({
            "id": s.get("sample_id"), "label": f"{s.get('title','样品')} · {s.get('city','')}",
            "inputs": s.get("inputs") or {}, "measured": s.get("measured") or {},
            "route_code": s.get("route_code"), "route_name": s.get("route_name"),
            "quality": s.get("quality") or {},
            "meta": {k: s.get(k) for k in ("province", "city", "coalfield", "source_type", "color", "petrology")},
        })
    preferred = ["Shanxi-Jincheng-Jinju-CFB-CalorificModel", "Shanxi-Taiyuan-BMIA-BrickUpgrading",
                 "Shanxi-Shuozhou-ZhouMingkai-SizeActivity", "Shanxi-Jincheng-YangZhiqiang-NonClinker",
                 "Shanxi-Yuncheng-GuoWenchao-AluminaExtraction"]
    samples.sort(key=lambda x: preferred.index(x["id"]) if x["id"] in preferred else 99)
    cfg = get_llm_config()
    return jsonify({"ok": True, "samples": samples, "routes": kb.get("entries", []),
                    "risk_rules": kb.get("risk_rules", []), "version": kb.get("version", ""),
                    "metrics": app_state.get("metrics", {}),
                    "llm": {"configured": cfg.get("configured", False), "model": cfg.get("model"),
                            "base_url": cfg.get("base_url"), "provider": cfg.get("provider")}})


@app.route("/api/precision/batch", methods=["POST"])
def api_precision_batch():
    data = request.get_json(force=True, silent=True) or {}
    stones = data.get("stones") or []
    if not stones:
        return jsonify({"ok": False, "error": "没有可生成方案的实验报告"}), 400
    try:
        sec = data.get("thinking_seconds", 2)
        try:
            sec = min(5.0, max(0.0, float(sec)))
        except Exception:
            sec = 2.0
        if sec:
            time.sleep(sec)
        cfg = get_llm_config()
        override = data.get("llm") or {}
        if override.get("api_key"):
            cfg["api_key"] = override["api_key"].strip()
            cfg["configured"] = True
        if override.get("base_url"):
            cfg["base_url"] = override["base_url"].rstrip("/")
        if override.get("model"):
            cfg["model"] = override["model"]
        use_llm = bool(data.get("use_llm", True)) and bool(cfg.get("configured"))
        results = []
        for i, item in enumerate(stones):
            values = _precision_values(item)
            codes = []
            for k in ("D", "L", "G", "T", "S"):
                fk = (item.get("feature") or {}).get(k)
                if isinstance(fk, dict) and fk.get("code"):
                    codes.append(fk["code"])
            values["_codes"] = codes
            req = dict(item.get("requirements") or {})
            req["port"] = "precision"
            route = kb_recommend(values, req)
            shaped = _shape_route(route, item.get("id") or f"P{i+1:02d}", item.get("feature"), values)
            shaped["similar_cases"] = find_similar_cases(values, shaped["primary"].get("route_code", ""), 3)
            shaped["values"] = {k: v for k, v in values.items() if k != "_codes"}
            shaped["requirements_echo"] = req
            # 端口一只给方案，不回传“为什么选它”的理由/机理字段
            shaped.get("primary", {}).pop("why", None)
            shaped.get("primary", {}).pop("basis", None)
            for alt in shaped.get("secondary", []):
                alt.pop("why", None)
            if use_llm:
                try:
                    shaped["llm_plan"] = llm_precision_plan(cfg, values, shaped, req)
                except Exception as exc:
                    shaped["llm_error"] = str(exc)
            results.append(shaped)
        return jsonify(_json_safe({"ok": True, "results": results,
                                   "llm_configured": bool(cfg.get("configured")),
                                   "llm_model": cfg.get("model") if cfg.get("configured") else "",
                                   "thinking_seconds": sec}))
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.route("/api/precision/recommend", methods=["POST"])
def api_precision_recommend():
    data = request.get_json(force=True, silent=True) or {}
    values = _precision_values(data)
    requirements = dict(data.get("requirements") or {})
    requirements["port"] = "precision"
    try:
        res = kb_recommend(values, requirements)
        shaped = _shape_route(res, "P01", None, values)
        code = shaped["primary"].get("route_code", "")
        shaped["similar_cases"] = find_similar_cases(values, code, 3)
        shaped["values"] = {k: v for k, v in values.items() if k != "_codes"}
        shaped["requirements_echo"] = requirements
        shaped["desired_route"] = requirements.get("desired_route", "")
        if requirements.get("desired_route"):
            desired = requirements["desired_route"].upper()
            shaped["desired_status"] = ("matched" if code == desired else
                                        "blocked_or_not_top")
        return jsonify(_json_safe({"ok": True, **shaped}))
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.route("/api/health")
def api_health():
    kb = load_kb_v3()
    return jsonify({"ok": True, "ready": app_state.get("ready", False),
                    "model_source": app_state.get("model_source", "models"),
                    "models": list((app_state.get("models") or {}).keys()),
                    "kb_count": len(kb.get("entries", [])),
                    "kb_version": kb.get("version", ""),
                    "yolo_ready": app_state.get("model") is not None,
                    "ports": {"port2": "/", "port1": "/precision", "api": "/api"}})


@app.route("/api/meta")
def api_meta():
    cfg = get_llm_config()
    kb = load_process_kb()
    areas = (load_json(AREAS_PATH, {}) or {}).get("areas", [])
    return jsonify({
        "ok": True,
        "ready": app_state.get("ready", False),
        "device": "GPU" if app_state.get("device") != "cpu" else "CPU",
        "schema": app_state.get("schema", []),
        "metrics": app_state.get("metrics", {}),
        "areas": areas,
        "kb_count": len(kb), "model_source": app_state.get("model_source", "models"),
        "llm": {"provider": cfg["provider"], "base_url": cfg["base_url"],
                "model": cfg["model"], "protocol": cfg["protocol"],
                "configured": cfg["configured"]},
        "feature_options": {k: [{"code": c, "label": FEATURE_NAMES[k][i]}
                                for i, c in enumerate(v)] for k, v in LETTER.items()},
        "sources": {
            "recognition": "D:\\项目\\煤矸石识别（YOLOv8s，自训 2 类 + 低置信度规则）",
            "composition": "2026-11 新库 635 条；筛选 328 条常规矸石域训练 v2 集成模型",
            "knowledge_base": f"kb/process_kb_v3.json（R01~R12，{len(kb)} 条路线，可扩展）",
        },
    })


@app.route("/api/config", methods=["POST"])
def api_config():
    data = request.get_json(force=True, silent=True) or {}
    api_key = (data.get("api_key") or "").strip()
    cfg = load_json(CONFIG_PATH, {}) or {}
    if api_key:
        cfg["api_key"] = api_key
    cfg["base_url"] = (data.get("base_url") or cfg.get("base_url")
                       or "https://open.bigmodel.cn/api/paas/v4").rstrip("/")
    cfg["model"] = (data.get("model") or cfg.get("model") or "glm-4.5-flash").strip()
    cfg["provider"] = data.get("provider") or cfg.get("provider") or "zhipu"
    proto = (data.get("protocol") or "").strip().lower()
    if proto not in ("openai", "anthropic"):
        proto = "anthropic" if "anthropic" in cfg["base_url"] else "openai"
    cfg["protocol"] = proto
    save_json(CONFIG_PATH, cfg)
    cur = get_llm_config()
    return jsonify({"ok": True, "configured": cur["configured"], "model": cur["model"],
                    "base_url": cur["base_url"], "protocol": cur["protocol"]})


@app.route("/api/test_llm", methods=["POST"])
def api_test_llm():
    cfg = get_llm_config()
    if not cfg["configured"]:
        return jsonify({"ok": False, "error": "未配置 API Key"})
    try:
        res = call_llm(cfg, [{"role": "user", "content": "只回复 JSON：{\"ok\":true}"}], timeout=40)
        return jsonify({"ok": True, "latency": res["latency"], "model": cfg["model"],
                        "protocol": cfg["protocol"], "reply": res["content"][:200]})
    except Exception as exc:
        return jsonify({"ok": False, "error": str(exc)})


@app.route("/api/examples")
def api_examples():
    """示例图优先选“同时含煤块与矸石”的测试图，便于完整演示三步。"""
    d = Path(r"D:\项目\煤矸石识别\images\test")
    preferred = [
        "1019_jpg.rf.a4e306d38d3d9da7b0d11a9081dc9282.jpg",
        "1022_jpg.rf.900fd25c4750d3a629bea101106a61a6.jpg",
        "1041_jpg.rf.addeb88e4b96cd3955774dd86c54853c.jpg",
        "1051_jpg.rf.7a6f93c914d57f3303c6ed1ca774ec3c.jpg",
        "1057_jpg.rf.46dc2a97a6faa987915a24f306bc0c40.jpg",
        "1040_jpg.rf.883fded540eececf4ea10b11c4d0b039.jpg",
    ]
    items = []
    if d.is_dir():
        for name in preferred:
            f = d / name
            if f.exists():
                items.append({"name": f.name, "path": str(f)})
        if len(items) < 3:
            for f in sorted(d.glob("*.jpg"))[:6]:
                items.append({"name": f.name, "path": str(f)})
    return jsonify({"ok": True, "items": items})


@app.route("/api/detect", methods=["POST"])
def api_detect():
    try:
        data = request.get_json(force=True, silent=True) or {}
        raw_conf = request.form.get("conf")
        if raw_conf in (None, ""):
            raw_conf = data.get("conf", 0.25)
        raw_iou = request.form.get("iou")
        if raw_iou in (None, ""):
            raw_iou = data.get("iou", 0.45)
        conf = _float_or(raw_conf, 0.25)
        iou = _float_or(raw_iou, 0.45)
        src = None
        if "file" in request.files and request.files["file"].filename:
            f = request.files["file"]
            name = f"{int(time.time())}_{uuid.uuid4().hex[:6]}_{Path(f.filename).name}"
            dst = UPLOADS / name
            f.save(str(dst))
            src = dst
        else:
            p = Path(data.get("path", ""))
            if p.is_file():
                src = p
        if src is None:
            return jsonify({"ok": False, "error": "未收到图片"}), 400
        pil = Image.open(src).convert("RGB")
        res = run_detect(pil, conf, iou)
        res["source"] = src.name
        return jsonify(res)
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.route("/api/predict", methods=["POST"])
def api_predict():
    try:
        data = request.get_json(force=True, silent=True) or {}
        res = predict_for_stones(data)
        return jsonify(res), (200 if res.get("ok") else 400)
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.route("/api/recommend", methods=["POST"])
def api_recommend():
    data = request.get_json(force=True, silent=True) or {}
    stones = [s for s in (data.get("stones") or []) if s.get("pred")]
    area = data.get("area") or {}
    inputs = data.get("inputs") or {}
    requirements = data.get("requirements") or {}
    if not stones:
        return jsonify({"ok": False, "error": "没有可推荐的矸石（请先完成成分预测）"}), 400
    try:
        result = recommend_stones_v3(stones, area, inputs, requirements)
        return jsonify(_json_safe(result))
    except Exception as exc:
        traceback.print_exc()
        return jsonify({"ok": False, "error": str(exc)}), 500


@app.route("/api/areas", methods=["GET", "POST"])
def api_areas():
    doc = load_json(AREAS_PATH, {}) or {"areas": []}
    if request.method == "GET":
        return jsonify({"ok": True, "areas": doc.get("areas", [])})
    data = request.get_json(force=True, silent=True) or {}
    name = (data.get("name") or "").strip()
    if not name:
        return jsonify({"ok": False, "error": "矿区名称不能为空"}), 400
    area = {
        "id": "custom_" + uuid.uuid4().hex[:8],
        "name": name,
        "province": (data.get("province") or "山西").strip(),
        "city": (data.get("city") or "").strip(),
        "coalfield": (data.get("coalfield") or name).strip(),
        "coal_type": (data.get("coal_type") or "").strip(),
        "note": (data.get("note") or "").strip(),
        "custom": True,
    }
    doc.setdefault("areas", []).append(area)
    save_json(AREAS_PATH, doc)
    return jsonify({"ok": True, "area": area, "areas": doc["areas"]})


@app.route("/api/kb")
def api_kb():
    kb = load_kb_v3()
    return jsonify({"ok": True, "entries": kb.get("entries", []),
                    "risk_rules": kb.get("risk_rules", []), "version": kb.get("version", "")})


@app.errorhandler(413)
def too_large(_):
    return jsonify({"ok": False, "error": "图片超过 32MB，请压缩后重试"}), 413


def open_browser(url: str) -> bool:
    """优先 360 浏览器（用户默认），其次 Edge，最后系统默认浏览器。"""
    local = os.environ.get("LOCALAPPDATA", "")
    pf = os.environ.get("ProgramFiles", r"C:\Program Files")
    pf86 = os.environ.get("ProgramFiles(x86)", r"C:\Program Files (x86)")
    candidates = [
        os.path.join(local, r"360Chrome\Chrome\Application\360chrome.exe") if local else "",
        os.path.join(pf86, r"360\360Chrome\Chrome\Application\360chrome.exe"),
        os.path.join(pf, r"360\360Chrome\Chrome\Application\360chrome.exe"),
        os.path.join(local, r"360se6\Application\360se6.exe") if local else "",
        os.path.join(pf86, r"360\360se6\Application\360se6.exe"),
        os.path.join(pf, r"360\360se6\Application\360se6.exe"),
        os.path.join(pf86, r"Microsoft\Edge\Application\msedge.exe"),
        os.path.join(pf, r"Microsoft\Edge\Application\msedge.exe"),
    ]
    for exe in candidates:
        if exe and Path(exe).exists():
            try:
                subprocess.Popen([exe, url])
                return True
            except Exception:
                pass
    try:
        webbrowser.open(url)
        return True
    except Exception:
        return False


def main():
    ap = argparse.ArgumentParser(description="煤矸石三步式演示系统")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=7880)
    ap.add_argument("--no-warmup", action="store_true")
    ap.add_argument("--open", action="store_true", help="启动后自动打开默认浏览器")
    args = ap.parse_args()

    print("=" * 72)
    print("  煤矸石识别 · 成分预测 · 工艺推荐  |  大创中期 demo")
    print("=" * 72)
    load_models()
    print("[INFO] 成分模型已加载：", ", ".join(app_state["models"].keys()),
          "| source =", app_state.get("model_source"))
    if not args.no_warmup:
        try:
            get_yolo()
        except Exception as exc:
            print(f"[WARN] YOLO 预加载失败：{exc}")
    cfg = get_llm_config()
    print(f"[INFO] LLM：{cfg['model']} @ {cfg['base_url']} "
          f"{'（已配置 Key）' if cfg['configured'] else '（未配置，将用离线知识库）'}")
    print(f"[INFO] 知识库：{len(load_kb_v3().get('entries', []))} 条 R01~R12")
    print(f"[INFO] 端口二：http://{args.host}:{args.port}/")
    print(f"[INFO] 端口一：http://{args.host}:{args.port}/precision")
    print("=" * 72)
    if args.open:
        threading.Timer(1.2, lambda: open_browser(f"http://{args.host}:{args.port}/")).start()
    app.run(host=args.host, port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()