# -*- coding: utf-8 -*-
"""train_models.py —— 固化四个氧化物模型（含 XRD 条件 Al2O3 模型）

口径
----
* SiO2 复用已交付、已验收的模型（E:\\项目\\煤矸石\\SiO2_交付包），
  三种子分组 CV R² = 0.7272，不在此重训。
* Al2O3 / Fe2O3 / CaO 在 261 行建模表上重训，按 source_group_id 平衡分组
  5 折 × 3 个种子（42/7/2024），pooled OOF 计算 R²，报 均值 ± 标准差。
* Al2O3 另训一个 **XRD 条件模型**：仅用「高岭石 + LOI」+ 类别特征，
  只在用户填了高岭石定量时启用（55 条 / 14 组），并加矿物学上界：
      Al2O3 ≤ (高岭石×0.395 + 伊利石×0.30) × 1.8 + 8
  没填高岭石时仍走全表模型（261 条）。
* 输入指标即界面上的六项现场指标 + 可选 XRD 高岭石/伊利石。

运行：
    python scripts/train_models.py
"""
from __future__ import annotations

import json
import warnings
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
DATA = ROOT / "data" / "成分建模数据_261.xlsx"
MODELS = ROOT / "models"
MODELS.mkdir(exist_ok=True)

CATS = ["province", "city", "gangue_source_type", "material_stage"]
SEEDS = [42, 7, 2024]
NFOLD = 5

# 数值特征：尽量只用界面可填字段；Fe2O3 借矿物/灰分提升区分度
FEATURES = {
    "Al2O3": ["LOI烧失量", "_den闭合分母", "K2O", "高岭石"],
    "Fe2O3": ["LOI烧失量", "_den闭合分母", "K2O", "高岭石", "伊利石", "石英", "Na2O"],
    "CaO": ["MgO", "SO3", "TiO2"],
}
MODEL_KIND = {"Al2O3": "ridge", "Fe2O3": "xgb", "CaO": "xgb"}

INPUT_SCHEMA = [
    {"key": "LOI烧失量", "label": "LOI 烧失量", "unit": "%", "required": True,
     "range": [0, 60], "step": 0.1,
     "tip": "GB/T 212 马弗炉灼烧，现场可测；SiO2 的最强单指标"},
    {"key": "K2O", "label": "K₂O", "unit": "%", "required": True,
     "range": [0, 10], "step": 0.01, "tip": "伊利石/钾长石指示；进入 _den 闭合分母"},
    {"key": "MgO", "label": "MgO", "unit": "%", "required": True,
     "range": [0, 15], "step": 0.01, "tip": "白云石/绿泥石指示；CaO 的协同指标"},
    {"key": "Na2O", "label": "Na₂O", "unit": "%", "required": True,
     "range": [0, 10], "step": 0.01, "tip": "Fe2O3 的组内相关最强指标（r≈+0.39）"},
    {"key": "TiO2", "label": "TiO₂", "unit": "%", "required": True,
     "range": [0, 8], "step": 0.01, "tip": "金红石/黏土矿物指示"},
    {"key": "SO3", "label": "SO₃", "unit": "%", "required": True,
     "range": [0, 20], "step": 0.01, "tip": "石膏/硫酸盐指示；CaO 的组内 r≈+0.29"},
    {"key": "高岭石", "label": "高岭石定量（可选，XRD）", "unit": "%", "required": False,
     "range": [0, 100], "step": 0.1,
     "tip": "填了它，Al₂O₃ 自动切换到 XRD 条件模型（R²≈0.59）；缺失时用全表模型（R²≈0.27）"},
    {"key": "伊利石", "label": "伊利石定量（可选，XRD）", "unit": "%", "required": False,
     "range": [0, 100], "step": 0.1,
     "tip": "用于收紧 Al₂O₃ 矿物学上界；也进入 Fe₂O₃ 模型"},
    {"key": "石英", "label": "石英定量（可选，XRD）", "unit": "%", "required": False,
     "range": [0, 100], "step": 0.1,
     "tip": "Fe₂O₃ 模型使用；缺失按中位数插补"},
]


def load_data() -> pd.DataFrame:
    d = pd.read_excel(DATA, sheet_name="建模数据")
    d["_den闭合分母"] = d[["MgO", "K2O", "Na2O", "TiO2", "SO3", "LOI烧失量"]].sum(
        axis=1, min_count=3)
    for c in CATS:
        d[c] = d[c].fillna("缺失").astype(str)
    return d


