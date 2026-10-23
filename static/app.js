/* app.js —— 三步式演示前端逻辑 */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const S = {
  meta: null,
  detect: null,
  prediction: null,
  recommend: null,
  area: null,
  inputs: {},
  llm: null,
  step: 1,
  stoneSamples: [],
  stoneRefs: {},
  stoneInputs: {},
  activeCase: null,
};

const DEFAULT_LLM = {
  zhipu: { base: "https://open.bigmodel.cn/api/paas/v4", model: "glm-4.5-flash", protocol: "openai" },
  zhipu_coding: { base: "https://open.bigmodel.cn/api/coding/paas/v4", model: "glm-4.5-flash", protocol: "openai" },
  zhipu_anthropic: { base: "https://open.bigmodel.cn/api/anthropic", model: "glm-4.5-flash", protocol: "anthropic" },
  zai: { base: "https://api.z.ai/api/coding/paas/v4", model: "glm-4.5-flash", protocol: "openai" },
  zai_anthropic: { base: "https://api.z.ai/api/anthropic", model: "glm-4.5-flash", protocol: "anthropic" },
  zcode_plan: { base: "https://zcode.z.ai/api/v1/zcode-plan/anthropic", model: "GLM-5.3-Flash", protocol: "anthropic" },
};

/* ---------------- 通用 ---------------- */
function esc(s) {
  return String(s == null ? "" : s)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function fmt(v, n = 2) {
  const x = Number(v);
  return Number.isFinite(x) ? x.toFixed(n) : "—";
}
function toast(msg, type = "") {
  const el = document.createElement("div");
  el.className = "toast " + type;
  el.textContent = msg;
  $("#toast-wrap") || document.body.insertAdjacentHTML("beforeend", '<div class="toast-wrap" id="toast-wrap"></div>');
  $("#toast-wrap").appendChild(el);
  setTimeout(() => { el.style.opacity = "0"; el.style.transition = ".3s"; setTimeout(() => el.remove(), 320); }, 3600);
}
async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  let data = null;
  try { data = await res.json(); } catch (e) { data = { ok: false, error: "响应不是 JSON" }; }
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `请求失败（HTTP ${res.status}）`);
  }
  return data;
}

/* ---------------- 步骤切换 ---------------- */
function goStep(n) {
  if (n === 2 && !S.detect) { toast("请先在第一步上传并识别图片", "err"); return; }
  if (n === 2 && !usableStones().length) { toast("当前图片没有可参与预测的矸石", "err"); return; }
  if (n === 3 && !S.prediction) { toast("请先在第二步完成成分预测", "err"); return; }
  if (n === 3 && S.prediction && !(S.prediction.rows || []).length) { toast("没有可推荐工艺的矸石", "err"); return; }
  S.step = n;
  $$(".step-tab").forEach((el) => el.classList.toggle("active", Number(el.dataset.step) === n));
  $$(".step-panel").forEach((el) => el.classList.toggle("active", el.id === `panel-${n}`));
  if (n === 2) refreshStoneFeatureChips();
  window.scrollTo({ top: 0, behavior: "smooth" });
}
function markDone(n, done) {
  const el = $(`.step-tab[data-step="${n}"]`);
  if (el) el.classList.toggle("done", !!done);
}

/* ---------------- 初始化 ---------------- */
async function init() {
  try {
    S.meta = await api("/api/meta");
  } catch (e) {
    toast("后端未就绪：" + e.message, "err");
    return;
  }
  const m = S.meta;
  $("#chip-device").classList.add("ok");
  $("#chip-device").innerHTML = `<i class="dot"></i>设备 <b>${esc(m.device)}</b>`;
  $("#device-sub").textContent = `推理设备 ${m.device}`;
  $("#chip-model").classList.add("ok");
  $("#chip-model").innerHTML = `<i class="dot"></i>模型 <b>${Object.keys(m.metrics || {}).length} 个</b>`;
  renderLLMChip(m.llm);
  renderAreas(m.areas || []);
  renderModelGrid(m.metrics || {});
  renderExamples();
  await loadDemoSamples();
  renderStoneInputs();
  $("#rule-note").textContent = "";
  markDone(1, false);
}

function renderLLMChip(llm) {
  const el = $("#chip-llm");
  if (llm && llm.configured) {
    el.className = "chip ok";
    el.innerHTML = `<i class="dot"></i>LLM <b>${esc(llm.model)}</b>`;
    $("#llm-sub").textContent = `${llm.model} · 已配置`;
  } else {
    el.className = "chip warn";
    el.innerHTML = `<i class="dot"></i>LLM <b>离线知识库</b>`;
    $("#llm-sub").textContent = "未配置 API · 使用离线知识库";
  }
}

/* ---------------- 逐石指标输入（第一步 → 第二步） ---------------- */
function usableStones() {
  return (((S.detect && S.detect.stones) || [])).filter((s) => s.cls === 1);
}

function chipText(v) {
  const name = String(v && v.name || "");
  const code = String(v && v.code || "");
  return name.startsWith(code) ? name : `${code} ${name}`;
}

function featureChips(feature) {
  const keys = [["D", "粒径"], ["L", "明度"], ["G", "光泽"], ["T", "粗糙度"], ["S", "形状"]];
  return keys.map(([k, label]) => {
    const v = feature && feature[k];
    if (!v) return "";
    return `<span class="phys-chip" title="${esc(label)}">${esc(chipText(v))}</span>`;
  }).join("");
}

function caseToSample(c) {
  const measured = { ...(c.measured || {}) };
  if (measured.LOI烧失量 == null && c.inputs) measured.LOI烧失量 = c.inputs["LOI烧失量"];
  return {
    sample_id: c.sample_id, title: c.title || c.sample_id,
    inputs: c.inputs || {}, measured,
    source: "测试集配对行", note: "来自测试集 A/B/C 的库内实测行",
  };
}

function sampleForStone(index) {
  const list = S.stoneSamples || [];
  if (S.activeCase) {
    if (Array.isArray(S.activeCase.stone_samples) && S.activeCase.stone_samples[index]) {
      return S.activeCase.stone_samples[index];
    }
    if (index === 0) return caseToSample(S.activeCase);
    if (!list.length) return null;
    return list[(index - 1) % list.length];
  }
  if (!list.length) return null;
  return list[index % list.length];
}

function stoneFieldHTML(f, stoneId) {
  const val = f.value == null ? "" : f.value;
  return `<div class="field">
    <label title="${esc(f.tip || "")}"><b>${esc(f.label)}</b><span class="hint">${esc(f.unit || "")}</span></label>
    <div class="input-unit">
      <input type="number" data-stone="${esc(stoneId)}" data-key="${esc(f.key)}"
        value="${esc(val)}" min="${f.range[0]}" max="${f.range[1]}" step="${f.step}"
        inputmode="decimal">
      <span class="unit">${esc(f.unit || "")}</span>
    </div>
  </div>`;
}

