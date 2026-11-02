/* 端口一 · 图片识别 → 逐石必填实验报告 → 逐石处理方案 */
const P = {
  template: null, samples: [], detect: null, gangue: [], forms: [],
  idx: 0, step: 1, results: [], thinkingTimer: null,
};

const REQUIRED = [
  ["p1-province", "省份"], ["p1-city", "城市"], ["p1-coalfield", "煤田/矿区"], ["p1-source", "样品状态"], ["p1-color", "外观颜色"], ["p1-petrology", "岩石学类型"],
  ["p1-c-SiO2", "SiO₂"], ["p1-c-Al2O3", "Al₂O₃"], ["p1-c-Fe2O3", "Fe₂O₃"], ["p1-c-CaO", "CaO"],
  ["p1-c-MgO", "MgO"], ["p1-c-SO3", "SO₃"], ["p1-c-K2O", "K₂O"], ["p1-c-Na2O", "Na₂O"], ["p1-c-LOI", "LOI"],
  ["p1-i-ash", "灰分"], ["p1-i-volatile", "挥发分"], ["p1-i-FC", "固定碳"], ["p1-i-St", "全硫"], ["p1-i-Qnet", "发热量"],
  ["p1-e-pH", "浸出液 pH"],
  ["p1-x-kaolinite", "高岭石"], ["p1-x-quartz", "石英"], ["p1-x-illite", "伊利石"],
  ["p1-x-chlorite", "绿泥石"], ["p1-x-calcite", "方解石"], ["p1-x-pyrite", "黄铁矿"],
];
const SUPPORTED = ["jpg", "jpeg", "png", "bmp", "webp", "tif", "tiff"];

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
  el._t = setTimeout(() => { el.className = "toast"; }, 3000);
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
function num(id) {
  const v = $("#" + id).value.trim();
  return v === "" ? null : Number(v);
}
function softNum(id) {
  const n = num(id);
  return Number.isFinite(n) ? n : null;
}

