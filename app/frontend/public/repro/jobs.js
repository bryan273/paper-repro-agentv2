/* Runs made through "run it on your own agent": a list on the home page and one page per run
   (?job=<id>) with the full history, the result, the audit, the uploaded code and the first three steps.
   Everything is read from Supabase with the public key; nothing here can change a job. */
(function () {
  "use strict";
  const SB_URL = "https://vzvyghmtsakixlhzzuol.supabase.co";
  const SB_KEY = "sb_publishable_KMh-HF6q3wnJvux9OSes2g_XLtn2aBc";
  const NL = String.fromCharCode(10);
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const T = (s) => (window.t ? window.t(s) : s);
  const hdr = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY };
  const VERDICT = { reproduced: "Reproduced", partially_reproduced: "Partially reproduced", not_reproduced: "Not reproduced", could_not_run: "Could not run" };
  const STATUS = { waiting: "Waiting for an agent", running: "In progress", done: "Finished", failed: "Failed" };
  let timer = null;

  async function api(path) {
    const r = await fetch(`${SB_URL}/rest/v1/${path}`, { headers: hdr, cache: "no-store" });
    if (!r.ok) throw new Error(r.status);
    return r.json();
  }
  const ago = (iso) => {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    return s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : s < 129600 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 86400)} d`;
  };
  const clock = (iso) => new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const num = (x) => (typeof x === "number" ? (Math.abs(x) >= 100 ? x.toFixed(2) : x.toPrecision(4).replace(/0+$/, "").replace(/[.]$/, "")) : x == null ? "--" : esc(x));
  const pretty = (o) => JSON.stringify(o, null, 2);
  const badge = (v, st) => v ? `<span class="badge ${esc(v)}">${esc(T(VERDICT[v] || v))}</span>` : `<span class="badge ${st === "running" ? "running" : ""}">${esc(T(STATUS[st] || st || ""))}</span>`;

  // ------------------------------------------------------------------ home: list of runs
  async function loadList() {
    const box = $("#agentRuns");
    if (!box) return;
    try {
      const rows = await api("repro_jobs?select=id,arxiv_id,title,status,verdict,agent,model,requested_by,created_at,updated_at&agent=not.in.(viewer-steps-1-3,recorded-run-seed)&order=updated_at.desc&limit=20");
      $("#agentRunsSec").hidden = false;
      box.innerHTML = rows.map((r) => `<div class="runrow" data-job="${esc(r.id)}">
          <span class="t">${esc(r.title || r.arxiv_id)}</span>
          <span class="m">${badge(r.verdict, r.status)} ${esc(r.agent || "")}${r.model ? " · " + esc(r.model) : ""}${r.requested_by ? " · " + esc(r.requested_by) : ""} · ${esc(clock(r.created_at))}</span></div>`).join("");
      box.onclick = (e) => { const row = e.target.closest("[data-job]"); if (row) openJob(row.dataset.job); };
    } catch (e) { $("#agentRunsSec").hidden = true; }
  }

  // ------------------------------------------------------------------ one run
  function show(on) {
    $("#jobView").hidden = !on;
    if (on) { $("#home").hidden = true; $("#run").hidden = true; window.scrollTo(0, 0); }
  }
  function openJob(id) {
    clearInterval(timer);
    history.replaceState(null, "", `?job=${encodeURIComponent(id)}`);
    show(true);
    $("#jobBody").innerHTML = `<p class="muted small">${esc(T("Loading..."))}</p>`;
    render(id);
    timer = setInterval(() => render(id), 8000);
  }
  function closeJob() {
    clearInterval(timer);
    if ($("#jobView").hidden) return;
    $("#jobView").hidden = true;
    $("#home").hidden = false;
    history.replaceState(null, "", location.pathname);
    loadList();
  }

  const kv = (rows) => `<dl class="kv wide">${rows.filter((r) => r[1] != null && r[1] !== "").map(([k, v]) => `<dt>${esc(T(k))}</dt><dd>${v}</dd>`).join("")}</dl>`;
  const item = (x) => (typeof x === "string" ? x : x && (x.text || x.statement || x.description) ? (x.id ? x.id + ": " : "") + (x.text || x.statement || x.description) : pretty(x));
  const list = (a) => (a && a.length ? `<ul>${a.map((x) => `<li>${esc(item(x))}</li>`).join("")}</ul>` : "");

  function runInfoCard(j, ev, result) {
    const first = ev.find((e) => e.agent && e.agent !== "viewer-steps-1-3" && e.agent !== "recorded-run-seed" && !String(e.agent).startsWith("reused-from"));
    const info = (result && result.payload && result.payload.agent_info) || (ev.map((e) => e.payload && e.payload.agent_info).filter(Boolean)[0]) || {};
    const started = first ? first.created_at : null;
    const secs = started && result ? Math.round((new Date(result.created_at) - new Date(started)) / 1000) : null;
    const dur = secs == null ? "" : secs < 120 ? secs + " s" : Math.round(secs / 60) + " min";
    return `<section class="card"><h2 class="cardh">${esc(T("Who ran it"))}</h2>${kv([
      ["Agent app", esc(info.tool || j.agent || "")],
      ["Model", esc(j.model || info.model || T("not reported"))],
      ["Machine", esc([info.os, info.python ? "Python " + info.python : ""].filter(Boolean).join(" · "))],
      ["Requested by", esc(j.requested_by || "")],
      ["Link created", esc(clock(j.created_at))],
      ["Agent started", started ? esc(clock(started)) : ""],
      ["Result posted", result ? esc(clock(result.created_at)) : ""],
      ["Agent working time", esc(dur)],
    ])}</section>`;
  }

  function resultCard(res) {
    if (!res) return "";
    const p = res.payload || {};
    const gap = typeof p.measured === "number" && typeof p.paper_value === "number" ? p.measured - p.paper_value : null;
    const within = gap != null && typeof p.tolerance === "number" ? Math.abs(gap) <= p.tolerance : null;
    const reqs = Array.isArray(p.requirement_check) ? p.requirement_check : [];
    return `<section class="card"><h2 class="cardh">${esc(T("Result"))}</h2>
      ${kv([
        ["Verdict", badge(p.verdict)],
        ["Checked", esc(p.claim || "")],
        ["Paper value", num(p.paper_value)],
        ["Measured", num(p.measured)],
        ["Difference", gap == null ? "" : `${num(gap)} ${within == null ? "" : within ? `<span class="badge reproduced">${esc(T("within the band"))}</span>` : `<span class="badge not_reproduced">${esc(T("outside the band"))}</span>`}`],
        ["Tolerance", p.tolerance == null ? "" : `${num(p.tolerance)}${p.tolerance_rule ? ` (${esc(T("rule"))} ${esc(p.tolerance_rule)})` : ""}${p.contract_tolerance != null ? ` · ${esc(T("contract said"))} ${num(p.contract_tolerance)}` : ""}`],
        ["Scaled down", p.scaled_down == null ? "" : esc(p.scaled_down ? T("yes") : T("no"))],
        ["Flags", (p.flags || []).length ? esc(p.flags.join(", ")) : esc(T("none"))],
        ["Command", p.command ? `<code>${esc(p.command)}</code>` : ""],
        ["Run time", p.runtime_seconds != null ? esc(p.runtime_seconds) + " s" : ""],
        ["Posted", esc(clock(res.created_at))],
      ])}
      ${p.summary ? `<p class="jobsum">${esc(p.summary)}</p>` : ""}
      ${reqs.length ? `<details><summary>${esc(T("Requirement check"))} (${reqs.length})</summary><table class="jobtab"><tbody>${reqs.map((r) => `<tr><td><b>${esc(r.id)}</b></td><td>${esc(r.status)}</td><td>${esc(r.evidence || "")}</td></tr>`).join("")}</tbody></table></details>` : ""}
      ${(p.assumptions || []).length ? `<details><summary>${esc(T("Assumptions the agent made"))} (${p.assumptions.length})</summary>${list(p.assumptions)}</details>` : ""}
      ${p.clean_run_log_tail ? `<details><summary>${esc(T("End of the clean re-run log"))}</summary><pre class="jobpre">${esc(p.clean_run_log_tail)}</pre></details>` : ""}
      <details><summary>${esc(T("Everything the agent posted"))}</summary><pre class="jobpre">${esc(pretty(p))}</pre></details></section>`;
  }

  function auditCard(ev) {
    const a = ev.map((e) => e.payload && e.payload.audit).filter(Boolean).pop();
    const errs = ev.filter((e) => e.kind === "note" && e.payload && e.payload.step === "audit" && e.payload.error).length;
    if (!a) return `<section class="card"><h2 class="cardh">${esc(T("Independent audit"))}</h2><p class="muted small">${esc(errs ? T("The audit did not finish yet; the page asks again.") : T("Not done yet. It starts when the result is in."))}</p></section>`;
    const reqs = Array.isArray(a.requirement_check) ? a.requirement_check : [];
    return `<section class="card"><h2 class="cardh">${esc(T("Independent audit"))}</h2>
      ${kv([
        ["Flags", (a.flags || []).length ? esc(a.flags.join(", ")) : esc(T("none"))],
        ["Paper value written in the code", esc(a.paper_value_literal_in_code ? T("yes, a warning sign") : T("no"))],
        ["Code uploaded", esc(a.code_uploaded ? T("yes") : T("no"))],
        ["Right experiment", a.right_experiment == null ? "" : esc(a.right_experiment ? T("yes") : T("no"))],
        ["Scaled down", a.scaled_down == null ? "" : esc(a.scaled_down ? T("yes") : T("no"))],
      ])}
      <p class="jobsum">${esc(a.audit_summary || a.summary || a.notes || "")}</p>
      ${reqs.length ? `<details><summary>${esc(T("Requirement check"))} (${reqs.length})</summary><table class="jobtab"><tbody>${reqs.map((r) => `<tr><td><b>${esc(r.id)}</b></td><td>${esc(r.status)}</td><td>${esc(r.evidence || "")}</td></tr>`).join("")}</tbody></table></details>` : ""}</section>`;
  }

  function filesCard(ev) {
    const files = ev.filter((e) => e.kind === "file" && e.payload);
    if (!files.length) return "";
    return `<section class="card"><h2 class="cardh">${esc(T("Code the agent uploaded"))}</h2>${files.map((f, i) => `<details><summary><b>${esc(f.payload.name || "file")}</b> · ${esc(String((f.payload.content || "").length))} ${esc(T("characters"))}</summary>
        <button class="linkish" type="button" data-dl="${i}">${esc(T("Download"))}</button><pre class="jobpre">${esc(f.payload.content || "")}</pre></details>`).join("")}</section>`;
  }

  function stepsCard(ev) {
    const last = (k) => ev.filter((e) => e.kind === k).pop();
    const c = last("contract"), r = last("route"), pl = last("plan");
    if (!c && !r && !pl) return "";
    const cp = (c && c.payload) || {};
    const tgt = cp.match_target || cp.target;
    const claims = Array.isArray(cp.claims) ? cp.claims : [];
    return `<section class="card"><h2 class="cardh">${esc(T("Steps 1 to 3: what the agent was given"))}</h2>
      ${c ? `<details open><summary>${esc(T("Claim contract"))}${(cp.corrections || []).length ? ` · ${(cp.corrections || []).length} ${esc(T("corrections by the critic"))}` : ""}</summary>
        ${kv([["Paper", esc(cp.title || "")], ["Target", tgt ? esc(typeof tgt === "string" ? tgt : tgt.why || tgt.id || pretty(tgt)) : ""], ["Tolerance", cp.tolerance ? esc((cp.tolerance.type || "") + " " + (cp.tolerance.value ?? "")) + (cp.tolerance.why ? " · " + esc(cp.tolerance.why) : "") : ""]])}
        ${claims.length ? `<p class="small"><b>${esc(T("Claims"))}</b></p>${list(claims.map((x) => `${x.id || ""} ${x.statement || x.metric || ""} ${x.value != null ? "(" + x.value + ")" : ""}`))}` : ""}</details>` : ""}
      ${r ? `<details><summary>${esc(T("Route"))}</summary><pre class="jobpre">${esc(pretty(r.payload))}</pre></details>` : ""}
      ${pl ? `<details><summary>${esc(T("Plan"))}</summary><pre class="jobpre">${esc(pretty(pl.payload))}</pre></details>` : ""}</section>`;
  }

  function timelineCard(ev) {
    return `<section class="card"><h2 class="cardh">${esc(T("History"))} (${ev.length})</h2><div class="jobtl">${ev.slice().reverse().map((e) => {
      const p = e.payload || {};
      const txt = p.audit ? "Audit: " + ((p.audit.flags || []).length ? "flags " + p.audit.flags.join(", ") : "no flags") + ". " + (p.audit.audit_summary || p.audit.summary || "")
        : p.text || (e.kind === "file" ? (p.name || "file") + " (" + String((p.content || "").length) + " chars)" : e.kind === "result" ? (p.verdict || "") + " " + (p.summary || "") : e.kind === "contract" ? (p.title || "claim contract") : e.kind === "route" ? (p.why || "route") : e.kind === "plan" ? (p.approach || "plan") : pretty(p));
      return `<div class="jobev ${p.error ? "err" : ""}"><span class="mono">${esc(clock(e.created_at))}</span><span class="jk">${esc(e.kind)}</span><span class="ja">${esc(e.agent || "")}</span><span class="jx">${esc(String(txt).slice(0, 400))}</span></div>`;
    }).join("")}</div></section>`;
  }

  let lastEvents = [];
  async function render(id) {
    try {
      const [jr, ev] = await Promise.all([api(`repro_jobs?id=eq.${encodeURIComponent(id)}&select=*`), api(`repro_events?job_id=eq.${encodeURIComponent(id)}&select=id,kind,agent,created_at,payload&order=id`)]);
      const j = jr[0];
      if (!j) { $("#jobBody").innerHTML = `<p class="muted small">${esc(T("No such run."))}</p>`; clearInterval(timer); return; }
      lastEvents = ev;
      const result = ev.filter((e) => e.kind === "result").pop();
      const audited = ev.some((e) => e.payload && e.payload.audit);
      const idle = ev.length ? ago(ev[ev.length - 1].created_at) : "--";
      const live = j.status === "running" || (j.status === "done" && !audited);
      $("#jobBody").innerHTML = `<div class="runhead"><div class="rh-left"><div class="muted small mono">arXiv ${esc(j.arxiv_id)} · ${esc(T("run id"))} ${esc(j.id.slice(0, 8))}</div>
          <h1>${esc(j.title || j.arxiv_id)}</h1>
          <div class="badges">${badge(j.verdict, j.status)} ${j.agent && j.agent !== "viewer-steps-1-3" ? `<span class="badge">${esc(j.agent)}</span>` : ""}</div>
          <p class="muted small">${esc(T("Started"))} ${esc(clock(j.created_at))} · ${esc(T("last activity"))} ${esc(idle)} ${esc(T("ago"))}${live ? ` · <span class="jobpulse">${esc(T("updating"))}</span>` : ""}</p></div></div>
        ${runInfoCard(j, ev, result)}
        ${result ? resultCard(result) : `<section class="card"><h2 class="cardh">${esc(T("Result"))}</h2><p class="muted small">${esc(T(j.status === "waiting" ? "No agent has started on this run yet." : "The agent is still working. The history below updates by itself."))}</p></section>`}
        ${result ? auditCard(ev) : ""}${filesCard(ev)}${stepsCard(ev)}${timelineCard(ev)}`;
      if (!live) clearInterval(timer);
    } catch (e) { $("#jobBody").innerHTML = `<p class="muted small">${esc(T("Could not load this run:"))} ${esc(e.message)}</p>`; }
  }

  // ------------------------------------------------------------------ full history, grouped by day
  let H = { rows: [], q: "", verdict: "", agent: "", src: "" };
  const dayKey = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  function dayLabel(key) {
    const t = new Date(); const today = dayKey(t); t.setDate(t.getDate() - 1);
    if (key === today) return T("Today");
    if (key === dayKey(t)) return T("Yesterday");
    if (key === "0000") return T("Earlier sample runs");
    const [y, m, d] = key.split("-").map(Number);
    return new Date(y, m - 1, d).toLocaleDateString([], { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  }
  async function openHistory() {
    clearInterval(timer);
    history.replaceState(null, "", "?history=1");
    show(true);
    $("#jobBody").innerHTML = `<p class="muted small">${esc(T("Loading..."))}</p>`;
    try {
      const jobs = await api("repro_jobs?select=id,arxiv_id,title,status,verdict,agent,model,requested_by,created_at,updated_at&agent=not.in.(viewer-steps-1-3,recorded-run-seed)&order=created_at.desc&limit=500");
      let rec = [];
      try { rec = await (await fetch("demo-runs/index.json?v=" + Date.now(), { cache: "no-store" })).json(); } catch (e) {}
      const rows = jobs.map((r) => ({ kind: "job", id: r.id, when: new Date(r.created_at), title: r.title || r.arxiv_id, verdict: r.verdict, status: r.status, who: [r.agent, r.model, r.requested_by].filter(Boolean).join(" · "), agent: r.agent || "" }));
      for (const r of rec) {
        const m = String(r.id).match(/^([0-9]{4})([0-9]{2})([0-9]{2})-([0-9]{2})([0-9]{2})([0-9]{2})/);
        rows.push({ kind: "rec", id: r.id, file: r.file, pdf: r.pdf || "", when: m ? new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : null, title: r.title || r.paper, verdict: r.verdict, status: r.status,
          who: T("recorded run") + (r.seconds ? " · " + Math.round(r.seconds / 60) + " min" : ""), agent: "recorded run" });
      }
      rows.sort((a, b) => (b.when ? b.when.getTime() : 0) - (a.when ? a.when.getTime() : 0));
      H = { rows, q: "", verdict: "", agent: "", src: "" };
      const agents = Array.from(new Set(rows.map((r) => r.agent).filter(Boolean))).sort();
      $("#jobBody").innerHTML = `<div class="runhead"><div class="rh-left"><h1>${esc(T("Run history"))}</h1>
          <p class="muted small">${esc(T("Every run, newest first, grouped by day: runs on users' own agents and the recorded runs of the built-in agent."))}</p></div></div>
        <div class="card histf">
          <label>${esc(T("Paper or text"))}<input id="hq" type="search" autocomplete="off"></label>
          <label>${esc(T("Result"))}<select id="hv"><option value="">${esc(T("All results"))}</option>${Object.keys(VERDICT).map((k) => `<option value="${k}">${esc(T(VERDICT[k]))}</option>`).join("")}<option value="_open">${esc(T("Not finished"))}</option></select></label>
          <label>${esc(T("Agent"))}<select id="ha"><option value="">${esc(T("All agents"))}</option>${agents.map((a) => `<option>${esc(a)}</option>`).join("")}</select></label>
        </div><div id="histList"></div>`;
      const upd = () => { H.q = $("#hq").value.trim().toLowerCase(); H.verdict = $("#hv").value; H.agent = $("#ha").value; histRender(); };
      $("#hq").oninput = upd; $("#hv").onchange = upd; $("#ha").onchange = upd;
      histRender();
    } catch (e) { $("#jobBody").innerHTML = `<p class="muted small">${esc(T("Could not load the history:"))} ${esc(e.message)}</p>`; }
  }
  function histRender() {
    const rows = H.rows.filter((r) => (!H.q || (r.title + " " + r.who).toLowerCase().includes(H.q))
      && (!H.verdict || (H.verdict === "_open" ? !r.verdict : r.verdict === H.verdict)) && (!H.agent || r.agent === H.agent));
    const groups = new Map();
    for (const r of rows) { const k = r.when ? dayKey(r.when) : "0000"; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
    $("#histList").innerHTML = rows.length ? Array.from(groups).map(([k, g]) => {
      const c = {}; g.forEach((r) => { const v = r.verdict || "open"; c[v] = (c[v] || 0) + 1; });
      return `<section class="card histday"><h2 class="cardh">${esc(dayLabel(k))} <span class="muted small">· ${g.length} ${esc(T(g.length === 1 ? "run" : "runs"))}</span>
        <span class="histsum">${Object.entries(c).map(([v, n]) => `<span class="badge ${v === "open" ? "" : esc(v)}">${n} ${esc(T(VERDICT[v] || "in progress"))}</span>`).join(" ")}</span></h2>
        ${g.map((r) => `<div class="runrow" ${r.kind === "job" ? `data-job="${esc(r.id)}"` : `data-rec="${esc(r.file)}" data-pdf="${esc(r.pdf)}"`}>
          <span class="t"><span class="mono muted">${r.when ? esc(r.when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })) : "--:--"}</span> ${esc(r.title)}</span>
          <span class="m">${badge(r.verdict, r.status)} ${esc(r.who)}</span></div>`).join("")}</section>`;
    }).join("") : `<p class="muted small">${esc(T("No runs match."))}</p>`;
  }

  function init() {
    const sec = $("#jobView");
    if (!sec) return;
    $("#jobBack").onclick = closeJob;
    $("#homeBtn").addEventListener("click", closeJob);
    sec.addEventListener("click", (e) => {
      const d = e.target.closest("[data-dl]");
      if (!d) return;
      const f = lastEvents.filter((x) => x.kind === "file")[+d.dataset.dl];
      if (!f) return;
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([f.payload.content || ""], { type: "text/plain" }));
      a.download = f.payload.name || "file.txt"; a.click(); URL.revokeObjectURL(a.href);
    });
    window.openJob = openJob;
    sec.addEventListener("click", (e) => {
      const j = e.target.closest("#histList [data-job]");
      if (j) return openJob(j.dataset.job);
      const r = e.target.closest("#histList [data-rec]");
      if (r) location.href = "?replay=" + encodeURIComponent(r.dataset.rec) + (r.dataset.pdf ? "&pdf=" + encodeURIComponent(r.dataset.pdf) : "");
    });
    const hb = $("#historyBtn"); if (hb) hb.onclick = openHistory;
    loadList();
    const qs = new URLSearchParams(location.search), id = qs.get("job");
    if (id) setTimeout(() => openJob(id), 0);
    else if (qs.get("history")) setTimeout(openHistory, 0);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