function stoneCardHTML(st, sample, index) {
  const schema = (S.meta && S.meta.schema) || [];
  const optional = ["高岭石", "伊利石", "石英"];
  const main = schema.filter((f) => !optional.includes(f.key))
    .map((f) => stoneFieldHTML({ ...f, value: sample && sample.inputs ? sample.inputs[f.key] : "" }, st.id))
    .join("");
  const xrd = schema.filter((f) => optional.includes(f.key))
    .map((f) => stoneFieldHTML({ ...f, value: sample && sample.inputs ? sample.inputs[f.key] : "" }, st.id))
    .join("");
  const m = (sample && sample.measured) || null;
  const measured = m
    ? `库内实测：LOI <b>${fmt(m.LOI烧失量, 2)}</b> · SiO₂ <b>${fmt(m.SiO2, 2)}</b> · Al₂O₃ <b>${fmt(m.Al2O3, 2)}</b> · Fe₂O₃ <b>${fmt(m.Fe2O3, 2)}</b> · CaO <b>${fmt(m.CaO, 2)}</b>
       <button class="btn ghost sm" data-error-stone="${esc(st.id)}" style="margin-left:6px">误差</button>`
    : `无库内实测值，不参与误差对比`;
  return `<div class="stone-input-card" data-stone="${esc(st.id)}">
    <div class="stone-input-head">
      <span class="id-badge">${esc(st.id)}</span>
      <span class="tag good">${esc(st.cls_name || "矸石")}</span>
      <span class="mono">conf ${fmt(st.conf, 2)}</span>
      <span class="mono" style="font-size:9px;color:#7dd3fc">第一步 CV</span>
      <div class="phys-chips">${featureChips(st.feature)}</div>
      <span class="sample-tag" title="${esc(sample && (sample.title + (sample.source ? " · " + sample.source : "")) || "")}">${sample ? "库内默认 " + esc(sample.sample_id) : "无默认"}</span>
    </div>
    <div class="stone-fields">${main}</div>
    <details class="xrd-details stone-xrd">
      <summary>XRD 可选定量（高岭石 / 伊利石 / 石英）<span>填高岭石 → Al₂O₃ 条件模型</span></summary>
      <div class="stone-fields" style="margin-top:7px">${xrd}</div>
    </details>
    <div class="stone-measured">${measured}</div>
  </div>`;
}

function renderStoneInputs() {
  const box = $("#stone-input-list");
  if (!box) return;
  const stones = usableStones();
  if (!S.detect || !stones.length) {
    box.innerHTML = `<div class="pred-empty" style="min-height:150px"><div class="big">🪨</div>请先在第一步上传图片并识别，或载入「测试集」<br>第二步会按识别到的矸石数量自动生成输入框</div>`;
    $("#stone-link-text").textContent = "先完成第一步图像识别；第二步会按识别到的矸石数量自动生成逐石输入框，并带入 D/L/G/T/S 物理特征。";
    const ln = $("#link-note"); if (ln) ln.style.display = "none";
    return;
  }
  S.stoneRefs = {};
  S.stoneInputs = {};
  box.innerHTML = stones.map((st, i) => {
    const sample = sampleForStone(i);
    if (sample && sample.measured) {
      S.stoneRefs[st.id] = {
        sample_id: sample.sample_id,
        title: sample.title || sample.sample_id,
        measured: sample.measured,
      };
    }
    return stoneCardHTML(st, sample, i);
  }).join("");
  const ids = stones.map((s) => s.id).join("、");
  $("#stone-link-text").innerHTML =
    `第一步识别到 <b style="color:var(--ink)">${stones.length} 块矸石</b>（${esc(ids)}）；已生成 <b style="color:var(--ink)">${stones.length} 组独立输入</b>。` +
    `默认值来自库内真实完整行，可逐石修改；每张卡上方的 D/L/G/T/S 就是第一步的物理特征。`;
  const ln = $("#link-note");
  if (ln) {
    ln.style.display = "";
    $("#link-note-text").innerHTML =
      `第二步已按 <b>${esc(ids)}</b> 生成 ${stones.length} 组输入，并会把 D/L/G/T/S 带到第三步的工艺可行性判断。`;
  }
}

function collectStoneInputs(stoneId) {
  const card = document.querySelector(`.stone-input-card[data-stone="${CSS.escape(stoneId)}"]`);
  const out = {};
  if (!card) return out;
  card.querySelectorAll("input[data-key]").forEach((el) => {
    out[el.dataset.key] = el.value === "" ? null : Number(el.value);
  });
  return out;
}

function collectAllStoneInputs() {
  const out = {};
  usableStones().forEach((s) => { out[s.id] = collectStoneInputs(s.id); });
  return out;
}

function refreshStoneFeatureChips() {
  usableStones().forEach((st) => {
    const card = document.querySelector(`.stone-input-card[data-stone="${CSS.escape(st.id)}"]`);
    if (!card) return;
    const box = card.querySelector(".phys-chips");
    if (box) box.innerHTML = featureChips(st.feature);
  });
}

async function loadDemoSamples() {
  try {
    const d = await api("/api/demo_samples");
    S.stoneSamples = d.samples || [];
    if (S.detect) renderStoneInputs();
  } catch (e) {
    console.warn("逐石示例加载失败", e);
  }
}

function resetStoneDefaults() {
  if (!S.detect) { toast("请先在第一步识别图片", "err"); return; }
  renderStoneInputs();
  resetStep2();
  resetStep3();
  markDone(2, false);
  toast("已恢复为库内逐石默认值", "ok");
}

/* ---------------- 预测误差弹窗 ---------------- */
function errorClass(v) {
  if (!Number.isFinite(v)) return "err-bad";
  if (v < 10) return "err-good";
  if (v < 20) return "err-warn";
  return "err-bad";
}