def build_pipeline(num_feats, kind="ridge"):
    num_steps = [("imp", SimpleImputer(strategy="median", add_indicator=True))]
    if kind == "ridge":
        num_steps.append(("sc", StandardScaler()))
    cat = Pipeline([
        ("oh", OneHotEncoder(handle_unknown="ignore", min_frequency=2,
                             sparse_output=False, dtype=np.float32)),
    ])
    pre = ColumnTransformer([("num", Pipeline(num_steps), num_feats),
                             ("cat", cat, CATS)])
    if kind == "ridge":
        est = RidgeCV(alphas=np.logspace(-2, 4, 12))
    elif kind == "xgb":
        est = XGBRegressor(
            n_estimators=350, max_depth=3, learning_rate=0.04,
            subsample=0.9, colsample_bytree=0.9, reg_lambda=1.5,
            random_state=42, n_jobs=4, verbosity=0,
        )
    else:
        raise ValueError(kind)
    return Pipeline([("pre", pre), ("model", est)])


def group_folds(groups, nfolds=NFOLD, seed=42):
    rng = np.random.default_rng(seed)
    uniq = list(pd.unique(groups))
    rng.shuffle(uniq)
    sizes = Counter(groups)
    uniq.sort(key=lambda g: -sizes[g])
    load = np.zeros(nfolds)
    out = {}
    for g in uniq:
        f = int(np.argmin(load))
        out[g] = f + 1
        load[f] += sizes[g]
    return out


def _upper_bound(df: pd.DataFrame) -> np.ndarray:
    kaol = pd.to_numeric(df.get("高岭石"), errors="coerce").fillna(0).to_numpy(float)
    ill = pd.to_numeric(df.get("伊利石"), errors="coerce").fillna(0).to_numpy(float)
    return (kaol * 0.395 + ill * 0.30) * 1.8 + 8.0


def cross_validate(d, target, feats, kind="ridge", balanced=False, ub=False):
    d = d.dropna(subset=[target]).copy().reset_index(drop=True)
    per_seed = []
    for seed in SEEDS:
        fold = d["source_group_id"].map(
            group_folds(d["source_group_id"].to_numpy(), NFOLD, seed)).astype(int)
        pred = np.full(len(d), np.nan)
        for f in range(1, NFOLD + 1):
            m = (fold == f).to_numpy()
            if m.sum() < 3:
                continue
            tr = d.loc[~m].reset_index(drop=True)
            te = d.loc[m].reset_index(drop=True)
            pipe = build_pipeline(feats, kind)
            sw = None
            if balanced:
                sizes = tr.groupby("source_group_id")[target].transform("size")
                sw = (1.0 / sizes).to_numpy()
                sw = sw / sw.mean()
            fit_kw = {"model__sample_weight": sw} if sw is not None else {}
            pipe.fit(tr[feats + CATS], tr[target].to_numpy(float), **fit_kw)
            p = np.clip(pipe.predict(te[feats + CATS]), 0, 100)
            if ub:
                p = np.minimum(p, _upper_bound(te))
            pred[m] = p
        ok = np.isfinite(pred)
        per_seed.append({
            "seed": seed,
            "R2": float(r2_score(d[target][ok], pred[ok])),
            "MAE": float(mean_absolute_error(d[target][ok], pred[ok])),
            "RMSE": float(np.sqrt(mean_squared_error(d[target][ok], pred[ok]))),
            "n": int(ok.sum()),
        })
    r2 = [x["R2"] for x in per_seed]
    return {
        "per_seed": per_seed,
        "R2_mean": float(np.mean(r2)),
        "R2_sd": float(np.std(r2, ddof=1)),
        "MAE_mean": float(np.mean([x["MAE"] for x in per_seed])),
        "RMSE_mean": float(np.mean([x["RMSE"] for x in per_seed])),
        "R2_min": float(np.min(r2)),
        "R2_max": float(np.max(r2)),
        "n": len(d),
        "groups": int(d["source_group_id"].nunique()),
    }


def fit_and_save(d, target, feats, kind, path, balanced=False, ub=False, note=""):
    fit_df = d.dropna(subset=[target]).reset_index(drop=True)
    pipe = build_pipeline(feats, kind)
    sw = None
    if balanced:
        sizes = fit_df.groupby("source_group_id")[target].transform("size")
        sw = (1.0 / sizes).to_numpy()
        sw = sw / sw.mean()
    pipe.fit(fit_df[feats + CATS], fit_df[target].to_numpy(float),
             **({"model__sample_weight": sw} if sw is not None else {}))
    joblib.dump({
        "target": target,
        "features": feats,
        "cat_feats": CATS,
        "kind": kind,
        "balanced": balanced,
        "upper_bound": ub,
        "pipeline": pipe,
        "n_train": int(len(fit_df)),
        "groups_train": int(fit_df["source_group_id"].nunique()),
        "note": note,
    }, path)