/* ---------------- 步骤 ---------------- */
function showStep(n) {
  P.step = n;
  document.querySelectorAll(".p1-step").forEach((el) => el.classList.toggle("active", el.id === `p1-step-${n}`));
  document.querySelectorAll(".p1-step-tab").forEach((el) => el.classList.toggle("active", Number(el.dataset.step) === n));
  if (n === 2) fillForm(P.idx);
  window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ---------------- 图片识别 ---------------- */
function showDetectError(msg) {
  const el = $("#p1-detect-error");
  el.style.display = "";
  el.className = "notice";
  el.innerHTML = `<span>⚠</span><span>${esc(msg)}</span>`;
}
function clearDetectError() { $("#p1-detect-error").style.display = "none"; }

function renderDetect(d) {
  P.detect = d;
  P.gangue = (d.stones || []).filter((s) => s.cls === 1);
  const other = (d.stones || []).filter((s) => s.cls !== 1);
  $("#p1-drop").style.display = "none";
  $("#p1-image-box").style.display = "";
  $("#p1-result-img").src = d.image_url;
  $("#p1-image-badge").textContent = `${d.width}×${d.height} · ${d.device} · ${d.total} 个目标`;
  const q = d.quality || {};
  $("#p1-quality").innerHTML = `
    <div class="q-item"><div class="k"><span>清晰度</span><span class="tag ${q.sharpness >= 0.0012 ? "good" : "mid"}">${esc(q.sharpness_level || "—")}</span></div><div class="v">${fmt(q.sharpness, 4)}</div></div>
    <div class="q-item"><div class="k"><span>噪声 σ</span><span class="tag ${q.noise <= 0.012 ? "good" : "mid"}">${esc(q.noise_level || "—")}</span></div><div class="v">${fmt(q.noise, 3)}</div></div>
    <div class="q-item"><div class="k"><span>光照均匀度</span><span class="tag ${q.uniformity >= .75 ? "good" : "mid"}">${esc(q.uniformity_level || "—")}</span></div><div class="v">${fmt(q.uniformity, 3)}</div></div>
    <div class="q-item"><div class="k"><span>色彩可用</span><span class="tag ${q.color_usable ? "good" : "mid"}">${q.color_usable ? "可用" : "受限"}</span></div><div class="v">${q.color_usable ? "是" : "否"}</div></div>`;
  $("#p1-detect-sub").textContent = `${d.total} 个目标 · 矸石 ${P.gangue.length} 块`;
  $("#p1-counts").innerHTML = `
    <span class="count-pill">目标 <b>${d.total}</b></span>
    <span class="count-pill" style="border-color:rgba(239,68,68,.45)">矸石 <b>${P.gangue.length}</b></span>
    <span class="count-pill">煤块 <b>${(d.counts || {})["煤块"] || 0}</b></span>
    <span class="count-pill">其他杂石 <b>${(d.counts || {})["其他杂石"] || 0}</b></span>`;
  if (!P.gangue.length) {
    $("#p1-stone-body").innerHTML = `<tr><td colspan="5"><div class="empty" style="border:0">图中没有可参与实验报告的矸石；煤块和其他杂石不进入煤矸石工艺路线。</div></td></tr>`;
    $("#p1-to-forms").disabled = true;
    showDetectError("未识别到矸石：端口一仅对矸石生成实验报告。请更换图片或降低 conf。");
    return;
  }
  clearDetectError();
  $("#p1-stone-body").innerHTML = (d.stones || []).map((s) => {
    const feat = s.feature || {};
    const chips = ["D", "L", "G", "T", "S"].map((k) => feat[k] ? `<span class="phys-chip">${esc(feat[k].code)} ${esc(feat[k].name)}</span>` : "").join("");
    const can = s.cls === 1;
    return `<tr class="${can ? "" : "dim-row"}">
      <td><span class="id-badge">${esc(s.id)}</span></td>
      <td><span class="tag ${s.cls === 0 ? "good" : s.cls === 1 ? "bad" : ""}">${esc(s.cls_name)}</span></td>
      <td class="mono">${fmt(s.conf, 2)}</td>
      <td>${chips || "—"}</td>
      <td>${can ? `<span class="chip ok" style="padding:1px 6px;font-size:10px">进入</span>` : `<span style="color:var(--dim);font-size:10px">不进入</span>`}</td>
    </tr>`;
  }).join("");
  $("#p1-to-forms").disabled = false;
  P.forms = P.gangue.map((stone, i) => makeForm(stone, i));
}

function makeForm(stone, index) {
  const s = P.samples[index % Math.max(1, P.samples.length)] || {};
  const inp = s.inputs || {};
  const q = s.quality || {};
  return {
    stone, sample: s,
    data: {
      chemical: {
        SiO2: inp.SiO2, Al2O3: inp.Al2O3, Fe2O3: inp.Fe2O3, CaO: inp.CaO,
        MgO: inp.MgO, SO3: inp.SO3, K2O: inp.K2O, Na2O: inp.Na2O, LOI: inp.LOI,
      },
      industrial: { ash: inp.ash, volatile: inp.volatile, FC: inp.FC, St: inp.St, Qnet: inp.Qnet },
      xrd: { kaolinite: inp.kaolinite, quartz: inp.quartz, illite: inp.illite, chlorite: inp.chlorite, calcite: inp.calcite, pyrite: inp.pyrite },
      environment: { pH: q.pH, heavy_metal: q.heavy_metal || "符合I类一般工业固废(可生态回填/农用)", radioactivity: q.radioactivity || "符合A类建材(产销与使用范围不受限)" },
      meta: {
        province: s.meta?.province || "山西", city: s.meta?.city || "太原市", coalfield: s.meta?.coalfield || "西山煤田",
        source_type: s.meta?.source_type || "新鲜原矸(RAW)", color: s.meta?.color || "灰黑色/深灰色", petrology: s.meta?.petrology || "高岭石型(粘土岩类)",
      },
      requirements: { desired_route: "", priority: "balanced", sulfur_control: false, fine_grinding: false },
    },
  };
}

async function uploadFile(file) {
  if (!file) return;
  const ext = (file.name.split(".").pop() || "").toLowerCase();
  if (!SUPPORTED.includes(ext)) { toast(`不支持的图片格式 .${ext}，请用 JPG/JPEG/PNG/BMP/WEBP/TIF`, "err"); return; }
  clearDetectError();
  $("#p1-image-box").style.display = "none";
  $("#p1-detect-sub").textContent = "识别中…";
  $("#p1-to-forms").disabled = true;
  const fd = new FormData();
  fd.append("file", file);
  fd.append("conf", "0.25");
  fd.append("iou", "0.45");
  try {
    const d = await api("/api/detect", { method: "POST", body: fd });
    renderDetect(d);
    toast(`识别完成：${d.total} 个目标，${P.gangue.length} 块矸石`, "ok");
  } catch (e) {
    showDetectError("识别失败：" + e.message);
    $("#p1-detect-sub").textContent = "识别失败";
    toast("识别失败：" + e.message, "err");
  }
}

async function loadDemoImage() {
  clearDetectError();
  $("#p1-detect-sub").textContent = "识别中…";
  $("#p1-to-forms").disabled = true;
  try {
    const d = await api("/api/detect", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "tests/images/case_a.jpg", conf: 0.25, iou: 0.45 }) });
    renderDetect(d);
    toast(`测试图识别完成：${P.gangue.length} 块矸石`, "ok");
  } catch (e) {
    showDetectError("识别失败：" + e.message);
    $("#p1-detect-sub").textContent = "识别失败";
  }
}

