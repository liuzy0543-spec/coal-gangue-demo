/* 端口一 · 化验单精准匹配 */
const P = { template: null, samples: [], current: null };

function $(s) { return document.querySelector(s); }
function esc(v) {
  return String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmt(v, n = 2) {
  const x = Number(v);
  return Number.isFinite(x) ? x.toFixed(n) : "—";
}
function toast(msg, type = "") {
  let el = $("#toast");
  if (!el) { el = document.createElement("div"); el.id = "toast"; document.body.appendChild(el); }
  el.className = "toast show " + (type || "");
  el.textContent = msg;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = "toast"; }, 2600);
}
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const text = await r.text();
  let d = {};
  try { d = JSON.parse(text); } catch (e) { /* ignore */ }
  if (!r.ok || d.ok === false) throw new Error(d.error || `HTTP ${r.status}`);
  return d;
}

function setVal(id, v) {
  const el = $("#" + id);
  if (!el) return;
  el.value = v == null ? "" : v;
}

function fillSample(s) {
  P.current = s;
  const i = s.inputs || {};
  const m = s.meta || {};
  setVal("p-province", m.province || "山西");
  setVal("p-city", m.city || "");
  setVal("p-coalfield", m.coalfield || "");
  setVal("p-source", m.source_type || "新鲜原矸(RAW)");
  setVal("p-color", m.color || "灰黑色/深灰色");
  setVal("p-petrology", m.petrology || "高岭石型(粘土岩类)");
  ["SiO2", "Al2O3", "Fe2O3", "CaO", "MgO", "SO3", "K2O", "Na2O", "LOI"].forEach((k) => setVal("c-" + k, i[k]));
  ["ash", "volatile", "FC", "St", "Qnet"].forEach((k) => setVal("i-" + k, i[k]));
  ["kaolinite", "quartz", "illite", "chlorite", "calcite", "pyrite"].forEach((k) => setVal("x-" + k, i[k]));
  setVal("e-pH", (s.quality || {}).pH);
  if (s.quality && s.quality.heavy_metal) setVal("e-heavy", s.quality.heavy_metal);
  if (s.quality && s.quality.radioactivity) setVal("e-radio", s.quality.radioactivity);
  setVal("r-desired", "");
  $("#sample-note").textContent = `${s.label || s.id} · 库内路线 ${s.route_code || "—"}（对照） · 图像/化学为演示配对`;
}

function collect() {
  const chemical = {}, industrial = {}, xrd = {}, environment = {};
  ["SiO2", "Al2O3", "Fe2O3", "CaO", "MgO", "SO3", "K2O", "Na2O", "LOI"].forEach((k) => {
    const v = $("#c-" + k).value.trim(); chemical[k] = v === "" ? null : Number(v);
  });
  ["ash", "volatile", "FC", "St", "Qnet"].forEach((k) => {
    const v = $("#i-" + k).value.trim(); industrial[k] = v === "" ? null : Number(v);
  });
  ["kaolinite", "quartz", "illite", "chlorite", "calcite", "pyrite"].forEach((k) => {
    const v = $("#x-" + k).value.trim(); xrd[k] = v === "" ? null : Number(v);
  });
  environment.pH = $("#e-pH").value === "" ? null : Number($("#e-pH").value);
  environment.heavy_metal = $("#e-heavy").value;
  environment.radioactivity = $("#e-radio").value;
  const requirements = {
    desired_route: $("#r-desired").value,
    priority: $("#r-priority").value,
    sulfur_control: $("#r-sulfur").value === "true",
    fine_grinding: $("#r-fine").value === "true",
  };
  const meta = {
    province: $("#p-province").value.trim(), city: $("#p-city").value.trim(),
    coalfield: $("#p-coalfield").value.trim(), source_type: $("#p-source").value,
    color: $("#p-color").value.trim(), petrology: $("#p-petrology").value.trim(),
  };
  return { chemical, industrial, xrd, environment, meta, requirements };
}

