/* "Will it run on my machine, and how long?" card under the picked paper. Numbers come from fit.js; the paper's needs come
   from the Router (the `compute` object of step 2) or, for papers we have already run, from compute.json (measured). */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const T = (s) => (window.t ? window.t(s) : s);
  let known = null, last = null;

  async function loadKnown() {
    if (known) return known;
    try { known = await (await fetch("compute.json?v=20261019a", { cache: "no-store" })).json(); } catch (e) { known = {}; }
    return known;
  }
  const minutes = (e) => (e.feasible ? `${window.Fit.fmt(e.minutes)} <span class="muted">(${window.Fit.fmt(e.low)} ${T("to")} ${window.Fit.fmt(e.high)})</span>` : "");
  const why = (e) => e.problems && e.problems.includes("gpu") ? T("needs a GPU") : e.problems && e.problems.includes("ram") ? T("not enough memory") : T("does not fit");

  async function show(id, computeOverride, afterSteps) {
    const box = $("#fitBox");
    if (!box || !window.Fit) return;
    const k = await loadKnown();
    const rec = k[id] || null;
    const compute = computeOverride || (rec && rec.compute) || null;
    if (!compute || compute.ref_minutes == null) {
      box.innerHTML = `<div class="fit"><b>${esc(T("Will it run on your machine?"))}</b> <span class="muted small">${esc(afterSteps ? T("No time estimate for this paper yet: it was planned before estimates existed. Your agent still measures the machine and keeps to the time limit.") : T("The estimate appears once the paper is read and planned (steps 1 to 3, about 2 minutes)."))}</span></div>`;
      last = [id, computeOverride, afterSteps];
      return;
    }
    const tier = window.Fit.tier(compute), guess = window.Fit.browserGuess();
    let sel = guess.cls;
    try { sel = localStorage.getItem("fitClass") || sel; } catch (e) {}
    if (!window.Fit.CLASSES.some((c) => c.id === sel)) sel = guess.cls;
    const rows = window.Fit.forClasses(compute);
    const mine = rows.find((r) => r.id === sel) || rows[1];
    const dots = "●".repeat(compute.difficulty || 3) + "○".repeat(5 - (compute.difficulty || 3));
    const src = compute.source === "measured" ? T("Measured on recorded runs.") : T("Estimated by the Router from the paper.");
    box.innerHTML = `<div class="fit">
      <div class="fithead"><b>${esc(T("Will it run on your machine?"))}</b>
        ${tier ? `<span class="tier ${tier}">${esc(T(tier === "light" ? "Light" : tier === "medium" ? "Medium" : "Heavy"))}</span>` : ""}
        <span class="diff" title="${esc(T("Difficulty"))}">${esc(T("Difficulty"))} ${compute.difficulty || 3} / 5 <span class="dots">${dots}</span></span></div>
      <label class="fitsel">${esc(T("Your machine"))} <select id="fitSel">${rows.map((r) => `<option value="${r.id}"${r.id === sel ? " selected" : ""}>${esc(T(r.name))}</option>`).join("")}</select></label>
      <div class="fitmine ${mine.est.feasible ? "ok" : "no"}">${mine.est.feasible
        ? `${esc(T("About"))} <b>${minutes(mine.est)}</b> ${esc(T("from start to verdict."))}${mine.est.path === "gpu" ? " " + esc(T("Uses the GPU.")) : ""}`
        : `<b>${esc(why(mine.est))}</b> ${esc(T("on this machine. Pick a lighter paper, or run it on a machine with a GPU."))}`}</div>
      <details class="fitall"><summary>${esc(T("All machine types"))}</summary>
        <table><tbody>${rows.map((r) => `<tr class="${r.id === sel ? "me" : ""}"><td>${esc(T(r.name))}</td><td>${r.est.feasible ? minutes(r.est) : `<span class="muted">${esc(why(r.est))}</span>`}</td></tr>`).join("")}</tbody></table>
      </details>
      <p class="muted small"><span>${esc(src)}</span> <span>${esc(T(compute.basis || ""))}</span> <span>${esc(T("Rough: agent time plus command time. Your agent measures the real machine first and stops early if the paper will not fit."))}</span></p></div>`;
    last = [id, computeOverride, afterSteps];
    $("#fitSel").onchange = (ev) => { try { localStorage.setItem("fitClass", ev.target.value); } catch (e) {} show(id, computeOverride); };
  }
  window.fitShow = show;
  document.addEventListener("langchange", () => { if (last && $("#fitBox") && $("#fitBox").innerHTML) show(last[0], last[1], last[2]); });
})();
