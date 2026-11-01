# -*- coding: utf-8 -*-
"""R01~R12 route scoring and risk gates for the 2026-11 platform.

The engine is deliberately rule-first:
1) hard environmental/process risks (sulfur acid, lime burst, heavy metals...)
2) composition windows + characteristic ratios
3) dominant chemical regime + physical-code preferences
4) explicit user requirements (desulfurization, fine grinding, priority)
"""
from __future__ import annotations
import json
from pathlib import Path
from typing import Dict, List, Tuple

ROOT = Path(__file__).resolve().parent
KB_PATH = ROOT / "kb" / "process_kb_v3.json"

RATIO_KEYS = ("SI_AL", "AL_SI", "FE_AL", "CA_SI", "FE_SI", "SO3_CA", "LOI_ASH", "FLUX", "FC_LOI", "ALK")
RATIO_LABELS = {
    "SI_AL": "SiO₂/Al₂O₃", "AL_SI": "Al₂O₃/SiO₂", "FE_AL": "Fe₂O₃/Al₂O₃",
    "CA_SI": "CaO/SiO₂", "FE_SI": "Fe₂O₃/SiO₂", "SO3_CA": "SO₃/CaO",
    "LOI_ASH": "LOI/(SiO₂+Al₂O₃)", "FLUX": "CaO+Fe₂O₃+MgO+K₂O+Na₂O",
    "FC_LOI": "固定碳/LOI", "ALK": "K₂O+Na₂O",
}
COND_LABELS = {
    "SiO2": "SiO₂", "Al2O3": "Al₂O₃", "Fe2O3": "Fe₂O₃", "CaO": "CaO", "MgO": "MgO",
    "TiO2": "TiO₂", "SO3": "SO₃", "LOI": "LOI", "St": "全硫 St", "Qnet": "发热量 Qnet",
    "kaolinite": "高岭石", "FC": "固定碳", "pH": "浸出 pH", "heavy_metal": "重金属风险",
    "radioactivity": "放射性",
}


def load_kb(path: Path = KB_PATH) -> Dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _f(v):
    try:
        if v is None or str(v).strip() == "":
            return None
        return float(v)
    except Exception:
        return None


def ratios(values: Dict) -> Dict:
    si = _f(values.get("SiO2")) or 0.0
    al = _f(values.get("Al2O3")) or 0.0
    fe = _f(values.get("Fe2O3")) or 0.0
    ca = _f(values.get("CaO")) or 0.0
    so3 = _f(values.get("SO3")) or 0.0
    loi = _f(values.get("LOI")) or 0.0
    mg = _f(values.get("MgO")) or 0.0
    k = _f(values.get("K2O")) or 0.0
    na = _f(values.get("Na2O")) or 0.0
    fc = _f(values.get("FC")) or 0.0
    return {
        "SI_AL": round(si / max(al, 0.01), 2), "AL_SI": round(al / max(si, 0.01), 2),
        "FE_AL": round(fe / max(al, 0.01), 2), "CA_SI": round(ca / max(si, 0.01), 2),
        "FE_SI": round(fe / max(si, 0.01), 2), "SO3_CA": round(so3 / max(ca, 0.01), 2),
        "LOI_ASH": round(loi / max(si + al, 0.01), 2),
        "FLUX": round(ca + fe + mg + k + na, 2), "FC_LOI": round(fc / max(loi, 0.01), 2),
        "ALK": round(k + na, 2),
    }


def dominant_regime(v: Dict) -> str:
    si = _f(v.get("SiO2")) or 0.0
    al = _f(v.get("Al2O3")) or 0.0
    fe = _f(v.get("Fe2O3")) or 0.0
    ca = _f(v.get("CaO")) or 0.0
    so3 = _f(v.get("SO3")) or 0.0
    loi = _f(v.get("LOI")) or 0.0
    qnet = _f(v.get("Qnet")) or 0.0
    if loi >= 30 and (loi / max(si + al, 1.0) >= 0.50 or qnet >= 6.27):
        return "carbon"
    if al >= 35 and al / max(si, 1.0) >= 0.45:
        return "high_al"
    if ca >= 12 or (ca >= 7 and so3 >= 4):
        return "calcareous"
    if fe >= 15:
        return "high_fe"
    if si >= 60 and si / max(al, 1.0) >= 2.3:
        return "high_si"
    if 16 <= al <= 34 and 38 <= si <= 64:
        return "aluminosilicate"
    return "low_grade"


def _risk_value(rule: Dict, v: Dict):
    field = rule.get("field")
    return v.get(field)


