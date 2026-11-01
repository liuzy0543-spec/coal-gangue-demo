# -*- coding: utf-8 -*-
"""Train four oxide models on the 2026-11 635-record database.

Data filter (documented in README / metrics):
- 635 real samples; keep explicit utilization route R01..R12;
- remove D-level multi-sample statistical means (marked 禁入单样模型);
- require all four target oxides present, XRF sum 85..105, and the typical
  gangue domain SiO2 20..75, Al2O3 5..45, Fe2O3 0.1..25, CaO 0..20 wt%.
This yields ~328 independent samples / ~299 source groups.  The filter is an
applicability-domain definition for the visual/quick port, not a claim that
high-Ca/high-Fe gangue does not exist; out-of-domain inputs are flagged by the app.
"""
from __future__ import annotations
import json, re, warnings
from collections import Counter
from pathlib import Path
import joblib
import numpy as np
import pandas as pd
from sklearn.compose import ColumnTransformer
from sklearn.impute import SimpleImputer
from sklearn.linear_model import RidgeCV
from sklearn.metrics import mean_absolute_error, mean_squared_error, r2_score
from sklearn.pipeline import Pipeline
from sklearn.preprocessing import OneHotEncoder, StandardScaler
from xgboost import XGBRegressor

warnings.filterwarnings("ignore")
ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data" / "新数据库_635.xlsx"
OUT = ROOT / "models_v2"
OUT.mkdir(exist_ok=True)
SEEDS = [42, 7, 2024]
NFOLD = 5

TARGET_MAP = {"SiO2": "SiO2_wt%", "Al2O3": "Al2O3_wt%", "Fe2O3": "Fe2O3_wt%", "CaO": "CaO_wt%"}
FEATURES = ["LOI", "K2O", "MgO", "Na2O", "TiO2", "SO3", "ash", "volatile", "FC", "St",
            "Qnet", "kaolinite", "quartz", "illite", "chlorite", "calcite", "pyrite",
            "P2O5", "_den"]
CATS = ["province", "city", "coalfield", "source_type", "color", "petrology"]


def num(s):
    if isinstance(s, (int, float, np.number)):
        return float(s)
    t = str(s).strip().replace(",", "")
    if not t or t.lower() in ("nan", "none", "未测", "未说明", "—", "-", "/", "收到基(ar)"):
        return np.nan
    t = t.replace("＜", "<").replace("＞", ">")
    m = re.search(r"[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?", t)
    if not m:
        return np.nan
    v = float(m.group())
    return v / 2 if t.startswith("<") else v


def load_data() -> pd.DataFrame:
    d = pd.read_excel(DATA, sheet_name="煤矸石全量数据库_标准输入总表", header=3, skiprows=[4])
    for c in TARGET_MAP.values():
        d[c] = d[c].map(num)
    mapping = {
        "烧失量LOI_wt%": "LOI", "K2O_wt%": "K2O", "MgO_wt%": "MgO", "Na2O_wt%": "Na2O",
        "TiO2_wt%": "TiO2", "SO3_wt%": "SO3", "灰分A_wt%": "ash", "挥发分V_wt%": "volatile",
        "固定碳FC_wt%": "FC", "全硫St_wt%": "St", "发热量Qnet_MJ_kg": "Qnet",
        "高岭石_wt%": "kaolinite", "石英_wt%": "quartz", "伊利石与云母_wt%": "illite",
        "绿泥石与蒙脱石_wt%": "chlorite", "方解石与白云石_wt%": "calcite",
        "黄铁矿与菱铁矿_wt%": "pyrite", "P2O5_MnO等其他_wt%": "P2O5",
    }
    for src, dst in mapping.items():
        d[dst] = d[src].map(num)
    d["_den"] = d[["MgO", "K2O", "Na2O", "TiO2", "SO3", "LOI"]].sum(axis=1, min_count=3)
    d["_sum"] = d[["SiO2_wt%", "Al2O3_wt%", "Fe2O3_wt%", "CaO_wt%", "MgO", "TiO2", "K2O",
                   "Na2O", "SO3", "P2O5", "LOI"]].sum(axis=1, min_count=1)
    d["province"] = d["省份"].fillna("缺失").astype(str)
    d["city"] = d["城市"].fillna("缺失").astype(str)
    d["coalfield"] = d["所属煤田或聚煤区"].fillna("缺失").astype(str)
    d["source_type"] = d["样品原始状态分类"].fillna("缺失").astype(str)
    d["color"] = d["外观颜色分类"].fillna("缺失").astype(str)
    d["petrology"] = d["岩石学与矿物类型"].fillna("缺失").astype(str)
    d["group"] = d["文献来源分组ID"].astype(str)
    route = d["12大标准组合处理工艺路线编码"].astype(str).str.match(r"^R(0[1-9]|1[0-2])$")
    q = d[(~d["数据证据等级"].astype(str).str.startswith("D级")) & route
          & d[list(TARGET_MAP.values())].notna().all(axis=1)
          & d["_sum"].between(85, 105)
          & d["SiO2_wt%"].between(20, 75) & d["Al2O3_wt%"].between(5, 45)
          & d["Fe2O3_wt%"].between(0.1, 25) & d["CaO_wt%"].between(0, 20)].copy()
    for t in TARGET_MAP:
        q[t] = q[TARGET_MAP[t]].astype(float)
    return q.reset_index(drop=True)


