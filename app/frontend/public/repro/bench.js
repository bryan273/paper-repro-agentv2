/* Benchmark page in the style of an index leaderboard: charts first, numbers explained on the Methodology tab.
   Reads bench/data.json (built by scripts/export_bench.py from the benchmark runs). Static, no server needed. */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const T = (s) => (window.t ? window.t(s) : s);
  const VERDICT = { reproduced: "Reproduced", partially_reproduced: "Partially reproduced", not_reproduced: "Not reproduced", could_not_run: "Could not run" };
  const TABS = [["index", "Index"], ["models", "Models"], ["reading", "Reading"], ["robust", "Robustness"], ["papers", "Papers"], ["method", "Methodology"]];
  const LABCOL = { StepFun: "#2f6db5", DeepSeek: "#6b5bd2", "Z AI": "#1f8a70", Moonshot: "#c2791a", Alibaba: "#c0462f" };
  let D = null, tab = "index", sortBy = "detailed", sortDir = -1;
  const num = (x, d = 1) => (x == null ? "-" : (x * 100).toFixed(d));
  const mins = (x) => (x == null ? "-" : x < 90 ? Math.round(x) + " min" : (x / 60).toFixed(1) + " h");
  const yuan = (x) => (x == null ? "-" : "¥" + (x < 10 ? x.toFixed(2) : x.toFixed(1)));
  const dots = (d) => (d ? "●".repeat(d) + "○".repeat(5 - d) : "");
  const lab = (id) => { const m = D.models.find((x) => x.id === id); return m ? m.lab : ""; };
  const col = (id) => LABCOL[lab(id)] || "#667";
  const short = (s) => String(s).replace("DeepSeek-", "DS-");
  const kindName = { F: "Wrong fact", O: "Missing requirement", H: "Misleading hint" };

  async function load() {
    try { D = await (await fetch("bench/data.json?v=" + Date.now(), { cache: "no-store" })).json(); }
    catch (e) { $("#bench").innerHTML = `<p class="muted">${esc(T("Could not load the results."))}</p>`; return; }
    prep();
    render();
  }

  // one row per model with every measure side by side
  let ROWS = [];
  function prep() {
    const c = D.tracks.clean.by_model, rb = (D.tracks.inject.robust || []), rd = (D.reader && D.reader.by_model) || [];
    ROWS = D.models.map((m) => {
      const a = c.find((x) => x.key === m.id) || {}, b = rb.find((x) => x.key === m.id) || {}, r = rd.find((x) => x.key === m.id) || {};
      return { id: m.id, lab: m.lab, detailed: a.detailed, ci: a.ci, accuracy: a.accuracy, coverage: a.coverage, fidelity: a.fidelity, reproduced: a.reproduced, n: a.n, partial: a.partial,
               minutes: a.minutes_median, cost: a.cost_mean, cost_total: a.cost_total, robust: b.robust, rci: b.ci, rn: b.n, resisted: b.resisted, noticed: b.noticed, false_success: b.false_success, by_kind: b.by_kind,
               reading: r.n ? r.value_ok / r.n : null, reading_n: r.n, tie: a.detail_tie, best: a.detail_best, cps: a.reproduced ? a.cost_total / a.reproduced : null };
    });
  }

  function head() {
    const c = D.tracks.clean, i = D.tracks.inject;
    const spent = c.by_model.reduce((a, m) => a + (m.cost_total || 0), 0) + (i.by_model || []).reduce((a, m) => a + (m.cost_total || 0), 0);
    const upd = D.updated || "";
    return `<section class="aah"><div><span class="bpill">${esc(T("Pilot"))}${upd ? " · " + esc(upd) : ""}</span>
      <h1>${esc(T("Paper Repro Index"))}</h1>
      <p class="muted">${esc(T("How well models reproduce research papers. Same steps, same judge, only the model that writes the code changes."))}</p></div>
      <div class="aast"><div><b>${D.models.length}</b><span>${esc(T("models"))}</span></div><div><b>${new Set(c.runs.map((r) => r.paper_id)).size}</b><span>${esc(T("papers"))}</span></div>
      <div><b>${c.runs.length + i.runs.filter((r) => r.status !== "error").length}</b><span>${esc(T("runs"))}: ${c.runs.length} ${esc(T("normal"))} + ${i.runs.filter((r) => r.status !== "error").length} ${esc(T("with a planted mistake"))}</span></div><div><b>${yuan(spent)}</b><span>${esc(T("spent"))}</span></div></div></section>`;
  }

  function tabs() {
    return `<div class="btabs">${TABS.map(([k, n]) => `<button type="button" data-tab="${k}" class="${tab === k ? "on" : ""}">${esc(T(n))}</button>`).join("")}</div>`;
  }

  // ---- charts ----
  function card(title, sub, body, wide, cohort) {
    return `<section class="aac ${wide ? "wide" : ""}"><h3>${esc(T(title))}</h3>${sub ? `<p class="muted small">${esc(T(sub))}</p>` : ""}${body}${cohort ? `<p class="cohort">${esc(cohort)}</p>` : ""}</section>`;
  }
  // what one number counts, written next to it
  const cleanCohort = () => {
    const c = D.tracks.clean, papers = new Set(c.runs.map((r) => r.paper_id)).size, per = Math.max(...ROWS.map((r) => r.n || 0));
    return `${T("Sample")}: ${per} ${T("runs per model")} (${papers} ${T("papers, some run twice")}); ${c.runs.length} ${T("runs in all")}.`;
  };
  const robustCohort = () => { const per = Math.max(...ROWS.map((r) => r.rn || 0)); return `${T("Sample")}: ${per} ${T("runs with one planted mistake per model")}; ${D.tracks.inject.runs.filter((r) => r.status !== "error").length} ${T("runs in all")}.`; };
  const readCohort = () => { const per = Math.max(...ROWS.map((r) => r.reading_n || 0)); return `${T("Sample")}: ${per} ${T("papers read by every model (step 1 only)")}.`; };
  // dot and whisker on a 0 to 100 scale: the interval is the main mark, the score is printed next to the dot
  function dotplot(rows, key, ci) {
    const list = rows.filter((r) => r[key] != null).sort((a, b) => b[key] - a[key]);
    if (!list.length) return `<p class="muted small">${esc(T("No finished runs yet."))}</p>`;
    const lo = Math.max(0, Math.floor(Math.min(...list.map((r) => (r[ci] ? r[ci][0] : r[key]))) * 10) / 10), hi = 1;
    const X = (v) => ((v - lo) / (hi - lo)) * 100;
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => lo + (hi - lo) * f);
    return `<div class="dp">${list.map((r) => {
      const c = r[ci];
      return `<div class="dpr"><div class="dpn"><span class="dot" style="background:${col(r.id)}"></span><b>${esc(r.id)}</b><span class="dpv">${(r[key] * 100).toFixed(1)}${c ? ` <span class="muted">(${(c[0] * 100).toFixed(0)} to ${(Math.min(1, c[1]) * 100).toFixed(0)})</span>` : ""}</span></div>
        <div class="dpt">${ticks.map((v) => `<i class="tk" style="left:${X(v)}%"></i>`).join("")}${c ? `<u style="left:${X(c[0])}%;width:${X(Math.min(1, c[1])) - X(c[0])}%;background:${col(r.id)}"></u>` : ""}<s style="left:${X(r[key])}%;background:${col(r.id)}"></s></div></div>`;
    }).join("")}<div class="dpx">${ticks.map((v) => `<span style="left:${X(v)}%">${Math.round(v * 100)}</span>`).join("")}</div></div>`;
  }
  // a metric where every model has the same value is a shared result, not a ranking
  function allSame(rows, key) {
    const v = rows.filter((r) => r[key] != null).map((r) => r[key]);
    return v.length > 1 && v.every((x) => x === v[0]);
  }
  function sharedResult(rows, text) {
    return `<p class="shared">${esc(text)}</p><div class="chips">${rows.map((r) => `<span class="chip"><span class="dot" style="background:${col(r.id)}"></span>${esc(r.id)}</span>`).join("")}</div>`;
  }
  function readingBody() {
    if (allSame(ROWS, "reading")) {
      const r = ROWS.find((x) => x.reading != null);
      return sharedResult(ROWS.filter((x) => x.reading != null), `${T("All")} ${ROWS.filter((x) => x.reading != null).length} ${T("models found the right number on")} ${Math.round(r.reading * r.reading_n)} ${T("of")} ${r.reading_n} ${T("papers. No ranking: they are tied.")}`);
    }
    return bars(ROWS, "reading", { fmt: (v, x) => Math.round(v * x.reading_n) + "/" + x.reading_n });
  }
  // the plain-language reading of a cost or time chart: the cheapest (fastest) model among those tied with the best
  function tradeoff(key, fmt, word) {
    const top = ROWS.filter((r) => (r.tie || r.best) && r[key] != null);
    if (top.length < 2) return "";
    const b = top.slice().sort((a, c) => a[key] - c[key])[0];
    return `<p class="take">${esc(T(word))}: <b>${esc(b.id)}</b> (${esc(fmt(b[key]))}), ${esc(T("with a score tied with the best"))}.</p>`;
  }
  // horizontal bars; value in 0..1 unless max is given; ci = [lo, hi] on the same scale
  function bars(rows, key, o = {}) {
    const max = o.max || 1, fmt = o.fmt || ((v) => num(v));
    const list = rows.filter((r) => r[key] != null).sort((a, b) => (o.asc ? a[key] - b[key] : b[key] - a[key]));
    if (!list.length) return `<p class="muted small">${esc(T("No finished runs yet."))}</p>`;
    return `<div class="aab">${list.map((r, i) => {
      const ci = o.ci && r[o.ci];
      return `<div class="aar"><div class="aan"><span class="rk">${i + 1}</span><span class="dot" style="background:${col(r.id)}"></span><b>${esc(r.id)}</b></div>
        <div class="aat"><i style="width:${Math.min(100, (r[key] / max) * 100)}%;background:${col(r.id)}"></i>${ci ? `<u style="left:${(ci[0] / max) * 100}%;width:${Math.max(0.8, ((ci[1] - ci[0]) / max) * 100)}%"></u>` : ""}</div>
        <div class="aav">${fmt(r[key], r)}</div></div>`;
    }).join("")}</div>`;
  }
  function scatter(rows, xkey, xlab, fmtx) {
    const W = 520, H = 290, P = { l: 44, r: 96, t: 12, b: 38 };
    const pts = rows.filter((m) => m[xkey] != null && m.detailed != null);
    if (!pts.length) return "";
    const xs = pts.map((m) => m[xkey]), xmax = Math.max(...xs) * 1.08 || 1, xmin = Math.max(0, Math.min(...xs) * 0.85) * (xmax / Math.max(...xs) > 3 ? 0 : 1);
    const lo = Math.max(0, Math.floor((Math.min(...pts.map((m) => m.detailed)) - 0.08) * 10) / 10), hi = 1;
    const X = (v) => P.l + ((v - xmin) / (xmax - xmin)) * (W - P.l - P.r), Y = (v) => H - P.b - ((v - lo) / (hi - lo)) * (H - P.t - P.b);
    const front = pts.filter((a) => !pts.some((b) => b !== a && b[xkey] <= a[xkey] && b.detailed >= a.detailed && (b[xkey] < a[xkey] || b.detailed > a.detailed))).sort((a, b) => a[xkey] - b[xkey]);
    const gv = [0, 1, 2, 3, 4].map((i) => lo + ((hi - lo) * i) / 4);
    const grid = gv.map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}" class="g"/><text x="${P.l - 6}" y="${Y(v) + 4}" text-anchor="end">${Math.round(v * 100)}</text>`).join("");
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => `<text x="${X(xmin + (xmax - xmin) * f)}" y="${H - P.b + 16}" text-anchor="middle">${fmtx(xmin + (xmax - xmin) * f)}</text>`).join("");
    return `<figure class="sc"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(xlab)}">${grid}${ticks}
      <polyline class="front" points="${front.map((m) => X(m[xkey]) + "," + Y(m.detailed)).join(" ")}"/>
      ${pts.map((m) => `<g><circle cx="${X(m[xkey])}" cy="${Y(m.detailed)}" r="6.5" style="fill:${col(m.id)}"/><text x="${X(m[xkey]) + 10}" y="${Y(m.detailed) + 4}" class="pl">${esc(short(m.id))}</text></g>`).join("")}
      <text x="${(W + P.l - P.r) / 2}" y="${H - 5}" text-anchor="middle" class="ax">${esc(xlab)}</text><text x="11" y="${H / 2}" transform="rotate(-90 11 ${H / 2})" text-anchor="middle" class="ax">${esc(T("Repro Index"))}</text></svg></figure>`;
  }
  const legend = () => `<p class="aal">${[...new Set(D.models.map((m) => m.lab))].map((l) => `<span><i style="background:${LABCOL[l] || "#667"}"></i>${esc(l)}</span>`).join("")}</p>`;
  const tieNote = (rows) => {
    const t = rows.filter((r) => r.tie || r.best).map((r) => r.id);
    if (t.length < 2) return "";
    return `<p class="aatie">≈ ${t.length === rows.filter((r) => r.detailed != null).length ? esc(T("All scores are statistically tied; the intervals overlap.")) : esc(T("Tied at the top, intervals overlap")) + ": " + esc(t.join(", ")) + "."}</p>`;
  };

  // ---- tabs ----
  function indexTab() {
    if (!D.tracks.clean.runs.length) return `<p class="muted">${esc(T("No finished runs yet."))}</p>`;
    const maxc = Math.max(...ROWS.map((r) => r.cps || 0)) * 1.05 || 1, maxm = Math.max(...ROWS.map((r) => r.minutes || 0)) * 1.05 || 1;
    return `<div class="aag">
      ${card("Repro Index", "Score 0 to 100 (dot) with its 95% interval (line). Higher is better.", dotplot(ROWS, "detailed", "ci") + tieNote(ROWS), true, cleanCohort())}
      ${card("Robustness to planted mistakes", "0 to 100. How well a model resists a wrong fact, a missing requirement or a misleading hint. See the Robustness tab for each kind.", dotplot(ROWS, "robust", "rci"), false, robustCohort())}
      ${card("Reading the paper", "Papers where step 1 finds the right number to reproduce.", readingBody(), false, readCohort())}
      ${card("Repro Index vs cost per run", "Higher and further left is better: a better score for less money.", scatter(ROWS, "cost", T("Cost per run (¥)"), (v) => "¥" + v.toFixed(1)) + tradeoff("cost", (v) => yuan(v) + " " + T("per run"), "Lower cost, similar score"), false, cleanCohort())}
      ${card("Repro Index vs median time", "Higher and further left is better. Runs share one machine, so times are rough.", scatter(ROWS, "minutes", T("Median time per run (min)"), (v) => Math.round(v) + "") + tradeoff("minutes", (v) => mins(v), "Faster, similar score"), false, cleanCohort())}
      ${card("Cost per successful reproduction", "Total spent divided by runs marked reproduced. Lower is better.", bars(ROWS, "cps", { asc: true, max: maxc, fmt: (v) => yuan(v) }), false, cleanCohort())}
      ${card("Median time per run", "Minutes on 7 CPU cores. Lower is better.", bars(ROWS, "minutes", { asc: true, max: maxm, fmt: (v) => mins(v) }), false, cleanCohort())}
    </div>${legend()}${judges()}`;
  }

  function judges() {
    const j = D.judges;
    if (!j) return "";
    const sg = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(1);
    return `<details class="jbox"><summary>${esc(T("How far can the judges be trusted?"))}</summary><p class="small">${esc(T("Two judges from different labs rated every requirement of every run without knowing which model wrote the code."))}
      ${esc(T("They gave the same rating on"))} <b>${Math.round(j.agree_mean * 100)}%</b> ${esc(T("of requirements"))}; ${esc(T("the two coverage scores correlate at"))} <b>${j.corr == null ? "-" : j.corr}</b>.
      ${j.bias_own_family != null ? esc(T("When the first judge (DeepSeek) rated DeepSeek's own code it scored")) + " " + sg(j.bias_own_family) + " " + esc(T("points against the second judge, versus")) + " " + sg(j.bias_other) + " " + esc(T("for other models")) + "." : ""}</p></details>`;
  }

  const COLS = [["detailed", "Index", (r) => num(r.detailed)], ["accuracy", "Accuracy", (r) => num(r.accuracy, 0)], ["coverage", "Coverage", (r) => num(r.coverage, 0)], ["fidelity", "Fidelity", (r) => num(r.fidelity, 0)],
    ["robust", "Robustness", (r) => num(r.robust)], ["reading", "Reading", (r) => (r.reading == null ? "-" : Math.round(r.reading * r.reading_n) + "/" + r.reading_n)],
    ["reproduced", "Reproduced", (r) => (r.n ? r.reproduced + "/" + r.n : "-")], ["minutes", "Time", (r) => mins(r.minutes)], ["cost", "Cost / run", (r) => yuan(r.cost)], ["cps", "Cost / success", (r) => yuan(r.cps)]];
  function modelsTab() {
    const nul = sortDir < 0 ? -1e12 : 1e12, sorted = ROWS.slice().sort((a, b) => ((b[sortBy] == null ? nul : b[sortBy]) - (a[sortBy] == null ? nul : a[sortBy])) * -sortDir);
    return `<div class="tw lbwrap"><table class="lb"><thead><tr><th>${esc(T("Model"))}</th>${COLS.map(([k, n]) => `<th class="nm"><button type="button" class="sortb ${sortBy === k ? "on" : ""}" data-sort="${k}">${esc(T(n))}${sortBy === k ? (sortDir < 0 ? " ▾" : " ▴") : ""}</button></th>`).join("")}</tr></thead>
      <tbody>${sorted.map((r) => `<tr><td><span class="dot" style="background:${col(r.id)}"></span><b>${esc(r.id)}</b><div class="muted small">${esc(r.lab)}</div></td>${COLS.map(([k, , f]) => `<td class="nm ${sortBy === k ? "sel" : ""}">${f(r)}${k === "detailed" && r.tie ? ` <span class="tie" title="${esc(T("Too close to the best model to call: the intervals overlap"))}">≈</span>` : ""}</td>`).join("")}</tr>`).join("")}</tbody></table></div>
      <div class="mcards">${sorted.map((r) => `<div class="mcard"><div class="mch"><span class="dot" style="background:${col(r.id)}"></span><b>${esc(r.id)}</b><span class="muted small">${esc(r.lab)}</span><span class="mci">${num(r.detailed)}${r.tie ? " ≈" : ""}</span></div><dl>${COLS.slice(1).map(([k, n, f]) => `<div class="${sortBy === k ? "sel" : ""}"><dt>${esc(T(n))}</dt><dd>${f(r)}</dd></div>`).join("")}</dl></div>`).join("")}</div>
      <p class="muted small">${esc(T("Index = 0.40 accuracy + 0.35 coverage + 0.25 fidelity. See Methodology for every formula."))} ≈ ${esc(T("marks a statistical tie with the best model."))}</p>`;
  }

  function readingTab() {
    const r = D.reader || { runs: [], by_model: [] };
    if (!r.runs.length) return `<p class="muted">${esc(T("No finished runs yet."))}</p>`;
    const sp = r.by_model.map((m) => ({ id: m.key, s: m.seconds_median }));
    return `<div class="aag">${card("Step 1: right number to reproduce", "Each model reads the paper and writes the claim contract. Compared with the reference contract.", readingBody(), false, readCohort())}
      ${card("Speed of step 1", "Median seconds for one paper. Lower is better.", bars(sp, "s", { asc: true, max: Math.max(...sp.map((m) => m.s)) * 1.05, fmt: (v) => Math.round(v) + " s" }))}</div>
      <div class="tw"><table class="lb"><thead><tr><th>${esc(T("Model"))}</th><th class="nm">${esc(T("Valid contract"))}</th><th class="nm">${esc(T("Same target"))}</th><th class="nm">${esc(T("Right paper value"))}</th><th class="nm">${esc(T("Tolerance close"))}</th><th class="nm">${esc(T("Requirements found"))}</th><th class="nm">${esc(T("Cost per run"))}</th></tr></thead><tbody>
      ${r.by_model.map((m) => `<tr><td><span class="dot" style="background:${col(m.key)}"></span><b>${esc(m.key)}</b></td><td class="nm">${m.ok}/${m.n}</td><td class="nm">${m.same_claim}/${m.n}</td><td class="nm"><b>${m.value_ok}/${m.n}</b></td><td class="nm">${m.tolerance_ok}/${m.n}</td><td class="nm">${Math.round(m.req_ratio * 100)}%</td><td class="nm">${yuan(m.cost_mean)}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted small">${esc(T("Right paper value = the number to reproduce matches the reference within 0.1%. Tolerance close = within 35% of the reference tolerance. Requirements found = how many requirements it listed compared with the reference."))}</p>`;
  }

  function heat(v) {
    if (v == null) return `<td class="empty">·</td>`;
    const a = Math.round(14 + v * 56);
    return `<td class="hm nm" style="background:color-mix(in srgb,var(--ok) ${a}%,var(--surface))">${(v * 100).toFixed(0)}</td>`;
  }
  function robustTab() {
    const inj = D.tracks.inject, rb = inj.robust || [];
    if (!rb.length) return `<p class="muted">${esc(T("No finished runs yet."))}</p>`;
    const runs = inj.runs.filter((r) => r.status !== "error" && r.robust != null);
    const kind = (r) => String(r.condition || "").split(":")[1] || "";
    return `<div class="aag">
      ${card("Robustness", "0.5 resisted + 0.2 noticed + 0.3 quality of the run. Dot: score; line: 95% interval.", dotplot(ROWS, "robust", "rci") + legend(), true, robustCohort())}
      </div>
      <h3 class="aah3">${esc(T("By kind of mistake"))}</h3>
      <div class="tw"><table class="lb"><thead><tr><th>${esc(T("Model"))}</th>${["F", "O", "H"].map((k) => `<th class="nm">${esc(T(kindName[k]))}</th>`).join("")}<th class="nm">${esc(T("Resisted"))}</th><th class="nm">${esc(T("Noticed"))}</th><th class="nm">${esc(T("False success"))}</th></tr></thead><tbody>
      ${ROWS.filter((r) => r.rn).sort((a, b) => b.robust - a.robust).map((r) => `<tr><td><span class="dot" style="background:${col(r.id)}"></span><b>${esc(r.id)}</b></td>${["F", "O", "H"].map((k) => heat(r.by_kind && r.by_kind[k])).join("")}<td class="nm">${r.resisted}/${r.rn}</td><td class="nm">${r.noticed}/${r.rn}</td><td class="nm">${r.false_success}/${r.rn}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted small">${esc(T("Resisted = the final code did not use the planted mistake. Noticed = the model said in words that it was wrong. False success = it used the mistake and was still marked reproduced."))}</p>
      <details class="jbox"><summary>${esc(T("Run by run"))} (${runs.length})</summary><div class="tw"><table class="why"><thead><tr><th>${esc(T("Model"))}</th><th>${esc(T("Planted mistake"))}</th><th>${esc(T("Paper"))}</th><th class="nm">${esc(T("Robustness"))}</th><th>${esc(T("What the judge saw"))}</th></tr></thead><tbody>
      ${runs.map((r) => `<tr><td>${esc(short(r.model))}</td><td>${esc(T(kindName[kind(r)] || ""))}</td><td>${esc(r.paper_id)}</td><td class="nm">${num(r.robust, 0)}<div class="muted small">${esc(r.noticed ? T("noticed") : T("did not notice"))} · ${esc(r.followed ? T("fooled") : T("not fooled"))}</div></td><td class="small">${esc(r.judge_evidence || "")}</td></tr>`).join("")}</tbody></table></div></details>`;
  }

  function matrix() {
    const c = D.tracks.clean, models = D.models.map((m) => m.id);
    const cell = (p, m) => {
      const r = c.runs.find((x) => x.paper_id === p.id && x.model === m);
      if (!r) return `<td class="empty">·</td>`;
      const v = r.verdict || "none";
      const val = r.detailed != null ? (r.detailed * 100).toFixed(0) : "";
      const tip = `${r.verdict ? T(VERDICT[r.verdict] || r.verdict) : T("no verdict")}: ${r.measured != null ? Number(r.measured).toFixed(r.measured > 20 ? 1 : 3) : ""} ${T("vs")} ${r.target == null ? "" : r.target} · ${mins((r.seconds || 0) / 60)} · ${yuan(r.cost_cny)}${(r.flags || []).length ? " · " + r.flags.join(", ") : ""}`;
      const href = r.replay ? `index.html?replay=${encodeURIComponent(r.replay)}${r.pdf ? "&pdf=" + encodeURIComponent(r.pdf) : ""}` : "";
      const inner = `<span class="dotv ${esc(v)}"></span><span class="val">${esc(val)}</span>`;
      return `<td class="cell ${esc(v)}" title="${esc(tip)}">${href ? `<a href="${esc(href)}">${inner}</a>` : inner}</td>`;
    };
    return `<div class="tw"><table class="mxp"><thead><tr><th>${esc(T("Paper"))}</th>${models.map((m) => `<th class="rot"><span>${esc(short(m))}</span></th>`).join("")}</tr></thead>
      <tbody>${D.papers.filter((p) => c.runs.some((r) => r.paper_id === p.id)).map((p) => `<tr><td><b>${esc(p.title.length > 46 ? p.title.slice(0, 44) + "..." : p.title)}</b><div class="muted small">${esc(T("Difficulty"))} <span class="dots">${dots(p.difficulty)}</span></div></td>${models.map((m) => cell(p, m)).join("")}</tr>`).join("")}</tbody></table></div>
      <p class="legend small muted"><span class="dotv reproduced"></span>${esc(T("Reproduced"))} <span class="dotv partially_reproduced"></span>${esc(T("Partially reproduced"))} <span class="dotv not_reproduced"></span>${esc(T("Not reproduced"))} · ${esc(T("Number = Repro Index of that run. Click a cell to replay the run."))}</p>`;
  }

  function calib() {
    const c = D.calibration || [];
    if (!c.length) return "";
    return `<div class="tw"><table><thead><tr><th>${esc(T("Paper"))}</th><th class="nm">${esc(T("Estimated"))}</th><th class="nm">${esc(T("Measured, median"))}</th><th class="nm">${esc(T("Measured, fastest to slowest"))}</th><th></th></tr></thead><tbody>
      ${c.map((r) => { const p = D.papers.find((x) => x.id === r.paper_id); return `<tr><td>${esc(p.title.length > 40 ? p.title.slice(0, 38) + "..." : p.title)}</td><td class="nm">${mins(r.estimate)} <span class="muted small">(${mins(r.low)} - ${mins(r.high)})</span></td><td class="nm"><b>${mins(r.median)}</b></td><td class="nm">${mins(r.min)} - ${mins(r.max)}</td><td>${r.inside ? "✓" : "✗"}</td></tr>`; }).join("")}</tbody></table></div>`;
  }

  function setTable() {
    const ps = D.paper_set;
    if (!ps) return "";
    const tiers = [["easy", "Easy"], ["medium", "Medium"], ["hard", "Hard"]];
    return `<div class="aast"><div><b>${ps.triaged}</b><span>${esc(T("papers triaged"))}</span></div><div><b>${ps.eligible}</b><span>${esc(T("can be reproduced"))}</span></div>${tiers.map(([k, n]) => `<div><b>${ps.counts[k]}</b><span>${esc(T(n))}</span></div>`).join("")}</div>
      ${tiers.map(([k, n]) => `<h3 class="aah3">${esc(T(n))}</h3><div class="tw"><table><thead><tr><th>${esc(T("Paper"))}</th><th>${esc(T("Difficulty"))}</th><th class="nm">${esc(T("Time on a laptop"))}</th><th>${esc(T("Code"))}</th><th>${esc(T("Target result"))}</th></tr></thead><tbody>
        ${ps.papers.filter((p) => p.tier === k).map((p) => `<tr><td><b>${esc(p.title.length > 58 ? p.title.slice(0, 56) + "..." : p.title)}</b><div class="muted small mono">${esc(p.id)}${p.pilot ? " · " + esc(T("in the pilot")) : ""}</div></td><td><span class="dots">${dots(p.difficulty)}</span></td><td class="nm">${p.needs_gpu ? esc(T("needs a GPU")) : mins(p.ref_minutes)}</td><td>${esc(T(p.release === "full" ? "released" : p.release === "partial" ? "partly released" : p.release === "none" ? "not released" : "unknown"))}</td><td class="small">${esc((p.target || "").slice(0, 110))}</td></tr>`).join("")}</tbody></table></div>`).join("")}`;
  }

  function papersTab() {
    return `<h3 class="aah3">${esc(T("Results by paper"))}</h3>${matrix()}
      <h3 class="aah3">${esc(T("Paper set"))} ${esc((D.paper_set || {}).version || "")}</h3>${setTable()}
      <h3 class="aah3">${esc(T("Does the time estimate hold?"))}</h3>${calib()}`;
  }

  // ---- methodology ----
  function formula(title, expr, lines) {
    return `<section class="aam"><h3>${esc(T(title))}</h3><pre class="fx">${esc(expr)}</pre><ul class="plain">${lines.map((l) => `<li>${esc(T(l))}</li>`).join("")}</ul></section>`;
  }
  const rd = (x) => (x == null ? "-" : Number(Number(x).toPrecision(4)));
  function example() {
    const ok = D.tracks.clean.runs.filter((x) => x.detailed != null);
    const r = ok.filter((x) => x.verdict === "reproduced").sort((a, b) => Math.abs(a.detailed - 0.9) - Math.abs(b.detailed - 0.9))[0] || ok[0];
    if (!r) return "";
    const p = D.papers.find((x) => x.id === r.paper_id) || { title: r.paper_id };
    return `<section class="aam wide"><h3>${esc(T("A worked example"))}</h3><p class="small">${esc(r.model)} · ${esc(p.title)}</p>
      <pre class="fx">${esc(T("target"))} ${r.target}   ${esc(T("measured"))} ${rd(r.measured)}   ${esc(T("tolerance"))} ±${rd(r.band)}
${esc(T("Accuracy"))}  = 1 - min(1, |${rd(r.diff)}| / (2 × ${rd(r.band)}))  = ${r.accuracy}
${esc(T("Coverage"))}  = ${r.coverage}   (${esc(T("judge 1"))} ${r.coverage_j1}, ${esc(T("judge 2"))} ${r.coverage_j2})
${esc(T("Fidelity"))}  = ${r.fidelity}${(r.flags || []).length ? "   (" + r.flags.join(", ") + ")" : ""}
${esc(T("Index"))}     = 100 × (0.40 × ${r.accuracy} + 0.35 × ${r.coverage} + 0.25 × ${r.fidelity}) = ${(r.detailed * 100).toFixed(1)}</pre></section>`;
  }
  function whyModels() {
    return `<div class="tw"><table class="why"><thead><tr><th>${esc(T("Model"))}</th><th class="nm">${esc(T("General index"))}</th><th class="nm">${esc(T("Cost per task"))}</th><th>${esc(T("Why it is in the pilot"))}</th></tr></thead><tbody>
      ${D.models.map((m) => `<tr><td><b>${esc(m.id)}</b><div class="muted small">${esc(m.lab)}</div></td><td class="nm">${m.aa_index == null ? "-" : m.aa_index}</td><td class="nm">${m.aa_cost_per_task_usd == null ? "-" : "$" + m.aa_cost_per_task_usd.toFixed(2)}</td><td class="small">${esc(T(m.why))}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted small">${esc(T("General index and cost per task: Artificial Analysis Intelligence Index, snapshot"))} ${esc(D.snapshot)}. ${esc(T("Not in the pilot"))}: ${D.considered.map((m) => esc(m.id) + " (" + esc(T(m.why)) + ")").join("; ")}.</p>`;
  }
  function methodTab() {
    return `<div class="aamg">
      ${formula("Repro Index", "Index = 100 × (0.40 × Accuracy + 0.35 × Coverage + 0.25 × Fidelity)", [
        "Accuracy = 1 - min(1, |measured - paper| / (2 × tolerance)). 1 at an exact match, 0.5 at the edge of the tolerance, 0 at twice the tolerance.",
        "Coverage = share of the paper's requirements the code really meets: met 1, partial 0.5, missing 0. Mean of two independent judges.",
        "Fidelity = 1, minus 0.5 for a serious flag (hard-coded number, copied paper value, wrong split, swapped method), minus 0.2 for a scaled-down run, minus 0.3 for the wrong experiment.",
        "Cost and time are never inside the score. They are shown next to it."])}
      ${formula("Robustness", "Robustness = 100 × (0.5 × Resisted + 0.2 × Noticed + 0.3 × Quality)", [
        "One planted mistake per run: a wrong fact, a missing requirement, or a misleading hint.",
        "Resisted = 1 if the final code did not use the mistake. Noticed = 1 if the model said in words that it was wrong.",
        "Quality = the run's own Repro Index, so resisting but failing to reproduce scores lower than resisting and reproducing.",
        "False success: used the mistake and still marked reproduced. Counted separately."])}
      ${formula("Reading", "Reading = papers where the contract's number is within 0.1% of the reference / papers", [
        "Step 1 alone: the model reads the paper and writes the claim contract. Compared with a reference contract.",
        "Cheap, fast, and shows whether a small model is enough for this step."])}
      ${formula("Ties and intervals", "interval = mean ± 1.96 × standard error", [
        "With few papers a gap can be luck. A model whose interval overlaps the best model's is shown as a tie.",
        "More papers and repeated runs narrow the intervals. Ranks inside a tie are not meaningful."])}
      ${example()}
      ${D.noise ? `<section class="aam wide"><h3>${esc(T("Run-to-run noise"))}</h3><p class="small">${esc(T("The same model on the same paper, run twice, moves by"))} <b>${(D.noise.mean_abs_diff * 100).toFixed(1)}</b> ${esc(T("index points on average"))} (${esc(T("largest"))} ${(D.noise.max_abs_diff * 100).toFixed(0)}), ${esc(T("and the verdict changed in"))} <b>${D.noise.verdict_flips} ${esc(T("of"))} ${D.noise.pairs}</b> ${esc(T("pairs. Differences between models smaller than this are not meaningful."))}</p></section>` : ""}
      <section class="aam wide"><h3>${esc(T("What is held fixed"))}</h3><ul class="plain">
        ${["Steps 1 to 3 (reading, route, plan) are run once and frozen. Every model gets the same contract and plan.",
          "Only the model that writes and runs the code changes. The verifier is the same model for every run, so a model never grades itself.",
          "Every run gets 7 CPU cores, no GPU, a 60 minute limit and a ¥10 cap. Three runs go at the same time, so times are noisy.",
          "Judge 2 is never from the same lab as the model tested, and does not see its name.",
          "Reproduced = the re-run number is inside the tolerance fixed before the run, with no serious flag. Partial = a gap up to twice the tolerance, a scaled-down run, or missing requirements.",
          "Time excludes the minutes the laptop was asleep, read from the system event log. The raw wall time is kept in the data.",
          "Cost = tokens times the provider's price. StepFun prices are fitted to the real invoice."].map((l) => `<li>${esc(T(l))}</li>`).join("")}</ul></section>
      <section class="aam wide"><h3>${esc(T("Limits"))}</h3><p class="small">${esc(T("A pilot: one run per paper and model on a small set of easy and medium papers. It shows that the method works and gives first numbers. Hard papers that need a GPU, repeated runs and agent apps come next."))}</p></section>
      <section class="aam wide"><h3>${esc(T("Why these models"))}</h3>${whyModels()}</section></div>`;
  }

  function render() {
    const body = { index: indexTab, models: modelsTab, reading: readingTab, robust: robustTab, papers: papersTab, method: methodTab }[tab]();
    $("#bench").innerHTML = head() + tabs() + `<div id="btab">${body}</div>`;
  }
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]"); if (t) { tab = t.dataset.tab; render(); return; }
    const s = e.target.closest("[data-sort]"); if (s) { sortDir = sortBy === s.dataset.sort ? -sortDir : -1; sortBy = s.dataset.sort; render(); }
  });
  document.addEventListener("langchange", () => { if (D) render(); });
  load();
})();
