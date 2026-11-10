const $ = (s) => document.querySelector(s);
const AI_FIELDS = ["SiO2", "Al2O3", "Fe2O3", "CaO", "LOI", "ash", "St", "Qnet", "pH"];
const PORT_META = {
  precision: { label: "端口一", need: "现场图片 + 至少 3 项化验指标" },
  vision: { label: "端口二", need: "至少 1 张现场图片" },
  report: { label: "端口三", need: "至少 3 项化验指标" },
};
let autoFile = null;
let target = null;
let sampleCache = null;

function countLab() {
  return AI_FIELDS.reduce((n, k) => n + (String($("#ai-" + k).value).trim() !== "" ? 1 : 0), 0);
}
function readValues() {
  const values = {};
  AI_FIELDS.forEach((k) => {
    const v = $("#ai-" + k).value.trim();
    if (v !== "") values[k] = Number(v);
  });
  const place = $("#ai-place").value.trim();
  if (place) {
    const p = place.split(/[\/,，\s]+/).filter(Boolean);
    values.province = p[0] || "";
    values.city = p[1] || "";
    values.coalfield = p[2] || "";
  }
  return values;
}
function validateTarget(t = target) {
  if (!t) return "请先在顶部三选一：端口一、端口二或端口三。";
  if (t === "precision" && !autoFile) return "端口一需要一张现场图片；请上传图片，或点「一键填写端口一」。";
  if (t === "precision" && countLab() < 3) return "端口一至少需要 3 项化验指标（SiO₂、Al₂O₃、Fe₂O₃、CaO 等）；请补充，或点「一键填写端口一」。";
  if (t === "vision" && !autoFile) return "端口二需要一张现场图片；请上传图片，或点「一键填写端口二」。";
  if (t === "report" && countLab() < 3) return "端口三至少需要 3 项化验指标；请填写，或点「一键填写端口三」。";
  return "";
}
function statusText() {
  return `${autoFile ? "有图片" : "无图片"} · ${countLab()} 项化验`;
}
function paintDecision() {
  const meta = target ? PORT_META[target] : null;
  const err = validateTarget();
  if (!meta) {
    $("#decision-title").textContent = "请选择目标端口";
    $("#decision-desc").textContent = "三个端口三选一：图片 + 化验 → 端口一；只有图片 → 端口二；只有化验 → 端口三。选择后仍需满足该端口的最低输入要求。";
    $("#decision-port").textContent = "—";
    $("#decision-count").textContent = "三选一";
    $("#decision-tags").innerHTML = `<span>三选一</span><span>必填校验</span>`;
    $("#decision-icon").textContent = "?";
  } else {
    $("#decision-title").textContent = `${meta.label} · ${err ? "尚未满足要求" : "可以进入"}`;
    $("#decision-desc").textContent = err || `已满足 ${meta.label} 的最低输入要求，点击下方按钮进入对应工作台。`;
    $("#decision-port").textContent = meta.label;
    $("#decision-count").textContent = statusText();
    $("#decision-tags").innerHTML = `<span>${meta.need}</span><span>${err ? "待补充" : "已就绪"}</span>`;
    $("#decision-icon").textContent = target === "precision" ? "▤" : target === "vision" ? "◉" : "▣";
  }
  document.querySelectorAll(".auto-mode-btn").forEach((b) => b.classList.toggle("active", b.dataset.target === target));
}
function selectTarget(t) {
  target = t;
  paintDecision();
}
function guard(message) {
  $("#guard-text").textContent = message;
  $("#auto-guard").classList.add("show");
}
function closeGuard() { $("#auto-guard").classList.remove("show"); }

