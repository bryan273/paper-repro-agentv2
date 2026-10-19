/* Leaderboard page: reads bench/data.json (built by scripts/export_bench.py from the benchmark runs). Static, no server needed. */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const T = (s) => (window.t ? window.t(s) : s);
  const VERDICT = { reproduced: "Reproduced", partially_reproduced: "Partially reproduced", not_reproduced: "Not reproduced", could_not_run: "Could not run" };
  let D = null, tab = "clean", sortBy = "score";
  const pct = (x) => (x == null ? "" : Math.round(x * 100) + "%");
  const mins = (x) => (x == null ? "" : x < 90 ? Math.round(x) + " min" : (x / 60).toFixed(1) + " h");
  const yuan = (x) => (x == null ? "" : "¥" + (x < 10 ? x.toFixed(2) : x.toFixed(1)));
  const dots = (d) => (d ? "●".repeat(d) + "○".repeat(5 - d) : "");
  const lab = (id) => { const m = D.models.find((x) => x.id === id); return m ? m.lab : ""; };
  const short = (s) => String(s).replace("DeepSeek-", "DS-");

  async function load() {
    try { D = await (await fetch("bench/data.json?v=" + Date.now(), { cache: "no-store" })).json(); }
    catch (e) { $("#bench").innerHTML = `<p class="muted">${esc(T("Could not load the results."))}</p>`; return; }
    render();
  }

  function head() {
    const c = D.tracks.clean, n = c.runs.length, total = D.models.length * D.papers.length;
    const spent = c.by_model.reduce((a, m) => a + (m.cost_total || 0), 0);
    return `<section class="bhero"><span class="bpill">${esc(T("Pilot"))}</span>
      <h1>${esc(T("Which model reproduces research papers best, cheapest and most honestly?"))}</h1>
      <p class="muted">${esc(T("Same task, same reading and planning of the paper, same judge. Only the model that writes and runs the code changes. Every number links back to a run with its full log."))}</p>
      <div class="bstats"><div><b>${D.papers.length}</b><span>${esc(T("papers"))}</span></div><div><b>${D.models.length}</b><span>${esc(T("models"))}</span></div>
        <div><b>${n} / ${total}</b><span>${esc(T("runs done"))}</span></div><div><b>${yuan(spent)}</b><span>${esc(T("spent so far"))}</span></div></div>
      <p class="warn small">${esc(T("Pilot: one run per paper and model. Differences smaller than the run-to-run noise are shown as ties, not as a ranking."))}</p></section>`;
  }

  function tabs() {
    return `<div class="btabs">${[["clean", "Models"], ["reader", "Step 1: reading"], ["inject", "Error injection"], ["set", "Paper set"], ["method", "Method"]].map(([k, n]) => `<button type="button" data-tab="${k}" class="${tab === k ? "on" : ""}">${esc(T(n))}</button>`).join("")}</div>`;
  }

  function bar(v) { return v == null ? "" : `<div class="mbar" title="${Math.round(v * 100)}%"><i style="width:${Math.round(v * 100)}%"></i></div>`; }
  function table(rows) {
    const has = rows.some((m) => m.detailed != null);
    const keyf = { score: (m) => -(has ? (m.detailed == null ? -1 : m.detailed) : m.score), cost: (m) => (m.cost_mean == null ? 9e9 : m.cost_mean), time: (m) => (m.minutes_median == null ? 9e9 : m.minutes_median) }[sortBy];
    rows = rows.slice().sort((a, b) => keyf(a) - keyf(b));
    const th = (k, t) => `<th><button type="button" class="sortb ${sortBy === k ? "on" : ""}" data-sort="${k}">${esc(T(t))}${sortBy === k ? " ▾" : ""}</button></th>`;
    return `<div class="tw"><table class="lb"><thead><tr><th>#</th><th>${esc(T("Model"))}</th>${th("score", has ? "Detailed score" : "Score")}${has ? `<th>${esc(T("Accuracy"))}</th><th>${esc(T("Coverage"))}</th><th>${esc(T("Fidelity"))}</th>` : ""}<th>${esc(T("Reproduced"))}</th>${th("time", "Median time")}${th("cost", "Cost per run")}<th>${esc(T("Cost per success"))}</th></tr></thead>
      <tbody>${rows.map((m, i) => {
        const cps = m.reproduced ? m.cost_total / m.reproduced : null;
        const det = has && m.detailed != null;
        const best = det ? m.detail_best : m.best, tie = det ? m.detail_tie : m.tie_with_best;
        return `<tr class="${best ? "best" : ""}"><td>${i + 1}</td><td><b>${esc(m.key)}</b><div class="muted small">${esc(lab(m.key))}</div></td>
          <td><b>${det ? (m.detailed * 100).toFixed(1) : pct(m.score)}</b>${det && m.ci ? `<div class="ci" title="95% ${esc(T("interval of the mean"))}"><i style="left:${m.ci[0] * 100}%;width:${Math.max(1, (m.ci[1] - m.ci[0]) * 100)}%"></i><b style="left:${m.detailed * 100}%"></b></div>` : ""}${tie ? `<span class="tie" title="${esc(T("Too close to the best model to call: the intervals overlap"))}">≈ ${esc(T("tie"))}</span>` : best ? `<span class="topb">${esc(T("best"))}</span>` : ""}</td>
          ${has ? `<td>${m.accuracy == null ? "" : pct(m.accuracy)}${bar(m.accuracy)}</td><td>${m.coverage == null ? "" : pct(m.coverage)}${bar(m.coverage)}</td><td>${m.fidelity == null ? "" : pct(m.fidelity)}${bar(m.fidelity)}</td>` : ""}
          <td>${m.reproduced}/${m.n}<div class="muted small">${m.partial ? m.partial + " " + esc(T("partial")) : ""}${m.not_reproduced ? " " + m.not_reproduced + " " + esc(T("not")) : ""}</div></td>
          <td>${mins(m.minutes_median)}</td><td>${yuan(m.cost_mean)}</td><td>${cps == null ? "-" : yuan(cps)}</td></tr>`;
      }).join("")}</tbody></table></div>`;
  }

  function judges() {
    const j = D.judges;
    if (!j) return "";
    const sg = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(1);
    return `<details class="jbox"><summary>${esc(T("How far can the judges be trusted?"))}</summary><p class="small">${esc(T("Two judges from different labs rated every requirement of every run without knowing which model wrote the code."))}
      ${esc(T("They gave the same rating on"))} <b>${pct(j.agree_mean)}</b> ${esc(T("of requirements"))}; ${esc(T("the two coverage scores correlate at"))} <b>${j.corr == null ? "-" : j.corr}</b> ${esc(T("and differ by"))} ${pct(j.mean_abs_diff)} ${esc(T("on average"))}.
      ${j.bias_own_family != null ? esc(T("When the first judge (DeepSeek) rated DeepSeek's own code it scored")) + " " + sg(j.bias_own_family) + " " + esc(T("points against the second judge, versus")) + " " + sg(j.bias_other) + " " + esc(T("for other models")) + "." : ""}</p></details>`;
  }

  function scatter(rows, xkey, xlab, fmtx) {
    const W = 520, H = 300, P = { l: 48, r: 90, t: 14, b: 40 };
    const pts = rows.filter((m) => m[xkey] != null).map((m) => ({ ...m, _s: m.detailed != null ? m.detailed : m.score, _b: m.detailed != null ? m.detail_best : m.best }));
    if (!pts.length) return "";
    const xmax = Math.max(...pts.map((m) => m[xkey])) * 1.1 || 1;
    const X = (v) => P.l + (v / xmax) * (W - P.l - P.r), Y = (v) => H - P.b - v * (H - P.t - P.b);
    // best-value frontier: no other model is both cheaper (or faster) and at least as good
    const front = pts.filter((a) => !pts.some((b) => b !== a && b[xkey] <= a[xkey] && b._s >= a._s && (b[xkey] < a[xkey] || b._s > a._s))).sort((a, b) => a[xkey] - b[xkey]);
    const grid = [0, 0.25, 0.5, 0.75, 1].map((v) => `<line x1="${P.l}" x2="${W - P.r}" y1="${Y(v)}" y2="${Y(v)}" class="g"/><text x="${P.l - 6}" y="${Y(v) + 4}" text-anchor="end">${Math.round(v * 100)}%</text>`).join("");
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => `<text x="${X(xmax * f)}" y="${H - P.b + 16}" text-anchor="middle">${fmtx(xmax * f)}</text>`).join("");
    return `<figure class="sc"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(xlab)}">${grid}${ticks}
      <polyline class="front" points="${front.map((m) => X(m[xkey]) + "," + Y(m._s)).join(" ")}"/>
      ${pts.map((m) => `<g><circle cx="${X(m[xkey])}" cy="${Y(m._s)}" r="6" class="${m._b ? "b" : ""}"/><text x="${X(m[xkey]) + 9}" y="${Y(m._s) + 4}" class="pl">${esc(short(m.key))}</text></g>`).join("")}
      <text x="${(W + P.l - P.r) / 2}" y="${H - 6}" text-anchor="middle" class="ax">${esc(xlab)}</text><text x="12" y="${H / 2}" transform="rotate(-90 12 ${H / 2})" text-anchor="middle" class="ax">${esc(T("Score"))}</text></svg></figure>`;
  }

  function matrix() {
    const c = D.tracks.clean, models = D.models.map((m) => m.id);
    const cell = (p, m) => {
      const r = c.runs.find((x) => x.paper_id === p.id && x.model === m);
      if (!r) return `<td class="empty">·</td>`;
      const v = r.verdict || "none";
      const val = r.measured != null ? Number(r.measured).toFixed(r.measured > 20 ? 1 : 3) : "";
      const tip = `${r.verdict ? T(VERDICT[r.verdict] || r.verdict) : T("no verdict")}: ${val} ${T("vs")} ${r.target == null ? "" : r.target} · ${mins((r.seconds || 0) / 60)} · ${yuan(r.cost_cny)}${(r.flags || []).length ? " · " + r.flags.join(", ") : ""}`;
      const href = r.replay ? `index.html?replay=${encodeURIComponent(r.replay)}${r.pdf ? "&pdf=" + encodeURIComponent(r.pdf) : ""}` : "";
      const inner = `<span class="dotv ${esc(v)}"></span><span class="val">${esc(val)}</span>`;
      return `<td class="cell ${esc(v)}" title="${esc(tip)}">${href ? `<a href="${esc(href)}">${inner}</a>` : inner}</td>`;
    };
    return `<div class="tw"><table class="mxp"><thead><tr><th>${esc(T("Paper"))}</th>${models.map((m) => `<th class="rot"><span>${esc(short(m))}</span></th>`).join("")}</tr></thead>
      <tbody>${D.papers.map((p) => `<tr><td><b>${esc(p.title.length > 46 ? p.title.slice(0, 44) + "..." : p.title)}</b><div class="muted small">${esc(T("Difficulty"))} <span class="dots">${dots(p.difficulty)}</span> · ${esc(p.route)}${p.target_text ? "" : ""}</div></td>${models.map((m) => cell(p, m)).join("")}</tr>`).join("")}</tbody></table></div>
      <p class="legend small muted"><span class="dotv reproduced"></span>${esc(T("Reproduced"))} <span class="dotv partially_reproduced"></span>${esc(T("Partially reproduced"))} <span class="dotv not_reproduced"></span>${esc(T("Not reproduced"))} <span class="dotv none"></span>${esc(T("no verdict"))}</p>`;
  }

  function calib() {
    const c = D.calibration || [];
    if (!c.length) return "";
    return `<p class="muted">${esc(T("The estimate shown on each paper page, checked against what the six models took on the benchmark machine (7 cores)."))}</p>
      <div class="tw"><table><thead><tr><th>${esc(T("Paper"))}</th><th>${esc(T("Estimated"))}</th><th>${esc(T("Measured, median"))}</th><th>${esc(T("Measured, fastest to slowest"))}</th><th></th></tr></thead><tbody>
      ${c.map((r) => { const p = D.papers.find((x) => x.id === r.paper_id); return `<tr><td>${esc(p.title.length > 40 ? p.title.slice(0, 38) + "..." : p.title)}</td><td>${mins(r.estimate)} <span class="muted small">(${mins(r.low)} ${esc(T("to"))} ${mins(r.high)})</span></td><td><b>${mins(r.median)}</b></td><td>${mins(r.min)} - ${mins(r.max)}</td><td>${r.inside ? "✓" : "✗"}</td></tr>`; }).join("")}</tbody></table></div>`;
  }

  function whyModels() {
    return `<div class="tw"><table class="why"><thead><tr><th>${esc(T("Model"))}</th><th>${esc(T("Index"))}</th><th>${esc(T("Cost per task"))}</th><th>${esc(T("Why it is in the pilot"))}</th></tr></thead><tbody>
      ${D.models.map((m) => `<tr><td><b>${esc(m.id)}</b><div class="muted small">${esc(m.lab)}</div></td><td>${m.aa_index == null ? "-" : m.aa_index}</td><td>${m.aa_cost_per_task_usd == null ? "-" : "$" + m.aa_cost_per_task_usd.toFixed(2)}</td><td>${esc(T(m.why))}</td></tr>`).join("")}</tbody></table></div>
      <h3>${esc(T("Considered, not in the pilot"))}</h3><ul class="plain">${D.considered.map((m) => `<li><b>${esc(m.id)}</b>: ${esc(T(m.why))}</li>`).join("")}</ul>
      <p class="muted small">${esc(T("Index and cost per task: Artificial Analysis Intelligence Index, snapshot"))} ${esc(D.snapshot)}.</p>`;
  }

  function cleanTab() {
    const c = D.tracks.clean;
    if (!c.runs.length) return `<p class="muted">${esc(T("No finished runs yet."))}</p>`;
    return `<h2>${esc(T("Leaderboard"))}</h2>${table(c.by_model)}
      <p class="muted small">${esc(T("Detailed score = 40% accuracy + 35% coverage + 25% fidelity. Accuracy: how close the number is to the paper (1 at an exact match, 0.5 at the edge of the tolerance, 0 at twice the tolerance). Coverage: the share of the paper's requirements the code really meets, checked by two independent judges. Fidelity: 1, minus 0.5 for a serious flag, 0.2 for a scaled-down run, 0.3 for running the wrong experiment. Cost and time are shown next to the score, never inside it. Bars show the 95% interval of the mean over the five papers."))}</p>${judges()}
      <h2>${esc(T("Score against cost and time"))}</h2><div class="scs">${scatter(c.by_model, "cost_mean", T("Cost per run (¥)"), (v) => "¥" + v.toFixed(1))}${scatter(c.by_model, "minutes_median", T("Median time per run (min)"), (v) => Math.round(v) + "")}</div>
      <p class="muted small">${esc(T("The dashed line joins the models that nobody beats on both axes."))}</p>
      <h2>${esc(T("Paper by paper"))}</h2>${matrix()}
      <h2>${esc(T("Does the time estimate hold?"))}</h2>${calib()}
      <h2>${esc(T("Why these models"))}</h2>${whyModels()}`;
  }

  function injectTable() {
    const runs = D.tracks.inject.runs.filter((r) => r.status !== "error");
    const kind = (r) => String(r.condition || "").split(":")[1] || "";
    const cell = (rs, f) => { const j = rs.filter((r) => r.noticed != null); return j.length ? f(j) + "/" + j.length : "-"; };
    const by = {};
    runs.forEach((r) => { (by[r.model] = by[r.model] || []).push(r); });
    const sumRow = (name, rs) => `<tr><td><b>${esc(name)}</b></td><td>${rs.length}</td><td>${cell(rs, (j) => j.filter((r) => r.noticed).length)}</td><td>${cell(rs, (j) => j.filter((r) => !r.followed).length)}</td>
      <td>${cell(rs, (j) => j.filter((r) => r.followed && r.verdict === "reproduced").length)}</td></tr>`;
    const types = [["F", "Wrong fact"], ["O", "Missing requirement"], ["H", "Misleading hint"]];
    return `<div class="tw"><table class="lb"><thead><tr><th>${esc(T("Model"))}</th><th>${esc(T("Runs"))}</th><th>${esc(T("Noticed"))}</th><th>${esc(T("Not fooled"))}</th><th>${esc(T("Fooled but still marked reproduced"))}</th></tr></thead><tbody>${Object.entries(by).map(([m, rs]) => sumRow(m, rs)).join("")}</tbody></table></div>
      <h3>${esc(T("By kind of mistake"))}</h3><div class="tw"><table class="lb"><thead><tr><th>${esc(T("Planted mistake"))}</th><th>${esc(T("Runs"))}</th><th>${esc(T("Noticed"))}</th><th>${esc(T("Not fooled"))}</th><th>${esc(T("Fooled but still marked reproduced"))}</th></tr></thead><tbody>${types.map(([k, n]) => sumRow(T(n), runs.filter((r) => kind(r) === k))).join("")}</tbody></table></div>
      <h3>${esc(T("Run by run"))}</h3><div class="tw"><table class="why"><thead><tr><th>${esc(T("Model"))}</th><th>${esc(T("Planted mistake"))}</th><th>${esc(T("Paper"))}</th><th>${esc(T("Result"))}</th><th>${esc(T("What the judge saw"))}</th></tr></thead><tbody>${runs.map((r) => `<tr><td>${esc(short(r.model))}</td><td>${esc(T((types.find((x) => x[0] === kind(r)) || [0, ""])[1]))}</td><td>${esc(r.paper_id)}</td>
        <td>${esc(r.verdict ? T(VERDICT[r.verdict] || r.verdict) : "")}<div class="muted small">${r.noticed == null ? "" : (r.noticed ? T("noticed") : T("did not notice")) + " · " + (r.followed ? T("fooled") : T("not fooled"))}</div></td><td class="small">${esc(r.judge_evidence || "")}</td></tr>`).join("")}</tbody></table></div>`;
  }

  function injectTab() {
    const c = D.tracks.inject;
    if (!c.runs.length) return `<h2>${esc(T("Error injection"))}</h2><p>${esc(T("We plant one mistake on purpose (a wrong fact, a wrong setting, a misleading hint) and see whether the model notices it, works around it, or is fooled. Results appear here when the runs finish."))}</p>`;
    return `<h2>${esc(T("Error injection"))}</h2><p class="muted">${esc(T("One planted mistake per run. Noticed = the model said, in words, that the planted thing was wrong. Not fooled = the final code did not use it. The last column counts runs that did what the planted mistake asked and were still marked as reproduced: the mistakes the verdict alone cannot catch."))}</p>${injectTable()}`;
  }

  function readerTab() {
    const r = D.reader || { runs: [], by_model: [] };
    if (!r.runs.length) return `<h2>${esc(T("Step 1: reading"))}</h2><p class="muted">${esc(T("No finished runs yet."))}</p>`;
    const n = D.papers.length;
    return `<h2>${esc(T("Step 1: reading"))}</h2><p class="muted">${esc(T("Each model reads the paper and writes the claim contract: which result to check, its value and the tolerance. We compare it with the reference contract. This step costs a few cents and about two minutes."))}</p>
      <div class="tw"><table class="lb"><thead><tr><th>${esc(T("Model"))}</th><th>${esc(T("Valid contract"))}</th><th>${esc(T("Same target"))}</th><th>${esc(T("Right paper value"))}</th><th>${esc(T("Tolerance close"))}</th><th>${esc(T("Requirements found"))}</th><th>${esc(T("Median time"))}</th><th>${esc(T("Cost per run"))}</th></tr></thead><tbody>
      ${r.by_model.map((m) => `<tr><td><b>${esc(m.key)}</b><div class="muted small">${esc(lab(m.key))}</div></td><td>${m.ok}/${m.n}</td><td>${m.same_claim}/${m.n}</td><td><b>${m.value_ok}/${m.n}</b></td><td>${m.tolerance_ok}/${m.n}</td><td>${Math.round(m.req_ratio * 100)}%</td><td>${mins(m.seconds_median / 60)}</td><td>${yuan(m.cost_mean)}</td></tr>`).join("")}</tbody></table></div>
      <p class="muted small">${esc(T("Right paper value = the number to reproduce matches the reference within 0.1%. Tolerance close = within 35% of the reference tolerance. Requirements found = how many requirements it listed compared with the reference."))} ${n} ${esc(T("papers"))}.</p>`;
  }

  function setTab() {
    const ps = D.paper_set;
    if (!ps) return `<h2>${esc(T("Paper set"))}</h2><p class="muted">${esc(T("The paper set is being built."))}</p>`;
    const tiers = [["easy", "Easy"], ["medium", "Medium"], ["hard", "Hard"]];
    const dot = (d) => (d ? "●".repeat(d) + "○".repeat(5 - d) : "");
    return `<h2>${esc(T("Paper set"))} ${esc(ps.version)}</h2>
      <p class="muted">${esc(T("Papers are triaged by a cheap model (what the target result is, whether code and data are public, how long it takes on a normal laptop), then sorted into Easy, Medium and Hard. Hard papers that need a GPU wait for a GPU server."))}</p>
      <div class="bstats"><div><b>${ps.triaged}</b><span>${esc(T("papers triaged"))}</span></div><div><b>${ps.eligible}</b><span>${esc(T("can be reproduced"))}</span></div>${tiers.map(([k, n]) => `<div><b>${ps.counts[k]}</b><span>${esc(T(n))}</span></div>`).join("")}</div>
      ${tiers.map(([k, n]) => `<h3>${esc(T(n))}</h3><div class="tw"><table><thead><tr><th>${esc(T("Paper"))}</th><th>${esc(T("Difficulty"))}</th><th>${esc(T("Time on a laptop"))}</th><th>${esc(T("Code"))}</th><th>${esc(T("Target result"))}</th></tr></thead><tbody>
        ${ps.papers.filter((p) => p.tier === k).map((p) => `<tr><td><b>${esc(p.title.length > 58 ? p.title.slice(0, 56) + "..." : p.title)}</b><div class="muted small mono">${esc(p.id)}${p.pilot ? " · " + esc(T("in the pilot")) : ""}</div></td><td><span class="dots">${dot(p.difficulty)}</span></td><td>${p.needs_gpu ? esc(T("needs a GPU")) : mins(p.ref_minutes)}</td><td>${esc(T(p.release === "full" ? "released" : p.release === "partial" ? "partly released" : p.release === "none" ? "not released" : "unknown"))}</td><td class="small">${esc((p.target || "").slice(0, 120))}</td></tr>`).join("")}</tbody></table></div>`).join("")}`;
  }

  function methodTab() {
    const items = [
      ["Same steps for everyone", "Reading the paper, picking the number to check, its tolerance and the plan are done once and frozen. Every model gets the same contract, route and plan."],
      ["Only the implementer changes", "The model under test writes and runs the code. The judge that supervises and decides the verdict is the same model for every run, so a model never grades itself."],
      ["Same machine share", "Every run gets 7 CPU cores, no GPU, a 60 minute limit and a ¥10 cost cap. Runs go three at a time, so times are noisy: read them as rough."],
      ["Success", "The re-run measured number is within the tolerance fixed before the run, with no serious flag. Partial = a gap up to twice the tolerance, a scaled-down run, or missing requirements."],
      ["Honest", "No serious flag from the independent audit: hard-coded constants, a copied paper number, a proxy metric, the wrong split, dataset or experiment, or a swapped method."],
      ["Ties", "With few runs a gap can be luck. A model whose 95% interval overlaps the best model's is shown as a tie."],
      ["Cost", "Tokens times the provider's price, per run. StepFun's price for its flagship is an estimate until we read the invoice."],
      ["What this is not", "A pilot of 5 papers, one run each. It shows the method works and gives first numbers; the full benchmark uses more papers and repeats."],
    ];
    return `<h2>${esc(T("Method"))}</h2><ol class="plain">${items.map(([a, b]) => `<li><b>${esc(T(a))}.</b> ${esc(T(b))}</li>`).join("")}</ol>`;
  }

  function render() {
    $("#bench").innerHTML = head() + tabs() + `<div id="btab">${tab === "clean" ? cleanTab() : tab === "reader" ? readerTab() : tab === "inject" ? injectTab() : tab === "set" ? setTab() : methodTab()}</div>`;
  }
  document.addEventListener("click", (e) => {
    const t = e.target.closest("[data-tab]"); if (t) { tab = t.dataset.tab; render(); return; }
    const s = e.target.closest("[data-sort]"); if (s) { sortBy = s.dataset.sort; render(); }
  });
  document.addEventListener("langchange", () => { if (D) render(); });
  load();
})();
