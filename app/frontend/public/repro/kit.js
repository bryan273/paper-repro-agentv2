/* "Run it on your own agent": turns the picked paper into a job on Supabase and a plain-text kit link.
   Any agent that can read a URL and run commands (Claude Code, Codex, a local agent) follows the kit,
   does the experiment on its owner's machine and posts progress and the result back to the job.
   Only public values live here: the project URL and the publishable (anon) key. The anon role can
   read jobs and call two functions (supabase/schema.sql); it holds no model key and no secret. */
(function () {
  "use strict";
  const SB_URL = "https://vzvyghmtsakixlhzzuol.supabase.co";
  const SB_KEY = "sb_publishable_KMh-HF6q3wnJvux9OSes2g_XLtn2aBc";
  const NL = String.fromCharCode(10);
  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const T = (s) => (window.t ? window.t(s) : s);
  const hdr = { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY };
  let pollTimer = null;

  async function rpc(name, body) {
    const r = await fetch(`${SB_URL}/rest/v1/rpc/${name}`, { method: "POST", headers: { ...hdr, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || r.status);
    return j;
  }

  function kitText(job, token, paper, title, lang, protocol) {
    const rest = `${SB_URL}/rest/v1/rpc/post_event`;
    const L = [];
    const p = (s) => L.push(s == null ? "" : s);
    p(`# Reproduction job: ${title || paper}`);
    p("");
    p(`You are an autonomous research engineer. Reproduce ONE quantitative result of a published paper on this machine, then report back.`);
    p(`Work end to end without asking the user questions. Take your time: a careful run is worth more than a fast one.`);
    p("");
    p("## Job");
    p("");
    p(`- Paper: ${paper}  (arXiv id, or a PDF URL; fetch the PDF yourself)`);
    p(`- Job id: ${job}`);
    p(`- Report language for summaries: ${lang === "zh" ? "Chinese (中文); keep code, file names and numbers as they are" : "English"}`);
    p(`- Hardware assumption: CPU only. Do not plan work that needs a GPU or days of training. If the paper needs one, scale down openly and say so.`);
    p("");
    p("## Ground rules (these are what make the result trustworthy)");
    p("");
    p("1. Decide what to check and its tolerance BEFORE you run anything (Reader rules below). Never change the tolerance after seeing a result.");
    p("2. Do not copy a number from the paper into code, config or output. Every reported number must come from code that ran.");
    p("3. If you scale the experiment down (fewer seeds, smaller data, fewer epochs), say so in the result and set scaled_down=true.");
    p("4. If you replace a core component of the method with something else, set the flag method_substituted.");
    p("5. Finish with a clean re-run: delete your results, then run ONE no-argument command (for example `python reproduce.py`) from scratch and use only that run's numbers.");
    p("6. Be honest about failure. 'not_reproduced' or 'could_not_run' with a clear reason is a good outcome; a faked match is not.");
    p("7. Use a fresh working folder for this job. Do not touch anything outside it. Never send secrets, API keys or personal files anywhere.");
    p("");
    p("## How to work");
    p("");
    p(`First look whether the viewer already did steps 1 to 3 for this job: GET ${SB_URL}/rest/v1/repro_events?job_id=eq.${job}&kind=in.(contract,route,plan)&select=kind,payload&order=id (header apikey: ${SB_KEY}). If a contract, route and plan are there, use them and start at role 4.`);
    p("");
    p("Play the five roles below in order. Each role has the exact instructions the hosted agent uses. Write the output of each role into your working folder (contract.json, route.json, plan.md, the code, then the verification), and post a short event after each step so the viewer shows progress.");
    p("");
    p(protocol.trim());
    p("");
    p("## Practical notes (learned from a real test run)");
    p("");
    p("- The contract, route and plan were written by a model that could not run anything. Treat them as a draft. If a number in them is wrong (a class balance, a dataset size, a filename), check it against the real data, write the correction in a progress event, and carry on. Do not fail a run because a draft check was wrong.");
    p("- If the contract's tolerance disagrees with the rule it names (for example rule 1 gives 3 x std but a wider band is written), the RULE wins. Use the rule's value for the verdict, say so in a progress event BEFORE you run, and also report the contract's value as contract_tolerance.");
    p("- verdict_ceiling in the route only matters if you really scale down. If you ran at full scale, ignore it.");
    p("- Datasets: if the GitHub API is rate limited, use raw.githubusercontent.com paths, a shallow `git clone --depth 1`, or a sparse checkout. Look for the exact file name before you assume one.");
    p("- Windows: use a SHORT working path (for example C:/w/job) so pip does not hit the long-path limit; set PYTHONIOENCODING=utf-8; open files with encoding='utf-8'. If a package will not install, write the small piece yourself (for example AUC) rather than giving up.");
    p("- Print progress while long steps run, and keep each command under a few minutes so you notice problems early.");
    p("");
    p("## Verdict");
    p("");
    p("Compute it from your numbers, not by feel. Let band be the tolerance from the claim contract and gap = |measured - paper value|.");
    p("- `reproduced`: gap is within band, the clean re-run succeeded, no scaled_down, no serious flag (hardcoded_constant, echoed_paper_number, proxy_metric, wrong_split, wrong_experiment, wrong_dataset, undisclosed_scale_down, method_substituted).");
    p("- `partially_reproduced`: gap is up to 2 x band, or the run was scaled down, or the match target was reached but other requirements are missing.");
    p("- `not_reproduced`: a faithful run finished but the gap is larger than 2 x band, or a serious flag applies.");
    p("- `could_not_run`: you could not get a faithful run at all (data unavailable, code cannot be ported, out of compute). Say what blocked you.");
    p("");
    p("## Reporting back");
    p("");
    p(`Send events to the job with an HTTP POST. kind is one of: contract, route, plan, progress, note, result. The token below belongs to this job only.`);
    p("");
    p("```bash");
    p(`curl -s -X POST '${rest}' \\`);
    p(`  -H 'apikey: ${SB_KEY}' -H 'Content-Type: application/json' \\`);
    p(`  -d '{"p_job":"${job}","p_token":"${token}","p_kind":"progress","p_agent":"<your agent name>","p_payload":{"text":"what you just did"}}'`);
    p("```");
    p("");
    p("From Python (no extra packages):");
    p("");
    p("```python");
    p("import json, urllib.request");
    p("def post(kind, payload, agent='my-agent'):");
    p(`    body = json.dumps({'p_job': '${job}', 'p_token': '${token}', 'p_kind': kind, 'p_payload': payload, 'p_agent': agent}).encode()`);
    p(`    req = urllib.request.Request('${rest}', body, {'apikey': '${SB_KEY}', 'Content-Type': 'application/json'})`);
    p("    return urllib.request.urlopen(req, timeout=60).read()");
    p("```");
    p("");
    p("Post these, in this order (the payload is free-form JSON, keep it under 300 KB):");
    p("");
    p("1. `contract` after the Reader: the claim contract JSON.");
    p("2. `route` after the Router, `plan` after the Planner.");
    p("3. `progress` now and then while implementing: what you ran, what you saw, what you will try next.");
    p("4. `result` ONCE at the end, with this shape:");
    p("");
    p("```json");
    p("{");
    p('  "verdict": "reproduced | partially_reproduced | not_reproduced | could_not_run",');
    p('  "claim": "the exact result you tried to reproduce (table, dataset, metric)",');
    p('  "paper_value": 0.0, "measured": 0.0, "tolerance": 0.0, "tolerance_rule": 1, "contract_tolerance": null,');
    p('  "scaled_down": false, "flags": [],');
    p('  "command": "the one command that re-creates the number",');
    p('  "runtime_seconds": 0,');
    p('  "requirement_check": [{"id": "R1", "status": "met | partial | missing", "evidence": "..."}],');
    p('  "assumptions": ["each detail the paper left open and what you chose"],');
    p('  "summary": "3 to 6 sentences a researcher would find useful, including why numbers differ if they do"');
    p("}");
    p("```");
    p("");
    p("When the result is posted, tell your user the verdict and the value in one or two sentences. The viewer shows the run on the job page.");
    return L.join(NL) + NL;
  }

  async function makeKit(withSteps) {
    const out = $("#kitOut");
    const paper = ($("#paperId").value || "").trim();
    if (!paper) { out.innerHTML = `<p class="muted small">${esc(T("Pick a paper first."))}</p>`; return; }
    const title = ($("#pickedTitle").textContent || "").trim();
    const lang = window.getLang ? window.getLang() : "en";
    $("#kitBtn").disabled = true;
    out.innerHTML = `<p class="muted small">${esc(T("Preparing the kit..."))}</p>`;
    try {
      const protocol = await (await fetch("kit-protocol.md?v=20261016d", { cache: "no-store" })).text();
      const j = await rpc("create_job", { p_arxiv: paper, p_title: title, p_lang: lang });
      const text = kitText(j.id, j.token, paper, title, lang, protocol);
      const up = await fetch(`${SB_URL}/storage/v1/object/kits/${j.id}.md`, { method: "POST", headers: { ...hdr, "Content-Type": "text/markdown" }, body: text });
      if (!up.ok) throw new Error("upload " + up.status);
      const link = `${SB_URL}/storage/v1/object/public/kits/${j.id}.md`;
      const prompt = `Read ${link} and do the job it describes, end to end.`;
      out.innerHTML = `<div class="kitlink"><label>${esc(T("Kit link"))}<input readonly value="${esc(link)}" id="kitLink"></label>
          <div class="kitbtns"><button class="ghost" type="button" data-copy="${esc(link)}">${esc(T("Copy the link"))}</button>
          <button class="ghost" type="button" data-copy="${esc(prompt)}">${esc(T("Copy as a prompt"))}</button>
          <a class="ghost" href="${esc(link)}" target="_blank" rel="noopener">${esc(T("Open the kit"))}</a></div>
          <p class="muted small">${esc(T("Paste it into Claude Code, Codex or any agent that can read a URL and run commands. It does the experiment on your machine and posts the result back here."))}</p>
          <div id="kitStatus" class="kitstatus"></div></div>`;
      if (withSteps === true) runSteps(j.id, j.token, paper, lang);
      watch(j.id);
    } catch (e) {
      out.innerHTML = `<p class="muted small">${esc(T("Could not prepare the kit:"))} ${esc(e.message)}</p>`;
    } finally { $("#kitBtn").disabled = false; }
  }


  // Reader, Router and Planner run one after the other: each is its own short request on the server,
  // and the next starts when the previous one has posted its event.
  async function runSteps(job, token, paper, lang) {
    const want = { reader: "contract", router: "route", planner: "plan" };
    for (const step of ["reader", "router", "planner"]) {
      const r = await fetch(`${SB_URL}/functions/v1/run-steps`, { method: "POST", headers: { ...hdr, "Content-Type": "application/json" },
        body: JSON.stringify({ job, token, paper, lang, step }) });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        const box = $("#kitStatus");
        if (box) box.insertAdjacentHTML("afterbegin", `<div class="muted small">${esc(T("Steps 1 to 3 could not start:"))} ${esc(e.error || r.status)}</div>`);
        return;
      }
      let ok = false;
      for (let i = 0; i < 60 && !ok; i++) {
        await new Promise((res) => setTimeout(res, 4000));
        try {
          const ev = await (await fetch(`${SB_URL}/rest/v1/repro_events?job_id=eq.${job}&kind=in.(${want[step]},note)&select=kind,payload&order=id.desc&limit=3`, { headers: hdr })).json();
          if (ev.some((x) => x.kind === want[step])) ok = true;
          else if (ev.some((x) => x.kind === "note" && x.payload && x.payload.error && x.payload.step === step)) return;
        } catch (e) {}
      }
      if (!ok) return;
    }
  }

  async function watch(job) {
    clearInterval(pollTimer);
    async function tick() {
      const box = $("#kitStatus");
      if (!box) return clearInterval(pollTimer);
      try {
        const [jr, er] = await Promise.all([
          fetch(`${SB_URL}/rest/v1/repro_jobs?id=eq.${job}&select=status,verdict,agent`, { headers: hdr }).then((r) => r.json()),
          fetch(`${SB_URL}/rest/v1/repro_events?job_id=eq.${job}&select=kind,agent,payload,created_at&order=id.desc&limit=8`, { headers: hdr }).then((r) => r.json())]);
        const s = jr[0] || {};
        const names = { waiting: "Waiting for an agent to pick it up", running: "An agent is working on it", done: "Finished", failed: "Failed" };
        let html = `<div><b>${esc(T(names[s.status] || "Waiting for an agent to pick it up"))}</b>${s.agent ? ` · ${esc(s.agent)}` : ""}${s.verdict ? ` · <span class="badge ${esc(s.verdict)}">${esc(T({ reproduced: "Reproduced", partially_reproduced: "Partially reproduced", not_reproduced: "Not reproduced", could_not_run: "Could not run" }[s.verdict] || s.verdict))}</span>` : ""}</div>`;
        html += er.slice().reverse().map((e) => {
          const p = e.payload || {};
          const txt = p.text || p.summary || p.claim || (p.verdict ? p.verdict : "") || "";
          return `<div class="muted small"><span class="mono">${esc(e.kind)}</span> ${esc(String(txt).slice(0, 220))}</div>`;
        }).join("");
        box.innerHTML = html;
        if (s.status === "done" || s.status === "failed") clearInterval(pollTimer);
      } catch (e) {}
    }
    tick();
    pollTimer = setInterval(tick, 8000);
  }

  function init() {
    const host = $("#kitBox");
    if (!host) return;
    host.innerHTML = `<h3 class="kith">${esc(T("Run it on your own agent"))}</h3>
      <p class="muted small">${esc(T("Get a link that holds the full instructions. Give it to any agent; the run happens on your own machine."))}</p>
      <div class="kitbtns"><button class="ghost" type="button" id="stepsBtn">${esc(T("Run steps 1 to 3 here first"))}</button>
      <button class="primary" type="button" id="kitBtn">${esc(T("Make the link"))}</button></div><div id="kitOut"></div>`;
    $("#stepsBtn").onclick = () => makeKit(true);
    $("#kitBtn").onclick = makeKit;
    host.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-copy]");
      if (!b) return;
      try { await navigator.clipboard.writeText(b.dataset.copy); b.textContent = T("Copied"); }
      catch (x) { const i = $("#kitLink"); if (i) { i.select(); } }
    });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