function setPreview(file) {
  autoFile = file || null;
  if (autoFile) {
    $("#auto-preview").src = URL.createObjectURL(autoFile);
    $("#auto-drop").classList.add("has-image");
  } else {
    $("#auto-preview").removeAttribute("src");
    $("#auto-drop").classList.remove("has-image");
  }
  paintDecision();
}
function fillValuesFromSample() {
  const s = (sampleCache && sampleCache.samples && sampleCache.samples[0]) || {};
  const inp = s.inputs || {}, q = s.quality || {};
  AI_FIELDS.forEach((k) => {
    const v = k === "pH" ? q.pH : inp[k];
    $("#ai-" + k).value = v == null ? "" : v;
  });
  $("#ai-place").value = [s.province || "山西", s.city || "", s.coalfield || ""].filter(Boolean).join(" / ");
}
function clearValues() {
  AI_FIELDS.forEach((k) => { $("#ai-" + k).value = ""; });
  $("#ai-place").value = "";
}
async function ensureSample() {
  if (!sampleCache) sampleCache = await (await fetch("/api/demo_samples", { cache: "no-store" })).json();
}
async function loadDefaultImage() {
  const r = await fetch("/tests/images/case_a.jpg", { cache: "no-store" });
  const blob = await r.blob();
  setPreview(new File([blob], "case_a.jpg", { type: blob.type || "image/jpeg" }));
}
async function fillDemo(kind) {
  try {
    await ensureSample();
    target = kind;
    if (kind === "precision") {
      fillValuesFromSample();
      await loadDefaultImage();
    } else if (kind === "vision") {
      clearValues();
      await loadDefaultImage();
    } else {
      setPreview(null);
      fillValuesFromSample();
    }
    paintDecision();
    window.scrollTo({ top: document.querySelector(".auto-submit").offsetTop - 80, behavior: "smooth" });
  } catch (e) {
    $("#auto-hint").textContent = "演示数据加载失败：" + e.message;
  }
}

async function submitAuto() {
  const err = validateTarget();
  if (err) { guard(err); return; }
  $("#auto-go").disabled = true;
  $("#auto-go").textContent = "正在分流…";
  try {
    let imagePath = "";
    if (autoFile) {
      const fd = new FormData();
      fd.append("file", autoFile);
      fd.append("values", JSON.stringify(readValues()));
      const up = await (await fetch("/api/auto/intake", { method: "POST", body: fd })).json();
      if (!up.ok) throw new Error(up.error || "图片上传失败");
      imagePath = up.image_path || "";
    }
    const intake = { imagePath, values: readValues(), route: target, ts: Date.now() };
    try { localStorage.setItem("yzb_intake", JSON.stringify(intake)); } catch (e) {}
    $("#decision-desc").textContent = `已校验通过，正在打开${PORT_META[target].label}…`;
    setTimeout(() => { location.href = "/" + target + "?intake=1"; }, 700);
  } catch (e) {
    $("#auto-go").disabled = false;
    $("#auto-go").innerHTML = "开始智能匹配 <span>→</span>";
    guard("分流失败：" + e.message);
  }
}

function initAuto() {
  const drop = $("#auto-drop");
  drop.addEventListener("click", (e) => { if (e.target.id !== "auto-clear") $("#auto-file").click(); });
  $("#auto-file").addEventListener("change", (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) setPreview(f);
  });
  ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) setPreview(f);
  });
  $("#auto-clear").addEventListener("click", (e) => { e.stopPropagation(); setPreview(null); });
  $("#auto-sample").addEventListener("click", async () => { await ensureSample(); fillValuesFromSample(); paintDecision(); });
  AI_FIELDS.forEach((k) => $("#ai-" + k).addEventListener("input", paintDecision));
  $("#ai-place").addEventListener("input", paintDecision);
  document.querySelectorAll(".auto-mode-btn").forEach((b) => b.addEventListener("click", () => selectTarget(b.dataset.target)));
  document.querySelectorAll("[data-demo]").forEach((b) => b.addEventListener("click", () => fillDemo(b.dataset.demo)));
  $("#auto-go").addEventListener("click", submitAuto);
  $("#guard-close").addEventListener("click", closeGuard);
  $("#auto-guard").addEventListener("click", (e) => { if (e.target === $("#auto-guard")) closeGuard(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeGuard(); });
  paintDecision();
}
document.addEventListener("DOMContentLoaded", initAuto);
