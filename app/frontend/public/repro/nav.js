/* Top bar, the three home panes (start, papers, runs) and the 3D bits. The pane comes from the URL hash, so every pane has
   its own link. Opening a run hides #home (app.js); the logo brings the home back. */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const PANES = ["start", "papers", "runs"];
  const onIndex = !!$("#home");
  const menu = $("#menuBtn"), suiteBtn = $("#suiteBtn"), suiteMenu = $("#suiteMenu");

  function openMenu(on) {
    document.body.classList.toggle("menu-open", on);
    if (menu) menu.setAttribute("aria-expanded", on ? "true" : "false");
  }
  function openSuite(on) {
    if (!suiteMenu) return;
    suiteMenu.hidden = !on;
    suiteBtn.setAttribute("aria-expanded", on ? "true" : "false");
  }
  if (menu) menu.onclick = () => openMenu(!document.body.classList.contains("menu-open"));
  if (suiteBtn) suiteBtn.onclick = (e) => { e.stopPropagation(); openSuite(suiteMenu.hidden); };
  document.addEventListener("click", (e) => { if (suiteMenu && !suiteMenu.hidden && !e.target.closest(".suite")) openSuite(false); });
  addEventListener("keydown", (e) => { if (e.key === "Escape") { openMenu(false); openSuite(false); } });
  addEventListener("resize", () => { if (innerWidth > 980) openMenu(false); });


  // how-to-use guide: opens from the top bar, once automatically on a first visit
  const helpM = $("#helpModal"), helpB = $("#helpBtn");
  function help(on) { if (helpM) helpM.hidden = !on; }
  if (helpB) helpB.onclick = () => help(true);
  if (helpM) {
    $("#helpClose").onclick = () => help(false);
    helpM.addEventListener("click", (e) => { if (e.target === helpM) help(false); });
    addEventListener("keydown", (e) => { if (e.key === "Escape") help(false); });
    try { if (onIndex && !localStorage.getItem("repro.helpSeen")) { localStorage.setItem("repro.helpSeen", "1"); setTimeout(() => help(true), 900); } } catch (e) {}
  }

  // the status text is hidden in the bar; keep it as the dot's tooltip
  const st = $("#status"), stt = $("#statusText");
  if (st && stt) { const sync = () => { st.title = stt.textContent; }; sync(); new MutationObserver(sync).observe(stt, { childList: true, characterData: true, subtree: true }); }

  function mark(name) {
    $$(".tbnav a, .tbsheet a").forEach((a) => a.classList.toggle("on", !!((a.dataset.pane && a.dataset.pane === name) || (a.dataset.page && a.dataset.page === name))));
  }
  if (!onIndex) { mark(document.body.dataset.page || ""); return; }

  function setPane(name, keepScroll) {
    if (!PANES.includes(name)) name = "start";
    $$(".pane").forEach((p) => { p.hidden = p.dataset.pane !== name; });
    mark(name);
    if (!keepScroll) window.scrollTo(0, 0);
  }
  let viaHash = false;
  function fromHash() {
    const h = location.hash.replace("#", "");
    if (!PANES.includes(h)) return;
    if ($("#home").hidden) { viaHash = true; $("#homeBtn").click(); viaHash = false; }   // leave a run view first
    setPane(h);
  }
  $("#homeBtn").addEventListener("click", (e) => {
    openMenu(false);
    if (!viaHash) { e.preventDefault(); history.replaceState(null, "", location.pathname + "#start"); setPane("start"); }
  });
  $$(".tbnav a[data-pane], .tbsheet a[data-pane]").forEach((a) => a.addEventListener("click", (e) => {
    openMenu(false);
    e.preventDefault();
    if (location.hash !== "#" + a.dataset.pane) history.pushState(null, "", "#" + a.dataset.pane);
    fromHash(); setPane(a.dataset.pane);
  }));
  addEventListener("hashchange", fromHash);
  addEventListener("popstate", fromHash);

  // hero buttons scroll to a section of the start pane
  $$("[data-scroll]").forEach((b) => b.addEventListener("click", () => { const t = $(b.dataset.scroll); if (t) t.scrollIntoView({ behavior: "smooth", block: "start" }); }));

  // picking a paper from the library opens the start form
  const picked = $("#picked");
  if (picked) new MutationObserver(() => {
    if (!picked.hidden && $('.pane[data-pane="start"]').hidden) {
      setPane("start", true);
      history.replaceState(null, "", "#start");
      $("#uploader").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }).observe(picked, { attributes: true, attributeFilter: ["hidden"] });

  // 3D hero: the stack follows the pointer a little
  const stage = $("#stage"), stack = $("#stack");
  if (stage && stack && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
    const host = $(".herogrid");
    host.addEventListener("pointermove", (e) => {
      const r = host.getBoundingClientRect(), x = (e.clientX - r.left) / r.width - 0.5, y = (e.clientY - r.top) / r.height - 0.5;
      stack.style.setProperty("--ry", (22 + x * 22).toFixed(1) + "deg");
      stack.style.setProperty("--rx", (10 - y * 16).toFixed(1) + "deg");
    });
    host.addEventListener("pointerleave", () => { stack.style.removeProperty("--ry"); stack.style.removeProperty("--rx"); });
  }

  // the pipeline journey: one scene at a time, select a step to hold it
  const steps = $$("#pipeSteps li"), scenes = $$(".pscene"), track = $$("#ptrack i");
  let cur = 0, held = false, timer = null;
  function light(i) {
    cur = i;
    steps.forEach((s, k) => s.classList.toggle("on", k === i));
    scenes.forEach((s, k) => s.classList.toggle("on", k === i));
    track.forEach((t, k) => { t.classList.toggle("done", k < i); t.classList.toggle("cur", k === i && !held); });
  }
  steps.forEach((s, k) => s.querySelector("button").addEventListener("click", () => { held = true; clearInterval(timer); light(k); track.forEach((t, n) => t.classList.toggle("done", n <= k)); }));
  if (steps.length) {
    light(0);
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) timer = setInterval(() => { if (!held) light((cur + 1) % steps.length); }, 3600);
  }

  setPane(PANES.includes(location.hash.replace("#", "")) ? location.hash.replace("#", "") : "start", true);
})();