function showPredictionError(rows, refs, title) {
  if (!rows || !rows.length) { toast("请先完成一次逐石预测", "err"); return; }
  const types = [["SiO2", "SiO₂"], ["Al2O3", "Al₂O₃"], ["Fe2O3", "Fe₂O₃"], ["CaO", "CaO"]];
  const blocks = [];
  const allPct = [];
  let used = 0;
  rows.forEach((r) => {
    const ref = (refs || {})[r.id];
    const measured = (ref && ref.measured) || {};
    if (!ref || !Object.keys(measured).length) return;
    used += 1;
    const trs = types.map(([k, n]) => {
      const pred = Number(r.pred && r.pred[k] && r.pred[k].value);
      const truth = Number(measured[k]);
      const ok = Number.isFinite(pred) && Number.isFinite(truth) && truth !== 0;
      const abs = ok ? Math.abs(pred - truth) : null;
      const pct = ok ? (abs / Math.abs(truth)) * 100 : null;
      if (pct != null && truth >= 1.0) allPct.push(pct);
      const lowTruth = ok && truth < 1.0;
      return `<tr><td><b>${n}</b></td><td class="num">${ok ? fmt(truth, 2) : "—"}</td>
        <td class="num" style="color:#7dd3fc">${ok ? fmt(pred, 2) : "—"}</td>
        <td class="num">${ok ? fmt(abs, 2) : "—"}</td>
        <td class="num"><span class="err-pill ${lowTruth ? "err-warn" : errorClass(pct)}">${ok ? fmt(pct, 1) + "%" : "—"}</span>${lowTruth ? ` <small style="color:var(--dim)" title="真实值小于 1 wt%，相对误差会被放大，不计入 MAPE">低值*</small>` : ""}</td></tr>`;
    }).join("");
    blocks.push(`<div class="err-stone">
      <div class="err-stone-head"><span class="id-badge">${esc(r.id)}</span><b>${esc(ref.sample_id)}</b>
        <span class="mono">LOI ${fmt(measured.LOI烧失量, 2)} · 实测行</span></div>
      <div class="table-wrap"><table class="err-table">
        <thead><tr><th>目标</th><th class="num">真实值 wt%</th><th class="num">预测值 wt%</th><th class="num">绝对误差</th><th class="num">误差百分比</th></tr></thead>
        <tbody>${trs}</tbody></table></div>
    </div>`);
  });
  if (!used) { toast("当前矸石没有库内实测值，无法计算误差", "err"); return; }
  const mape = allPct.length ? allPct.reduce((a, b) => a + b, 0) / allPct.length : null;
  const mt = (S.prediction && S.prediction.metrics) || {};
  const mtText = [["SiO2", "SiO₂"], ["Al2O3", "Al₂O₃"], ["Fe2O3", "Fe₂O₃"], ["CaO", "CaO"]]
    .map(([k, n]) => `${n} ${mt[k] && Number.isFinite(Number(mt[k].R2_mean)) ? (Number(mt[k].R2_mean) >= 0 ? "+" : "") + Number(mt[k].R2_mean).toFixed(3) : "—"}`)
    .join(" / ");
  $("#error-title").textContent = title || `逐石预测误差 · ${used} 块`;
  $("#error-body").innerHTML = blocks.join("") + `
    <div class="notice cyan" style="margin-top:8px"><span>ⓘ</span><span>
      误差 = |预测值 − 真实值| / 真实值 × 100%；共 <b>${used}</b> 块矸石、${allPct.length} 个目标参与，全局 MAPE ≈ <b>${mape == null ? "—" : fmt(mape, 1) + "%"}</b>。
      </span></div>
    <div class="notice green" style="margin-top:8px"><span>✓</span><span>
      模型整体（按来源组 5 折 × 3 个种子，pooled OOF）R²：<b>${mtText}</b>。单石误差会随样品波动，报告时请同时给出这组整体指标，不用单点替代整体。
    </span></div>
    <div class="notice" style="margin-top:8px"><span>⚠</span><span>
      这是<b>逐石示例样品</b>的误差，不等于模型整体 R²/MAE。真实值 &lt;1 wt% 的目标（如低钙样品 CaO）相对误差会被放大，表中仍显示单点误差、但不计入 MAPE（标为“低值*”）。修改输入后重新预测，误差会随之变化。
    </span></div>`;
  showModal("modal-error");
}

/* ---------------- 测试集（三图 + 三组含 LOI 实测） ---------------- */
let CASE_DATA = null;
async function openCases() {
  showModal("modal-cases");
  if (CASE_DATA) return;
  try {
    const d = await api("/api/cases");
    CASE_DATA = d;
    $("#cases-note").innerHTML = `<span>ⓘ</span><span>${esc(d.note || "")}</span>`;
    $("#case-list").innerHTML = (d.cases || []).map((c) => {
      const m = c.measured || {};
      return `<div style="display:grid;grid-template-columns:112px 1fr auto;gap:12px;align-items:center;border:1px solid var(--line);border-radius:12px;padding:9px 11px">
        <img src="${esc(c.image_url)}" alt="${esc(c.title)}" style="width:112px;height:84px;object-fit:cover;border-radius:8px;border:1px solid var(--line)">
        <div>
          <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
            <b style="color:var(--ink)">${esc(c.title)}</b>
            <span class="id-badge">${esc(c.sample_id)}</span>
            <span style="font-size:10.5px;color:var(--dim)">${esc(c.city || "")} · ${esc(c.image_note || "")}</span>
          </div>
          <div style="font-size:11px;color:var(--muted);margin-top:4px">LOI ${fmt(c.inputs["LOI烧失量"], 2)} · K₂O ${fmt(c.inputs.K2O, 2)} · MgO ${fmt(c.inputs.MgO, 2)} · Na₂O ${fmt(c.inputs.Na2O, 2)} · TiO₂ ${fmt(c.inputs.TiO2, 2)} · SO₃ ${fmt(c.inputs.SO3, 2)}</div>
          <div style="font-size:10.5px;color:var(--dim);margin-top:3px">库内实测：SiO₂ ${fmt(m.SiO2, 1)} / Al₂O₃ ${fmt(m.Al2O3, 1)} / Fe₂O₃ ${fmt(m.Fe2O3, 1)} / CaO ${fmt(m.CaO, 1)} ｜ 预期：${esc(c.expected || "")}</div>
          <div style="font-size:10.5px;color:#94a3b8;margin-top:3px">${esc(c.story || "")}</div>
        </div>
        <button class="btn sm primary" data-case="${esc(c.id)}">载入</button>
      </div>`;
    }).join("");
    $$("#case-list [data-case]").forEach((b) => b.addEventListener("click", () => loadCase(b.dataset.case)));
  } catch (e) { $("#case-list").textContent = "加载失败：" + e.message; }
}

async function loadCase(id) {
  const d = CASE_DATA || await api("/api/cases");
  CASE_DATA = d;
  const c = (d.cases || []).find((x) => x.id === id);
  if (!c) return;
  hideModal("modal-cases");
  S.activeCase = c;
  const res = await detectByPath(c.image_path);
  if (!res) { S.activeCase = null; return; }
  resetStep2();
  const area = (S.meta.areas || []).find((a) => a.id === c.area_id);
  if (area) { S.area = area; $("#area-select").value = area.id; updateAreaHint(); }
  if ($("#source-type")) $("#source-type").value = c.source_type || "煤矸石";
  if ($("#stage")) $("#stage").value = c.stage || "RAW_OR_UNSPECIFIED_GANGUE";
  const m = c.measured || {};
  const note = $("#case-note");
  note.style.display = "";
  note.innerHTML = `<span>🧪</span><span><b>${esc(c.title)}</b> · 样品 ${esc(c.sample_id)} · ${esc(c.city || "")}
    <br>库内实测：SiO₂ <b>${fmt(m.SiO2, 1)}</b> / Al₂O₃ <b>${fmt(m.Al2O3, 1)}</b> / Fe₂O₃ <b>${fmt(m.Fe2O3, 1)}</b> / CaO <b>${fmt(m.CaO, 1)}</b> wt%
    · 预期方向：${esc(c.expected || "")}
    <br><span style="color:var(--dim)">S01 默认值用本案例行；其余矸石用库内完整行补齐。图像与化验行为演示配对，非同一块样品；D/L/G/T/S 可点 ✎ 修正。</span>
    <button class="btn sm" style="margin-left:8px" onclick="goStep(2)">去第二步 →</button></span>`;
  toast(`已载入 ${c.title}，逐石输入已生成`, "ok");
}

