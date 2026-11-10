# -*- coding: utf-8 -*-
"""Transparent, market-anchored budget ranges for the demo line.

All numbers are order-of-magnitude estimates for a 5 t/h (≈30,000 t/y)
demonstration line, in CNY 10k. They are built from public equipment and
project-investment ranges, not vendor quotations.
"""
from __future__ import annotations

from typing import Dict, List, Tuple

# (keywords, low, high, equipment/scope, note) — unit: 万元
_STEP_COSTS: List[Tuple[Tuple[str, ...], float, float, str, str]] = [
    (("选矸", "分拣", "手选"), 3, 8, "人工分拣台/除铁器", "含拣选平台与除铁"),
    (("破碎", "粗碎", "细碎"), 14, 28, "给料机+颚破/锤破+皮带", "含给料、破碎、输送"),
    (("筛分", "筛孔", "粒径"), 6, 14, "振动筛+输送", "含筛分与返回料"),
    (("粉磨", "磨细", "球磨", "立磨"), 22, 48, "球磨/立磨+分级", "含粉磨与分级"),
    (("混配", "配料", "均化"), 8, 18, "配料仓+双轴搅拌", "含计量与均化"),
    (("造粒", "成球", "成型", "压砖", "挤出", "制粒"), 14, 32, "造粒/成型主机", "含成型与坯体输送"),
    (("煅烧", "烧结", "焙烧", "热活化", "预热", "燃烧"), 75, 170, "回转窑/隧道窑/流化床+燃烧器", "含窑炉、燃烧与温控"),
    (("养护", "蒸压", "碳化", "水热", "晶化"), 25, 58, "养护/蒸压/碳化釜", "含养护与配套"),
    (("浸出", "酸浸", "沉淀", "提取", "酸溶"), 30, 72, "反应釜+过滤+储罐", "含防腐与三废接口"),
    (("激发", "碱激发", "地聚", "改性"), 16, 36, "碱液配制+搅拌+养护", "含碱液与防护"),
    (("脱硫", "烟气", "除尘", "环保", "收尘"), 18, 44, "布袋除尘/脱硫/风机", "含排气筒与在线监测"),
    (("冷却", "烘干", "干燥"), 8, 20, "冷却机/烘干机", "含热风与收尘接口"),
    (("包装", "检验", "监测", "计量"), 5, 12, "包装/化验/在线监测", "含基础质检"),
]

_DEFAULT_LOW, _DEFAULT_HIGH = 8, 18

_SOURCES = [
    {"label": "黎明重工：煤矸石粉碎生产线配置与价格区间（时产50吨 17~27万）",
     "url": "https://www.lmzkjq.com/news/1177.html"},
    {"label": "搜狐：煤矸石粉碎机全套设备价格与150吨/时项目投资参考",
     "url": "https://www.sohu.com/a/888738265_122027329"},
    {"label": "郑矿机器：陶粒回转窑设备价格区间 5~400万",
     "url": "https://www.chzkmill.com/products/5253.html"},
    {"label": "新化县政府：年产6000万块煤矸石标准砖项目总投资900万元",
     "url": "https://www.xinhua.gov.cn/xinhua/bmxxgkml/xhbj/jsxmhp11/spqgs11/202109/a7191f2ad0c64e8f8220d743131c9568.shtml"},
]


def _match(step: str):
    text = str(step)
    for keywords, low, high, scope, note in _STEP_COSTS:
        if any(k in text for k in keywords):
            return low, high, scope, note
    return _DEFAULT_LOW, _DEFAULT_HIGH, "通用设备/安装", "按通用工序估算"


def build_budget(chain: List[str], route: Dict, values: Dict | None = None) -> Dict:
    """Return step-by-step and total budget ranges (CNY 10k)."""
    steps = []
    equipment_low = 0.0
    equipment_high = 0.0
    for step in (chain or []):
        low, high, scope, note = _match(step)
        # Thermal/chemical routes have more auxiliary scope; keep a small route factor.
        name = str((route or {}).get("name", ""))
        if any(k in name for k in ("烧结", "煅烧", "焙烧", "燃烧", "陶粒", "砖", "水泥")):
            low *= 1.08
            high *= 1.08
        steps.append({
            "step": step,
            "low": round(low, 1),
            "high": round(high, 1),
            "scope": scope,
            "note": note,
        })
        equipment_low += low
        equipment_high += high

    # Engineering / installation / commissioning, then contingency.
    eng_low = round(equipment_low * 0.18, 1)
    eng_high = round(equipment_high * 0.25, 1)
    subtotal_low = round(equipment_low + eng_low, 1)
    subtotal_high = round(equipment_high + eng_high, 1)
    cont_low = round(subtotal_low * 0.08, 1)
    cont_high = round(subtotal_high * 0.10, 1)
    total_low = round(subtotal_low + cont_low, 1)
    total_high = round(subtotal_high + cont_high, 1)

    return {
        "currency": "CNY",
        "unit": "万元",
        "scale": "5 t/h · 3 万吨/年（按 6000 h/a 估算）",
        "steps": steps,
        "equipment_low": round(equipment_low, 1),
        "equipment_high": round(equipment_high, 1),
        "engineering_low": eng_low,
        "engineering_high": eng_high,
        "contingency_low": cont_low,
        "contingency_high": cont_high,
        "total_low": total_low,
        "total_high": total_high,
        "basis": "公开市场设备价与同类项目投资区间，按 5 t/h 演示线折算；仅用于方案概算，不等于供应商报价。",
        "assumptions": [
            "按新建 5 t/h、年运行 6000 h 的演示线估算，不含土地、融资与流动资金。",
            "设备价格取公开市场区间，工程/安装按设备费的 18%~25%，预备费按 8%~10%。",
            "原料、燃料、电价、人工与当地环评要求会显著改变最终投资，正式立项需重新询价。",
        ],
        "sources": _SOURCES,
    }
