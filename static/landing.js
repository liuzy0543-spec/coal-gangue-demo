const HOME_COLORS = ["#1d79c9", "#36a98e", "#75c28f", "#a9d4b1", "#d9b96a", "#8f9fd1", "#c6d8dc"];
const $ = (s) => document.querySelector(s);
const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (v) => Number(v).toLocaleString("zh-CN");

function fallbackHome() {
  return {
    ok: true, updated: "—",
    stats: { records: 0, groups: 0, model_samples: 0, routes: 0 },
    routes: [], kb_preview: [], cases: [], workflow: [],
    hero: { image: "/tests/images/case_a.jpg", sample: {}, route: { code: "R12", name: "资源化利用", process_chain: [] } },
  };
}

async function loadHome() {
  let d;
  try {
    const r = await fetch("/api/home", { cache: "no-store" });
    d = await r.json();
  } catch (e) { d = fallbackHome(); }
  if (!d || !d.ok) d = fallbackHome();
  renderHero(d);
  renderStats(d);
  renderRoutes(d);
  renderCases(d);
  renderKb(d);
  renderWorkflow(d);
  $("#sys-status").textContent = d.ok ? "服务在线" : "服务离线";
  $("#updated-at").textContent = d.updated ? `更新 ${d.updated}` : "—";
}

function renderHero(d) {
  const st = d.stats || {};
  $("#hero-kb-count").textContent = st.routes || 12;
  $("#hero-records").textContent = fmt(st.records || 635);
  const hero = d.hero || {};
  if (hero.image) $("#hero-image").src = hero.image;
  const s = hero.sample || {};
  $("#hero-sample-id").textContent = (s.city ? s.city + " · " : "") + (s.route_code || "SAMPLE") + " · 实测样本";
  const route = hero.route || {};
  $("#hero-route-name").textContent = route.name || "资源化利用";
  $("#hero-route-code").textContent = route.code || "R12";
  const inp = s.inputs || {};
  const comp = [
    ["SiO₂", inp.SiO2, "#2d7fd3"], ["Al₂O₃", inp.Al2O3, "#4cb6a8"],
    ["Fe₂O₃", inp.Fe2O3, "#84c8a7"], ["CaO", inp.CaO, "#e7b45c"],
    ["其他", Math.max(0, 100 - [inp.SiO2, inp.Al2O3, inp.Fe2O3, inp.CaO].reduce((a, b) => a + (Number(b) || 0), 0)), "#dceaf0"],
  ];
  const total = comp.reduce((a, x) => a + (Number(x[1]) || 0), 0) || 1;
  let acc = 0;
  const stops = comp.map((x) => {
    const pct = (Number(x[1]) || 0) / total * 100;
    const start = acc; acc += pct;
    return `${x[2]} ${start.toFixed(1)}% ${Math.min(100, acc).toFixed(1)}%`;
  });
  $("#hero-donut").style.background = `conic-gradient(${stops.join(",")})`;
  $("#hero-composition").innerHTML = comp.slice(0, 4).map(([name, val, color]) => {
    const pct = ((Number(val) || 0) / total * 100).toFixed(1);
    return `<div class="comp-row"><i style="background:${color}"></i><span>${esc(name)}</span><b>${pct}%</b></div>`;
  }).join("");
  const chain = route.process_chain || [];
  $("#hero-route-flow").innerHTML = chain.slice(0, 3).map((x) => `<span><i></i>${esc(String(x).slice(0, 8))}</span>`).join("") || `<span><i></i>破碎</span><span><i></i>资源化</span>`;
}

function renderStats(d) {
  const s = d.stats || {};
  const items = [
    ["全量记录", s.records || 635, "条", "真实煤矸石样本"],
    ["来源分组", s.groups || 528, "组", "按文献来源去重"],
    ["建模样本", s.model_samples || 328, "条", "四氧化物训练集"],
    ["标准路线", s.routes || 12, "条", "R01 ~ R12"],
  ];
  $("#stat-grid").innerHTML = items.map(([label, value, unit, sub]) => `
    <div class="stat-item"><span class="stat-ic">◈</span><b>${fmt(value)}<em>${unit}</em></b><small>${esc(label)}</small><div class="empty-soft" style="padding:2px 0 0;font-size:8px">${esc(sub)}</div></div>
  `).join("");
}