/* ---------------- 物理特征修正 ---------------- */
let FEAT_TARGET = null;
function openFeatureEdit(id) {
  if (!S.detect) return;
  const st = S.detect.stones.find((s) => s.id === id);
  if (!st) return;
  FEAT_TARGET = st;
  $("#feat-stone-id").textContent = id;
  const opts = (S.meta && S.meta.feature_options) || {};
  $("#feature-fields").innerHTML = ["D", "L", "G", "T", "S"].map((k) => {
    const list = opts[k] || [];
    return `<div class="field">
      <label><b>${k}</b><span class="hint">${esc((st.feature[k] && st.feature[k].tip) || "")}</span></label>
      <select id="feat-${k}">${list.map((o) => `<option value="${esc(o.code)}" ${o.code === st.feature[k].code ? "selected" : ""}>${esc(o.label)}</option>`).join("")}</select>
    </div>`;
  }).join("");
  $("#feature-measured").innerHTML = `<span>ⓘ</span><span>CV 实测：${["D", "L", "G", "T", "S"].map((k) => `${k}=${st.feature[k].code}（${st.feature[k].value}）`).join(" · ")}</span>`;
  showModal("modal-feature");
}
function applyFeatureEdits(restore = false) {
  const st = FEAT_TARGET;
  if (!st) return;
  if (restore) {
    st.feature = JSON.parse(JSON.stringify(st._cv || st.feature));
    st.edited = false;
  } else {
    ["D", "L", "G", "T", "S"].forEach((k) => {
      const val = $(`#feat-${k}`).value;
      const old = st.feature[k] || {};
      const opt = (S.meta.feature_options[k] || []).find((o) => o.code === val);
      st.feature[k] = { ...old, code: val, name: opt ? opt.label : val };
    });
    st.edited = true;
  }
  hideModal("modal-feature");
  renderDetection(S.detect);
  refreshStoneFeatureChips();
  if (S.prediction) {
    S.prediction.rows.forEach((r) => { if (r.id === st.id) r.feature = st.feature; });
    S.recommend = null;
    resetStep3();
    renderPrediction(S.prediction);
    toast(`已${restore ? "恢复" : "更新"} ${st.id} 的物理特征，工艺方案需重新生成`, "ok");
  } else {
    toast(`已${restore ? "恢复" : "更新"} ${st.id} 的物理特征`, "ok");
  }
}

/* ---------------- 矿区 ---------------- */
function renderAreas(areas) {
  const sel = $("#area-select");
  sel.innerHTML = areas.map((a) => `<option value="${esc(a.id)}">${esc(a.name)} · ${esc(a.city || "")}</option>`).join("")
    + `<option value="__add__">＋ 新增矿区…</option>`;
  if (!areas.length) {
    sel.innerHTML = `<option value="">（暂无矿区，请新增）</option><option value="__add__">＋ 新增矿区…</option>`;
  }
  const first = areas.find((a) => a.id === "hx_mt") || areas[0];
  if (first) { sel.value = first.id; S.area = first; }
  updateAreaHint();
}
function updateAreaHint() {
  const a = S.area;
  $("#area-hint").textContent = a
    ? `${a.province || ""}${a.city ? " · " + a.city : ""}${a.coalfield ? " · " + a.coalfield : ""}${a.coal_type ? " · " + a.coal_type : ""}${a.note ? " ｜ " + a.note : ""}`
    : "—";
}

/* ---------------- 模型卡片 ---------------- */
function renderModelGrid(metrics) {
  const labels = { SiO2: "SiO₂ 二氧化硅", Al2O3: "Al₂O₃ 氧化铝", Fe2O3: "Fe₂O₃ 氧化铁", CaO: "CaO 氧化钙" };
  $("#model-grid").innerHTML = ["SiO2", "Al2O3", "Fe2O3", "CaO"].map((t) => {
    const m = metrics[t] || {};
    const xrd = t === "Al2O3" ? (metrics.Al2O3_xrd || null) : null;
    const r2 = Number(m.R2_mean);
    const pct = Math.max(0, Math.min(100, isFinite(r2) ? Math.max(0, r2) * 100 : 0));
    return `<div class="model-card" title="${esc(m.note || "")}">
      <div class="top"><span class="name">${labels[t]}</span><span class="r2">R² ${isFinite(r2) ? (r2 >= 0 ? "+" : "") + r2.toFixed(3) : "—"}</span></div>
      <div class="feat">${esc((m.features || []).join(" + "))}<br>MAE ${fmt(m.MAE_mean, 2)} wt% · n=${m.n || "—"} / ${m.groups || "—"} 组${xrd ? `<br><span style="color:var(--cyan)">XRD 条件 R² +${Number(xrd.R2_mean).toFixed(3)} · n=${xrd.n}/${xrd.groups} 组</span>` : ""}</div>
      <div class="meter"><i style="width:${pct}%"></i></div>
    </div>`;
  }).join("");
}

/* ---------------- 示例图片 ---------------- */
async function renderExamples() {
  try {
    const d = await api("/api/examples");
    if (!d.items || !d.items.length) return;
    $("#example-row").style.display = "";
    $("#example-list").innerHTML = d.items.map((it, i) => `
      <button class="btn sm ghost" data-path="${esc(it.path)}" style="font-family:var(--mono);font-size:10.5px">
        ${esc(it.name.slice(0, 18))}…
      </button>`).join("");
    $$("#example-list button").forEach((b) => b.addEventListener("click", () => {
      S.activeCase = null;
      detectByPath(b.dataset.path);
    }));
  } catch (e) { /* 忽略 */ }
}

/* ---------------- 检测 ---------------- */
async function detectByFile(file) {
  S.activeCase = null;
  const fd = new FormData();
  fd.append("file", file);
  fd.append("conf", S.conf);
  fd.append("iou", "0.45");
  await runDetect(() => api("/api/detect", { method: "POST", body: fd }));
}
async function detectByPath(path) {
  return await runDetect(() => api("/api/detect", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, conf: S.conf, iou: 0.45 }),
  }));
}
async function runDetect(fn) {
  $("#drop").style.display = "none";
  $("#image-box").style.display = "";
  $("#scanning").style.display = "grid";
  $("#case-note").style.display = "none";
  try {
    const d = await fn();
    (d.stones || []).forEach((s) => {
      s._cv = JSON.parse(JSON.stringify(s.feature));
      s.edited = false;
    });
    S.detect = d;
    S.prediction = null;
    S.recommend = null;
    renderDetection(d);
    markDone(1, true);
    markDone(2, false);
    markDone(3, false);
    resetStep2();
    resetStep3();
    renderStoneInputs();
    toast(`识别完成：${d.total} 个目标，其中矸石 ${d.gangue_count} 块`, "ok");
    return d;
  } catch (e) {
    toast("识别失败：" + e.message, "err");
    $("#image-box").style.display = "none";
    $("#drop").style.display = "";
    return null;
  } finally {
    $("#scanning").style.display = "none";
  }
}