/* ---------------- 逐石表单 ---------------- */
function fillForm(index) {
  if (!P.forms.length) return;
  P.idx = Math.max(0, Math.min(index, P.forms.length - 1));
  const f = P.forms[P.idx];
  const d = f.data;
  $("#p1-form-sub").textContent = `第 ${P.idx + 1} / ${P.forms.length} 块 · ${f.stone.id}`;
  $("#p1-progress-bar").style.width = `${((P.idx + 1) / P.forms.length) * 100}%`;
  const feat = f.stone.feature || {};
  const chips = ["D", "L", "G", "T", "S"].map((k) => feat[k] ? `<span class="phys-chip">${esc(feat[k].code)} ${esc(feat[k].name)}</span>` : "").join("");
  $("#p1-stone-head").innerHTML = `<span class="id-badge">${esc(f.stone.id)}</span>
    <span class="tag ${f.stone.cls === 1 ? "bad" : "good"}">${esc(f.stone.cls_name)}</span>
    <span class="mono" style="font-size:10px;color:var(--dim)">conf ${fmt(f.stone.conf, 2)}</span>
    <div class="phys-chips">${chips}</div>
    <span class="sample-tag">测试默认 ${esc(f.sample.label || f.sample.id || "库内行")}</span>`;
  setVal("p1-province", d.meta.province); setVal("p1-city", d.meta.city); setVal("p1-coalfield", d.meta.coalfield);
  setVal("p1-source", d.meta.source_type); setVal("p1-color", d.meta.color); setVal("p1-petrology", d.meta.petrology);
  ["SiO2", "Al2O3", "Fe2O3", "CaO", "MgO", "SO3", "K2O", "Na2O", "LOI"].forEach((k) => setVal("p1-c-" + k, d.chemical[k]));
  ["ash", "volatile", "FC", "St", "Qnet"].forEach((k) => setVal("p1-i-" + k, d.industrial[k]));
  ["kaolinite", "quartz", "illite", "chlorite", "calcite", "pyrite"].forEach((k) => setVal("p1-x-" + k, d.xrd[k]));
  setVal("p1-e-pH", d.environment.pH);
  setVal("p1-e-heavy", d.environment.heavy_metal);
  setVal("p1-e-radio", d.environment.radioactivity);
  setVal("p1-r-desired", d.requirements.desired_route || "");
  setVal("p1-r-priority", d.requirements.priority || "balanced");
  setVal("p1-r-sulfur", String(!!d.requirements.sulfur_control));
  setVal("p1-r-fine", String(!!d.requirements.fine_grinding));
  $("#p1-form-error").style.display = "none";
  $("#p1-prev").disabled = P.idx === 0;
  $("#p1-save-next").style.display = P.idx === P.forms.length - 1 ? "none" : "";
  $("#p1-generate").style.display = P.idx === P.forms.length - 1 ? "" : "none";
}

