/* Paper Repro Agent UI. Works against a live runner (same origin or ?runner=URL) and, without one,
   in replay mode using the recorded runs and PDFs in ./demo-runs/. No build step. */
(function () {
  "use strict";
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const fmtS = (s) => (s == null || isNaN(s) ? "--" : s < 60 ? `${s.toFixed(1)}s` : `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, "0")}s`);
  const fmtN = (n) => (n == null ? "--" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n));
  const STAGES = [["reader", "Reader", "paper analysis"], ["router", "Router", "release and compute check"], ["planner", "Planner", "implementation plan"],
    ["implementer", "Implementer", "code and experiments"], ["verifier", "Verifier", "independent re-run and audit"]];
  const ROUTE_LONG = { full_release: "Authors' code released and runnable", partial_release: "Authors' code released, but incomplete or not runnable as released",
    paper_only: "No author code released; method reimplemented from the paper" };
  const ROLES = ["reader", "router", "planner", "executor", "verifier"];
  const VERDICT = { reproduced: "Reproduced", partially_reproduced: "Partially reproduced", not_reproduced: "Not reproduced", could_not_run: "Could not run" };
  const ROUTE = { full_release: "full release", partial_release: "partial release", paper_only: "paper only" };
  // pdf.js is vendored in web/vendor (Apache-2.0) so the viewer works without a CDN.
  const workerReady = Promise.resolve(window.pdfjsLib && (pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js"));

  const params = new URLSearchParams(location.search);
  // Runner: ?runner=URL, else the URL in runner.json (written when the page is deployed apart from
  // the runner, e.g. on Vercel), else the same origin.
  let RUNNER = params.get("runner") || "";
  async function findRunner() {
    if (RUNNER) return;
    try { const r = await fetch("runner.json", { cache: "no-store" }); if (r.ok) RUNNER = (await r.json()).url || ""; } catch (e) {}
  }
  const keyHeaders = () => { const k = $("#keyIn").value.trim(); return k ? { "X-Access-Key": k } : {}; };
  const api = (p) => (RUNNER ? RUNNER.replace(/\/$/, "") : "") + p;
  let live = false, demos = [], recorded = [], cur = null, es = null, timer = null, clock = null, paused = false;
  let speed = params.has("speed") ? +params.get("speed") : 20;
  let picked = null; // {mode:'file'|'sample'|'id', file, demo, data}

  // =============================== runner + data ===============================
  async function probe() {
    try {
      const r = await fetch(api("/api/health"), { cache: "no-store" });
      if (!r.ok) throw 0;
      const h = await r.json();
      live = true;
      $("#arxivSearch").hidden = false;   // searching all of arXiv needs the runner
      $("#status").className = "status live";
      $("#statusText").textContent = `Runner online · ${h.resources.cpu_cores} CPU cores · ${h.resources.ram_gb} GB RAM · GPU ${h.resources.gpu} · spent ¥${h.global_spend_cny}`;
      $("#keyLabel").hidden = !h.needs_key;
      try { $("#keyIn").value = localStorage.getItem("accessKey") || ""; } catch (e) {}
    } catch (e) {
      live = false;
      $("#status").className = "status replay";
      $("#statusText").textContent = "Replay mode: no runner connected, recorded runs only";
    }
  }

  // a live runner uses its own default models; the limits below are the runner's usual ones
  function config() {
    return { max_cost_cny: 15, max_wall_minutes: 60, max_executor_steps: 120 };
  }

  async function loadDemos() {
    try { demos = await (await fetch("demos.json?v=20261020a", { cache: "no-store" })).json(); } catch (e) { try { demos = await (await fetch(api("/api/demos"))).json(); } catch (e2) { demos = []; } }
    try { recorded = await (await fetch("demo-runs/index.json?v=20261020a", { cache: "no-store" })).json(); } catch (e) { recorded = []; }
    $("#samples").innerHTML = demos.map((d) => {
      const recs = recorded.filter((r) => r.demo_id === d.id);
      const rec = recs[0];
      const hist = recs.length > 1 ? `<span class="muted more-runs">${recs.length} recorded runs: ${recs.map((r) => esc(VERDICT[r.verdict] || r.status).toLowerCase()).join(", ")}</span>` : "";
      return `<button class="sample" type="button" data-id="${esc(d.id)}">
        <div class="th"><canvas data-pdf="${esc(d.pdf || "")}"></canvas></div>
        <div class="bd"><div><span class="badge ${d.route}">${esc(ROUTE[d.route])}</span></div>
          <b>${esc(d.title)}</b><p>${esc(d.scenario)}</p>
          ${rec && rec.verdict ? `<div class="res"><span class="badge ${rec.verdict}">${esc(VERDICT[rec.verdict])}</span><span class="muted">${fmtS(rec.seconds)} · ¥${(+rec.cost_cny).toFixed(2)}</span>${hist}</div>` : ""}
        </div></button>`;
    }).join("");
    $$("#samples canvas").forEach((c) => { if (c.dataset.pdf) thumb("demo-runs/" + c.dataset.pdf, c, 260); });
    $("#samples").onclick = (e) => { const b = e.target.closest(".sample"); if (b) pickSample(demos.find((d) => d.id === b.dataset.id)); };
  }

  let showAllRuns = false;
  async function loadRuns() {
    let rows = recorded.slice();
    if (live) {
      try {
        const liveRows = await (await fetch(api("/api/runs"))).json();
        const ids = new Set(liveRows.map((r) => r.id));
        rows = liveRows.concat(rows.filter((r) => !ids.has(r.id)));
      } catch (e) {}
    }
    if (!rows.length) return;
    const btn = $("#allRunsBtn");
    btn.hidden = rows.length <= 12;
    btn.textContent = showAllRuns ? "Show the latest 12" : `Show all ${rows.length} runs`;
    btn.onclick = () => { showAllRuns = !showAllRuns; loadRuns(); };
    $("#runs").innerHTML = rows.slice(0, showAllRuns ? rows.length : 12).map((r) => `<div class="runrow" data-id="${esc(r.id)}" data-file="${esc(r.file || "")}" data-pdf="${esc(r.pdf || "")}" data-status="${esc(r.status || "")}">
        <span class="t">${esc(r.title || r.paper)}</span>
        <span class="m">${r.verdict ? `<span class="badge ${r.verdict}">${esc(VERDICT[r.verdict])}</span>` : `<span class="badge ${r.status === "running" ? "running" : ""}">${esc(r.status)}</span>`}
        ${r.route ? esc(ROUTE[r.route] || r.route) + " · " : ""}${r.seconds ? fmtS(r.seconds) : ""}${r.cost_cny != null ? " · ¥" + (+r.cost_cny).toFixed(2) : ""}</span></div>`).join("");
    $("#runs").onclick = (e) => {
      const row = e.target.closest(".runrow");
      if (!row) return;
      if (row.dataset.file) openReplay(row.dataset.file, row.dataset.pdf);
      else openLive(row.dataset.id, { running: row.dataset.status === "running" });
    };
  }

  // =============================== PDF helpers ===============================
  async function openPdf(src) {
    if (!window.pdfjsLib) throw new Error("pdf.js did not load");
    await workerReady;
    return pdfjsLib.getDocument(typeof src === "string" ? { url: src } : { data: src }).promise;
  }
  async function thumb(src, canvas, width) {
    try {
      const doc = await openPdf(src);
      const page = await doc.getPage(1);
      const vp0 = page.getViewport({ scale: 1 });
      const dpr = window.devicePixelRatio || 1;
      const vp = page.getViewport({ scale: (width / vp0.width) * dpr });
      canvas.width = vp.width; canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      const meta = await doc.getMetadata().catch(() => ({}));
      return { pages: doc.numPages, title: (meta.info && meta.info.Title) || "" };
    } catch (e) { return null; }
  }

  // =============================== home: picking a paper ===============================
  const drop = $("#drop"), fileInput = $("#fileInput");
  drop.addEventListener("click", (e) => { if (e.target.id === "useId") return; fileInput.click(); });
  drop.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fileInput.click(); } });
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) pickFile(f); });
  fileInput.addEventListener("change", () => { if (fileInput.files[0]) pickFile(fileInput.files[0]); });
  $("#useId").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); showPicked({ mode: "id" }); });
  $("#clearPick").addEventListener("click", () => { picked = null; $("#picked").hidden = true; drop.hidden = false; fileInput.value = ""; });

  function showPicked(p) {
    picked = p;
    drop.hidden = true;
    $("#picked").hidden = false;
    $(".thumbwrap").hidden = p.mode === "id";
    $("#paperId").closest("label").hidden = p.mode !== "id";
    $("#pickedFile").textContent = p.mode === "file" ? p.file.name : p.mode === "sample" ? "sample paper" : "paper by link";
    $("#pickedTitle").textContent = p.mode === "id" ? "Paste an arXiv ID or a PDF link" : "Reading PDF";
    $("#pickedMeta").textContent = "";
    $("#pickedNote").textContent = "";
    $("#pickedStatus").innerHTML = "";
    if ($("#fitBox")) $("#fitBox").innerHTML = "";
    $("#repoIn").value = p.demo ? p.demo.repo || "" : "";
    $("#hintIn").value = p.demo ? p.demo.target_hint || "" : "";
    $("#upbar").style.width = "0";
    $("#formMsg").textContent = "";
    renderActions();
    if (window.kitSetState) window.kitSetState(false);
  }

  async function pickFile(file) {
    showPicked({ mode: "file", file });
    const data = new Uint8Array(await file.arrayBuffer());
    picked.data = data;
    requestAnimationFrame(() => ($("#upbar").style.width = "100%"));
    const info = await thumb(data.slice(0), $("#pickedThumb"), 440);
    $("#pickedTitle").textContent = (info && info.title) || file.name.replace(/\.pdf$/i, "");
    $("#pickedMeta").textContent = `${info ? info.pages + " pages · " : ""}${(file.size / 1024).toFixed(0)} KB`;
    renderActions();
  }

  async function pickSample(d) {
    showPicked({ mode: "sample", demo: d });
    $("#pickedFile").textContent = (d.pdf || "paper.pdf") + " · sample";
    $("#pickedTitle").textContent = d.title;
    setTimeout(() => ($("#upbar").style.width = "100%"), 30);
    const info = d.pdf ? await thumb("demo-runs/" + d.pdf, $("#pickedThumb"), 440) : null;
    const rec = recorded.find((r) => r.demo_id === d.id);
    $("#pickedMeta").innerHTML = `<span class="badge ${d.route}">${esc(ROUTE[d.route])}</span> ${info ? info.pages + " pages" : ""}`;
    $("#pickedNote").textContent = d.scenario + (rec ? ` A recorded run took ${fmtS(rec.seconds)} and cost ¥${(+rec.cost_cny).toFixed(2)}.` : "");
    renderActions();
    $("#uploader").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function renderActions() {
    const a = $("#pickedActions");
    if (!picked) return (a.innerHTML = "");
    const rec = picked.demo && recorded.find((r) => r.demo_id === picked.demo.id);
    let html = "";
    if (picked.mode === "sample" && rec) html += `<button class="primary" data-act="replay">Watch the agent reproduce it</button>`;
    if (live) html += `<button class="${html ? "ghost" : "primary"}" data-act="live">${picked.mode === "sample" ? "Run it live now" : "Start reproduction"}</button>`;
    a.innerHTML = html;
    a.onclick = (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      if (b.dataset.act === "replay") openReplay(rec.file, rec.pdf);
      if (b.dataset.act === "live") startLive();
    };
  }

  async function startLive() {
    $("#formMsg").textContent = "Starting...";
    const repo = $("#repoIn").value.trim() || null, hint = $("#hintIn").value.trim() || null;
    let j, r;
    try {
      if (picked.mode === "file") {
        const fd = new FormData();
        fd.append("file", new Blob([picked.data], { type: "application/pdf" }), picked.file.name);
        fd.append("repo", repo || ""); fd.append("target_hint", hint || ""); fd.append("config", JSON.stringify(config()));
        r = await fetch(api("/api/runs/upload"), { method: "POST", headers: keyHeaders(), body: fd });
      } else {
        const body = picked.mode === "sample" ? { demo_id: picked.demo.id, repo, target_hint: hint, config: config() }
          : { paper: $("#paperId").value.trim(), repo, target_hint: hint, config: config() };
        if (picked.mode === "id" && !body.paper) { $("#formMsg").textContent = "Give an arXiv ID or a PDF link."; return; }
        r = await fetch(api("/api/runs"), { method: "POST", headers: { "Content-Type": "application/json", ...keyHeaders() }, body: JSON.stringify(body) });
      }
    } catch (e) { $("#formMsg").textContent = "Could not reach the runner."; return; }
    j = await r.json().catch(() => ({}));
    if (r.status === 401) { $("#formMsg").textContent = "Wrong or missing access key."; return; }
    if (!j.run_id) { $("#formMsg").textContent = j.detail || JSON.stringify(j); return; }
    try { localStorage.setItem("accessKey", $("#keyIn").value.trim()); } catch (e) {}
    const pdf = picked.mode === "file" ? picked.data : picked.mode === "sample" && picked.demo.pdf ? "demo-runs/" + picked.demo.pdf : null;
    openLive(j.run_id, { pdf, running: true });
  }

  // =============================== home: finding a paper on arXiv ===============================
  let searchMode = "author", lastResults = [], lastQuery = "", nextStart = 0;
  $("#searchMode").onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    searchMode = b.dataset.m;
    $$("#searchMode button").forEach((x) => x.classList.toggle("on", x === b));
    $("#searchIn").placeholder = searchMode === "author" ? "e.g. Yujiu Yang" : "e.g. isolation forest anomaly";
  };
  $("#searchForm").onsubmit = async (e) => {
    e.preventDefault();
    const q = $("#searchIn").value.trim();
    if (q.length < 2) return;
    if (!live) return localSearch(q);
    lastQuery = q; lastResults = []; nextStart = 0;
    $("#results").innerHTML = "";
    await searchPage();
  };

  async function searchPage() {
    const q = lastQuery, first = nextStart === 0;
    $("#searchMsg").textContent = "Searching arXiv...";
    try {
      const r = await fetch(api(`/api/search?q=${encodeURIComponent(q)}&mode=${searchMode}&start=${nextStart}`));
      const j = await r.json();
      if (!r.ok) throw new Error(j.detail || r.status);
      const pinned = first ? j.already_run : [];
      const seen = new Set(lastResults.map((p) => p.id).concat(pinned.map((p) => p.id)));
      const fresh = j.papers.filter((p) => !seen.has(p.id));
      if (first && pinned.length) lastResults.push(...pinned.map((p) => ({ ...p, pinned: true })));
      lastResults.push(...fresh);
      nextStart = j.start + j.papers.length;
      const n = lastResults.length;
      $("#searchMsg").textContent = n ? `${n} papers${pinned.length ? `; the ${pinned.length} already run here are listed first` : ""}, the rest newest first.`
        : "No papers found. For an author, try the name as written on the paper.";
      renderResults(lastResults, q, j.has_more);
    } catch (err) { $("#searchMsg").textContent = "Search failed: " + err.message; }
  }

  function renderResults(rows, q, more) { $("#results").innerHTML = resultHtml(rows, 0, q, more, "moreResults"); }
  function resultHtml(rows, offset, q, more, moreId) {
    const words = searchMode === "author" && q ? q.toLowerCase().split(/\s+/) : [];
    const isMatch = (a) => words.length && words.every((w) => a.toLowerCase().includes(w));
    return rows.map((p, i) => `<div class="result">
        <a class="t" href="https://arxiv.org/abs/${esc(p.id)}" target="_blank" rel="noopener">${esc(p.title)}</a>
        <div class="au">${p.authors.map((a) => (isMatch(a) ? `<b>${esc(a)}</b>` : esc(a))).join(", ")}</div>
        ${p.groups && p.groups.length ? `<div class="inst">${p.groups.map((g) => `<b>${esc(L(g, "name"))}</b> · ${esc(L(g, "institute"))}`).join("; ")}</div>` : ""}
        <div class="muted small mono">${esc(p.id)} · ${esc(p.published)}${p.category ? " · " + esc(p.category) : ""}${p.comment ? " · " + esc(p.comment.slice(0, 90)) : ""}</div>
        <details><summary>Abstract</summary><p>${esc(p.summary)}</p></details>
        <div class="ra"><span class="past">${(p.recs || []).map((r) => `<button type="button" data-rfile="${esc(r.file)}" data-rpdf="${esc(r.pdf || "")}"><span class="badge ${esc(r.verdict || "")}">${esc(VERDICT[r.verdict] || r.status)}</span></button>`).join("")}${(p.jobs || []).map((j) => `<span class="badge ${esc(j.verdict || "")}" title="Run on a user's own agent">${esc(VERDICT[j.verdict] || j.verdict || "")}</span>`).join("")}${(p.runs || []).map((r) => `<button type="button" data-run="${esc(r.id)}" data-status="${esc(r.status)}" title="Open run ${esc(r.id)}"><span class="badge ${esc(r.verdict || (r.status === "running" ? "running" : ""))}">${esc(r.verdict ? VERDICT[r.verdict] : r.status)}</span></button>`).join("")}</span>
          <button class="ghost" type="button" data-pick="${offset + i}">Reproduce this paper</button></div>
        <div class="rtier">${tierTag(p.id)}</div>
      </div>`).join("") + (more ? `<button class="ghost" type="button" id="${moreId}">Load more papers</button>` : "");
  }
  $("#results").onclick = (e) => {
    if (e.target.id === "moreResults") { e.target.disabled = true; return searchPage(); }
    const rf = e.target.closest("[data-rfile]");
    if (rf) return openReplay(rf.dataset.rfile, rf.dataset.rpdf || null);
    const run = e.target.closest("[data-run]");
    if (run) return openLive(run.dataset.run, { running: run.dataset.status === "running" });
    const b = e.target.closest("[data-pick]");
    if (!b) return;
    pickPaper(lastResults[+b.dataset.pick]);
  };
  function pickPaper(p) {
    showPicked({ mode: "id" });
    $("#paperId").value = p.id;
    $("#pickedFile").textContent = "arXiv " + p.id;
    $("#pickedTitle").textContent = p.title;
    $("#pickedMeta").textContent = `${p.authors.slice(0, 6).join(", ")}${p.authors.length > 6 ? ", et al." : ""} · ${p.published}`;
    const n = (p.runs || []).length;
    $("#pickedNote").textContent = n ? `Already run here ${n} time${n > 1 ? "s" : ""}; a new run is saved next to the earlier ones.` : "";
    const recs = p.recs || [], jobs = p.jobs || [];
    const badge = (v, st) => `<span class="badge ${esc(v || "")}">${esc(VERDICT[v] || st || v || "")}</span>`;
    if (window.kitSetState) window.kitSetState(!!(recs.length || jobs.length));
    if (window.fitShow) window.fitShow(p.id);
    $("#pickedStatus").innerHTML = (recs.length || jobs.length
      ? `<div class="pstat done"><b>Already reproduced</b> ${recs.map((r) => `<button type="button" class="linkish" data-rfile="${esc(r.file)}" data-rpdf="${esc(r.pdf || "")}">${badge(r.verdict, r.status)}</button>`).join(" ")}</div>${jobs.length ? `<div class="pjobs"><b>${jobs.length > 1 ? jobs.length + " " + t("runs on users' own agents") : t("Run on a user's own agent")}</b>${jobs.map((j) => `<button type="button" class="linkish pjob" data-job="${esc(j.id)}">${badge(j.verdict)} ${esc(j.agent || "")}${j.model ? " · " + esc(j.model) : ""}${j.requested_by ? " · " + esc(j.requested_by) : ""} · ${esc(new Date(j.created_at).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }))}</button>`).join("")}</div>` : ""}<div>
          <span class="muted small">Open a recorded run, or get the link below to run it again on your own agent.</span></div>`
      : `<div class="pstat todo"><b>Not reproduced yet</b> <span class="muted small">Get the link below, give it to your agent, and the result is saved here.</span></div>`)
      + (p.summary ? `<details class="abs"><summary>Abstract</summary><p>${esc(p.summary)}</p></details>` : "");
    $("#uploader").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // =============================== home: browse by research group (static, no runner) ===============================
  let dir = null, browseRows = [], browseShown = 0, computeMap = {};
  const tierOf = (id) => { const c = computeMap[id] && computeMap[id].compute; return c && window.Fit ? window.Fit.tier(c) : null; };
  function tierTag(id) {
    const e = computeMap[id], c = e && e.compute, tr = tierOf(id);
    if (!c || !tr) return `<span class="tier none">${esc(t("Not estimated yet"))}</span>`;
    const m = window.Fit.estimate(c, window.Fit.CLASSES[1]);
    const rel = e.release ? ` · ${esc(t("Code"))}: ${esc(t(e.release === "full" ? "released" : e.release === "partial" ? "partly released" : e.release === "none" ? "not released" : "unknown"))}` : "";
    return `<span class="tier ${tr}">${esc(t(tr === "light" ? "Light" : tr === "medium" ? "Medium" : "Heavy"))}</span> <span class="muted small">${esc(t("Difficulty"))} ${c.difficulty || 3}/5${m.feasible ? " · ~" + window.Fit.fmt(m.minutes) : " · " + esc(t("needs a GPU"))}${rel}</span>`;
  }
  const L = (o, k) => (window.getLang && window.getLang() === "zh" && o[k + "_zh"]) || o[k];
  const surname = (n) => n.trim().split(/ +/).slice(-1)[0].toLowerCase();
  let jobDone = {};   // arXiv id -> finished runs made through "run it on your own agent"
  const recsFor = (id) => recorded.filter((r) => r.paper === id);
  const doneFor = (id) => recsFor(id).length + (jobDone[id] || []).length;
  async function loadJobs() {
    try {
      const r = await fetch("https://vzvyghmtsakixlhzzuol.supabase.co/rest/v1/repro_jobs?status=eq.done&or=(agent.is.null,agent.neq.recorded-run-seed)&select=id,arxiv_id,verdict,agent,model,requested_by,created_at&order=created_at.desc", { headers: { apikey: "sb_publishable_KMh-HF6q3wnJvux9OSes2g_XLtn2aBc" } });
      jobDone = {};
      for (const j of r.ok ? await r.json() : []) { const id = arxivIdOf(j.arxiv_id); if (id) (jobDone[id] = jobDone[id] || []).push(j); }
    } catch (e) {}
  }
  const arxivIdOf = (x) => { const m = String(x || "").match(/([0-9]{4}[.][0-9]{4,5})/); return m ? m[1] : null; };
  async function loadDirectory() {
    // one shared copy in Supabase (editable without a redeploy); the file next to the page is the fallback
    try {
      const r = await fetch("https://vzvyghmtsakixlhzzuol.supabase.co/rest/v1/repro_directory?key=eq.directory&select=data", { headers: { apikey: "sb_publishable_KMh-HF6q3wnJvux9OSes2g_XLtn2aBc" } });
      const j = r.ok ? await r.json() : [];
      dir = j[0] && j[0].data && j[0].data.groups ? j[0].data : null;
    } catch (e) { dir = null; }
    if (!dir) { try { dir = await (await fetch("directory.json?v=20261020a", { cache: "no-store" })).json(); } catch (e) { dir = null; } }
    if (!dir || !dir.groups || !dir.groups.length) { $("#browseMsg").textContent = "Could not load the paper list. Reload the page (Ctrl+F5)."; return; }
    $("#grpSel").innerHTML = dir.groups.map((g, i) => `<option value="${i}">${esc(g.name)} · ${esc(g.institute)}</option>`).join("");
    try { computeMap = await (await fetch("compute.json?v=20261020a", { cache: "no-store" })).json(); } catch (e) { computeMap = {}; }
    await loadJobs();
    fillAuthors();
  }
  function fillAuthors() {
    const g = dir.groups[+$("#grpSel").value];
    const ms = g.members.slice().sort((a, b) => surname(a.name).localeCompare(surname(b.name)) || a.name.localeCompare(b.name));
    let letter = "", html = `<option value="">All authors</option>`;
    for (const m of ms) {
      const l = (surname(m.name)[0] || "#").toUpperCase();
      if (l !== letter) { html += (letter ? "</optgroup>" : "") + `<optgroup label="${esc(l)}">`; letter = l; }
      html += `<option value="${esc(m.name)}">${esc(m.name)} (${m.papers})</option>`;
    }
    $("#authSel").innerHTML = html + (letter ? "</optgroup>" : "");
    browse();
  }
  function browse() {
    const g = dir.groups[+$("#grpSel").value], who = $("#authSel").value, f = $("#titleFilter").value.trim().toLowerCase(), st = $("#statusSel").value, tf = $("#tierSel") ? $("#tierSel").value : "";
    browseRows = g.papers.map((id) => dir.papers[id]).filter((p) => p && (!who || p.authors.includes(who))
      && (!f || (p.title + " " + p.authors.join(" ")).toLowerCase().includes(f))
      && (!st || (st === "done") === doneFor(p.id) > 0)
      && (!tf || (tf === "none" ? !tierOf(p.id) : tierOf(p.id) === tf))).map((p) => ({ ...p, groups: [g], recs: recsFor(p.id), jobs: jobDone[p.id] || [], runs: [] }));
    browseShown = 0;
    $("#browseResults").innerHTML = "";
    const nDone = browseRows.filter((p) => p.recs.length || p.jobs.length).length;
    $("#browseMsg").textContent = `${browseRows.length} papers in this group` + (nDone ? `, ${nDone} reproduced` : "");
    browseMore();
  }
  function browseMore() {
    const next = browseRows.slice(browseShown, browseShown + 20);
    browseShown += next.length;
    lastResults = browseRows;
    const old = $("#moreBrowse");
    if (old) old.remove();
    $("#browseResults").insertAdjacentHTML("beforeend", resultHtml(next, browseShown - next.length, "", browseShown < browseRows.length, "moreBrowse"));
  }
  // group and institute names come in both languages, so draw the rows again when the language changes
  document.addEventListener("langchange", () => {
    if (!dir) return;
    const n = browseShown; browseShown = 0; $("#browseResults").innerHTML = "";
    do browseMore(); while (browseShown < n);
  });
  $("#grpSel").onchange = fillAuthors;
  $("#authSel").onchange = browse;
  $("#statusSel").onchange = browse;
  if ($("#tierSel")) $("#tierSel").onchange = browse;
  $("#titleFilter").oninput = () => { clearTimeout(browse.t); browse.t = setTimeout(browse, 200); };
  $("#pickedStatus").onclick = (e) => {
    const jb = e.target.closest("[data-job]");
    if (jb && window.openJob) return window.openJob(jb.dataset.job);
    const rf = e.target.closest("[data-rfile]");
    if (rf) openReplay(rf.dataset.rfile, rf.dataset.rpdf || null);
  };
  $("#browseResults").onclick = (e) => {
    if (e.target.id === "moreBrowse") return browseMore();
    const rf = e.target.closest("[data-rfile]");
    if (rf) return openReplay(rf.dataset.rfile, rf.dataset.rpdf || null);
    const b = e.target.closest("[data-pick]");
    if (b) pickPaper(browseRows[+b.dataset.pick]);
  };
  // the search box falls back to the same directory when no runner is connected
  function localSearch(q) {
    if (!dir) { $("#searchMsg").textContent = "Searching needs a running runner."; return; }
    const w = q.toLowerCase().split(/ +/);
    const rows = [];
    for (const g of dir.groups) for (const id of g.papers) {
      const p = dir.papers[id];
      const hay = searchMode === "author" ? p.authors.join(" ").toLowerCase() : (p.title + " " + p.summary).toLowerCase();
      if (w.every((x) => hay.includes(x)) && !rows.some((r) => r.id === id)) rows.push({ ...p, groups: [g], recs: recsFor(id), runs: [] });
    }
    lastResults = rows;
    $("#searchMsg").textContent = rows.length ? `${rows.length} papers shown` : "No papers found in the built-in list. Connect a runner to search all of arXiv.";
    $("#results").innerHTML = resultHtml(rows.slice(0, 40), 0, q, false, "moreResults");
  }

  // =============================== run view ===============================
  function showView(v) {
    $("#home").hidden = v !== "home";
    $("#run").hidden = v !== "run";
    window.scrollTo(0, 0);
  }
  $("#homeBtn").onclick = () => { stopAll(); showView("home"); loadRuns(); };

  function stopAll() {
    if (es) { es.close(); es = null; }
    clearTimeout(timer); clearInterval(clock);
    if (cur && cur.scanTimer) clearInterval(cur.scanTimer);
  }

  function fresh(id, mode) {
    return { id, mode, stages: {}, active: null, meter: {}, t: 0, startTs: null, endT: null, commands: 0, status: "running",
      contract: null, full: null, route: null, resources: null, ledger: [], verdict: null, calls: {}, lastThink: null,
      pages: [], pdfReady: false, scanTimer: null, readerGroup: null, hlHidden: new Set() };
  }

  function resetView(id, mode) {
    stopAll();
    cur = fresh(id, mode);
    showView("run");
    $("#timeline").innerHTML = "";
    $("#pages").innerHTML = `<p class="muted small pad">The PDF appears here.</p>`;
    ["verdictCard", "contractCard", "routeCard", "ledgerCard", "costCard", "filesCard"].forEach((c) => { $("#" + c).hidden = true; $("#" + c).innerHTML = ""; });
    $("#rvId").textContent = `${mode === "replay" ? "recorded run" : "live run"} · ${id}`;
    $("#rvTitle").textContent = "Starting";
    $("#rvBadges").innerHTML = "";
    $("#readChip").textContent = "Waiting for the paper";
    $("#readChip").className = "readchip";
    $("#replayCtl").hidden = mode !== "replay";
    $("#stopBtn").hidden = mode !== "live";
    $("#stopBtn").disabled = false; $("#stopBtn").textContent = "Stop run";
    $("#reportBtn").hidden = true;
    cur.stageEls = {};
    cur.ov = { llm: {}, llmBars: [], cmds: {}, mgr: [], retries: 0, files: new Set(), fails: 0, rerun: null, pages: null };
    $("#story").innerHTML = `<dt>Status</dt><dd class="muted">Filled in as the run progresses.</dd>`;
    $("#timeSplit").innerHTML = ""; $("#runMap").innerHTML = "";
    $("#objBody").innerHTML = `<p class="muted small">Defined after the paper has been analysed.</p>`;
    $("#resBody").innerHTML = `<p class="muted small">Pending.</p>`;
    $("#cmpBody").innerHTML = `<p class="muted small">Pending.</p>`;
    $("#stageBar").innerHTML = "";
    paused = false; $("#playBtn").innerHTML = "&#10074;&#10074;";
    $$("#speedSeg button").forEach((x) => x.classList.toggle("on", +x.dataset.s === speed));
    renderStepper(); renderMetrics();
    if (mode === "live") clock = setInterval(() => { if (cur.status === "running") { renderMetrics(); renderStepper(); } }, 1000);
  }

  // Process details are open while a run is being watched and fold away once there is a result,
  // so a finished run opens on its result. A click on the toggle wins over both.
  function setDetails(open, byUser) {
    if (byUser && cur) cur.detailsUser = true;
    $("#details").hidden = !open;
    const b = $("#detailsBtn");
    b.textContent = open ? "Hide process details" : "Show process details";
    b.setAttribute("aria-expanded", String(open));
    if (open && cur) {
      if (cur.pdfSrc && !cur.pdfStarted) renderPaper(cur.pdfSrc);
      renderOverview();
    }
  }
  $("#detailsBtn").addEventListener("click", () => setDetails($("#details").hidden, true));

  function showOnPaper(id) {
    setDetails(true, true);
    $(".paper").scrollIntoView({ behavior: "smooth", block: "start" });
    if (cur.pdfReady && cur.hlIndex) jumpTo(id); else cur.pendingJump = id;
  }

  function openLive(id, opts) {
    resetView(id, "live");
    setDetails(opts.running !== false);
    if (opts.running == null) {  // opened by link: only a run still going starts with the details open
      fetch(api(`/api/runs/${id}`)).then((r) => r.json()).then((j) => {
        if (cur && cur.id === id && !cur.detailsUser && j.meta && j.meta.status !== "running") setDetails(false);
      }).catch(() => {});
    }
    if (opts.pdf) loadPaper(opts.pdf);
    cur.pdfPending = !opts.pdf;
    es = new EventSource(api(`/api/runs/${id}/events`));
    es.onmessage = (m) => { const ev = JSON.parse(m.data); apply(ev); if (ev.type === "run_end" && es) { es.close(); es = null; } };
    es.addEventListener("idle", () => es.close());
  }

  async function openReplay(file, pdf) {
    const id = file.replace(".jsonl", "");
    resetView(id, "replay");
    setDetails(speed !== 0);
    if (pdf) loadPaper("demo-runs/" + pdf);
    let text = "";
    try { text = await (await fetch(file.startsWith("/") || file.startsWith("http") || file.startsWith("bench/") ? file : "demo-runs/" + file)).text(); }
    catch (e) { $("#rvTitle").textContent = "Could not load the recording"; return; }
    const evs = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
    let i = 0;
    const step = () => {
      if (!cur || cur.id !== id) return;
      if (paused) { timer = setTimeout(step, 200); return; }
      if (speed === 0) { while (i < evs.length) apply(evs[i++]); return; }
      apply(evs[i++]);
      if (i >= evs.length) return;
      const dt = Math.max(0, ((evs[i].t - evs[i - 1].t) * 1000) / speed);
      timer = setTimeout(step, Math.min(dt, 1500));
    };
    step();
  }

  $("#speedSeg").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    speed = +b.dataset.s;
    $$("#speedSeg button").forEach((x) => x.classList.toggle("on", x === b));
  });
  $("#playBtn").addEventListener("click", () => { paused = !paused; $("#playBtn").innerHTML = paused ? "&#9654;" : "&#10074;&#10074;"; });
  $("#tlFilter").addEventListener("click", (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    $$("#tlFilter button").forEach((x) => x.classList.toggle("on", x === b));
    $("#timeline").classList.toggle("f-key", b.dataset.f === "key");
  });
  $("#timeline").classList.add("f-key");

  // =============================== the paper viewer ===============================
  // The viewer sizes pages to its column, so it only renders while the details are open.
  function loadPaper(src) {
    cur.pdfSrc = src;
    if (!$("#details").hidden) renderPaper(src);
  }

  async function renderPaper(src) {
    const box = $("#pages");
    const myId = cur.id;
    cur.pdfStarted = true;
    let doc;
    try { doc = await openPdf(typeof src === "string" ? src : src.slice(0)); } catch (e) { console.error("pdf load failed", e); box.innerHTML = `<p class="muted small pad">Could not open the PDF.</p>`; return; }
    if (!cur || cur.id !== myId) return;
    if ($("#details").hidden) { cur.pdfStarted = false; return; }
    box.innerHTML = "";
    const width = Math.max(320, box.clientWidth - 16);
    const dpr = window.devicePixelRatio || 1;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      if (!cur || cur.id !== myId) return;
      const vp0 = page.getViewport({ scale: 1 });
      const vp = page.getViewport({ scale: width / vp0.width });
      const wrap = document.createElement("div");
      wrap.className = "page";
      wrap.style.width = vp.width + "px"; wrap.style.height = vp.height + "px";
      wrap.dataset.page = n;
      const c = document.createElement("canvas");
      c.width = vp.width * dpr; c.height = vp.height * dpr;
      c.style.width = vp.width + "px"; c.style.height = vp.height + "px";
      const ov = document.createElement("div"); ov.className = "ov";
      const num = document.createElement("span"); num.className = "num"; num.textContent = `p. ${n}`;
      wrap.append(c, ov, num);
      box.appendChild(wrap);
      await page.render({ canvasContext: c.getContext("2d"), viewport: page.getViewport({ scale: vp.scale * dpr }) }).promise;
      const tc = await page.getTextContent();
      const entry = { n, wrap, ov, vp, items: tc.items };
      buildIndex(entry);
      cur.pages[n] = entry;
    }
    cur.pdfReady = true;
    cur.numPages = doc.numPages;
    if (cur.full) { drawHighlights(); const j = cur.pendingJump || targetId(); cur.pendingJump = null; if (j) jumpTo(j); }
    if (cur.active === "reader") startScan();
  }

  // Match on letters and digits only: pdf.js splits text into runs (sometimes mid-word), and PDFs
  // differ in spaces, hyphenation and ligatures, so everything else is dropped on both sides.
  const norm = (t) => t.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]/g, "");
  function buildIndex(p) {
    let s = "";
    p.starts = p.items.map((it) => { const a = s.length; s += norm(it.str); return a; });
    p.str = s;
  }

  function findRects(p, quote) {
    const q = norm(quote);
    let idx = -1, len = 0;
    for (const probe of [q, q.slice(0, 45), q.slice(-45), q.slice(Math.floor(q.length / 2) - 20, Math.floor(q.length / 2) + 20)]) {
      if (probe.length < 16) continue;
      idx = p.str.indexOf(probe);
      if (idx >= 0) { len = probe.length; break; }
    }
    if (idx < 0) return [];
    const end = idx + len, rects = [];
    p.items.forEach((it, i) => {
      const a = p.starts[i], b = i + 1 < p.starts.length ? p.starts[i + 1] : p.str.length;
      if (b <= a || b <= idx || a >= end) return;
      const tx = pdfjsLib.Util.transform(p.vp.transform, it.transform);
      const h = Math.hypot(tx[2], tx[3]);
      const full = it.width * p.vp.scale;
      const n = b - a, s0 = Math.max(0, idx - a) / n, s1 = Math.min(1, (end - a) / n);
      rects.push({ left: tx[4] + full * s0, top: tx[5] - h * 0.95, width: Math.max(4, full * (s1 - s0)), height: h * 1.2 });
    });
    return rects;
  }

  function hlItems() {
    const f = cur.full, out = [];
    if (!f) return out;
    (f.claims || []).filter((c) => c.target).forEach((c) => out.push({ id: c.id, k: "t", quote: c.quote, page: c.page, text: `Target result ${c.id}: ${c.statement}` }));
    (f.requirements || []).forEach((r) => out.push({ id: r.id, k: "r", quote: r.quote, page: r.page, text: `${r.id}: ${r.stmt} (${r.cite || ""})` }));
    (f.assumptions || []).forEach((a) => out.push({ id: a.id, k: "a", quote: a.quote, page: a.page, text: `${a.id} open detail: ${a.gap} -> chose ${a.chosen}` }));
    return out;
  }

  function drawHighlights() {
    if (!cur.pdfReady || !cur.full) return;
    cur.pages.forEach((p) => { if (p) p.ov.innerHTML = ""; });
    const status = {};
    ((cur.verdict && cur.verdict.requirement_check) || []).forEach((r) => (status[r.id] = r.status));
    cur.hlIndex = {};
    hlItems().forEach((it) => {
      if (!it.quote) return;
      const order = it.page ? [it.page, ...cur.pages.map((p, i) => i).filter((i) => i && i !== it.page)] : cur.pages.map((p, i) => i).filter(Boolean);
      for (const n of order) {
        const p = cur.pages[n];
        if (!p) continue;
        const rects = findRects(p, it.quote);
        if (!rects.length) continue;
        const els = rects.map((r, i) => {
          const d = document.createElement("div");
          d.className = `hl ${it.k}${it.k === "r" && status[it.id] ? " " + status[it.id] : ""}`;
          Object.assign(d.style, { left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px" });
          d.title = it.text + (status[it.id] ? ` · verifier: ${status[it.id]}` : "");
          p.ov.appendChild(d);
          if (i === 0) { const t = document.createElement("span"); t.className = `tag ${it.k}`; t.textContent = it.id; t.style.left = r.left + "px"; t.style.top = r.top + "px"; p.ov.appendChild(t); }
          return d;
        });
        cur.hlIndex[it.id] = { page: n, els };
        break;
      }
    });
    applyLegend();
  }

  function applyLegend() {
    ["t", "r", "a"].forEach((k) => $("#pages").classList.toggle("hide-" + k, cur.hlHidden.has(k)));
  }
  $("#hlLegend").addEventListener("click", (e) => {
    const b = e.target.closest(".lg");
    if (!b || !cur) return;
    const k = b.dataset.k;
    if (cur.hlHidden.has(k)) cur.hlHidden.delete(k); else cur.hlHidden.add(k);
    b.classList.toggle("on", !cur.hlHidden.has(k));
    applyLegend();
  });

  function jumpTo(id) {
    const box = $("#pages");
    const h = cur.hlIndex && cur.hlIndex[id];
    if (!h) {  // no exact highlight: at least open the page the Reader cited
      const it = hlItems().find((x) => x.id === id);
      const p = it && it.page && cur.pages[it.page];
      if (p) { box.scrollTo({ top: p.wrap.offsetTop - 8, behavior: "smooth" }); flashPages([it.page]); }
      return;
    }
    const p = cur.pages[h.page];
    box.scrollTo({ top: p.wrap.offsetTop + parseFloat(h.els[0].style.top) - 80, behavior: "smooth" });
    h.els.forEach((el) => { el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse"); });
  }

  function startScan() {
    if (!cur.pdfReady || cur.scanTimer) return;
    let k = 1;
    const tick = () => {
      cur.pages.forEach((p) => p && p.wrap.classList.remove("scan"));
      const p = cur.pages[k];
      if (p) {
        p.wrap.classList.add("scan");
        $("#pages").scrollTo({ top: p.wrap.offsetTop - 8, behavior: "smooth" });
        chip(`<b>Reader</b> is reading page ${k} of ${cur.numPages}`, true);
      }
      k = (k % cur.numPages) + 1;
    };
    tick();
    cur.scanTimer = setInterval(tick, 1100);
  }
  function stopScan() {
    clearInterval(cur.scanTimer); cur.scanTimer = null;
    cur.pages.forEach((p) => p && p.wrap.classList.remove("scan"));
  }
  function chip(html, liveDot) { const c = $("#readChip"); c.innerHTML = html; c.className = "readchip" + (liveDot ? " live" : ""); }
  function flashPages(pages) {
    if (!cur.pdfReady || !pages) return;
    pages.forEach((n) => { const p = cur.pages[n]; if (!p) return; p.wrap.classList.add("flash"); setTimeout(() => p.wrap.classList.remove("flash"), 1800); });
    const p = cur.pages[pages[0]];
    if (p) $("#pages").scrollTo({ top: p.wrap.offsetTop - 8, behavior: "smooth" });
  }

  // =============================== event reducer ===============================
  const STAGE_CHIP = {
    router: "<b>Router</b> is checking the authors' code release and this machine",
    planner: "<b>Planner</b> is laying out files, settings and checks",
    implementer: "<b>Implementer</b> is writing and running code; the paper stays open for it",
    verifier: "<b>Verifier</b> deleted the results and is re-running everything, then checking the code against the highlighted requirements",
  };

  function apply(ev) {
    track(ev);
    const s = cur;
    s.t = ev.t;
    if (!s.startTs) s.startTs = ev.ts - ev.t;
    if (ev.meter) s.meter = ev.meter;
    switch (ev.type) {
      case "run_start": add("stage", `<b>Run started</b> <span class="muted small">${ev.target_hint ? "checking: " + esc(ev.target_hint) : ""}</span>`, ev); break;
      case "stage_start":
        { const prev = s.stages[ev.stage];  // a re-audit restarts the verifier: keep the original timing
          s.stages[ev.stage] = { ...(prev || {}), status: "active", t0: prev && prev.t0 != null ? prev.t0 : ev.t }; }
        s.active = ev.stage;
        s.stageEls[ev.stage] = add("stage", `<b>${esc(ev.title)}</b>`, ev);
        if (ev.stage === "reader") startScan(); else if (STAGE_CHIP[ev.stage]) chip(STAGE_CHIP[ev.stage], true);
        renderStepper(); break;
      case "stage_end":
        { const prev = s.stages[ev.stage] || {};
          s.stages[ev.stage] = { ...prev, status: ev.status === "ok" ? "done" : "error", seconds: Math.max(ev.seconds || 0, prev.seconds || 0) }; }
        s.active = null;
        if (ev.stage === "reader") stopScan();
        renderStepper(); break;
      case "paper":
        s.title = ev.title; $("#rvTitle").textContent = ev.title;
        if (s.pdfPending && s.mode === "live") { s.pdfPending = false; loadPaper(api(`/api/runs/${s.id}/files/paper/paper.pdf`)); }
        add("", `<span class="who">reader</span>opened <b>${esc(ev.title)}</b>: ${ev.pages} pages, ${fmtN(ev.chars)} characters of text`, ev, "minor"); break;
      case "contract":
        s.contract = ev; s.title = ev.title || s.title; $("#rvTitle").textContent = s.title;
        add("key", `<span class="who">reader</span>wrote the claim contract: <b>${esc(ev.target.statement || "")}</b><div class="small muted">${ev.n_claims} results found, ${ev.n_requirements} requirements, ${ev.n_assumptions} details the paper leaves open</div>`, ev);
        renderContract(); renderObjective(); renderCompare(); break;
      case "contract_full":
        s.full = ev; drawHighlights(); renderContract(); renderLedger(); renderObjective();
        setTimeout(() => { if (cur === s && targetId()) jumpTo(targetId()); }, 400);
        chip(`<b>Reader</b> marked the target result, ${(ev.requirements || []).length} requirements and ${(ev.assumptions || []).length} open details on the paper`, false); break;
      case "assumption":
        s.ledger.push(ev);
        if (ev.by === "reader") readerGroup(ev);
        else add("assume", `<span class="who">implementer · decided</span><span class="risk ${esc(ev.risk)}">${esc(ev.risk)}</span> ${esc(ev.gap)} &rarr; <b>${esc(ev.chosen)}</b>`, ev);
        renderLedger(); break;
      case "repo": add("", `<span class="who">router</span>${ev.url ? (ev.cloned ? `cloned <code>${esc(ev.url)}</code> · ${ev.n_files} files${ev.python2_style_files ? ` · ${ev.python2_style_files} files look like Python 2` : ""}` : `could not clone <code>${esc(ev.url)}</code>`) : "no code repository in the paper or given"}`, ev); break;
      case "resources": s.resources = ev; break;
      case "route": s.route = ev; add("key", `<span class="who">router</span>route <span class="badge ${esc(ev.route)}">${esc(ROUTE[ev.route] || ev.route)}</span>${ev.gpu_required ? " · <b>needs a GPU</b>" : " · CPU is enough"}<div class="small">${esc(clip(ev.why, 320))}</div>`, ev); renderRoute(); renderBadges(); renderObjective(); renderCompare(); break;
      case "plan": add("key", `<span class="who">planner</span>${esc(clip(ev.approach, 360))}<details class="io"><summary>${(ev.steps || []).length} steps · files: ${(ev.files || []).map(esc).join(", ")}</summary><ol class="small">${(ev.steps || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ol>${ev.intermediate_checks ? `<div class="small"><b>Checks before the full run:</b> ${(ev.intermediate_checks || []).map(esc).join("; ")}</div>` : ""}</details>`, ev); break;
      case "handoff": add("", `<span class="who">handoff</span>${esc(ev.from)} &rarr; ${esc(ev.to)} <code>${esc(ev.kind)}</code>${ev.injected && ev.injected.length ? ` <span class="badge not_reproduced">injected ${ev.injected.map((x) => esc(x.type + " " + x.marker)).join(", ")}</span>` : ""}`, ev, "minor"); break;
      case "sandbox_ready": add("", `<span class="who">sandbox</span>fresh Python environment ready in ${ev.seconds}s`, ev, "minor"); break;
      case "paper_read":
        flashPages(ev.pages);
        chip(ev.pages ? `<b>Implementer</b> went back to page ${ev.pages[0]}${ev.pages.length > 1 ? "–" + ev.pages[ev.pages.length - 1] : ""} of the paper` : `<b>Implementer</b> searched the paper text`, true);
        add("", `<span class="who">implementer</span>re-read the paper${ev.pages ? `, page ${ev.pages.join(", ")}` : " (text search)"}`, ev); break;
      case "thinking": thinking(ev); break;
      case "message": s.lastThink = null; add("", `<span class="who">${esc(ev.role === "executor" ? "implementer" : ev.role)}</span>${esc(clip(ev.text, 500))}`, ev); break;
      case "tool_call": s.lastThink = null; toolCall(ev); break;
      case "tool_output": toolOutput(ev); break;
      case "tool_result": toolResult(ev); break;
      case "snapshot": add("", `<span class="who">safety net</span>${esc(ev.note)}`, ev, "minor"); break;
      case "manager": add("manager", `<span class="who">repair manager · ${esc(ev.diagnosis)}</span><span class="muted small">${esc(ev.reason)}</span><div>${esc(ev.instruction)}</div>`, ev, ev.diagnosis === "on_track" ? "minor" : ""); break;
      case "implementation_done": add("key", `<span class="who">implementer</span>${ev.blocked ? "<b>blocked</b>: " : "<b>done</b>: "}${esc(clip(ev.summary, 420))}`, ev); break;
      case "verifier_rerun": add("", `<span class="who">verifier</span>${esc(ev.note)}`, ev); break;
      case "rerun_result": s.rerunMetrics = ev.metrics || null; add(ev.exit === 0 ? "key" : "err", `<span class="who">verifier</span>clean re-run finished: exit ${esc(ev.exit)} in ${fmtS(ev.seconds)}${ev.metrics ? ` &rarr; <b>${esc(ev.metrics.metric)} = ${esc(ev.metrics.value)}</b>` : ""}`, ev); break;
      case "verdict": s.verdict = ev; add("verdict", `<span class="who">verifier</span><span class="badge ${esc(ev.verdict)}">${esc(VERDICT[ev.verdict])}</span> ${esc(ev.reason)}`, ev); renderVerdict(); renderBadges(); drawHighlights(); renderResult(); renderCompare();
        chip(`<b>${esc(VERDICT[ev.verdict])}</b>. Requirement highlights are now coloured by the verifier: green met, amber partial, red missing.`, false); break;
      case "llm_retry": add("", `<span class="who">${esc(ev.role)}</span>model connection retry ${ev.attempt}`, ev, "minor"); break;
      case "llm_fallback": add("", `<span class="who">${esc(ev.role)}</span>switched to ${esc(ev.fallback)} after repeated connection errors`, ev); break;
      case "error": add("err", `<b>${esc(ev.kind)}</b>: ${esc(ev.message)}`, ev); break;
      case "run_end": s.status = ev.status; s.endT = ev.t; if (ev.meter) s.meter = ev.meter; stopScan();
        add("stage", `<b>Run ended</b>${ev.status === "cancelled" ? " (stopped)" : ""}${ev.verdict ? ": " + esc(VERDICT[ev.verdict]) : ""} after ${fmtS(ev.seconds)}`, ev);
        renderBadges(); renderCost(); if (s.mode === "live") loadFiles();
        $("#stopBtn").hidden = true; $("#reportBtn").hidden = false; renderResult(); renderOverview();
        if (!s.detailsUser && !$("#details").hidden) { setDetails(false); window.scrollTo({ top: 0, behavior: "smooth" }); }
        break;
    }
    renderMetrics();
    if (ev.type === "llm_call" || ev.type === "stage_end") renderCost();
  }

  const clip = (t, n) => (t && t.length > n ? t.slice(0, n) + "…" : t || "");

  function add(cls, html, ev, extra) {
    const d = document.createElement("div");
    d.className = `ev ${cls} ${extra || ""}`;
    if (ev.seq != null) d.dataset.seq = ev.seq;
    d.innerHTML = `<div class="h"><div>${html}</div><span class="ts">${fmtS(ev.t)}</span></div>`;
    const tl = $("#timeline");
    const stick = tl.scrollTop + tl.clientHeight >= tl.scrollHeight - 60;
    tl.appendChild(d);
    if (stick) tl.scrollTop = tl.scrollHeight;
    return d;
  }

  function readerGroup(ev) {
    if (!cur.readerGroup) {
      const d = add("assume", `<span class="who">reader</span><span class="rg-title"></span><details class="io"><summary>show them</summary><ul class="list rg-list"></ul></details>`, ev);
      cur.readerGroup = d;
    }
    const d = cur.readerGroup;
    const n = cur.ledger.filter((a) => a.by === "reader").length;
    $(".rg-title", d).innerHTML = `found <b>${n}</b> details the paper leaves open and chose a value for each`;
    $(".rg-list", d).insertAdjacentHTML("beforeend", `<li><span class="risk ${esc(ev.risk)}">${esc(ev.risk)}</span> <b>${esc(ev.id)}</b> ${esc(ev.gap)} &rarr; ${esc(ev.chosen)}</li>`);
  }

  function thinking(ev) {
    const s = cur;
    if (s.lastThink && s.lastThink.role === ev.role) {
      s.lastThink.body.textContent += ev.delta;
      if (s.lastThink.body.textContent.length > 12000) s.lastThink.body.textContent = "…" + s.lastThink.body.textContent.slice(-10000);
      s.lastThink.body.scrollTop = s.lastThink.body.scrollHeight;
      return;
    }
    const d = add("think", `<span class="who">${esc(ev.role === "executor" ? "implementer" : ev.role)} · thinking</span>`, ev);
    const b = document.createElement("div");
    b.className = "body";
    b.textContent = ev.delta;
    d.appendChild(b);
    s.lastThink = { role: ev.role, body: b };
  }

  function describe(ev) {
    const a = ev.args || {};
    switch (ev.name) {
      case "run": return `ran <span class="cmd">${esc(clip((a.argv || []).join(" "), 160))}</span>`;
      case "write_file": return `wrote <code>${esc(a.path)}</code> <span class="muted small">${(a.content || "").split("\n").length} lines</span>`;
      case "edit_file": return `edited <code>${esc(a.path)}</code>`;
      case "read_file": return `read <code>${esc(a.path)}</code>`;
      case "list_files": return `looked at <code>${esc(a.path || ".")}</code>`;
      case "note_assumption": return `noted a decision: ${esc(a.gap)}`;
      case "finish": return `<b>declared finished</b>${a.blocked ? " (blocked)" : ""}`;
      default: return esc(ev.name);
    }
  }
  const isRepro = (ev) => ev.name === "run" && (ev.args.argv || []).some((x) => /reproduce\.py$/.test(x));

  function toolCall(ev) {
    if (ev.name === "run") cur.commands += 1;
    const key = isRepro(ev) || ev.name === "finish" || ev.name === "note_assumption";
    const d = add("tool", `<span class="who">implementer · ${ev.step}</span>${describe(ev)}`, ev, key ? "" : "minor");
    d.id = "call-" + ev.call_id;
    const a = ev.args || {};
    if (ev.name === "write_file" || ev.name === "edit_file") {
      const det = document.createElement("details");
      det.className = "io";
      det.innerHTML = `<summary>show ${ev.name === "write_file" ? "code" : "change"}</summary><pre class="out open"></pre>`;
      $("pre", det).textContent = ev.name === "write_file" ? a.content : `- ${a.old}\n+ ${a.new}`;
      d.appendChild(det);
    }
    if (ev.name === "run") {
      const pre = document.createElement("pre");
      pre.className = "out"; pre.hidden = true;
      const more = document.createElement("button");
      more.className = "more"; more.type = "button"; more.textContent = "show all output"; more.hidden = true;
      more.onclick = () => { pre.classList.toggle("open"); more.textContent = pre.classList.contains("open") ? "show less" : "show all output"; };
      d.append(pre, more);
      cur.calls[ev.call_id] = { pre, more, raw: "" };
    }
  }

  function cleanOut(t) {
    const lines = t.replace(/\r/g, "\n").split("\n").filter((l) => !/^\s*Progress:|words\/sec\/thread|^\s*Read \d+M words|^\s*$/.test(l));
    const out = [];
    lines.forEach((l) => { if (out[out.length - 1] !== l) out.push(l); });
    return out.join("\n");
  }

  function toolOutput(ev) {
    const c = cur.calls[ev.call_id];
    if (!c) return;
    c.raw += ev.text;
    if (c.raw.length > 40000) c.raw = c.raw.slice(-30000);
    const t = cleanOut(c.raw);
    if (!t) return;
    c.pre.hidden = false;
    c.more.hidden = t.split("\n").length < 7;
    c.pre.textContent = t;
    c.pre.scrollTop = c.pre.scrollHeight;
  }

  function toolResult(ev) {
    const d = document.getElementById("call-" + ev.call_id);
    if (!d) return;
    if (!ev.ok) { d.classList.add("fail"); d.classList.remove("minor"); }
    const tag = document.createElement("span");
    tag.className = "muted small";
    const exit = /\[(exit=\S+|TIMEOUT) in ([\d.]+)s\]/.exec(ev.text || "");
    tag.textContent = exit ? ` · ${exit[1] === "exit=0" ? "ok" : exit[1]} · ${fmtS(+exit[2])}` : ev.ok ? "" : " · error";
    $(".h > div", d).appendChild(tag);
    if (!ev.ok && ev.name !== "run") d.insertAdjacentHTML("beforeend", `<div class="small" style="color:var(--bad)">${esc(clip(ev.text, 300))}</div>`);
  }

  // =============================== panels ===============================
  function renderStepper() {
    const s = cur;
    let el = s.endT != null ? s.endT : s.t;
    if (s.mode === "live" && s.status === "running" && s.startTs) el = Date.now() / 1000 - s.startTs;
    $("#stepper").innerHTML = STAGES.map(([k, name, sub]) => {
      const st = s.stages[k] || {};
      const t = st.status === "active" ? fmtS(el - st.t0) : st.seconds != null ? fmtS(st.seconds) : "";
      return `<li class="${st.status || ""}" data-stage="${k}" title="Show this stage in the timeline"><b>${name}</b><small>${sub}</small><span>${t}</span></li>`;
    }).join("");
  }

  $("#stepper").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-stage]");
    const el = li && cur && cur.stageEls && cur.stageEls[li.dataset.stage];
    if (!el) return;
    setDetails(true, true);
    $(".timeline").scrollIntoView({ behavior: "smooth", block: "start" });
    const tl = $("#timeline");
    tl.scrollTo({ top: el.offsetTop - tl.offsetTop - 6, behavior: "smooth" });
    el.classList.remove("target-flash"); void el.offsetWidth; el.classList.add("target-flash");
  });

  $("#stopBtn").addEventListener("click", async () => {
    if (!cur || cur.mode !== "live") return;
    if (!confirm("Stop this run? The agent stops at once and no verdict is given.")) return;
    $("#stopBtn").disabled = true; $("#stopBtn").textContent = "Stopping...";
    try { await fetch(api(`/api/runs/${cur.id}/cancel`), { method: "POST", headers: keyHeaders() }); } catch (e) {}
  });

  $("#reportBtn").addEventListener("click", () => {
    const md = reportMarkdown();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([md], { type: "text/markdown" }));
    a.download = `${cur.id}-report.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  function reportMarkdown() {
    const s = cur, v = s.verdict || {}, t = (v.target || (s.contract && s.contract.target) || {}), g = v.gap || {}, m = s.meter || {};
    const L = [`# Reproduction report: ${s.title || s.id}`, "", `Run \`${s.id}\` (${s.mode === "replay" ? "recorded" : "live"}), status: ${s.status}`, ""];
    if (v.verdict) {
      L.push(`## Verdict: ${VERDICT[v.verdict]}`, "", v.reason || "", "",
        `| | value |`, `|---|---|`, `| Target | ${t.statement || ""} |`, `| Paper | ${t.value ?? ""} ${t.unit || ""} |`,
        `| Measured on a clean re-run | ${g.measured_normalised ?? ""} |`, `| Difference | ${g.diff ?? ""} (tolerance ±${g.band ?? ""}) |`,
        `| Scaled down | ${v.scaled_down ? "yes" : "no"} |`, `| Flags | ${(v.flags || []).join(", ") || "none"} |`, "");
      if (v.audit_summary) L.push("### Verifier's audit", "", v.audit_summary, "");
      if (v.divergence_causes && v.divergence_causes.length) L.push("### Why it differs", "", ...v.divergence_causes.map((x) => `- ${x}`), "");
      if (v.requirement_check && v.requirement_check.length) L.push("### Requirement check", "", ...v.requirement_check.map((r) => `- **${r.id}** ${r.status}: ${r.evidence}`), "");
    }
    if (s.route) L.push("## Route and compute", "", `- Route: ${ROUTE[s.route.route] || s.route.route}`, `- GPU needed: ${s.route.gpu_required ? "yes" : "no"}`, `- Why: ${s.route.why || ""}`, "");
    if (s.ledger.length) L.push("## Open details and choices", "", ...s.ledger.map((a) => `- **${a.id}** (${a.risk}, ${a.by}): ${a.gap} -> ${a.chosen}`), "");
    L.push("## Time and cost", "", ...STAGES.map(([k, n]) => `- ${n}: ${s.stages[k] && s.stages[k].seconds != null ? fmtS(s.stages[k].seconds) : "-"}`),
      `- Model calls: ${m.calls ?? "-"}, tokens in ${m.prompt_tokens ?? "-"}, out ${m.completion_tokens ?? "-"}`, `- Estimated model cost: ¥${m.cost_cny ?? "-"}`, `- Commands run: ${s.commands}`, "");
    return L.join("\n");
  }

  // =============================== overview ===============================
  const ROLE_NAME = { reader: "Reader", router: "Router", planner: "Planner", executor: "Implementer", manager: "Repair manager", verifier: "Verifier" };
  function track(ev) {
    const o = cur && cur.ov;
    if (!o) return;
    switch (ev.type) {
      case "paper": o.pages = ev.pages; break;
      case "llm_call": o.llm[ev.role] = (o.llm[ev.role] || 0) + (ev.seconds || 0); o.llmBars.push({ t0: ev.t - (ev.seconds || 0), t1: ev.t, role: ev.role, seq: ev.seq }); break;
      case "tool_call":
        if (ev.name === "run") o.cmds[ev.call_id] = { t0: ev.t, argv: (ev.args && ev.args.argv) || [], seq: ev.seq };
        if (ev.name === "write_file" && ev.args) o.files.add(ev.args.path);
        break;
      case "tool_result": {
        const c = ev.name === "run" && o.cmds[ev.call_id];
        if (!c) break;
        const m = /\[(\S+) in ([\d.]+)s\]/.exec(ev.text || "");
        c.secs = m ? +m[2] : ev.seconds; c.t1 = c.t0 + c.secs; c.ok = m ? m[1] === "exit=0" : ev.ok;
        if (!c.ok) o.fails++;
        break;
      }
      case "manager": o.mgr.push({ t: ev.t, d: ev.diagnosis, seq: ev.seq, text: ev.instruction || "" }); break;
      case "rerun_result": o.rerun = { t0: ev.t - (ev.seconds || 0), t1: ev.t, ok: ev.exit === 0, secs: ev.seconds || 0, seq: ev.seq }; break;
      case "llm_retry": o.retries++; break;
    }
    if (!cur.ovTimer) cur.ovTimer = setTimeout(() => { cur.ovTimer = null; renderOverview(); }, 400);
  }

  const isDownload = (argv) => /fetch_|urlopen|download|requests\.get|wget|load_dataset|\.tgz|\.zip|data\.py|prepare/i.test(argv.join(" "));

  function renderOverview() {
    const s = cur, o = s.ov;
    if (!o || $("#details").hidden) return;
    const now = s.endT != null ? s.endT : s.t;
    const total = Math.max(1, now);
    const cmds = Object.values(o.cmds);
    const cmdSecs = cmds.reduce((a, c) => a + (c.secs != null ? c.secs : Math.max(0, now - c.t0)), 0) + (o.rerun ? o.rerun.secs : 0);
    const llmSecs = Object.values(o.llm).reduce((a, b) => a + b, 0);
    const longest = cmds.filter((x) => x.secs != null).sort((a, b) => b.secs - a.secs)[0];
    const pct = (x) => Math.round((100 * x) / total);

    // ---- process summary: one formal line per phase
    const R = [];
    const c = s.contract, v = s.verdict;
    if (c) R.push(["Paper analysis", `${o.pages ? o.pages + " pages" : "The paper was"} analysed in ${fmtS((s.stages.reader || {}).seconds)}. ${c.n_claims} quantitative results identified; ${c.n_requirements} implementation requirements and ${s.ledger.filter((a) => a.by === "reader").length} unspecified details recorded.`]);
    if (s.route) R.push(["Code availability", `${esc(ROUTE_LONG[s.route.route] || s.route.route)}.`],
      ["Compute", s.route.gpu_required ? "GPU required." : "CPU only; no GPU required."]);
    if (cmds.length || o.files.size) {
      const imp = s.stages.implementer || {};
      R.push(["Implementation", `${o.files.size} source files written and ${cmds.length} commands executed${o.fails ? ` (${o.fails} failed and ${o.fails > 1 ? "were" : "was"} corrected)` : ""}${imp.seconds != null ? `, over ${fmtS(imp.seconds)}` : ""}.`]);
    }
    if (o.mgr.length) {
      const k = o.mgr.filter((m) => m.d !== "on_track").length;
      R.push(["Supervision", `The repair manager reviewed progress ${o.mgr.length} time${o.mgr.length > 1 ? "s" : ""}${k ? ` and issued ${k} corrective instruction${k > 1 ? "s" : ""}` : ""}.`]);
    }
    if (longest && longest.secs > 60) R.push(["Longest operation", `${isDownload(longest.argv) ? "Data download" : "Experiment run"}, ${fmtS(longest.secs)} (${pct(longest.secs)}% of wall-clock time): <code>${esc(clip(longest.argv.join(" "), 110))}</code>`]);
    if (o.rerun) {
      let line = `Results deleted and regenerated from scratch in ${fmtS(o.rerun.secs)}.`;
      if (v) {
        const rc = v.requirement_check || [], n = (st) => rc.filter((r) => r.status === st).length;
        const copied = (v.flags || []).some((f) => /hardcoded|echoed/.test(f));
        line += ` Code audited against ${rc.length} requirements (${n("met")} met, ${n("partial")} partial, ${n("missing")} missing); ${copied ? "copied or hard-coded paper values were found" : "no copied or hard-coded paper values found"}.`;
      }
      R.push(["Independent verification", line]);
    }
    if (!v && s.status === "running") R.push(["Status", `In progress: ${esc((STAGES.find((x) => x[0] === s.active) || [, "between stages"])[1])}.`]);
    if (R.length) $("#story").innerHTML = R.map(([k, x]) => `<dt>${k}</dt><dd>${x}</dd>`).join("");

    // ---- time allocation: three categories, one colour each
    const byRole = Object.entries(o.llm).filter(([, x]) => x > 0.5).sort((a, b) => b[1] - a[1]).map(([r, x]) => `${ROLE_NAME[r] || r} ${fmtS(x)}`).join(", ");
    const parts = [
      { k: "c-cmd", label: "Command execution", sub: "installs, downloads, training, evaluation, clean re-run", v: cmdSecs },
      { k: "c-model", label: "Model inference", sub: byRole, v: llmSecs },
      { k: "c-other", label: "Other", sub: "file operations, connection retries, waiting", v: Math.max(0, total - llmSecs - cmdSecs) },
    ].filter((p) => p.v > 0.5);
    $("#timeSplit").innerHTML = `<div class="split">${parts.map((p) => `<span class="${p.k}" style="width:${(100 * p.v) / total}%" title="${esc(p.label)}: ${fmtS(p.v)}"></span>`).join("")}</div>
      <div class="splitlegend">${parts.map((p) => `<div><i class="${p.k}"></i><span>${esc(p.label)}<small>${esc(p.sub)}</small></span><b>${fmtS(p.v)} · ${pct(p.v)}%</b></div>`).join("")}</div>
      ${longest && longest.secs > 0.3 * total ? `<div class="callout">${isDownload(longest.argv)
        ? `A single data download accounts for ${pct(longest.secs)}% of the wall-clock time. Downloaded datasets are now cached and reused across runs.`
        : `The experiment itself accounts for ${pct(longest.secs)}% of the wall-clock time on this CPU. A GPU or fewer repeats would shorten it.`}</div>` : ""}`;

    // ---- execution timeline: fixed scale, scrolls horizontally instead of squeezing a long run
    const box = $("#runMap");
    const prev = $(".scroller", box);
    const keepLeft = prev ? prev.scrollLeft : 0, followEnd = prev ? prev.scrollLeft + prev.clientWidth >= prev.scrollWidth - 4 : false;
    const avail = Math.max(300, (prev ? prev.clientWidth : box.clientWidth - 90) || 800);
    const PX_MIN = 64;
    const W = Math.max(avail, Math.ceil((total / 60) * PX_MIN));
    const X = (tt) => Math.max(0, Math.min(W, (W * tt) / total));
    const bar = (cls, a, b, attrs, label) => `<div class="seg-bar ${cls}" style="left:${X(a)}px;width:${Math.max(3, X(b) - X(a))}px" ${attrs}>${label || ""}</div>`;
    const stages = STAGES.map(([k, n]) => { const st = s.stages[k]; if (!st || st.t0 == null) return ""; const end = st.seconds != null ? st.t0 + st.seconds : now;
      return bar("seg-stage", st.t0, end, `data-stage="${k}" title="${n}: ${fmtS(end - st.t0)}"`, X(end) - X(st.t0) > 50 ? n : ""); }).join("");
    const llm = o.llmBars.map((b) => bar("c-model", b.t0, b.t1, `data-seq="${b.seq}" title="${esc(ROLE_NAME[b.role] || b.role)} model call: ${fmtS(b.t1 - b.t0)}"`)).join("");
    const cm = cmds.map((x) => { const end = x.t1 != null ? x.t1 : now;
      return bar(x.ok === false ? "c-cmdfail" : "c-cmd", x.t0, end, `data-seq="${x.seq}" title="${esc(clip(x.argv.join(" "), 140))} · ${fmtS(end - x.t0)}${x.ok === false ? " · failed" : ""}"`); }).join("")
      + (o.rerun ? bar("c-rerun", o.rerun.t0, o.rerun.t1, `data-seq="${o.rerun.seq}" title="Verifier's clean re-run · ${fmtS(o.rerun.secs)}"`) : "");
    const mg = o.mgr.map((m) => `<div class="mk" style="left:${X(m.t)}px" data-seq="${m.seq}" title="Repair manager (${esc(m.d)}): ${esc(clip(m.text, 160))}"></div>`).join("");
    const stepMin = [1, 2, 5, 10, 15, 30, 60].find((m) => m * PX_MIN * (W / ((total / 60) * PX_MIN || 1)) >= 70) || 60;
    let ticks = "";
    for (let x = 0; x <= total; x += stepMin * 60) ticks += `<span style="left:${X(x)}px${x === 0 ? ";transform:none" : ""}">${Math.round(x / 60)}m</span>`;
    box.innerHTML = `<div class="map"><div class="labels"><span>Stages</span><span>Model calls</span><span>Commands</span><span>Supervision</span></div>
      <div class="scroller"><div class="track" style="width:${W}px">
      <div class="lane">${stages}</div><div class="lane">${llm}</div><div class="lane">${cm}</div><div class="lane">${mg}</div>
      <div class="axis">${ticks}</div></div></div></div>`;
    const sc = $(".scroller", box);
    sc.scrollLeft = followEnd && s.status === "running" ? sc.scrollWidth : keepLeft;
  }
  const fmtNum = (x) => (x == null ? "--" : Math.abs(x) >= 10 ? (+x).toFixed(2) : (+x).toFixed(3));

  $("#runMap").addEventListener("click", (e) => {
    const b = e.target.closest("[data-seq],[data-stage]");
    if (!b || !cur) return;
    let el = null;
    if (b.dataset.stage) el = cur.stageEls && cur.stageEls[b.dataset.stage];
    else {
      el = $(`#timeline [data-seq="${b.dataset.seq}"]`);
      if (!el) {  // a model call has no row of its own: use the next row after it
        const seq = +b.dataset.seq;
        el = $$("#timeline [data-seq]").find((r) => +r.dataset.seq >= seq) || null;
      }
    }
    if (!el) return;
    if (el.classList.contains("minor") || el.classList.contains("think")) {
      $$("#tlFilter button").forEach((x) => x.classList.toggle("on", x.dataset.f === "all"));
      $("#timeline").classList.remove("f-key");
    }
    const tl = $("#timeline");
    tl.scrollTo({ top: el.offsetTop - tl.offsetTop - 6, behavior: "smooth" });
    el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    el.classList.remove("target-flash"); void el.offsetWidth; el.classList.add("target-flash");
  });

  function renderMetrics() {
    const s = cur, m = s.meter || {}, res = s.resources;
    let el = s.endT != null ? s.endT : s.t;
    if (s.mode === "live" && s.status === "running" && s.startTs) el = Date.now() / 1000 - s.startTs;
    const cells = [["wall-clock time", fmtS(el)], ["model cost", m.cost_cny != null ? "¥" + (+m.cost_cny).toFixed(2) : "--"],
      ["model calls", m.calls ?? "--"], ["tokens in / out", `${fmtN(m.prompt_tokens)} / ${fmtN(m.completion_tokens)}`],
      ["commands executed", s.commands], ["hardware", res ? `${res.cpu_cores}-core CPU${res.gpu && res.gpu !== "none" ? ", GPU" : ""}` : "--"]];
    $("#metrics").innerHTML = cells.map(([k, v]) => `<div class="metric"><b title="${esc(v)}">${esc(v)}</b><span>${k}</span></div>`).join("");
    const secs = STAGES.map(([k, n], i) => { const st = s.stages[k] || {}; const v = st.status === "active" ? Math.max(0, el - st.t0) : st.seconds || 0; return { k, n, v, c: "s" + (i + 1) }; });
    const sum = secs.reduce((a, x) => a + x.v, 0);
    $("#stageBar").innerHTML = sum > 0 ? `<div class="sbhead">Wall-clock time by stage</div>
      <div class="stagebar">${secs.filter((x) => x.v > 0).map((x) => `<span class="${x.c}" style="width:${(100 * x.v) / sum}%" title="${x.n}: ${fmtS(x.v)}"></span>`).join("")}</div>
      <div class="stagelegend">${secs.map((x) => `<div><span><i class="${x.c}"></i>${x.n}</span><b>${x.v ? fmtS(x.v) : "--"}</b></div>`).join("")}</div>` : "";
    if (!s.verdict) renderResult();
  }

  // =============================== results first ===============================
  const sign = (d) => (d == null ? "--" : (d > 0 ? "+" : d < 0 ? "−" : "") + fmtNum(Math.abs(d)));
  const fmtTick = (x) => String(+x.toFixed(6));
  function niceTicks(lo, hi, n) {
    const raw = (hi - lo) / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    const step = (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * p, out = [];
    for (let x = Math.ceil(lo / step) * step; x <= hi + 1e-9; x += step) out.push(+x.toFixed(10));
    return out;
  }

  function renderObjective() {
    const c = cur.contract;
    if (!c) return;
    const t = c.target || {}, tol = c.tolerance || {}, r = cur.route;
    const page = targetPage() || t.page, id = targetId() || t.id;
    const pending = `<span class="muted">pending</span>`;
    $("#objBody").innerHTML = `<p class="claim">${esc(t.statement)}</p>
      <dl class="kv wide">
        <dt>Metric</dt><dd>${esc(t.metric)}${t.higher_is_better != null ? ` <span class="muted small">(${t.higher_is_better ? "higher is better" : "lower is better"})</span>` : ""}</dd>
        <dt>Reported value</dt><dd><b class="mono">${esc(t.value)}</b> ${esc(t.unit || "")}${t.reported_spread ? ` <span class="muted small">${esc(t.reported_spread)}</span>` : ""}</dd>
        <dt>Source</dt><dd>${esc(t.table_ref)}${page ? ` <button class="chip" type="button" data-show="${esc(id)}">view on p. ${esc(page)}</button>` : ""}</dd>
        <dt>Acceptance criterion</dt><dd>Difference within ±${esc(tol.value)}${tol.type === "relative" ? " (relative)" : ""}, fixed before any code was run.${tol.why ? ` <details class="io"><summary>rationale</summary><p class="small" style="margin:4px 0 0">${esc(tol.why)}</p></details>` : ""}</dd>
        <dt>Code availability</dt><dd>${r ? esc(ROUTE_LONG[r.route] || r.route) : pending}</dd>
        <dt>Compute required</dt><dd>${r ? (r.gpu_required ? "GPU" : "CPU only; no GPU required") : pending}</dd>
      </dl>
      ${c.summary ? `<details class="io"><summary>Summary of the paper</summary><p class="small" style="margin:4px 0 0">${esc(c.summary)}</p></details>` : ""}`;
  }
  $("#objBody").addEventListener("click", (e) => { const b = e.target.closest("[data-show]"); if (b) showOnPaper(b.dataset.show); });

  function conclusion(v) {
    const g = v.gap || {}, t = v.target || {};
    const nums = g.measured_normalised != null && g.target != null
      ? `An independent clean re-run measured ${fmtNum(g.measured_normalised)} against the reported ${esc(g.target)} ${esc(t.unit || "")} (difference ${sign(g.diff)}; acceptance band ±${fmtNum(g.band)}).` : "";
    switch (v.verdict) {
      case "reproduced": return `The reported result was reproduced. ${nums}`;
      case "partially_reproduced": return `The reported result was partially reproduced. ${nums} ${v.scaled_down ? "The experiment was run at a reduced scale relative to the paper, which limits the verdict to partial reproduction." : esc(v.reason)}`;
      case "not_reproduced": return `The reported result was not reproduced. ${nums} Reason: ${esc(v.reason)}.`;
      default: return `The reproduction could not be completed. Reason: ${esc(v.reason)}.`;
    }
  }

  function agreeChart(g, std) {
    const a = g.target, m = g.measured_normalised, b = g.band || 0;
    const lo = Math.min(a - b, m - std), hi = Math.max(a + b, m + std);
    const span = hi - lo || Math.abs(a) * 0.1 || 1, L = lo - span * 0.3, Rr = hi + span * 0.3;
    const X = (x) => ((x - L) / (Rr - L)) * 100;
    return `<div class="agree" role="img" aria-label="Reported ${esc(a)}, reproduced ${fmtNum(m)}, acceptance band plus or minus ${esc(b)}">
        <div class="axisline"></div>
        <div class="band" style="left:${X(a - b)}%;width:${X(a + b) - X(a - b)}%"></div>
        ${std ? `<div class="spread mea" style="left:${X(m - std)}%;width:${X(m + std) - X(m - std)}%"></div>` : ""}
        <div class="mk rep" style="left:${X(a)}%"><span>reported ${esc(a)}</span><i></i></div>
        <div class="mk mea" style="left:${X(m)}%"><i></i><span>reproduced ${fmtNum(m)}</span></div>
        ${niceTicks(L, Rr, 5).map((x) => `<span class="tk" style="left:${X(x)}%">${fmtTick(x)}</span>`).join("")}
      </div>
      <div class="agreelegend"><span><i style="background:var(--acct);border:1px dashed var(--acc)"></i>acceptance band ±${fmtNum(b)}</span>${std ? `<span><i style="background:var(--acc);height:3px"></i>±1 standard error across repeats</span>` : ""}</div>`;
  }

  function renderResult() {
    const s = cur, v = s.verdict, body = $("#resBody");
    if (!v) {
      const st = s.status === "running" ? `In progress. Current stage: ${(STAGES.find((x) => x[0] === s.active) || [, "between stages"])[1]}.`
        : s.status === "cancelled" ? "Stopped before a verdict was reached." : s.status === "interrupted" ? "Interrupted before a verdict was reached."
        : `Finished without a verdict (status: ${s.status}).`;
      body.innerHTML = `<p class="concl muted">${esc(st)}</p>`;
      return;
    }
    const g = v.gap || {}, t = v.target || {}, m = s.rerunMetrics || {};
    const sameUnits = g.measured != null && g.measured_normalised != null && Math.abs(g.measured - g.measured_normalised) < 1e-6;
    const std = sameUnits && typeof m.std_error === "number" ? m.std_error : 0;
    const has = g.target != null && g.measured_normalised != null;
    body.innerHTML = `<div class="verdict-line"><span class="vbadge ${esc(v.verdict)}">${esc(VERDICT[v.verdict] || v.verdict)}</span><span class="muted small">based on an independent clean re-run</span></div>
      <p class="concl">${conclusion(v)}</p>
      ${has ? `<div class="kpis">
        <div class="kpi"><span>Reported (paper)</span><b>${esc(g.target)}</b><small>${esc(t.unit || "")}</small></div>
        <div class="kpi"><span>Reproduced</span><b>${fmtNum(g.measured_normalised)}</b><small>${std ? `±${fmtNum(std)} std. error` : "clean re-run"}</small></div>
        <div class="kpi"><span>Difference</span><b class="${g.within ? "ok" : "bad"}">${sign(g.diff)}</b><small>${g.within ? "within" : "outside"} ±${fmtNum(g.band)}</small></div>
      </div>${agreeChart(g, std)}` : ""}`;
  }

  function renderCompare() {
    const s = cur, c = s.contract;
    if (!c) return;
    const t = c.target || {}, m = s.rerunMetrics, v = s.verdict, res = s.resources;
    const flags = (v && v.flags) || [];
    const mark = (bad, okText, badText) => (!v ? "" : bad ? ` <span class="diffr">${badText}</span>` : ` <span class="same">✓ ${okText}</span>`);
    const cell = (x, extra) => (x == null || x === "" ? `<td class="muted">${m ? "not recorded" : "pending"}</td>` : `<td>${esc(clip(String(x), 240))}${extra || ""}</td>`);
    const conf = m && m.config && typeof m.config === "object" ? Object.entries(m.config) : null;
    const confCell = conf ? `<td><details><summary>${conf.length} settings recorded</summary><ul>${conf.map(([k, x]) => `<li>${esc(k)}: ${esc(clip(typeof x === "string" ? x : JSON.stringify(x), 120))}</li>`).join("")}</ul></details></td>` : cell(m && m.config);
    const rerunSecs = s.ov && s.ov.rerun ? s.ov.rerun.secs : null;
    const rows = [
      `<tr><td>Dataset</td><td>${esc(clip(t.dataset, 240))}</td>${cell(m && m.dataset, mark(flags.includes("wrong_dataset"), "consistent", "differs"))}</tr>`,
      `<tr><td>Evaluation</td><td>${esc(clip(t.split, 240))}</td>${cell(m && m.split, mark(flags.includes("wrong_split") || (v && v.scaled_down), "consistent", v && v.scaled_down ? "reduced scale" : "differs"))}</tr>`,
      `<tr><td>Metric</td><td>${esc(t.metric)}</td>${cell(m && m.metric, mark(flags.includes("proxy_metric"), "consistent", "proxy metric"))}</tr>`,
      `<tr class="val"><td>Value</td><td>${esc(t.value)} <span class="muted small">${esc(t.unit || "")}</span></td>${m && m.value != null ? `<td>${fmtNum(m.value)}${typeof m.std_error === "number" ? ` <span class="muted small">±${fmtNum(m.std_error)}</span>` : ""}</td>` : cell(null)}</tr>`,
      `<tr><td>Setup</td><td>${esc(clip(t.config_for_value, 300))}</td>${confCell}</tr>`,
      `<tr><td>Compute</td><td>${t.est_compute ? `<span class="muted small">estimated:</span> ${esc(clip(t.est_compute, 160))}` : `<span class="muted">not stated</span>`}</td>${res ? `<td>${res.cpu_cores}-core CPU, ${res.gpu && res.gpu !== "none" ? "GPU" : "no GPU"}${rerunSecs != null ? `; clean re-run ${fmtS(rerunSecs)}` : ""}</td>` : cell(null)}</tr>`,
    ];
    $("#cmpBody").innerHTML = `<table class="cmp"><thead><tr><th></th><th>Paper</th><th>Reproduction</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  }
  function renderBadges() {
    const s = cur;
    $("#rvBadges").innerHTML = (s.route ? `<span class="badge ${esc(s.route.route)}">${esc(ROUTE[s.route.route] || s.route.route)}</span>` : "")
      + (s.verdict ? `<span class="badge ${esc(s.verdict.verdict)}">${esc(VERDICT[s.verdict.verdict])}</span>` : `<span class="badge running">${esc(s.status)}</span>`);
  }

  function renderContract() {
    const f = cur.full;
    if (!f || !(f.requirements || []).length) return;
    const el = $("#contractCard");
    el.hidden = false;
    el.innerHTML = `<h2 class="cardh">Implementation requirements <span class="muted small">(${f.requirements.length})</span></h2>
      <p class="muted small" style="margin:0">What a faithful implementation must contain, as extracted from the paper. Select one to locate it.</p>
      <ul class="list">${f.requirements.map((r) => `<li class="${r.quote ? "click" : ""}" data-id="${esc(r.id)}">${r.page ? `<span class="pg">p.${r.page}</span>` : ""}<b>${esc(r.id)}</b> ${esc(r.stmt)}</li>`).join("")}</ul>`;
    el.onclick = (e) => { const x = e.target.closest("[data-id]"); if (x) jumpTo(x.dataset.id); };
  }
  const targetId = () => { const t = cur.full && (cur.full.claims || []).find((c) => c.target); return t && t.id; };
  const targetPage = () => { const t = cur.full && (cur.full.claims || []).find((c) => c.target); return t && t.quote && t.page; };

  function renderRoute() {
    const r = cur.route, res = cur.resources || {};
    const el = $("#routeCard");
    el.hidden = false;
    el.innerHTML = `<h2 class="cardh">Code release and compute</h2>
      <dl class="kv"><dt>Route</dt><dd><span class="badge ${esc(r.route)}">${esc(ROUTE[r.route] || r.route)}</span></dd>
      <dt>This machine</dt><dd class="small">${esc(res.cpu_cores)} cores · ${esc(res.ram_gb)} GB RAM · GPU: ${esc(res.gpu)}</dd>
      <dt>GPU needed</dt><dd>${r.gpu_required ? "<b>yes</b>" : "no"}</dd>
      <dt>Fits budget</dt><dd>${r.fits_budget ? "yes" : "<b>no</b>"}</dd>
      <dt>Est. runtime</dt><dd class="small">${esc(clip(r.est_runtime, 220))}</dd>
      ${r.scale_down_plan ? `<dt>If too big</dt><dd class="small">${esc(clip(r.scale_down_plan, 260))}</dd>` : ""}
      ${r.blockers && r.blockers.length ? `<dt>Blockers</dt><dd class="small">${r.blockers.map(esc).join("; ")}</dd>` : ""}</dl>`;
  }

  function renderLedger() {
    if (!cur.ledger.length) return;
    const el = $("#ledgerCard");
    el.hidden = false;
    const pages = {};
    ((cur.full && cur.full.assumptions) || []).forEach((a) => { if (a.quote) pages[a.id] = a.page; });
    el.innerHTML = `<h2 class="cardh">Unspecified details <span class="muted small">(${cur.ledger.length})</span></h2>
      <p class="muted small" style="margin:0">Settings the paper does not specify, and the value chosen for each. Select one to locate it in the paper.</p>
      <ul class="list">${cur.ledger.map((a) => `<li class="${pages[a.id] ? "click" : ""}" data-id="${esc(a.id)}">${pages[a.id] ? `<span class="pg">p.${pages[a.id]}</span>` : ""}<span class="risk ${esc(a.risk)}">${esc(a.risk)}</span> <b>${esc(a.id)}</b> ${esc(a.gap)}<br><span class="muted">chose:</span> ${esc(a.chosen)}</li>`).join("")}</ul>`;
    el.onclick = (e) => { const x = e.target.closest("[data-id]"); if (x) jumpTo(x.dataset.id); };
  }

  function renderVerdict() {
    const v = cur.verdict;
    const el = $("#verdictCard");
    el.hidden = false;
    const reqs = (v.requirement_check || []).map((r) => `<li class="req click" data-id="${esc(r.id)}"><span class="st ${esc(r.status)}">${esc(r.status)}</span><span><b>${esc(r.id)}</b> ${esc(clip(r.evidence, 240))}</span></li>`).join("");
    el.innerHTML = `<h2 class="cardh">Verification audit</h2>
      ${v.audit_summary ? `<p class="small" style="margin:0">${esc(v.audit_summary)}</p>` : ""}
      <dl class="kv"><dt>Verdict</dt><dd><span class="badge ${esc(v.verdict)}">${esc(VERDICT[v.verdict] || v.verdict)}</span></dd>
        <dt>Flags</dt><dd>${v.flags && v.flags.length ? v.flags.map(esc).join(", ") : "none"}</dd>
        <dt>Scale</dt><dd>${v.scaled_down ? "reduced relative to the paper" : "as in the paper"}</dd>
        ${v.divergence_causes && v.divergence_causes.length ? `<dt>Divergence</dt><dd class="small">${v.divergence_causes.map(esc).join("; ")}</dd>` : ""}</dl>
      ${reqs ? `<details class="io" open><summary>Requirement check (select one to locate it in the paper)</summary><ul class="list">${reqs}</ul></details>` : ""}`;
    el.onclick = (e) => { const x = e.target.closest("[data-id]"); if (x) jumpTo(x.dataset.id); };
  }
  function renderCost() {
    const m = cur.meter || {};
    if (!m.by_role) return;
    const el = $("#costCard");
    el.hidden = false;
    el.innerHTML = `<h2 class="cardh">Model cost by agent</h2><table class="cost"><tbody>${Object.entries(m.by_role).map(([r, x]) => `<tr><td>${esc(r === "executor" ? "implementer" : r)}</td><td class="mono muted">${esc(x.model)}</td><td class="mono">${x.calls} calls</td><td class="mono">¥${(+x.cost_cny).toFixed(3)}</td></tr>`).join("")}</tbody></table>
      <p class="muted small" style="margin:0">Estimated from the price table in repro/config.py.</p>`;
  }

  async function loadFiles() {
    if (!live || !cur) return;
    try {
      const files = await (await fetch(api(`/api/runs/${cur.id}/tree`))).json();
      const el = $("#filesCard");
      el.hidden = false;
      el.innerHTML = `<h2 class="cardh">Source files</h2><div class="files">${files.filter((f) => !/^paper\/|^data\/|^\.good\//.test(f.path)).map((f) => `<button data-p="${esc(f.path)}"><span>${esc(f.path)}</span><span class="muted">${fmtN(f.size)}</span></button>`).join("")}</div>`;
      el.onclick = async (e) => {
        const b = e.target.closest("button[data-p]");
        if (!b) return;
        const t = await (await fetch(api(`/api/runs/${cur.id}/files/${b.dataset.p}`))).text();
        $("#fileDlgName").textContent = b.dataset.p;
        $("#fileDlgBody").textContent = t.length > 300000 ? t.slice(0, 300000) + "\n…" : t;
        $("#fileDlg").showModal();
      };
    } catch (e) {}
  }
  $("#fileDlgClose").onclick = () => $("#fileDlg").close();

  $("#showThinking").addEventListener("change", (e) => {
    $("#timeline").classList.toggle("hidden-think", !e.target.checked);
    try { localStorage.setItem("showThinking", e.target.checked ? "1" : "0"); } catch (x) {}
  });
  try { $("#showThinking").checked = localStorage.getItem("showThinking") === "1"; } catch (e) {}
  $("#timeline").classList.toggle("hidden-think", !$("#showThinking").checked);

  (async () => {
    await findRunner();
    await probe();
    await loadDemos();
    loadRuns();
    loadDirectory();
    const r = params.get("run"), rep = params.get("replay");
    if (r && live) openLive(r, {});
    else if (rep) { const rec = recorded.find((x) => x.file === rep); openReplay(rep, params.get("pdf") || (rec && rec.pdf)); }
  })();
})();