function renderDetection(d) {
  $("#result-img").src = d.image_url;
  $("#image-badge").textContent = `${d.width}×${d.height} · ${d.device} · ${d.total} 个目标`;
  $("#stone-sub").textContent = `${d.total} 个目标 · 矸石 ${d.gangue_count} 块`;
  $("#rule-note").textContent = d.rule;

  const q = d.quality;
  const tag = (cond) => cond ? "good" : "mid";
  $("#quality-grid").innerHTML = `
    <div class="q-item" title="梯度能量，>0.0012 清晰">
      <div class="k"><span>清晰度</span><span class="tag ${q.sharpness >= 0.0012 ? "good" : q.sharpness >= 0.0006 ? "mid" : "bad"}">${esc(q.sharpness_level)}</span></div>
      <div class="v">${q.sharpness.toFixed(4)}</div>
      <div style="font-size:10px;color:var(--dim)">${esc(q.sharpness_note)}</div>
    </div>
    <div class="q-item" title="Laplacian 鲁棒估计，越低越干净">
      <div class="k"><span>噪声 σ</span><span class="tag ${q.noise <= 0.012 ? "good" : q.noise <= 0.028 ? "mid" : "bad"}">${esc(q.noise_level)}</span></div>
      <div class="v">${q.noise.toFixed(3)}</div>
      <div style="font-size:10px;color:var(--dim)">灰度标准差估计</div>
    </div>
    <div class="q-item" title="8×8 分块灰度一致性">
      <div class="k"><span>光照均匀度</span><span class="tag ${q.uniformity >= 0.75 ? "good" : q.uniformity >= 0.55 ? "mid" : "bad"}">${esc(q.uniformity_level)}</span></div>
      <div class="v">${(q.uniformity * 100).toFixed(0)}<small>%</small></div>
      <div style="font-size:10px;color:var(--dim)">过曝 ${(q.overexposed * 100).toFixed(1)}% / 欠曝 ${(q.underexposed * 100).toFixed(1)}%</div>
    </div>
    <div class="q-item" title="饱和度接近 0 时色相不可用，只取明度">
      <div class="k"><span>色彩可用性</span><span class="tag ${q.color_usable ? "good" : "mid"}">${q.color_usable ? "可用" : "近灰度"}</span></div>
      <div class="v">${q.saturation.toFixed(3)}</div>
      <div style="font-size:10px;color:var(--dim)">饱和度 · 色相不参与建模</div>
    </div>`;

  const c = d.counts;
  $("#counts").innerHTML = `
    <span class="count-pill">目标总数 <b>${d.total}</b></span>
    <span class="count-pill coal">煤块 <b>${c["煤块"]}</b></span>
    <span class="count-pill rock">矸石 <b>${c["矸石"]}</b></span>
    <span class="count-pill misc">其他杂石（剔除）<b>${c["其他杂石"]}</b></span>`;

  $("#stone-body").innerHTML = d.stones.length ? d.stones.map((s) => {
    const f = s.feature;
    return `<tr class="${s.included ? "" : "excluded"}">
      <td><span class="id-badge">${esc(s.id)}</span>
        <button class="icon-btn mini" data-edit="${esc(s.id)}" title="修正物理特征">✎</button>
        ${s.edited ? `<span class="edit-dot" title="已人工修正">已修正</span>` : ""}
      </td>
      <td><span class="cls-badge ${s.cls_name === "煤块" ? "coal" : s.cls_name === "矸石" ? "rock" : "misc"}">
        <i class="dot" style="background:${s.color}"></i>${esc(s.cls_name)}</span>
        ${s.included ? "" : `<div style="font-size:9.5px;color:var(--dim);margin-top:2px">${esc(s.excluded_reason)}</div>`}
      </td>
      <td class="conf-cell">
        <div class="conf-num">${s.conf.toFixed(3)} <small>[${s.conf_lo.toFixed(2)}–${s.conf_hi.toFixed(2)}]</small></div>
        <div class="conf-bar"><span class="range" style="left:${s.conf_lo * 100}%;width:${Math.max(2, (s.conf_hi - s.conf_lo) * 100)}%"></span>
          <span class="point" style="left:${s.conf * 100}%"></span></div>
      </td>
      <td><span class="feat-tag D" title="${esc(f.D.tip)}｜实测 ${f.D.value}">${esc(f.D.code)}</span></td>
      <td><span class="feat-tag L" title="${esc(f.L.tip)}｜实测 ${f.L.value}">${esc(f.L.code)}</span></td>
      <td><span class="feat-tag G" title="${esc(f.G.tip)}｜实测 ${f.G.value}">${esc(f.G.code)}</span></td>
      <td><span class="feat-tag T" title="${esc(f.T.tip)}｜实测 ${f.T.value}">${esc(f.T.code)}</span></td>
      <td><span class="feat-tag S" title="${esc(f.S.tip)}｜实测 ${f.S.value}">${esc(f.S.code)}</span></td>
    </tr>`;
  }).join("") : `<tr><td colspan="8"><div class="empty" style="border:0">未检测到目标，可降低 conf 后重试</div></td></tr>`;
  bindFeatureButtons();
}

function bindFeatureButtons() {
  $$("#stone-body [data-edit]").forEach((b) => b.addEventListener("click", () => openFeatureEdit(b.dataset.edit)));
}

/* ---------------- 成分预测 ---------------- */
function resetStep2() {
  S.prediction = null;
  $("#pred-sub").textContent = "等待预测";
  $("#pred-result").innerHTML = `<div class="pred-empty"><div class="big">⚗</div>左侧每块矸石都有独立输入；点击「逐石成分预测」后<br>按 S01/S02… 分别给出 SiO₂ / Al₂O₃ / Fe₂O₃ / CaO 与区间</div>`;
  $("#btn-recommend").disabled = true;
}

async function doPredict() {
  if (!S.detect) { toast("请先在第一步识别图片", "err"); return; }
  const stones = usableStones();
  if (!stones.length) { toast("当前图片没有可参与预测的矸石", "err"); return; }
  const inputsByStone = collectAllStoneInputs();
  for (const st of stones) {
    const v = inputsByStone[st.id] && inputsByStone[st.id]["LOI烧失量"];
    if (v == null || Number.isNaN(v)) {
      toast(`${st.id} 缺少 LOI 烧失量（马弗炉可测）`, "err");
      return;
    }
  }
  const area = S.area || {};
  if (!area.name) { toast("请选择矿区", "err"); return; }
  const btn = $("#btn-predict");
  btn.disabled = true; btn.textContent = "逐石预测中…";
  try {
    const firstInputs = inputsByStone[stones[0].id];
    const d = await api("/api/predict", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stones: stones.map((s) => ({ ...s, inputs: inputsByStone[s.id] })),
        quality: S.detect.quality,
        inputs: firstInputs,
        area,
        source_type: $("#source-type").value,
        stage: $("#stage").value,
      }),
    });
    S.prediction = d;
    S.stoneInputs = inputsByStone;
    S.inputs = firstInputs;
    renderPrediction(d);
    markDone(2, true);
    goStep(2);
    if ((d.rows || []).some((r) => S.stoneRefs[r.id])) {
      showPredictionError(d.rows, S.stoneRefs, `逐石预测误差 · ${d.rows.length} 块`);
    }
    toast(`预测完成：${d.rows.length} 块矸石，各自独立中心值`, "ok");
  } catch (e) {
    toast("预测失败：" + e.message, "err");
  } finally {
    btn.disabled = false; btn.textContent = "⚡ 逐石成分预测";
  }
}