function readForm() {
  const chemical = {}, industrial = {}, xrd = {};
  ["SiO2", "Al2O3", "Fe2O3", "CaO", "MgO", "SO3", "K2O", "Na2O", "LOI"].forEach((k) => { chemical[k] = softNum("p1-c-" + k); });
  ["ash", "volatile", "FC", "St", "Qnet"].forEach((k) => { industrial[k] = softNum("p1-i-" + k); });
  ["kaolinite", "quartz", "illite", "chlorite", "calcite", "pyrite"].forEach((k) => { xrd[k] = softNum("p1-x-" + k); });
  return {
    chemical, industrial, xrd,
    environment: { pH: softNum("p1-e-pH"), heavy_metal: $("#p1-e-heavy").value, radioactivity: $("#p1-e-radio").value },
    meta: {
      province: $("#p1-province").value.trim(), city: $("#p1-city").value.trim(), coalfield: $("#p1-coalfield").value.trim(),
      source_type: $("#p1-source").value, color: $("#p1-color").value.trim(), petrology: $("#p1-petrology").value.trim(),
    },
    requirements: {
      desired_route: $("#p1-r-desired").value, priority: $("#p1-r-priority").value,
      sulfur_control: $("#p1-r-sulfur").value === "true", fine_grinding: $("#p1-r-fine").value === "true",
    },
  };
}

function validateCurrent(show = true) {
  const missing = [];
  REQUIRED.forEach(([id, label]) => {
    const v = $("#" + id).value.trim();
    if (v === "") missing.push(label);
    else if ($("#" + id).type === "number" && !Number.isFinite(Number(v))) missing.push(label);
  });
  if (!missing.length) return true;
  if (show) {
    const el = $("#p1-form-error");
    el.style.display = "";
    el.className = "notice";
    el.innerHTML = `<span>⚠</span><span>第 ${P.idx + 1} 块缺少必填项：<b>${missing.map(esc).join("、")}</b>。全部填写后才能生成方案。</span>`;
    toast(`请先补全：${missing.slice(0, 4).join("、")}${missing.length > 4 ? "…" : ""}`, "err");
  }
  return false;
}

function saveCurrent(validate = true) {
  if (validate && !validateCurrent(true)) return false;
  P.forms[P.idx].data = readForm();
  return true;
}

function nextForm() {
  if (!saveCurrent(true)) return;
  if (P.idx < P.forms.length - 1) { P.idx += 1; fillForm(P.idx); window.scrollTo({ top: 0, behavior: "smooth" }); }
}
function prevForm() {
  saveCurrent(false);
  if (P.idx > 0) { P.idx -= 1; fillForm(P.idx); window.scrollTo({ top: 0, behavior: "smooth" }); }
}

function validateAll() {
  if (!P.forms.length) return false;
  for (let i = 0; i < P.forms.length; i++) {
    if (i === P.idx) { if (!validateCurrent(true)) { return false; } P.forms[i].data = readForm(); }
  }
  const labels = {};
  for (let i = 0; i < P.forms.length; i++) {
    const d = P.forms[i].data;
    const miss = [];
    const map = [
      ["chemical.SiO2", "SiO₂"], ["chemical.Al2O3", "Al₂O₃"], ["chemical.Fe2O3", "Fe₂O₃"], ["chemical.CaO", "CaO"],
      ["chemical.MgO", "MgO"], ["chemical.SO3", "SO₃"], ["chemical.K2O", "K₂O"], ["chemical.Na2O", "Na₂O"], ["chemical.LOI", "LOI"],
      ["industrial.ash", "灰分"], ["industrial.volatile", "挥发分"], ["industrial.FC", "固定碳"], ["industrial.St", "全硫"], ["industrial.Qnet", "发热量"],
      ["environment.pH", "pH"], ["meta.province", "省份"], ["meta.city", "城市"], ["meta.coalfield", "煤田"],
      ["meta.source_type", "样品状态"], ["meta.color", "颜色"], ["meta.petrology", "岩相"],
      ["xrd.kaolinite", "高岭石"], ["xrd.quartz", "石英"], ["xrd.illite", "伊利石"],
      ["xrd.chlorite", "绿泥石"], ["xrd.calcite", "方解石"], ["xrd.pyrite", "黄铁矿"],
    ];
    for (const [path, label] of map) {
      const val = path.split(".").reduce((o, k) => (o == null ? null : o[k]), d);
      if (val == null || val === "" || (typeof val === "number" && !Number.isFinite(val))) miss.push(label);
    }
    if (miss.length) { labels[i + 1] = miss; }
  }
  const bad = Object.keys(labels);
  if (bad.length) {
    const first = Number(bad[0]) - 1;
    P.idx = first; fillForm(first);
    const el = $("#p1-form-error");
    el.style.display = "";
    el.innerHTML = `<span>⚠</span><span>第 ${bad.join("、")} 块仍有必填项未完成，不能生成处理方案。已跳转到第 ${first + 1} 块。</span>`;
    toast(`第 ${bad.join("、")} 块未填完整`, "err");
    return false;
  }
  return true;
}

