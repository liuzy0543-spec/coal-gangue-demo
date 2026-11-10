(function () {
  const HIDE_KEY = "yzb_pet_hidden";
  const POS_KEY = "yzb_pet_pos";
  const MESSAGES = [
    "我是绿色版桌宠，今天也要把煤矸石安排明白。",
    "先看成分，再选路线，别急着上设备。",
    "每个工序都可以对应一笔预算，记得看总包。",
    "端口一、二、三，现在都由智能入口统一调度。",
    "右键我，可以换个动作或者回右下角。",
  ];
  let idx = 0;
  let drag = null;
  let moved = false;
  let menu = null;
  let widget = null;

  function el(tag, cls, html) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html) e.innerHTML = html;
    return e;
  }
  function clampPos(x, y) {
    const w = Math.max(120, Math.min(168, window.innerWidth - 24));
    const h = 178;
    return {
      x: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      y: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
    };
  }
  function initialPos() {
    try {
      const p = JSON.parse(localStorage.getItem(POS_KEY) || "null");
      if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) return clampPos(p.x, p.y);
    } catch (e) {}
    return clampPos(window.innerWidth - 190, window.innerHeight - 210);
  }
  function savePos(x, y) {
    try { localStorage.setItem(POS_KEY, JSON.stringify({ x, y })); } catch (e) {}
  }
  function removeMenu() { if (menu) { menu.remove(); menu = null; } }
  function say(text) {
    if (!widget) return;
    const t = widget.querySelector("#pet-text");
    if (t) t.textContent = text;
    const b = widget.querySelector(".pet-bubble");
    if (b) { b.style.transform = "translateY(-2px)"; setTimeout(() => { b.style.transform = ""; }, 180); }
  }
  function switchAnim(src) {
    if (!widget) return;
    const v = widget.querySelector("video");
    if (!v) return;
    v.src = src;
    v.play().catch(() => {});
  }
  function makeMenu(x, y) {
    removeMenu();
    menu = el("div", "pet-menu");
    const actions = [
      ["👋 打个招呼", () => { say(MESSAGES[Math.floor(Math.random() * MESSAGES.length)]); }],
      ["🎬 换个动作", () => { switchAnim("/pet/assets/look.webm"); say("东张西望一下…"); setTimeout(() => switchAnim("/pet/assets/idle.webm"), 3200); }],
      ["↩ 回到右下角", () => { const p = clampPos(window.innerWidth - 190, window.innerHeight - 210); widget.style.left = p.x + "px"; widget.style.top = p.y + "px"; savePos(p.x, p.y); say("回到右下角啦。"); }],
      ["sep"],
      ["× 隐藏桌宠", () => { hidePet(); }, true],
    ];
    actions.forEach(([label, fn, danger]) => {
      if (label === "sep") { menu.appendChild(el("div", "sep")); return; }
      const b = el("button", danger ? "danger" : "", label);
      b.onclick = (e) => { e.stopPropagation(); removeMenu(); fn && fn(); };
      menu.appendChild(b);
    });
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(8, Math.min(x, window.innerWidth - r.width - 8)) + "px";
    menu.style.top = Math.max(8, Math.min(y, window.innerHeight - r.height - 8)) + "px";
  }
  function hidePet() {
    try { localStorage.setItem(HIDE_KEY, "1"); } catch (e) {}
    if (widget) { widget.remove(); widget = null; }
    removeMenu();
    const reopen = el("button", "pet-reopen", "🐟 桌宠");
    reopen.id = "pet-reopen";
    reopen.onclick = () => {
      try { localStorage.removeItem(HIDE_KEY); } catch (e) {}
      reopen.remove();
      mount();
    };
    document.body.appendChild(reopen);
  }
  function mount() {
    if (document.getElementById("dsh-pet-widget")) return;
    if (localStorage.getItem(HIDE_KEY) === "1") return;
    const link = document.createElement("link");
    link.rel = "stylesheet"; link.href = "/static/pet/pet.css";
    document.head.appendChild(link);
    widget = el("div"); widget.id = "dsh-pet-widget";
    const bubble = el("div", "pet-bubble", `<b>dsh-pet · 绿色版</b><span id="pet-text">${MESSAGES[0]}</span>`);
    const stage = el("div", "pet-stage");
    const video = document.createElement("video");
    video.autoplay = true; video.loop = true; video.muted = true; video.playsInline = true;
    video.setAttribute("muted", ""); video.setAttribute("playsinline", ""); video.src = "/pet/assets/idle.webm";
    stage.appendChild(video);
    stage.appendChild(el("span", "pet-badge", "拖拽 / 右键"));
    const close = el("button", "pet-close", "×"); close.title = "收起桌宠";
    stage.appendChild(close);
    widget.appendChild(bubble); widget.appendChild(stage);
    document.body.appendChild(widget);
    const p = initialPos(); widget.style.left = p.x + "px"; widget.style.top = p.y + "px";

    stage.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      if (e.target.closest(".pet-close")) return;
      drag = { sx: e.clientX, sy: e.clientY, ox: parseFloat(widget.style.left) || 0, oy: parseFloat(widget.style.top) || 0 };
      moved = false; stage.classList.add("dragging"); stage.setPointerCapture && stage.setPointerCapture(e.pointerId);
    });
    stage.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      const p = clampPos(drag.ox + dx, drag.oy + dy);
      widget.style.left = p.x + "px"; widget.style.top = p.y + "px";
    });
    const endDrag = () => {
      if (!drag) return;
      stage.classList.remove("dragging");
      savePos(parseFloat(widget.style.left) || 0, parseFloat(widget.style.top) || 0);
      drag = null;
    };
    stage.addEventListener("pointerup", endDrag);
    stage.addEventListener("pointercancel", endDrag);
    stage.addEventListener("click", (e) => {
      if (e.target.closest(".pet-close")) return;
      if (moved) { moved = false; return; }
      idx = (idx + 1) % MESSAGES.length; say(MESSAGES[idx]);
    });
    stage.addEventListener("contextmenu", (e) => {
      e.preventDefault(); e.stopPropagation();
      makeMenu(e.clientX, e.clientY);
    });
    close.addEventListener("click", (e) => { e.stopPropagation(); hidePet(); });
    window.addEventListener("resize", () => {
      if (!widget) return;
      const p = clampPos(parseFloat(widget.style.left) || 0, parseFloat(widget.style.top) || 0);
      widget.style.left = p.x + "px"; widget.style.top = p.y + "px";
    });
    document.addEventListener("click", removeMenu);
    setTimeout(() => say(MESSAGES[1]), 4200);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount);
  else mount();
})();