function renderPrediction(d) {
  $("#pred-sub").textContent = `${d.rows.length} 块矸石 · 逐石独立输入 · ${d.area.name || ""}`;
  if (!d.rows.length) {
    $("#pred-result").innerHTML = `<div class="pred-empty"><div class="big">🪨</div>图中没有可参与预测的矸石（全部为煤块或低置信度其他杂石）。<br>请更换图片或放宽 conf。</div>`;
    return;
  }
  const types = [["SiO2", "SiO₂"], ["Al2O3", "Al₂O₃"], ["Fe2O3", "Fe₂O₃"], ["CaO", "CaO"]];
  const blocks = d.rows.map((r) => {
    const f = r.feature || {};
    const fs = ["D", "L", "G", "T", "S"].map((k) => f[k]
      ? `<span class="phys-chip" title="${esc(f[k].tip || "")}">${esc(chipText(f[k]))}</span>` : "").join("");
    const inp = r.inputs || {};
    const trs = types.map(([k, n]) => {
      const p = r.pred[k] || {};
      const r2 = p.r2;
      const cond = p.conditional ? `<span class="cond-badge" title="高岭石 > 0，启用 XRD 条件模型">XRD 条件</span>` : "";
      return `<tr>
        <td><b>${n}</b> ${cond}</td>
        <td class="num" style="font-family:var(--mono);font-size:13px;color:var(--ink)">${fmt(p.value)}<small style="color:var(--dim)"> wt%</small></td>
        <td class="num" style="font-family:var(--mono);color:var(--dim)">[${fmt(p.lo)} – ${fmt(p.hi)}]</td>
        <td class="num">${r2 == null ? "—" : (r2 >= 0 ? "+" : "") + Number(r2).toFixed(3)}</td>
      </tr>`;
    }).join("");
    return `<div class="pred-stone">
      <div class="pred-stone-head">
        <span class="id-badge">${esc(r.id)}</span>
        <span class="tag good">${esc(r.cls_name || "矸石")}</span>
        <span class="mono">conf ${fmt(r.conf, 2)}</span>
        <div class="phys-chips">${fs}</div>
      </div>
      <div class="table-wrap"><table>
        <thead><tr><th>目标</th><th class="num">预测值</th><th class="num">90% 区间</th><th class="num">R²</th></tr></thead>
        <tbody>${trs}</tbody>
      </table></div>
      <div class="stone-measured">该石输入：LOI <b>${fmt(inp["LOI烧失量"], 2)}</b> · K₂O <b>${fmt(inp.K2O, 2)}</b> · MgO <b>${fmt(inp.MgO, 2)}</b> · Na₂O <b>${fmt(inp.Na2O, 2)}</b> · TiO₂ <b>${fmt(inp.TiO2, 2)}</b> · SO₃ <b>${fmt(inp.SO3, 2)}</b>${r.den == null ? "" : ` · _den ${fmt(r.den, 1)}`}</div>
    </div>`;
  }).join("");

  const mt = d.metrics || {};
  const xrd = d.rows.some((r) => r.pred.Al2O3 && r.pred.Al2O3.conditional);
  const mtShow = { ...mt };
  if (xrd) {
    const p = d.rows.find((r) => r.pred.Al2O3 && r.pred.Al2O3.conditional).pred.Al2O3;
    mtShow.Al2O3 = { ...(mtShow.Al2O3 || {}), R2_mean: p.r2 };
  }
  $("#pred-result").innerHTML = `
    <div class="counts" style="margin-bottom:10px">
      <span class="count-pill">矿区 <b style="font-size:12px">${esc(d.area.name)}</b></span>
      <span class="count-pill">矸石 <b>${d.rows.length}</b></span>
      <span class="count-pill" style="border-color:var(--cyan)">逐石独立输入</span>
      ${xrd ? `<span class="count-pill" style="border-color:var(--cyan)">Al₂O₃ XRD 条件模型</span>` : ""}
    </div>
    ${blocks}
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin-top:10px">
      ${types.map(([k, n]) => `<div class="q-item" style="padding:7px 9px">
        <div class="k"><span>${k === "Al2O3" && xrd ? "Al₂O₃*" : n}</span><span>R²</span></div>
        <div class="v" style="font-size:12px">${mtShow[k] ? (mtShow[k].R2_mean >= 0 ? "+" : "") + mtShow[k].R2_mean.toFixed(3) : "—"}
          <small>±MAE ${fmt(mtShow[k] && mtShow[k].MAE_mean, 2)}</small></div>
      </div>`).join("")}
    </div>
    ${xrd ? `<div class="notice green" style="margin-top:9px"><span>✧</span><span>已填高岭石定量：Al₂O₃ 使用 XRD 条件模型（R² ${Number(mtShow.Al2O3.R2_mean).toFixed(3)}，覆盖 55/261 条/14 组），并施加矿物学上界；未填高岭石时回退全表模型。</span></div>` : ""}
    <div class="notice cyan" style="margin-top:11px"><span>ⓘ</span><span>${esc(d.note)}</span></div>`;

  $("#step3-ready").className = "notice green";
  $("#step3-ready-text").innerHTML = `已就绪：<b>${d.rows.length} 块矸石</b> · ${esc(d.area.name)} · 每块使用自己的成分与物理特征。`;
  $("#btn-recommend").disabled = false;
  renderContext(d);
}

function renderContext(d) {
  const lines = (d.rows || []).map((r) => {
    const inp = r.inputs || {};
    return `<div><span class="id-badge" style="min-width:34px">${esc(r.id)}</span>
      LOI <b>${fmt(inp["LOI烧失量"], 2)}</b> · K₂O ${fmt(inp.K2O, 2)} · MgO ${fmt(inp.MgO, 2)} · Na₂O ${fmt(inp.Na2O, 2)} · TiO₂ ${fmt(inp.TiO2, 2)} · SO₃ ${fmt(inp.SO3, 2)}</div>`;
  }).join("");
  const q = S.detect && S.detect.quality;
  $("#context-box").innerHTML = `
    <div>矿区：<b style="color:var(--ink)">${esc(d.area.name)}</b>（${esc(d.area.city || "")}）</div>
    <div style="margin-top:3px">逐石指标：</div>
    <div class="mono" style="color:#cbd5e1;font-size:10px;line-height:1.9">${lines}</div>
    <div>矸石：${d.rows.length} 块 · ${q ? `图像质量：${esc(q.sharpness_level)} / 噪声${esc(q.noise_level)}` : "—"}</div>`;
}

/* ---------------- 推荐 ---------------- */
async function doRecommend() {
  if (!S.prediction) { toast("请先完成成分预测", "err"); return; }
  const btn = $("#btn-recommend");
  btn.disabled = true; btn.textContent = "生成中…";
  $("#rec-sub").textContent = "推理中…";
  try {
    const curFeat = new Map(((S.detect && S.detect.stones) || []).map((s) => [s.id, s.feature]));
    const stones = S.prediction.rows.map((r) => ({
      id: r.id, conf: r.conf, feature: curFeat.get(r.id) || r.feature, pred: r.pred,
      inputs: (S.stoneInputs && S.stoneInputs[r.id]) || r.inputs || S.inputs,
    }));
    const d = await api("/api/recommend", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        stones, area: S.prediction.area, inputs: S.inputs,
        quality: S.detect.quality, use_llm: true,
      }),
    });
    S.recommend = d;
    renderRecommend(d);
    markDone(3, true);
    toast(d.mode === "llm" ? `工艺方案已生成（${d.model}）` : "已用离线知识库生成方案", "ok");
  } catch (e) {
    toast("生成失败：" + e.message, "err");
  } finally {
    btn.disabled = false; btn.textContent = "🧠 生成逐石工艺方案";
  }
}