def check_risks(v: Dict, requirements: Dict) -> Dict:
    """Return risk findings, blocked routes and route-specific penalties."""
    findings = []
    blocked: Dict[str, List[str]] = {}
    penalties: Dict[str, float] = {}
    boosts: Dict[str, float] = {}
    sulfur_control = bool(requirements.get("sulfur_control"))
    fine_grinding = bool(requirements.get("fine_grinding"))
    for rule in load_kb().get("risk_rules", []):
        val = _risk_value(rule, v)
        if val is None or val == "":
            continue
        op, threshold = rule.get("op"), rule.get("value")
        hit = False
        if op == ">":
            hit = _f(val) is not None and _f(val) > float(threshold)
        elif op == ">=":
            hit = _f(val) is not None and _f(val) >= float(threshold)
        elif op == "<":
            hit = _f(val) is not None and _f(val) < float(threshold)
        elif op == "in":
            hit = str(val) in [str(x) for x in threshold]
        if not hit:
            continue
        item = {"id": rule["id"], "title": rule["title"], "message": rule["message"],
                "severity": rule.get("severity", "medium"), "value": val,
                "required_tests": rule.get("required_tests", [])}
        # contextual exemption / attenuation
        exempt = False
        if rule["id"] == "SULFUR_ACID":
            if sulfur_control:
                item["message"] += " 已勾选配套脱硫/中和：可进入需脱硫路线，但仍需浸出验证。"
                exempt = True
                for rid in rule.get("require", []):
                    penalties[rid] = min(penalties.get(rid, 1.0), 0.90)
            else:
                for rid in rule.get("require", []):
                    penalties[rid] = min(penalties.get(rid, 1.0), 0.35)
        if rule["id"] == "LIME_BURST" and fine_grinding:
            item["message"] += " 已勾选磨细/消解：R06 可进入，但须做石灰爆裂试验。"
            exempt = True
            penalties["R06"] = min(penalties.get("R06", 1.0), 0.88)
        if rule["id"] == "HIGH_QNET":
            for rid in rule.get("boost", []):
                boosts[rid] = boosts.get(rid, 0.0) + float(rule.get("boost_value", 0.08))
            exempt = True
        if not exempt and rule["id"] not in ("HIGH_QNET",):
            for rid in rule.get("block", []):
                blocked.setdefault(rid, []).append(rule["title"])
        findings.append(item)
    return {"findings": findings, "blocked": blocked, "penalties": penalties, "boosts": boosts}


def score_route(entry: Dict, v: Dict, r: Dict, regime: str, risks: Dict) -> Tuple[float, List[str]]:
    reasons: List[str] = []
    conds = entry.get("conditions", {}) or {}
    rs = entry.get("ratios", {}) or {}
    hits = total = 0.0
    for key, (lo, hi) in conds.items():
        val = _f(v.get(key))
        if val is None:
            continue
        total += 1.0
        if lo <= val <= hi:
            hits += 1.0
            reasons.append(f"{COND_LABELS.get(key, key)}={val:g} 在 {lo:g}~{hi:g} 内")
        else:
            dist = (lo - val) if val < lo else (val - hi)
            span = max(1e-6, hi - lo)
            hits += max(0.0, 1.0 - dist / (0.6 * span + 1e-6)) * 0.25
    for key, (lo, hi) in rs.items():
        val = r.get(key)
        if val is None:
            continue
        total += 1.2
        if lo <= val <= hi:
            hits += 1.2
            reasons.append(f"{RATIO_LABELS.get(key, key)}={val:g} 在 {lo:g}~{hi:g}")
        else:
            dist = (lo - val) if val < lo else (val - hi)
            span = max(1e-6, hi - lo)
            hits += max(0.0, 1.0 - dist / (0.6 * span + 1e-6)) * 0.30 * 1.2
    score = hits / total if total else 0.0

    # hard gate: any missing value is not a fail (UI may be partial), but present fails hurt.
    gate_failed = False
    for key in entry.get("gate", []):
        if key in conds:
            lo, hi = conds[key]
            val = _f(v.get(key))
            if val is not None and not (lo <= val <= hi):
                gate_failed = True
                reasons.insert(0, f"定义性门控 {COND_LABELS.get(key, key)} 未命中")
                break
        elif key in rs:
            lo, hi = rs[key]
            val = r.get(key)
            if val is not None and not (lo <= val <= hi):
                gate_failed = True
                reasons.insert(0, f"定义性门控 {RATIO_LABELS.get(key, key)} 未命中")
                break
    if gate_failed:
        score *= 0.30
    allowed = entry.get("regime") or []
    if allowed:
        if regime in allowed:
            score += 0.04
            reasons.insert(0, f"主导特征={regime} 匹配")
        else:
            score *= 0.60
            reasons.insert(0, f"主导特征={regime} 不匹配")
    # physical codes: small, only reorders
    codes = set((v.get("_codes") or []))
    bonus = sum(float(b) for code, b in (entry.get("physical") or {}).items() if code in codes)
    score += min(bonus, 0.12)
    score += float(entry.get("bias") or 0.0)
    score *= risks.get("penalties", {}).get(entry["id"], 1.0)
    score += risks.get("boosts", {}).get(entry["id"], 0.0)
    return max(0.0, min(1.40, score)), reasons