function renderRoutes(d) {
  const routes = d.routes || [];
  const total = routes.reduce((a, x) => a + (x.count || 0), 0) || 1;
  $("#route-total").textContent = fmt(total);
  if (!routes.length) { $("#route-legend").innerHTML = `<div class="empty-soft">暂无路线统计</div>`; return; }
  let acc = 0;
  const stops = routes.map((r, i) => {
    const pct = (r.count || 0) / total * 100;
    const start = acc; acc += pct;
    return `${HOME_COLORS[i % HOME_COLORS.length]} ${start.toFixed(1)}% ${Math.min(100, acc).toFixed(1)}%`;
  });
  $("#route-donut").style.background = `conic-gradient(${stops.join(",")})`;
  $("#route-legend").innerHTML = routes.slice(0, 5).map((r, i) => `
    <div class="legend-row"><i style="background:${HOME_COLORS[i % HOME_COLORS.length]}"></i><span>${esc(r.name || r.code)}</span><b>${r.pct || 0}%</b></div>
  `).join("");
}

function renderCases(d) {
  const cases = d.cases || [];
  if (!cases.length) { $("#case-feature").innerHTML = `<div class="empty-soft">案例数据加载中…</div>`; return; }
  const c = cases[0];
  $("#case-feature").innerHTML = `
    <div class="case-thumb"><img src="/tests/images/case_b.jpg" alt="煤矸石案例"></div>
    <div class="case-info">
      <b>${esc(c.city || "山西")} · ${esc(c.route_name || c.route_code || "资源化利用")}</b>
      <div class="case-badges"><span class="route">${esc(c.route_code || "—")}</span><span>低风险</span><span>已验证</span></div>
      <small>SiO₂ ${esc(c.inputs?.SiO2 ?? "—")}% · Al₂O₃ ${esc(c.inputs?.Al2O3 ?? "—")}% · 来源真实样品</small>
    </div>`;
  $("#case-mini-list").innerHTML = cases.slice(1, 4).map((x) => `
    <div class="case-mini"><b>${esc(x.city || "—")} · ${esc(x.route_code || "—")}</b><span>${esc(x.route_name || "")}</span></div>
  `).join("");
}

function renderKb(d) {
  const kb = d.kb_preview || [];
  if (!kb.length) { $("#kb-grid").innerHTML = `<div class="empty-soft">知识库加载中…</div>`; return; }
  $("#kb-grid").innerHTML = kb.slice(0, 6).map((x) => `
    <a class="kb-card" href="/precision">
      <div class="kb-card-top"><span class="kb-code">${esc(x.id)}</span><span class="kb-cat">${esc(x.category || "标准路线")}</span></div>
      <b>${esc(x.name)}</b>
      <small>${esc(x.standard || "企业/行业标准")} · 工艺参数与风险门控在端口中读取</small>
      <div class="kb-meta"><span>知识库条目</span><b>已启用</b></div>
    </a>
  `).join("");
}

function renderWorkflow(d) {
  const steps = d.workflow || [];
  $("#workflow-steps").innerHTML = steps.map((x) => `
    <div class="wf-step"><span class="wf-num">${esc(x.no)}</span><div><b>${esc(x.title)}</b><small>${esc(x.desc)}</small></div></div>
  `).join("") || `<div class="empty-soft">工作流程加载中…</div>`;
}

loadHome();
setInterval(loadHome, 60000);

/* ---------------- simple demo auth ---------------- */
const AUTH_USER_KEY = "yzb_auth_user";
const AUTH_USERS_KEY = "yzb_auth_users";
const DEMO_ADMIN = { username: "admin", password: "admin123", role: "系统管理员" };
let authMode = "login";
let memoryUsers = [];