function renderRecommend(d) {
  const mode = d.mode === "llm"
    ? `<span class="chip ok" style="padding:2px 9px"><i class="dot"></i>在线 ${esc(d.model || "LLM")}</span>`
    : `<span class="chip warn" style="padding:2px 9px"><i class="dot"></i>离线知识库</span>`;
  $("#rec-sub").innerHTML = `${mode} ${d.latency ? `<span style="margin-left:6px">${d.latency}s</span>` : ""}`;

  const fb = d.fallback_reason ? `<div class="notice" style="margin-bottom:10px"><span>⚠</span><span>在线模型不可用，已回退离线知识库：${esc(d.fallback_reason)}</span></div>` : "";
  const summary = d.summary ? `<div class="notice cyan" style="margin-bottom:10px"><span>✧</span><span>${esc(d.summary)}</span></div>` : "";

  const cards = (d.stones || []).map((r) => {
    const p = r.primary || {};
    const subs = (r.secondary || []).map((x) => `<span class="sub-chip" title="${esc(x.why || "")}">${esc(x.name)}</span>`).join("");
    const reg = { carbon: "炭质", high_al: "高铝", high_fe: "高铁", calcareous: "高钙", high_si: "高硅", aluminosilicate: "铝硅酸盐", low_grade: "低品位" }[r.regime] || r.regime || "";
    const ratios = r.ratios || {};
    const ratioText = Object.entries(ratios).map(([k, v]) => {
      const n = { SI_AL: "Si/Al", CA_SI: "Ca/Si", FE_AL: "Fe/Al", LOI_ASH: "LOI/灰分" }[k] || k;
      return `${n} ${v}`;
    }).join(" · ");
    const feat = r.feature || {};
    const fchips = ["D", "L", "G", "T", "S"].map((k) => feat[k]
      ? `<span class="phys-chip">${esc(chipText(feat[k]))}</span>` : "").join("");
    return `<div class="rec-card">
      <div class="rec-head">
        <span class="id-badge">${esc(r.id)}</span>
        <span class="title">${esc(p.name || "—")}</span>
        ${reg ? `<span class="chip" style="padding:1px 7px;font-size:10px">${esc(reg)}</span>` : ""}
        <span class="conf ${esc(r.confidence || "中")}">可信度 ${esc(r.confidence || "中")}</span>
      </div>
      <div class="rec-body">
        ${ratioText ? `<div class="row"><span class="k">成分特征</span><div class="v mono" style="color:#7dd3fc;font-size:10.5px">${esc(ratioText)}</div></div>` : ""}
        ${fchips ? `<div class="row"><span class="k">物性档位</span><div class="v"><div class="phys-chips">${fchips}</div></div></div>` : ""}
        ${p.why ? `<div class="row"><span class="k">判断依据</span><div class="v">${esc(p.why)}</div></div>` : ""}
        ${p.basis ? `<div class="row"><span class="k">机理依据</span><div class="v rec-note">${esc(p.basis)}</div></div>` : ""}
        ${p.process ? `<div class="row"><span class="k">工艺路线</span><div class="v">${esc(p.process)}</div></div>` : ""}
        ${p.products ? `<div class="row"><span class="k">目标产品</span><div class="v"><b>${esc(p.products)}</b></div></div>` : ""}
        ${p.risk ? `<div class="row"><span class="k">落地风险</span><div class="v">${esc(p.risk)}</div></div>` : ""}
        ${subs ? `<div class="row"><span class="k">备选工艺</span><div class="v"><div class="sub-list">${subs}</div></div></div>` : ""}
        ${p.ref ? `<div class="row"><span class="k">参考</span><div class="v rec-note">${esc(p.ref)}</div></div>` : ""}
      </div>
    </div>`;
  }).join("");

  $("#rec-result").innerHTML = fb + summary + `<div class="rec-list">${cards}</div>
    <div class="notice" style="margin-top:12px"><span>⚠</span><span>工艺阈值来自工程经验区间，落地前必须做<b>小试/中试</b>与重金属、放射性、安定性检测；模型成分误差会传导到工艺判断。</span></div>`;

  // 知识库命中
  $("#kb-hits").innerHTML = (d.stones || []).map((r) => {
    const subs = (r.secondary || []).map((x) => esc(x.name)).join(" / ");
    return `<div style="margin-bottom:7px"><span class="id-badge" style="min-width:34px">${esc(r.id)}</span>
      <b style="color:var(--ink)">${esc(r.primary && r.primary.name)}</b>${subs ? ` <span style="color:var(--dim)">备选：${subs}</span>` : ""}</div>`;
  }).join("") || "—";
}