def _confidence(score: float) -> str:
    if score >= 0.82:
        return "高"
    if score >= 0.62:
        return "中"
    return "低"


def _missing_tests(entry: Dict, v: Dict) -> List[str]:
    req = list(entry.get("required_tests") or [])
    missing = []
    for t in req:
        key = {"全硫 St": "St", "全硫": "St", "发热量": "Qnet", "Qnet": "Qnet", "CaO": "CaO",
               "SO3": "SO3", "高岭石": "kaolinite", "高岭石含量": "kaolinite",
               "浸出 pH": "pH", "重金属浸出": "heavy_metal", "放射性": "radioactivity"}.get(t)
        if key and _f(v.get(key)) is None and v.get(key) not in ("I类清洁固废", "II类需控", "超标危废"):
            missing.append(t)
    return missing


def recommend(v: Dict, requirements: Dict | None = None, top_k: int = 3) -> Dict:
    kb = load_kb()
    req = requirements or {}
    regime = dominant_regime(v)
    r = ratios(v)
    risks = check_risks(v, req)
    entries = kb.get("entries", [])
    priority = str(req.get("priority") or "balanced")
    priority_routes = {
        "cost": {"R01": 0.05, "R02": 0.04, "R12": 0.03},
        "carbon": {"R11": 0.06, "R03": 0.05, "R04": 0.04, "R02": 0.02},
        "high_value": {"R07": 0.06, "R08": 0.05, "R09": 0.04},
        "strength": {"R02": 0.04, "R05": 0.05, "R06": 0.04},
    }.get(priority, {})
    scored = []
    for e in entries:
        score, reasons = score_route(e, v, r, regime, risks)
        score += priority_routes.get(e["id"], 0.0)
        scored.append((score, e, reasons))
    scored.sort(key=lambda x: -x[0])
    desired = (req.get("desired_route") or "").upper()
    if desired:
        for i, (s, e, why) in enumerate(scored):
            if e["id"] == desired:
                scored.insert(0, scored.pop(i))
                break
    primary = scored[0]
    alternatives = scored[1:1 + max(0, top_k - 1)]
    blocked = risks["blocked"]
    # If the top route is hard-blocked, move to the first non-blocked for the primary display,
    # but retain the blocked route as a "risk-blocked" candidate in the alternatives.
    allowed_scored = [x for x in scored if x[1]["id"] not in blocked]
    if primary[1]["id"] in blocked and allowed_scored:
        primary = allowed_scored[0]
    if allowed_scored:
        alternatives = [x for x in allowed_scored if x is not primary][:max(0, top_k - 1)]
    else:
        alternatives = [x for x in scored if x is not primary][:max(0, top_k - 1)]
    e = primary[1]
    blocked_top = [{"route_code": x[1]["id"], "route_name": x[1]["name"],
                    "reason": "；".join(blocked[x[1]["id"]])} for x in scored if x[1]["id"] in blocked][:5]
    # required tests for the primary + risk tests
    tests = _missing_tests(e, v)
    for f in risks["findings"]:
        for t in f.get("required_tests", []):
            if t not in tests:
                tests.append(t)
    return {
        "ok": True, "mode": "precision" if req.get("port") == "precision" else "vision",
        "regime": regime, "ratios": {k: r[k] for k in ("SI_AL", "AL_SI", "FE_AL", "CA_SI", "LOI_ASH", "FLUX")},
        "primary": {
            "route_code": e["id"], "route_name": e["name"], "category": e.get("category", ""),
            "score": round(primary[0], 3), "confidence": _confidence(primary[0]),
            "standard": e.get("standard", ""), "process_chain": e.get("process_chain", []),
            "parameters": e.get("parameters", {}), "products": e.get("products", ""),
            "basis": e.get("basis", ""), "risk": e.get("risk", ""), "ref": e.get("ref", ""),
            "requirements": e.get("requirements", []), "why": primary[2][:5],
        },
        "alternatives": [{"route_code": x[1]["id"], "route_name": x[1]["name"], "score": round(x[0], 3),
                          "confidence": _confidence(x[0]), "why": x[2][:3]} for x in alternatives],
        "blocked": blocked_top, "risks": risks["findings"],
        "required_tests": tests,
        "requirements_echo": req,
    }