def main():
    d = load_data()
    print(f"数据：{len(d)} 行 / {d['source_group_id'].nunique()} 个来源组")

    metrics = {
        "protocol": "按 source_group_id 平衡分组 5 折 × 3 种子（42/7/2024），pooled OOF R²",
        "updated": "2026-10-22",
    }

    # SiO2：复用交付模型
    sio2 = joblib.load(MODELS / "sio2_model.joblib")
    cm = sio2["cv_metrics"]
    metrics["SiO2"] = {
        "model": "RidgeCV（交付版，LOI+_den+K2O）",
        "features": list(sio2["num_feats"]),
        "R2_mean": cm["R2_mean"], "R2_sd": cm["R2_sd"],
        "MAE_mean": cm["MAE_mean"], "RMSE_mean": cm["RMSE_mean"],
        "n": cm["n"], "groups": cm["groups"],
        "all_seeds_above_0.70": cm["all_above_0_70"],
        "note": "复用 SiO2_交付包，已通过三种子 > 0.70 验收",
    }
    print(f"  SiO2   R²={cm['R2_mean']:+.4f}（已交付）")

    for t in ["Al2O3", "Fe2O3", "CaO"]:
        feats = FEATURES[t]
        kind = MODEL_KIND[t]
        res = cross_validate(d, t, feats, kind)
        fit_and_save(d, t, feats, kind, MODELS / f"{t.lower()}_model.joblib",
                     note="全表模型（不需要 XRD）")
        metrics[t] = {
            "model": ("RidgeCV" if kind == "ridge" else "XGBoost") +
                     " + OneHot(4 类别) + 中位数插补",
            "features": feats,
            "R2_mean": round(res["R2_mean"], 4),
            "R2_sd": round(res["R2_sd"], 4),
            "MAE_mean": round(res["MAE_mean"], 3),
            "RMSE_mean": round(res["RMSE_mean"], 3),
            "n": res["n"], "groups": res["groups"],
            "all_seeds_above_0.70": bool(res["R2_mean"] > 0.70),
            "per_seed": res["per_seed"],
            "note": "全表 261 行；未填高岭石时使用",
        }
        print(f"  {t:6s} R²={res['R2_mean']:+.4f} ± {res['R2_sd']:.4f} "
              f"MAE={res['MAE_mean']:.2f} n={res['n']} g={res['groups']}")

    # XRD 条件 Al2O3：55 条有高岭石定量的样品
    k = d[d["高岭石"].notna()].copy()
    xfeats = ["高岭石", "LOI烧失量"]
    xres = cross_validate(k, "Al2O3", xfeats, "ridge", balanced=True, ub=True)
    fit_and_save(k, "Al2O3", xfeats, "ridge", MODELS / "al2o3_xrd_model.joblib",
                 balanced=True, ub=True,
                 note="XRD 条件模型：仅当用户填高岭石时启用；含矿物学上界")
    metrics["Al2O3_xrd"] = {
        "model": "RidgeCV（XRD 条件模型）+ 矿物学上界",
        "features": xfeats,
        "R2_mean": round(xres["R2_mean"], 4),
        "R2_sd": round(xres["R2_sd"], 4),
        "MAE_mean": round(xres["MAE_mean"], 3),
        "RMSE_mean": round(xres["RMSE_mean"], 3),
        "n": xres["n"], "groups": xres["groups"],
        "coverage": f"{xres['n']}/{len(d)}",
        "upper_bound": "Al2O3 ≤ (高岭石×0.395 + 伊利石×0.30)×1.8 + 8",
        "per_seed": xres["per_seed"],
        "all_seeds_above_0.70": False,
        "note": "仅覆盖有 XRD 高岭石定量的 55 条 / 14 组；未填高岭石时回退全表模型",
    }
    print(f"  Al2O3-XRD R²={xres['R2_mean']:+.4f} ± {xres['R2_sd']:.4f} "
          f"MAE={xres['MAE_mean']:.2f} n={xres['n']} g={xres['groups']}")

    (MODELS / "metrics.json").write_text(
        json.dumps(metrics, ensure_ascii=False, indent=2), encoding="utf-8")
    (MODELS / "input_schema.json").write_text(
        json.dumps(INPUT_SCHEMA, ensure_ascii=False, indent=2), encoding="utf-8")
    print("已写出 models/metrics.json、models/input_schema.json")


if __name__ == "__main__":
    main()