/* ---------------- 设置 ---------------- */
function openSettings() {
  const llm = (S.meta && S.meta.llm) || {};
  $("#cfg-provider").value = llm.provider || "zhipu";
  const base = llm.base_url || DEFAULT_LLM.zhipu.base;
  $("#cfg-base").value = base;
  $("#cfg-model").value = llm.model || "glm-4.5-flash";
  $("#cfg-protocol").value = llm.protocol || (base.includes("anthropic") ? "anthropic" : "openai");
  $("#cfg-key").value = "";
  $("#cfg-status").innerHTML = llm.configured
    ? `<span>✓</span><span>已配置：${esc(llm.model)} @ ${esc(llm.base_url)}</span>`
    : `<span>ⓘ</span><span>未配置 Key，将使用离线知识库。</span>`;
  showModal("modal-settings");
}
async function saveConfig() {
  const body = {
    provider: $("#cfg-provider").value,
    base_url: $("#cfg-base").value.trim(),
    model: $("#cfg-model").value.trim(),
    protocol: $("#cfg-protocol").value,
    api_key: $("#cfg-key").value.trim(),
  };
  try {
    const d = await api("/api/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    S.meta.llm = { provider: body.provider, base_url: d.base_url, model: d.model, protocol: d.protocol, configured: d.configured };
    renderLLMChip(S.meta.llm);
    $("#cfg-status").innerHTML = `<span>✓</span><span>已保存：${esc(d.model)} @ ${esc(d.base_url)}</span>`;
    toast("API 设置已保存", "ok");
    return true;
  } catch (e) { toast("保存失败：" + e.message, "err"); return false; }
}
async function testLLM() {
  const ok = await saveConfig();
  if (!ok) return;
  $("#cfg-status").innerHTML = `<span>⏳</span><span>测试中…</span>`;
  try {
    const d = await api("/api/test_llm", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    $("#cfg-status").className = "notice green";
    $("#cfg-status").innerHTML = `<span>✓</span><span>连通成功 · ${esc(d.model)} · ${d.latency}s</span>`;
  } catch (e) {
    $("#cfg-status").className = "notice";
    $("#cfg-status").innerHTML = `<span>✗</span><span>${esc(e.message)}</span>`;
  }
}

/* ---------------- 弹窗 ---------------- */
function showModal(id) { $(`#${id}`).classList.add("show"); }
function hideModal(id) { $(`#${id}`).classList.remove("show"); }
$$("[data-close]").forEach((b) => b.addEventListener("click", () => hideModal(b.dataset.close)));
$$(".modal-mask").forEach((m) => m.addEventListener("click", (e) => { if (e.target === m) m.classList.remove("show"); }));

async function openKB() {
  showModal("modal-kb");
  try {
    const d = await api("/api/kb");
    $("#kb-count").textContent = `共 ${d.entries.length} 条`;
    $("#kb-body").innerHTML = `
      <div class="notice cyan" style="margin-bottom:10px"><span>ⓘ</span><span>${d.entries.length} 条工艺按「成分区间 + 特征比值（Si/Al、Ca/Si、Fe/Al、LOI/灰分、SO₃/CaO）+ 第一步物性档位」匹配；阈值来自工程经验/88 条案例桥接，不是强制标准，落地前须做小试/中试。</span></div>
      <div class="kb-grid">` +
      d.entries.map((e) => {
        const cond = Object.entries(e.conditions || {}).map(([k, r]) => `${k} ${r[0]}~${r[1]}%`).join(" · ");
        const ratio = Object.entries(e.ratios || {}).map(([k, r]) => `${k} ${r[0]}~${r[1]}`).join(" · ");
        const gate = (e.gate || []).join(" / ");
        const phys = Object.entries(e.physical || {}).map(([k, v]) => `${k}+${v}`).join(" ");
        return `<div style="border:1px solid var(--line);border-radius:10px;padding:11px 13px">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline">
          <b>${esc(e.name)}</b><span class="mono" style="font-size:10.5px;color:var(--dim)">${esc(e.category || "资源化工艺")}</span>
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:5px">成分：${cond}</div>
        ${ratio ? `<div style="font-size:11px;color:var(--muted);margin-top:3px">比值：${ratio}</div>` : ""}
        ${gate ? `<div style="font-size:10.5px;color:#7dd3fc;margin-top:3px">定义性门控：${esc(gate)}</div>` : ""}
        ${phys ? `<div style="font-size:10.5px;color:var(--dim);margin-top:3px">物性偏好：${esc(phys)}</div>` : ""}
        ${e.basis ? `<div style="font-size:11px;color:#cbd5e1;margin-top:5px">机理：${esc(e.basis)}</div>` : ""}
        <div style="font-size:11.5px;color:#cbd5e1;margin-top:5px">${esc(e.process)}</div>
        <div style="font-size:10.5px;color:var(--dim);margin-top:5px">产品：${esc(e.products)} ｜ 风险：${esc(e.risk)}</div>
        <div style="font-size:10.5px;color:var(--dim);margin-top:3px">依据：${esc(e.ref || "工程经验")}</div>
      </div>`;
      }).join("") + `</div>`;
  } catch (e) { $("#kb-body").textContent = "加载失败：" + e.message; }
}

/* ---------------- 事件绑定 ---------------- */
function bind() {
  $$(".step-tab").forEach((el) => el.addEventListener("click", () => goStep(Number(el.dataset.step))));

  $("#drop").addEventListener("click", () => $("#file-input").click());
  $("#file-input").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) detectByFile(f);
  });
  ["dragenter", "dragover"].forEach((ev) => $("#drop").addEventListener(ev, (e) => {
    e.preventDefault(); $("#drop").classList.add("over");
  }));
  ["dragleave", "drop"].forEach((ev) => $("#drop").addEventListener(ev, (e) => {
    e.preventDefault(); $("#drop").classList.remove("over");
  }));
  $("#drop").addEventListener("drop", (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) detectByFile(f);
  });

  $("#btn-examples").addEventListener("click", () => {
    $("#example-row").style.display = $("#example-row").style.display === "none" ? "" : "none";
  });
  $("#btn-cases").addEventListener("click", openCases);
  $("#btn-feat-save").addEventListener("click", () => applyFeatureEdits(false));
  $("#btn-feat-reset").addEventListener("click", () => applyFeatureEdits(true));
  $("#btn-reset").addEventListener("click", () => {
    $("#image-box").style.display = "none";
    $("#drop").style.display = "";
    $("#file-input").value = "";
    S.detect = null; S.activeCase = null; S.stoneRefs = {}; S.stoneInputs = {};
    markDone(1, false); resetStep2(); resetStep3(); renderStoneInputs();
  });
  $("#btn-redetect").addEventListener("click", () => {
    if (S.detect && S.detect.source) {
      const lastFile = $("#file-input").files && $("#file-input").files[0];
      if (lastFile) detectByFile(lastFile);
      else toast("请重新拖入图片（本地路径示例不可再次提交）", "");
    }
  });
  $("#conf-range").addEventListener("input", (e) => { S.conf = Number(e.target.value); $("#conf-val").textContent = S.conf.toFixed(2); });

  $("#area-select").addEventListener("change", (e) => {
    if (e.target.value === "__add__") { showModal("modal-area"); e.target.value = S.area ? S.area.id : ""; return; }
    S.area = (S.meta.areas || []).find((a) => a.id === e.target.value) || null;
    updateAreaHint();
  });
  $("#btn-add-area").addEventListener("click", () => showModal("modal-area"));
  $("#btn-show-errors").addEventListener("click", () => {
    if (!S.prediction || !(S.prediction.rows || []).length) {
      toast("请先点击「逐石成分预测」", "err");
      return;
    }
    showPredictionError(S.prediction.rows, S.stoneRefs, `逐石预测误差 · ${S.prediction.rows.length} 块`);
  });
  $("#btn-reset-stones").addEventListener("click", resetStoneDefaults);
  $("#stone-input-list").addEventListener("click", (e) => {
    const b = e.target.closest("[data-error-stone]");
    if (!b || !S.prediction) return;
    const id = b.dataset.errorStone;
    const row = (S.prediction.rows || []).find((r) => r.id === id);
    if (row) showPredictionError([row], S.stoneRefs, `单石误差 · ${id}`);
  });
  $("#stone-input-list").addEventListener("input", () => {
    if (!S.prediction) return;
    S.prediction = null;
    resetStep2();
    resetStep3();
    markDone(2, false);
    toast("逐石输入已修改，请重新点「逐石成分预测」", "");
  });

  $("#btn-predict").addEventListener("click", doPredict);
  $("#btn-recommend").addEventListener("click", doRecommend);

  $("#btn-settings").addEventListener("click", openSettings);
  $("#btn-llm-config").addEventListener("click", openSettings);
  $("#btn-save-cfg").addEventListener("click", saveConfig);
  $("#btn-test-llm").addEventListener("click", testLLM);
  $("#btn-kb-view").addEventListener("click", openKB);

  $("#cfg-provider").addEventListener("change", (e) => {
    const p = e.target.value;
    if (DEFAULT_LLM[p]) {
      $("#cfg-base").value = DEFAULT_LLM[p].base;
      $("#cfg-model").value = DEFAULT_LLM[p].model;
      $("#cfg-protocol").value = DEFAULT_LLM[p].protocol;
    }
  });

  $("#btn-save-area").addEventListener("click", async () => {
    const name = $("#area-name").value.trim();
    if (!name) { toast("请填写矿区名称", "err"); return; }
    try {
      const d = await api("/api/areas", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name, province: $("#area-province").value, city: $("#area-city").value,
          coalfield: $("#area-coalfield").value, coal_type: $("#area-coal-type").value,
          note: $("#area-note").value,
        }),
      });
      S.meta.areas = d.areas;
      renderAreas(d.areas);
      $("#area-select").value = d.area.id;
      S.area = d.area; updateAreaHint();
      hideModal("modal-area");
      toast("矿区已新增并选中", "ok");
    } catch (e) { toast("新增失败：" + e.message, "err"); }
  });
}

function resetStep3() {
  S.recommend = null;
  $("#rec-sub").textContent = "尚未生成";
  $("#rec-result").innerHTML = `<div class="empty"><div class="big">🏭</div>完成成分预测后生成工艺方案<br>每块矸石给出主推工艺、备选、产品与风险提示</div>`;
  $("#kb-hits").textContent = "生成方案后显示逐石命中的知识库条目。";
  $("#step3-ready").className = "notice";
  $("#step3-ready-text").textContent = "请先完成第二步成分预测。";
  $("#btn-recommend").disabled = true;
  markDone(3, false);
}

bind();
init();