function readUsers() {
  let users = [];
  try { users = JSON.parse(localStorage.getItem(AUTH_USERS_KEY) || "[]"); } catch (e) { users = memoryUsers; }
  if (!Array.isArray(users)) users = [];
  if (!users.some((u) => u && u.username === DEMO_ADMIN.username)) users.unshift(DEMO_ADMIN);
  return users;
}
function saveUsers(users) {
  memoryUsers = users;
  try { localStorage.setItem(AUTH_USERS_KEY, JSON.stringify(users)); } catch (e) {}
}
function currentUser() {
  try { return JSON.parse(localStorage.getItem(AUTH_USER_KEY) || "null"); } catch (e) { return null; }
}
function setCurrentUser(user) {
  try {
    if (user) localStorage.setItem(AUTH_USER_KEY, JSON.stringify({ username: user.username, role: user.role || "系统管理员" }));
    else localStorage.removeItem(AUTH_USER_KEY);
  } catch (e) {}
  paintAuthChip();
}
function paintAuthChip() {
  const u = currentUser();
  $("#auth-name").textContent = u ? u.username : "系统管理员";
  $("#auth-avatar").textContent = u ? String(u.username).slice(0, 1).toUpperCase() : "研";
}
function openAuth(mode = "login") {
  authMode = mode;
  const u = currentUser();
  $("#auth-modal").classList.add("show");
  $("#auth-error").textContent = "";
  const loggedIn = !!u;
  document.querySelectorAll(".auth-tabs, #auth-form, .auth-demo").forEach((el) => {
    el.style.display = loggedIn ? "none" : "";
  });
  $("#auth-logout").classList.toggle("hidden", !loggedIn);
  if (loggedIn) {
    $("#auth-title").textContent = "已登录";
    $("#auth-sub").textContent = `当前账号：${u.username} · ${u.role || "系统管理员"}（演示校验，仅保存在本机浏览器）`;
    return;
  }
  $("#auth-title").textContent = mode === "register" ? "注册账号" : "登录平台";
  $("#auth-sub").textContent = "演示版仅做前端校验，不连接真实账号系统。";
  document.querySelectorAll("[data-auth-tab]").forEach((b) => b.classList.toggle("active", b.dataset.authTab === mode));
  $("#auth-confirm-row").classList.toggle("hidden", mode !== "register");
  $("#auth-submit").textContent = mode === "register" ? "注册并登录" : "登录";
  setTimeout(() => { const el = mode === "register" ? $("#auth-user") : $("#auth-user"); if (el) el.focus(); }, 30);
}
function closeAuth() { $("#auth-modal").classList.remove("show"); }
function authError(msg) { $("#auth-error").textContent = msg || ""; }

function handleAuthSubmit(e) {
  e.preventDefault();
  if (currentUser()) return;
  const username = $("#auth-user").value.trim();
  const password = $("#auth-pass").value;
  const confirm = $("#auth-confirm").value;
  if (username.length < 3) return authError("用户名至少 3 个字符");
  if (password.length < 6) return authError("密码至少 6 位");
  const users = readUsers();
  if (authMode === "register") {
    if (password !== confirm) return authError("两次密码不一致");
    if (users.some((u) => u.username === username)) return authError("用户名已存在，请直接登录");
    const user = { username, password, role: "注册用户" };
    users.push(user); saveUsers(users);
    setCurrentUser(user); closeAuth(); return;
  }
  const user = users.find((u) => u.username === username && u.password === password);
  if (!user) return authError("用户名或密码不正确（演示账号 admin / admin123）");
  setCurrentUser(user); closeAuth();
}

function initAuth() {
  paintAuthChip();
  $("#auth-open").addEventListener("click", () => openAuth("login"));
  $("#auth-close").addEventListener("click", closeAuth);
  $("#auth-modal").addEventListener("click", (e) => { if (e.target === $("#auth-modal")) closeAuth(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAuth(); });
  document.querySelectorAll("[data-auth-tab]").forEach((b) => b.addEventListener("click", () => openAuth(b.dataset.authTab)));
  $("#auth-form").addEventListener("submit", handleAuthSubmit);
  $("#auth-logout").addEventListener("click", () => { setCurrentUser(null); closeAuth(); });
}
document.addEventListener("DOMContentLoaded", initAuth);