/* ---------------- 生成与思考动画 ---------------- */
function thinkingProgress() {
  let pct = 0;
  $("#p1-thinking").classList.add("show");
  $("#p1-thinking-bar").style.width = "0%";
  $("#p1-thinking-pct").textContent = "0%";
  clearInterval(P.thinkingTimer);
  P.thinkingTimer = setInterval(() => {
    pct = Math.min(94, pct + Math.max(0.6, (94 - pct) * 0.035));
    $("#p1-thinking-bar").style.width = pct.toFixed(0) + "%";
    $("#p1-thinking-pct").textContent = pct.toFixed(0) + "%";
  }, 80);
}
function endThinking() {
  clearInterval(P.thinkingTimer);
  $("#p1-thinking-bar").style.width = "100%";
  $("#p1-thinking-pct").textContent = "100%";
  setTimeout(() => $("#p1-thinking").classList.remove("show"), 260);
}

async function generatePlans() {
  if (!validateAll()) return;
  showStep(3);
  $("#p1-results").style.display = "none";
  $("#p1-result-actions").style.display = "none";
  thinkingProgress();
  const body = {
    thinking_seconds: 2, use_llm: true,
    stones: P.forms.map((f, i) => ({ ...f.data, id: f.stone.id, feature: f.stone.feature, sample_id: f.sample.id || "" })),
  };
  try {
    const d = await api("/api/precision/batch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    await new Promise((r) => setTimeout(r, 520));
    endThinking();
    P.results = d.results || [];
    renderResults(d);
  } catch (e) {
    endThinking();
    $("#p1-results").style.display = "";
    $("#p1-results").innerHTML = `<div class="notice"><span>⚠</span><span>方案生成失败：${esc(e.message)}</span></div>`;
    $("#p1-result-actions").style.display = "";
  }
}

/* ---------------- 数据流图 ---------------- */
function wrapText(text, width = 7) {
  const s = String(text || "");
  const lines = [];
  for (let i = 0; i < s.length; i += width) lines.push(s.slice(i, i + width));
  return lines.slice(0, 3);
}
function flowSVG(chain, code) {
  const nodes = ["原矸 / 实验指标", ...(chain || []), "产品 / 去向"];
  const cols = 5, rows = Math.ceil(nodes.length / cols);
  const bw = 155, bh = 56, gapX = 32, gapY = 58, x0 = 24, y0 = 28;
  const width = x0 * 2 + cols * bw + (cols - 1) * gapX;
  const height = y0 * 2 + rows * bh + (rows - 1) * gapY;
  const pos = [];
  for (let i = 0; i < nodes.length; i++) {
    const row = Math.floor(i / cols);
    let col = i % cols;
    if (row % 2 === 1) col = cols - 1 - col;
    pos.push({ x: x0 + col * (bw + gapX), y: y0 + row * (bh + gapY) });
  }
  const escX = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  let svg = `<svg class="flow-svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escX(code)} 八工序数据流图">`;
  svg += `<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0,0 L8,4 L0,8 z" fill="rgba(125,211,252,.8)"/></marker></defs>`;
  for (let i = 0; i < nodes.length - 1; i++) {
    const a = pos[i], b = pos[i + 1];
    const ay = a.y + bh / 2;
    const by = b.y + bh / 2;
    if (a.y === b.y) {
      const rightward = b.x > a.x;
      const ax = rightward ? a.x + bw : a.x;
      const bx = rightward ? b.x - 4 : b.x + bw + 4;
      svg += `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="rgba(125,211,252,.45)" stroke-width="1.6" marker-end="url(#arrow)"/>`;
    } else {
      svg += `<path d="M ${a.x + bw / 2} ${a.y + bh} L ${a.x + bw / 2} ${b.y - 16} L ${b.x + bw / 2} ${b.y - 16} L ${b.x + bw / 2} ${b.y - 4}" fill="none" stroke="rgba(125,211,252,.45)" stroke-width="1.6" marker-end="url(#arrow)"/>`;
    }
  }
  nodes.forEach((label, i) => {
    const p = pos[i];
    const isEnd = i === 0 || i === nodes.length - 1;
    const fill = isEnd ? "rgba(34,197,94,.13)" : "rgba(56,189,248,.09)";
    const stroke = isEnd ? "rgba(74,222,128,.55)" : "rgba(125,211,252,.4)";
    svg += `<rect x="${p.x}" y="${p.y}" width="${bw}" height="${bh}" rx="9" fill="${fill}" stroke="${stroke}"/>`;
    svg += `<text x="${p.x + 10}" y="${p.y + 18}" fill="${isEnd ? "#86efac" : "#7dd3fc"}" font-size="9" font-family="monospace">${String(i).padStart(2, "0")} ${isEnd ? (i === 0 ? "INPUT" : "OUTPUT") : "STEP"}</text>`;
    wrapText(label, 8).forEach((line, k) => {
      svg += `<text x="${p.x + 10}" y="${p.y + 33 + k * 13}" fill="#dbeafe" font-size="9.5">${escX(line)}</text>`;
    });
  });
  svg += `</svg>`;
  return svg;
}

/* ---------------- 结果渲染 ---------------- */
function planBlock(r, i) {
  const p = r.primary || {};
  const plan = r.llm_plan || null;
  const params = Object.entries(p.parameters || {}).map(([k, v]) => `<div class="param-item"><b>${esc(k)}</b>${esc(v)}</div>`).join("") || "—";
  const reqs = (p.requirements || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>按标准小试/中试验证</li>";
  const tests = (r.required_tests || []).map((x) => `<span class="sub-chip">${esc(x)}</span>`).join("") || `<span style="color:var(--dim)">—</span>`;
  const risks = (r.risks || []).map((x) => `<div class="risk-card ${x.severity === "high" ? "high" : ""}"><div class="rt">${x.severity === "high" ? "⛔" : "⚠"} ${esc(x.title)}</div><p>${esc(x.message)}</p></div>`).join("");
  const qc = (plan && plan.quality_control || []).map((x) => `<li>${esc(x)}</li>`).join("");
  const rc = (plan && plan.risk_control || []).map((x) => `<li>${esc(x)}</li>`).join("");
  return `<article class="plan-card" data-plan-index="${i}" title="双击查看本块实验指标">
    <div class="plan-head">
      <div class="plan-no">${String(i + 1).padStart(2, "0")}</div>
      <div><div class="plan-stone">${esc(r.id)} · ${esc(r.stone_name || "矸石")}</div>
        <div class="plan-title">${esc(p.name || "—")}</div></div>
      <div class="plan-route">${esc(p.route_code || "")}<span>${esc(p.confidence || "中")}</span></div>
    </div>
    <div class="plan-meta"><span class="chip" style="padding:1px 7px;font-size:10px">${esc(p.category || "")}</span><span class="mono" style="font-size:10px;color:var(--dim)">${esc(p.standard || "")}</span><span class="mono" style="font-size:10px;color:var(--dim)">双击看指标</span></div>
    <div class="result-block"><h4>数据流图 · 八工序</h4>${flowSVG(p.process_chain, p.route_code)}</div>
    ${p.products ? `<div class="result-block"><h4>目标产品</h4><div class="plan-text">${esc(p.products)}</div></div>` : ""}
    <div class="result-block"><h4>关键参数</h4><div class="param-grid">${params}</div></div>
    <div class="result-block"><h4>路线要求</h4><ul class="req-list">${reqs}</ul></div>
    ${plan && plan.summary ? `<div class="result-block"><h4>处理方案</h4><div class="plan-text">${esc(plan.summary)}</div></div>` : ""}
    ${qc ? `<div class="result-block"><h4>质量控制</h4><ul class="req-list">${qc}</ul></div>` : ""}
    ${rc ? `<div class="result-block"><h4>风险控制</h4><ul class="req-list">${rc}</ul></div>` : ""}
    ${risks}
    <div class="result-block"><h4>必须补检</h4><div class="sub-list">${tests}</div></div>
  </article>`;
}

function renderResults(d) {
  $("#p1-results").style.display = "";
  $("#p1-result-actions").style.display = "";
  const cards = (d.results || []).map((r, i) => {
    // attach stone metadata for display
    const f = P.forms[i];
    if (f) r.stone_name = f.stone.cls_name;
    return planBlock(r, i);
  }).join("");
  const llm = d.llm_configured ? `<span class="chip ok" style="padding:2px 8px;font-size:10px">在线 ${esc(d.llm_model || "GLM")}</span>` : `<span class="chip warn" style="padding:2px 8px;font-size:10px">离线知识库</span>`;
  $("#p1-results").innerHTML = `<div class="notice cyan" style="margin-bottom:10px"><span>✧</span><span>已按图片编号顺序生成 <b>${(d.results || []).length}</b> 份处理方案；${llm}。方案只给处理步骤，不解释原因。双击任一方案查看本块实验指标。</span></div>
    <div class="plan-list">${cards}</div>
    <div class="notice" style="margin-top:12px"><span>⚠</span><span>方案用于工程筛选，不替代小试/中试与重金属、放射性、安定性检测；缺项实验报告不会生成方案。</span></div>`;
  document.querySelectorAll(".plan-card").forEach((el) => el.addEventListener("dblclick", () => openMetrics(Number(el.dataset.planIndex))));
}

function openMetrics(index) {
  const f = P.forms[index] || P.forms[0];
  if (!f) return;
  const d = f.data;
  $("#p1-metrics-title").textContent = `第 ${index + 1} 块 · ${f.stone.id} · ${f.stone.cls_name}`;
  const row = (k, v, u = "") => `<tr><td>${esc(k)}</td><td class="num">${v == null || v === "" ? "—" : esc(v) + (u ? " " + esc(u) : "")}</td></tr>`;
  const chem = Object.entries(d.chemical).map(([k, v]) => row(k, v, "%")).join("");
  const ind = Object.entries(d.industrial).map(([k, v]) => row(k, v, k === "Qnet" ? "MJ/kg" : "%")).join("");
  const xrd = Object.entries(d.xrd).map(([k, v]) => row(k, v, "%")).join("");
  $("#p1-metrics-body").innerHTML = `<div class="notice cyan" style="margin-bottom:10px"><span>ⓘ</span><span>本块方案使用的实验报告指标；测试阶段默认来自库内行，可返回修改。</span></div>
    <div class="grid-2" style="gap:12px">
      <div><h4 style="color:#7dd3fc;font-size:11px">XRF 化学成分</h4><table class="metric-table"><tbody>${chem}</tbody></table></div>
      <div><h4 style="color:#7dd3fc;font-size:11px">工业分析/热工</h4><table class="metric-table"><tbody>${ind}</tbody></table>
        <h4 style="color:#7dd3fc;font-size:11px;margin-top:10px">环境</h4><table class="metric-table"><tbody>${row("pH", d.environment.pH)}${row("重金属", d.environment.heavy_metal)}${row("放射性", d.environment.radioactivity)}</tbody></table></div>
    </div>
    <div style="margin-top:10px"><h4 style="color:#7dd3fc;font-size:11px">XRD（实验报告）</h4><table class="metric-table"><tbody>${xrd || `<tr><td colspan="2">未填写</td></tr>`}</tbody></table></div>`;
  $("#p1-metrics-modal").classList.add("show");
}

/* ---------------- 配置 ---------------- */
function fillConfig() {
  const llm = (P.template && P.template.llm) || {};
  setVal("p1-cfg-provider", llm.provider || "zhipu");
  setVal("p1-cfg-base", llm.base_url || "https://open.bigmodel.cn/api/paas/v4");
  setVal("p1-cfg-model", llm.model || "glm-4.5-flash");
  setVal("p1-cfg-protocol", "openai");
  setVal("p1-cfg-key", "");
  $("#p1-cfg-status").className = "notice";
  $("#p1-cfg-status").innerHTML = `<span>ⓘ</span><span>${llm.configured ? "已配置：" + esc(llm.model) : "未配置 Key；将使用离线知识库。"}</span>`;
}
async function saveConfig(test = false) {
  const body = {
    provider: $("#p1-cfg-provider").value.trim(), base_url: $("#p1-cfg-base").value.trim(),
    model: $("#p1-cfg-model").value.trim(), protocol: $("#p1-cfg-protocol").value,
    api_key: $("#p1-cfg-key").value.trim(),
  };
  try {
    const d = await api("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    P.template.llm = { ...(P.template.llm || {}), configured: d.configured, model: d.model, base_url: d.base_url, provider: body.provider };
    renderLLMChip();
    $("#p1-cfg-status").innerHTML = `<span>✓</span><span>已保存：${esc(d.model)} @ ${esc(d.base_url)}</span>`;
    if (test) {
      $("#p1-cfg-status").innerHTML = `<span>⏳</span><span>测试中…</span>`;
      const t = await api("/api/test_llm", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      $("#p1-cfg-status").className = "notice green";
      $("#p1-cfg-status").innerHTML = `<span>✓</span><span>连通成功 · ${esc(t.model)} · ${t.latency}s</span>`;
    }
  } catch (e) {
    $("#p1-cfg-status").className = "notice";
    $("#p1-cfg-status").innerHTML = `<span>✗</span><span>${esc(e.message)}</span>`;
  }
}
function renderLLMChip() {
  const llm = (P.template && P.template.llm) || {};
  $("#chip-llm").className = "chip " + (llm.configured ? "ok" : "warn");
  $("#chip-llm").innerHTML = `<i class="dot"></i>模型 <b>${llm.configured ? esc(llm.model || "GLM") : "离线规则"}</b>`;
}

/* ---------------- 初始化 ---------------- */
async function init() {
  try {
    const d = await api("/api/precision/template");
    P.template = d; P.samples = d.samples || [];
    $("#hero-routes").textContent = String((d.routes || []).length || 12);
    $("#hero-rules").textContent = String((d.risk_rules || []).length || 8);
    $("#chip-kb").innerHTML = `<i class="dot"></i>知识库 <b>${(d.routes || []).length} 条</b>`;
    const sel = $("#p1-r-desired");
    sel.innerHTML += (d.routes || []).map((r) => `<option value="${esc(r.id)}">${esc(r.id)} · ${esc(r.name)}</option>`).join("");
    renderLLMChip();
    fillConfig();
  } catch (e) {
    toast("模板加载失败：" + e.message, "err");
  }
  const drop = $("#p1-drop");
  drop.addEventListener("click", () => $("#p1-file").click());
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files && e.dataTransfer.files[0]; if (f) uploadFile(f); });
  $("#p1-file").addEventListener("change", (e) => { const f = e.target.files && e.target.files[0]; if (f) uploadFile(f); });
  $("#p1-btn-clear").addEventListener("click", () => { $("#p1-image-box").style.display = "none"; $("#p1-drop").style.display = ""; $("#p1-file").value = ""; P.detect = null; P.gangue = []; P.forms = []; $("#p1-to-forms").disabled = true; $("#p1-stone-body").innerHTML = `<tr><td colspan="5"><div class="empty" style="min-height:160px;border:0">上传图片后显示编号、类别和 D/L/G/T/S</div></td></tr>`; });
  $("#p1-btn-demo").addEventListener("click", loadDemoImage);
  $("#p1-to-forms").addEventListener("click", () => { if (!P.forms.length) { toast("没有可填写报告的矸石", "err"); return; } P.idx = 0; showStep(2); });
  $("#p1-prev").addEventListener("click", prevForm);
  $("#p1-save-next").addEventListener("click", nextForm);
  $("#p1-generate").addEventListener("click", generatePlans);
  $("#p1-back-forms").addEventListener("click", () => showStep(2));
  $("#p1-restart").addEventListener("click", () => { P.results = []; P.forms = []; P.detect = null; showStep(1); $("#p1-image-box").style.display = "none"; $("#p1-drop").style.display = ""; $("#p1-to-forms").disabled = true; });
  $("#btn-config").addEventListener("click", () => { fillConfig(); $("#p1-config-modal").classList.add("show"); });
  $("#p1-cfg-save").addEventListener("click", () => saveConfig(false));
  $("#p1-cfg-test").addEventListener("click", () => saveConfig(true));
  document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => $("#" + b.dataset.close).classList.remove("show")));
  document.querySelectorAll(".modal-mask").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.classList.remove("show"); }));
  document.querySelectorAll(".p1-step-tab").forEach((t) => t.addEventListener("click", () => {
    const n = Number(t.dataset.step);
    if (n === 2 && !P.forms.length) { toast("请先上传图片并识别矸石", "err"); return; }
    if (n === 3 && !P.results.length) { toast("请先完成所有实验报告并生成方案", "err"); return; }
    showStep(n);
  }));
}

init();