def group_folds(groups, seed):
    rng = np.random.default_rng(seed)
    uniq = list(pd.unique(groups))
    rng.shuffle(uniq)
    sizes = Counter(groups)
    uniq.sort(key=lambda g: -sizes[g])
    load = np.zeros(NFOLD)
    out = {}
    for g in uniq:
        f = int(np.argmin(load))
        out[g] = f + 1
        load[f] += sizes[g]
    return out


def make_model(kind):
    ns = [("imp", SimpleImputer(strategy="median", add_indicator=True))]
    if kind == "ridge":
        ns.append(("sc", StandardScaler()))
        est = RidgeCV(alphas=np.logspace(-2, 4, 12))
    else:
        est = XGBRegressor(n_estimators=500, max_depth=3, learning_rate=0.03,
                           subsample=0.9, colsample_bytree=0.9, reg_lambda=1.5,
                           random_state=42, n_jobs=4, verbosity=0)
    pre = ColumnTransformer([
        ("num", Pipeline(ns), FEATURES),
        ("cat", Pipeline([("oh", OneHotEncoder(handle_unknown="ignore", min_frequency=2,
                                                sparse_output=False, dtype=np.float32))]), CATS),
    ])
    return Pipeline([("pre", pre), ("model", est)])


def cv_target(q, target):
    y = q[target].to_numpy(float)
    models = {"ridge": [], "xgb": []}
    for seed in SEEDS:
        fold = q["group"].map(group_folds(q["group"].to_numpy(), seed)).astype(int)
        pred = {k: np.full(len(q), np.nan) for k in models}
        for f in range(1, NFOLD + 1):
            m = (fold == f).to_numpy()
            tr, te = q.loc[~m], q.loc[m]
            for k in models:
                p = make_model(k)
                p.fit(tr[FEATURES + CATS], tr[target].to_numpy(float))
                pred[k][m] = np.clip(p.predict(te[FEATURES + CATS]), 0, 100)
        ok = np.isfinite(pred["ridge"]) & np.isfinite(pred["xgb"])
        models["ridge"].append(pred["ridge"][ok])
        models["xgb"].append(pred["xgb"][ok])
    # choose a blend weight on the pooled OOF; keep per-seed metrics
    best = None
    for w in np.linspace(0, 1, 21):
        scores = []
        for i in range(len(SEEDS)):
            p = w * models["ridge"][i] + (1 - w) * models["xgb"][i]
            scores.append(r2_score(y[np.isfinite(models["ridge"][i])], p))
        avg = float(np.mean(scores))
        if best is None or avg > best[0]:
            best = (avg, float(w), scores)
    avg, w, scores = best
    pred = w * models["ridge"][0] + (1 - w) * models["xgb"][0]
    y0 = y[np.isfinite(models["ridge"][0])]
    # Use pooled OOF over all seeds for MAE/RMSE (evaluate each seed then average)
    maes, rmses = [], []
    for i in range(len(SEEDS)):
        p = w * models["ridge"][i] + (1 - w) * models["xgb"][i]
        yy = y[np.isfinite(models["ridge"][i])]
        maes.append(mean_absolute_error(yy, p))
        rmses.append(float(np.sqrt(mean_squared_error(yy, p))))
    return {"r2": float(avg), "r2_sd": float(np.std(scores, ddof=1)), "mae": float(np.mean(maes)),
            "rmse": float(np.mean(rmses)), "weight_ridge": w, "n": len(q),
            "groups": int(q["group"].nunique()), "seeds": scores}