function riskHTML(risks) {
  if (!risks || !risks.length) return `<div class="notice green"><span>✓</span><span>未触发硬性风险规则；仍需按推荐清单补检。</span></div>`;
  return risks.map((r) => `<div class="risk-card ${r.severity === "high" ? "high" : ""}">
    <div class="rt">${r.severity === "high" ? "⛔" : "⚠"} ${esc(r.title)}</div>
    <p>${esc(r.message)}</p>
  </div>`).join("");
}

function render(d) {
  const p = d.primary || {};
  const code = p.route_code || "—";
  const alt = (d.secondary || []).map((x) => `<span class="sub-chip" title="${esc(x.why)}">${esc(x.route_code)} ${esc(x.name)} · ${fmt(x.score, 2)}</span>`).join("") || "—";
  const chain = (p.process_chain || []).map((s, i) => `<span class="chain-step"><b>${String(i + 1).padStart(2, "0")}</b>${esc(s)}</span>`).join("");
  const params = Object.entries(p.parameters || {}).map(([k, v]) => `<div class="param-item"><b>${esc(k)}</b>${esc(v)}</div>`).join("") || "—";
  const reqs = (p.requirements || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>按标准小试/中试验证</li>";
  const ratios = Object.entries(d.ratios || {}).map(([k, v]) => `${esc(k)} <b style="color:#7dd3fc">${fmt(v, 2)}</b>`).join(" · ");
  const cases = (d.similar_cases || []).map((c) => `<tr>
      <td>${esc(c.sample_id).slice(0, 24)}</td><td>${esc(c.city)}</td><td class="mono">${esc(c.route_code)}</td>
      <td class="num">${fmt(c.measured.SiO2, 1)} / ${fmt(c.measured.Al2O3, 1)} / ${fmt(c.measured.Fe2O3, 1)} / ${fmt(c.measured.CaO, 1)}</td>
      <td class="num">${c.distance == null ? "—" : fmt(c.distance, 2)}</td>
      <td>${c.performance && c.performance.strength_28d ? fmt(c.performance.strength_28d, 1) + " MPa" : "—"}</td>
    </tr>`).join("") || `<tr><td colspan="6" style="color:var(--dim)">暂无同路线近邻案例</td></tr>`;
  const tests = (d.required_tests || []).map((x) => `<span class="sub-chip">${esc(x)}</span>`).join("") || `<span style="color:var(--dim)">—</span>`;
  const blocked = (d.blocked || []).map((b) => `<div class="blocked-line">⛔ <b>${esc(b.route_code)}</b> ${esc(b.route_name)}：${esc(b.reason)}</div>`).join("");
  const desired = d.desired_status === "blocked_or_not_top"
    ? `<div class="notice" style="margin-bottom:9px"><span>⚠</span><span>你指定的优先路线被风险门控拦截或未进入 Top-1；下方为可执行路线。</span></div>` : "";
  $("#precision-result").innerHTML = `${desired}
    <div class="route-badge">
      <div class="route-code">${esc(code)}</div>
      <div>
        <div class="route-title">${esc(p.name || "—")}</div>
        <div class="route-meta"><span class="chip" style="padding:1px 7px;font-size:10px">${esc(p.category || "")}</span>
          <span class="chip ${p.confidence === "高" ? "ok" : p.confidence === "低" ? "warn" : ""}" style="padding:1px 7px;font-size:10px">可信度 ${esc(p.confidence || "中")}</span>
          <span class="mono" style="font-size:10px;color:var(--dim)">${esc(p.standard || "")}</span></div>
      </div>
      <div class="route-score"><b>${fmt(p.score, 2)}</b><span>匹配分 / 1.40</span></div>
    </div>

    <div class="result-block"><h4>成分特征</h4><div style="font-size:11px;color:var(--muted)">${ratios || "—"}</div></div>
    <div class="result-block"><h4>推荐理由</h4><div style="font-size:11px;color:var(--muted);line-height:1.8">${esc(p.why || "")}</div>
      <div style="font-size:11px;color:var(--muted);line-height:1.8;margin-top:5px">${esc(p.basis || "")}</div></div>
    <div class="result-block"><h4>阶段 4 · 八工序执行链</h4><div class="chain">${chain || "—"}</div></div>
    <div class="result-block"><h4>阶段 4 · 关键参数</h4><div class="param-grid">${params}</div></div>
    <div class="result-block"><h4>路线硬性要求</h4><ul class="req-list">${reqs}</ul></div>
    <div class="result-block"><h4>阶段 5 · 风险与合规门控</h4>${riskHTML(d.risks)}
      ${blocked ? `<div style="margin-top:8px">${blocked}</div>` : ""}</div>
    <div class="result-block"><h4>阶段 5 · 建议补检</h4><div class="sub-list">${tests}</div></div>
    <div class="result-block"><h4>同路线相似标杆（kNN）</h4>
      <div class="table-wrap"><table class="case-table"><thead><tr><th>样品</th><th>城市</th><th>路线</th><th>SiO₂/Al₂O₃/Fe₂O₃/CaO</th><th>距离</th><th>28d 强度</th></tr></thead><tbody>${cases}</tbody></table></div>
    </div>
    <div class="result-block"><h4>备选路线</h4><div class="sub-list">${alt}</div></div>
    <div class="notice" style="margin-top:12px"><span>⚠</span><span>建议用于方案筛选，不替代小试/中试与重金属、放射性、安定性检测；路线阈值见知识库。</span></div>`;
  $("#result-sub").textContent = `${code} · 可信度 ${p.confidence || "中"} · ${new Date().toLocaleTimeString()}`;
}

async function run() {
  const body = collect();
  if (![body.chemical.SiO2, body.chemical.Al2O3, body.chemical.Fe2O3, body.chemical.CaO].every(Number.isFinite)) {
    toast("请至少填写 SiO₂ / Al₂O₃ / Fe₂O₃ / CaO", "err"); return;
  }
  $("#btn-run").disabled = true;
  $("#result-sub").textContent = "计算中…";
  try {
    const d = await api("/api/precision/recommend", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    render(d);
  } catch (e) {
    toast("推荐失败：" + e.message, "err");
    $("#result-sub").textContent = "失败";
  } finally {
    $("#btn-run").disabled = false;
  }
}

async function init() {
  try {
    const d = await api("/api/precision/template");
    P.template = d;
    P.samples = d.samples || [];
    const sel = $("#sample-select");
    sel.innerHTML = P.samples.map((s) => `<option value="${esc(s.id)}">${esc(s.label)}</option>`).join("");
    const routeSel = $("#r-desired");
    routeSel.innerHTML += (d.routes || []).map((r) => `<option value="${esc(r.id)}">${esc(r.id)} · ${esc(r.name)}</option>`).join("");
    $("#hero-routes").textContent = String((d.routes || []).length || 12);
    $("#hero-rules").textContent = String((d.risk_rules || []).length || 8);
    $("#chip-kb").innerHTML = `<i class="dot"></i>知识库 <b>${(d.routes || []).length} 条</b>`;
    if (P.samples.length) {
      fillSample(P.samples[0]);
      await run();
    }
  } catch (e) {
    toast("模板加载失败：" + e.message, "err");
    $("#result-sub").textContent = "加载失败";
  }
  $("#btn-load-sample").addEventListener("click", async () => {
    const s = P.samples.find((x) => x.id === $("#sample-select").value);
    if (s) { fillSample(s); await run(); }
  });
  $("#sample-select").addEventListener("change", async () => {
    const s = P.samples.find((x) => x.id === $("#sample-select").value);
    if (s) { fillSample(s); await run(); }
  });
  $("#btn-run").addEventListener("click", run);
  $("#btn-reset").addEventListener("click", async () => {
    if (P.samples.length) { fillSample(P.samples[0]); await run(); }
  });
}

init();
