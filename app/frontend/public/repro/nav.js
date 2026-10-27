/* Sidebar and the three home panes (start, papers, runs). The pane comes from the URL hash, so every pane has its own link.
   Opening a run hides #home (app.js); choosing a pane from the sidebar brings the home back through the logo button. */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const side = $("#side"), menu = $("#menuBtn"), scrim = $("#sideScrim");
  const PANES = ["start", "papers", "runs"];
  const onIndex = !!$("#home");

  function openMenu(on) {
    document.body.classList.toggle("menu-open", on);
    if (menu) menu.setAttribute("aria-expanded", on ? "true" : "false");
  }
  if (menu) menu.onclick = () => openMenu(!document.body.classList.contains("menu-open"));
  if (scrim) scrim.onclick = () => openMenu(false);
  addEventListener("keydown", (e) => { if (e.key === "Escape") openMenu(false); });

  function mark(name) {
    $$(".sidenav a").forEach((a) => a.classList.toggle("on", !!((a.dataset.pane && a.dataset.pane === name) || (a.dataset.page && a.dataset.page === name))));
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
  $("#homeBtn").addEventListener("click", () => { openMenu(false); if (!viaHash) { history.replaceState(null, "", location.pathname + "#start"); setPane("start"); } });
  $$(".sidenav a[data-pane]").forEach((a) => a.addEventListener("click", (e) => {
    openMenu(false);
    if (location.pathname.endsWith("bench.html")) return;
    e.preventDefault();
    if (location.hash !== "#" + a.dataset.pane) history.pushState(null, "", "#" + a.dataset.pane);
    fromHash(); setPane(a.dataset.pane);
  }));
  addEventListener("hashchange", fromHash);
  addEventListener("popstate", fromHash);

  // picking a paper from the library opens the start form
  const picked = $("#picked");
  if (picked) new MutationObserver(() => {
    if (!picked.hidden && $('.pane[data-pane="start"]').hidden) {
      setPane("start", true);
      history.replaceState(null, "", "#start");
      $("#uploader").scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }).observe(picked, { attributes: true, attributeFilter: ["hidden"] });

  // the pipeline illustration: one stage lit at a time, select a stage to hold it
  const steps = $$("#pipeSteps li"), slabs = $$(".iso .slab");
  let cur = 0, held = false, timer = null;
  function light(i) {
    cur = i;
    steps.forEach((s, k) => s.classList.toggle("on", k === i));
    slabs.forEach((s, k) => { s.classList.toggle("on", k === i); s.classList.toggle("past", k < i); });
  }
  steps.forEach((s, k) => s.querySelector("button").addEventListener("click", () => { held = true; clearInterval(timer); light(k); }));
  if (steps.length) {
    light(0);
    if (!matchMedia("(prefers-reduced-motion: reduce)").matches) timer = setInterval(() => { if (!held) light((cur + 1) % steps.length); }, 2600);
  }

  setPane(PANES.includes(location.hash.replace("#", "")) ? location.hash.replace("#", "") : "start", true);
})();