def main():
    q = load_data()
    print("training rows", len(q), "groups", q["group"].nunique())
    metrics = {
        "protocol": "按来源组 5 折 × 种子 42/7/2024 pooled OOF；RidgeCV + XGBoost 线性加权",
        "data": "2026-11 635 条真实库；R01~R12，排除 D 级统计均值，四目标齐全，加和 85~105，常规矸石域",
        "updated": "2026-11-01",
        "n": len(q), "groups": int(q["group"].nunique()),
        "domain": {"SiO2": [20, 75], "Al2O3": [5, 45], "Fe2O3": [0.1, 25], "CaO": [0, 20]},
    }
    for target in TARGET_MAP:
        mt = cv_target(q, target)
        # final fit on all training rows
        fitted = {}
        for kind in ("ridge", "xgb"):
            p = make_model(kind)
            p.fit(q[FEATURES + CATS], q[target].to_numpy(float))
            fitted[kind] = p
        artifact = {
            "target": target, "features": FEATURES, "cat_feats": CATS,
            "models": fitted, "weights": {"ridge": mt["weight_ridge"], "xgb": 1 - mt["weight_ridge"]},
            "n_train": len(q), "groups_train": int(q["group"].nunique()),
            "domain": metrics["domain"],
            "note": "635 条真实库筛选后的常规煤矸石域；Ridge/XGB 集成，权重由 OOF 选择",
        }
        joblib.dump(artifact, OUT / f"{target.lower()}_model.joblib")
        metrics[target] = {
            "model": f"RidgeCV + XGBoost 集成（ridge {mt['weight_ridge']:.2f}）",
            "features": FEATURES, "cat_feats": CATS,
            "R2_mean": mt["r2"], "R2_sd": mt["r2_sd"], "MAE_mean": mt["mae"],
            "RMSE_mean": mt["rmse"], "n": mt["n"], "groups": mt["groups"],
            "weight_ridge": mt["weight_ridge"], "seeds": mt["seeds"],
            "coverage": f"{mt['n']}/{len(q)}",
        }
        print(target, {k: round(metrics[target][k], 4) for k in ("R2_mean", "R2_sd", "MAE_mean", "RMSE_mean")})
    (OUT / "metrics.json").write_text(json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    schema = [
        {"key": "LOI", "label": "LOI 烧失量", "unit": "%", "group": "field", "required": True, "range": [0, 60], "step": 0.1, "tip": "GB/T 212 马弗炉；碳质/碳酸盐分解"},
        {"key": "K2O", "label": "K₂O", "unit": "%", "group": "field", "required": False, "range": [0, 10], "step": 0.01},
        {"key": "MgO", "label": "MgO", "unit": "%", "group": "field", "required": False, "range": [0, 20], "step": 0.01},
        {"key": "Na2O", "label": "Na₂O", "unit": "%", "group": "field", "required": False, "range": [0, 10], "step": 0.01},
        {"key": "TiO2", "label": "TiO₂", "unit": "%", "group": "field", "required": False, "range": [0, 8], "step": 0.01},
        {"key": "SO3", "label": "SO₃", "unit": "%", "group": "field", "required": False, "range": [0, 20], "step": 0.01},
        {"key": "ash", "label": "灰分 Aad", "unit": "%", "group": "industrial", "required": False, "range": [30, 98], "step": 0.1},
        {"key": "volatile", "label": "挥发分 Vad", "unit": "%", "group": "industrial", "required": False, "range": [0, 45], "step": 0.1},
        {"key": "FC", "label": "固定碳 FC", "unit": "%", "group": "industrial", "required": False, "range": [0, 40], "step": 0.1},
        {"key": "St", "label": "全硫 St", "unit": "%", "group": "industrial", "required": False, "range": [0, 20], "step": 0.01, "tip": ">1.5 触发高硫强酸性风险"},
        {"key": "Qnet", "label": "发热量 Qnet,ar", "unit": "MJ/kg", "group": "industrial", "required": False, "range": [0, 25], "step": 0.01},
        {"key": "kaolinite", "label": "高岭石", "unit": "%", "group": "xrd", "required": False, "range": [0, 100], "step": 0.1},
        {"key": "quartz", "label": "石英", "unit": "%", "group": "xrd", "required": False, "range": [0, 100], "step": 0.1},
        {"key": "illite", "label": "伊利石/云母", "unit": "%", "group": "xrd", "required": False, "range": [0, 100], "step": 0.1},
        {"key": "chlorite", "label": "绿泥石/蒙脱石", "unit": "%", "group": "xrd", "required": False, "range": [0, 100], "step": 0.1},
        {"key": "calcite", "label": "方解石/白云石", "unit": "%", "group": "xrd", "required": False, "range": [0, 100], "step": 0.1},
        {"key": "pyrite", "label": "黄铁矿/菱铁矿", "unit": "%", "group": "xrd", "required": False, "range": [0, 100], "step": 0.1},
    ]
    (OUT / "input_schema.json").write_text(json.dumps(schema, ensure_ascii=False, indent=2), encoding="utf-8")
    print("saved", OUT)


if __name__ == "__main__":
    main()
