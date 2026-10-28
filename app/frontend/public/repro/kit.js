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

  function kitText(job, token, paper, title, lang, protocol, by, limit, probe, compute) {
    const rest = `${SB_URL}/rest/v1/rpc/post_event`;
    const L = [];
    const p = (s) => L.push(s == null ? "" : s);
    p(`# Reproduction job: ${title || paper}`);
    p("");
    p(`You are an autonomous research engineer. Reproduce ONE quantitative result of a published paper on this machine, then report back.`);
    p(`Work end to end without asking the user questions. Be careful, but stay inside the time limit (${limit} minutes, see Step 0): an honest partial result beats a run that never ends.`);
    p("");
    p("## Job");
    p("");
    p(`- Paper: ${paper}  (arXiv id, or a PDF URL; fetch the PDF yourself)`);
    p(`- Job id: ${job}`);
    if (by) p(`- Requested by: ${by}`);
    const repo = ($("#repoIn") && $("#repoIn").value || "").trim(), hint = ($("#hintIn") && $("#hintIn").value || "").trim();
    if (repo) p(`- Code repository the user points to: ${repo}`);
    if (hint) p(`- Result the user wants checked (honour it when choosing the match target): ${hint}`);
    p(`- Report language for summaries: ${lang === "zh" ? "Chinese (中文); keep code, file names and numbers as they are" : "English"}`);
    p(`- Time limit: ${limit} minutes in total, from when you start.`);
    p(`- Hardware: not known in advance. Step 0 measures it. Do not plan work that needs more than the machine has; scale down openly and say so, or stop early (Step 0 says when).`);
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
    p("## Step 0: check this machine and the clock (do this first, about a minute)");
    p("");
    p(`This job has a hard time limit of ${limit} minutes from the moment you start. Write down the start time now (run \`date\` or print time.time()) and check how much time has passed before every command that could take more than two minutes.`);
    p("");
    p("1. Save the script below as probe.py in your working folder and run it: `python probe.py`. It prints this machine (CPU cores, memory, free disk, GPU if any) and how fast the CPU and GPU are. It needs only Python; numpy and torch make the speed numbers better.");
    if (compute) p(`2. The needs of this paper were worked out already. Save this as compute.json and run \`python probe.py compute.json ${limit}\`:

   \`${JSON.stringify(compute)}\`

   The output adds an estimate and a \`decision\`:`);
    else p(`2. Get the route of this job: GET ${SB_URL}/rest/v1/repro_events?job_id=eq.${job}&kind=eq.route&select=payload&order=id.desc&limit=1 (header apikey: ${SB_KEY}). If its payload has a \`compute\` object, save that object as compute.json and run \`python probe.py compute.json ${limit}\`. The output adds an estimate and a \`decision\`:`);
    p("   - `go`: start.");
    p("   - `go_with_checkpoints`: start, but save partial results early.");
    p("   - `scale_down`: shrink the protocol (fewer seeds or splits, a smaller subset, fewer epochs) until it fits, and set scaled_down=true in the result.");
    p("   - `stop_too_big`: do NOT download or run anything big. Post a `result` with verdict could_not_run and the `why` text as the reason. This is a good outcome: the user learns early that this machine cannot do it.");
    p("   If there is no compute information, skip the estimate, but still use the clock below.");
    p("3. Post the printed JSON as your first progress event: payload {\"machine\": ..., \"estimate\": ..., \"decision\": ...}.");
    p("");
    p(`The clock: at half of the limit (${Math.round(limit / 2)} minutes) post a progress event with what you have so far. At 90% (${Math.round(limit * 0.9)} minutes) stop starting experiments: do the clean re-run on what you have and post the result (partially_reproduced with scaled_down=true, or could_not_run). Never run past ${limit} minutes. An honest partial result is worth far more than a run that never ends.`);
    p("");
    p("```python");
    p(probe.trim());
    p("```");
    p("");
    p("## How to work");
    p("");
    p(`First look whether the viewer already did steps 1 to 3 for this job: GET ${SB_URL}/rest/v1/repro_events?job_id=eq.${job}&kind=in.(contract,route,plan)&select=kind,payload&order=id (header apikey: ${SB_KEY}). Use whatever is there: if all three exist, start at role 4; if some are missing, do only the missing roles yourself (briefly) and still post them.`);
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
    p("- The draft contract can misread the paper: check every assumption against the paper's own words (for example a hidden size, a split, a learning rate) and use the paper's reading when they differ. Say what you changed in the result.");
    p("- A validation split that the draft mentions may not exist in the released data. If only train and test are shipped, hold out part of train for any model selection, then retrain on all of train. Never select on the test set.");
    p("- Prefer a prebuilt pip wheel over compiling C or C++ code (for example fasttext-wheel instead of building fastText with make), and say which you used. If the authors' own code builds and runs, run it rather than rewriting it.");
    p("- Write code to files with your editor tool, not through shell heredocs: a heredoc can strip backslashes and break regular expressions and Windows paths.");
    p("- If the final number comes from several trainings or seeds, report the mean in measured and every single value in the summary or metrics file.");
    p("- If a prebuilt package crashes at run time (for example after a major NumPy upgrade), pin the older compatible version of the dependency and say so.");
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
    p("Say who is running this, so every run of this paper can be told apart later: use your tool name as `p_agent` in every call, and put `agent_info` (tool, exact model name, operating system, Python version) in your FIRST progress event and again in the result. If you do not know your model name, write unknown; never guess.");
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
    p('  "agent_info": {"tool": "the app you are, e.g. Claude Code, Codex, WorkBuddy", "model": "the exact model name you run on, or unknown", "os": "...", "python": "..."},');
    p('  "machine": "the JSON printed by probe.py in Step 0 (cpu_cores, ram_gb, gpu, cpu_gflops, ...)", "elapsed_minutes": 0, "time_limit_min": ' + limit + ',');
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
    p("Before the result, upload the code that produced the number, so it can be audited: post one `file` event per important source file (at most 15 KB each; the main one is the file your single command runs), payload `{\"name\": \"reproduce.py\", \"content\": \"...the file text...\"}`. Put the last 40 lines of the clean re-run output in the result as `clean_run_log_tail`.");
    p("");
    p("After the result is posted, ask the viewer to audit it (a second model reads your code, log and numbers; it takes about 30 seconds and its findings appear next to your result). The call only starts the audit; read the job events a minute later. If the newest note says the audit stopped with an error, call it again, up to three times:");
    p("");
    p("```bash");
    p(`curl -s -X POST '${SB_URL}/functions/v1/run-steps' \\`);
    p(`  -H 'apikey: ${SB_KEY}' -H 'Content-Type: application/json' \\`);
    p(`  -d '{"job":"${job}","token":"${token}","paper":"${paper}","lang":"${lang}","step":"audit"}'`);
    p("```");
    p("");
    p("When the result is posted, tell your user the verdict and the value in one or two sentences. The viewer shows the run on the job page.");
    return L.join(NL) + NL;
  }

  const STAGES = [["reader", "Reader"], ["critic", "Critic"], ["router", "Router"], ["planner", "Planner"], ["publish", "Publishing the link"]];
  function barHtml() {
    return `<div class="pbar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>
      <ol class="psteps">${STAGES.map(([k, n]) => `<li data-k="${k}"><span class="dot"></span>${esc(T(n))}</li>`).join("")}</ol>`;
  }
  // stage state: "now" (running), "done", "retry"; the bar fills as stages finish
  function setStage(k, state) {
    const box = $(".pbar"); if (!box) return;
    const items = Array.from(document.querySelectorAll(".psteps li"));
    const idx = items.findIndex((li) => li.dataset.k === k);
    items.forEach((li, i) => { li.className = i < idx ? "done" : i === idx ? (state === "done" ? "done" : state === "retry" ? "now retry" : "now") : ""; });
    const pct = Math.round(((idx + (state === "done" ? 1 : 0.35)) / items.length) * 100);
    box.querySelector("i").style.width = pct + "%"; box.setAttribute("aria-valuenow", String(pct));
    box.classList.toggle("busy", state !== "done");
  }

  async function makeKit(mode) {
    // mode: "auto" (reuse earlier steps 1 to 3 of this paper, else run them), "fresh" (run them again), "skip" (the user's agent does them)
    mode = typeof mode === "string" ? mode : "auto";
    const out = $("#kitOut");
    let paper = ($("#paperId").value || "").trim();
    if (!paper) {
      // an uploaded PDF has no id: use the arXiv number in its file name (2312.15235v1.pdf), else ask for the id or link
      const fm = (($("#pickedFile") && $("#pickedFile").textContent) || "").match(/(\d{4}\.\d{4,5})(v\d+)?/);
      if (fm) { paper = fm[1]; $("#paperId").value = paper; }
    }
    if (!paper) {
      const lab = $("#paperId").closest("label"); if (lab) lab.hidden = false;
      out.innerHTML = `<p class="small" style="color:var(--bad,#b3261e)">${esc(T("Your own agent needs an arXiv ID or a PDF link, not an uploaded file. Paste it in the Paper box above, then press the button again."))}</p>`;
      $("#paperId").focus(); return;
    }
    const title = ($("#pickedTitle").textContent || "").trim();
    const lang = window.getLang ? window.getLang() : "en";
    Array.from(document.querySelectorAll("#kitBtns button")).forEach((x) => (x.disabled = true));
    out.innerHTML = `<p class="muted small">${esc(T("Preparing the kit..."))}</p>`;
    try {
      const protocol = await (await fetch("kit-protocol.md?v=20261020a", { cache: "no-store" })).text();
      const probe = await (await fetch("kit-probe.py?v=20261020a", { cache: "no-store" })).text();
      const limit = Math.max(10, Math.min(480, parseInt(($("#kitLimit") && $("#kitLimit").value) || "60", 10) || 60));
      try { localStorage.setItem("kitLimit", String(limit)); } catch (e) {}
      const by = (($("#kitBy") && $("#kitBy").value) || "").trim();
      try { localStorage.setItem("kitBy", by); } catch (e) {}
      const j = await rpc("create_job", { p_arxiv: paper, p_title: title, p_lang: lang, p_by: by });
      let reused = null, stepsOk = true;
      if (mode === "auto") { try { reused = await rpc("reuse_steps", { p_job: j.id, p_token: j.token }); } catch (e) { reused = null; } }
      if (mode === "fresh" || (mode === "auto" && !(reused && reused.reused))) {
        out.innerHTML = `<div class="kitlink"><p class="muted small">${esc(T("Running steps 1 to 3 on the server. The link appears when they are done (about 2 minutes)."))}</p>${barHtml()}<div id="kitStatus" class="kitstatus"></div></div>`;
        watch(j.id, null);
        stepsOk = await runSteps(j.id, j.token, paper, lang, setStage);
      } else if (mode === "auto") {
        out.innerHTML = `<div class="kitlink"><p class="muted small">${esc(T("Reusing the earlier steps 1 to 3 of this paper"))}</p>${barHtml()}</div>`;
        setStage("planner", "done");
      }
      setStage("publish", "now");
      let compute = null;   // the Router's compute numbers, or the measured ones for a paper we have run; shown as the machine-fit card
      try {
        const rt = await (await fetch(`${SB_URL}/rest/v1/repro_events?job_id=eq.${j.id}&kind=eq.route&select=payload&order=id.desc&limit=1`, { headers: hdr })).json();
        compute = rt[0] && rt[0].payload && rt[0].payload.compute || null;
        if (!compute) { const k = await (await fetch("compute.json?v=20261020a", { cache: "no-store" })).json(); compute = k[paper] && k[paper].compute || null; }
        if (window.fitShow) window.fitShow(paper, compute, true);
      } catch (e) {}
      const text = kitText(j.id, j.token, paper, title, lang, protocol, by, limit, probe, compute);
      const up = await fetch(`${SB_URL}/storage/v1/object/kits/${j.id}.md`, { method: "POST", headers: { ...hdr, "Content-Type": "text/markdown" }, body: text });
      if (!up.ok) throw new Error("upload " + up.status);
      const link = `${SB_URL}/storage/v1/object/public/kits/${j.id}.md`;
      const prompt = `Read ${link} and do the job it describes, end to end.`;
      const note = mode === "skip" ? T("Steps 1 to 3 are left to your agent.")
        : reused && reused.reused ? `${T("Steps 1 to 3 were reused from an earlier run of this paper")} (${esc(String(reused.at || "").slice(0, 10))}).`
        : stepsOk ? T("Steps 1 to 3 are done.") : T("Steps 1 to 3 did not finish; your agent will do the missing ones.");
      out.innerHTML = `<div class="kitlink"><p class="small"><b>${note}</b>${reused && reused.reused ? ` <button class="linkish" type="button" id="rerunSteps">${esc(T("Run steps 1 to 3 again"))}</button>` : ""}</p>
          <label>${esc(T("Paste this into your agent"))}<textarea readonly rows="3" id="kitPrompt" class="kitprompt">${esc(prompt)}</textarea></label>
          <div class="kitbtns"><button class="primary" type="button" data-copy-from="kitPrompt">${esc(T("Copy this prompt"))}</button>
          <button class="ghost" type="button" data-copy-from="kitLink">${esc(T("Copy only the link"))}</button>
          <a class="ghost" href="${esc(link)}" target="_blank" rel="noopener">${esc(T("Open the kit"))}</a></div>
          <label class="muted small">${esc(T("Kit link"))}<input readonly value="${esc(link)}" id="kitLink"></label>
          <p class="muted small">${esc(T("Paste it into Claude Code, Codex or any agent that can read a URL and run commands. It does the experiment on your machine and posts the result back here."))}</p>
          <div id="kitStatus" class="kitstatus"></div></div>`;
      const rr = $("#rerunSteps"); if (rr) rr.onclick = () => makeKit("fresh");
      watch(j.id, { token: j.token, paper, lang, tries: 0, last: Date.now() - 30000 });
    } catch (e) {
      out.innerHTML = `<p class="muted small">${esc(T("Could not prepare the kit:"))} ${esc(e.message)}</p>`;
    } finally { Array.from(document.querySelectorAll("#kitBtns button")).forEach((x) => (x.disabled = false)); }
  }

  // Reader, Router and Planner run one after the other: each is its own short request on the server,
  // and the next starts when the previous one has posted its event.
  async function runSteps(job, token, paper, lang, onStage) {
    const on = onStage || (() => {});
    const want = { reader: "contract", critic: "contract", router: "route", planner: "plan" };
    const maxId = async () => {
      try {
        const r = await (await fetch(`${SB_URL}/rest/v1/repro_events?job_id=eq.${job}&select=id&order=id.desc&limit=1`, { headers: hdr })).json();
        return r.length ? r[0].id : 0;
      } catch (e) { return 0; }
    };
    for (const step of ["reader", "critic", "router", "planner"]) {
     let done = false;
     // a step is tried up to three times: the model gateway now and then says nothing for a minute
     for (let attempt = 0; attempt < 3 && !done; attempt++) {
      const last = await maxId();
      on(step, attempt ? "retry" : "now");
      const r = await fetch(`${SB_URL}/functions/v1/run-steps`, { method: "POST", headers: { ...hdr, "Content-Type": "application/json" },
        body: JSON.stringify({ job, token, paper, lang, step }) });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        const box = $("#kitStatus");
        if (box) box.insertAdjacentHTML("afterbegin", `<div class="muted small">${esc(T("Steps 1 to 3 could not start:"))} ${esc(e.error || r.status)}</div>`);
        return false;
      }
      let ok = false, failed = false;
      for (let i = 0; i < 45 && !ok && !failed; i++) {
        await new Promise((res) => setTimeout(res, 4000));
        try {
          const ev = await (await fetch(`${SB_URL}/rest/v1/repro_events?job_id=eq.${job}&id=gt.${last}&kind=in.(${want[step]},note)&select=kind,payload&order=id.desc&limit=3`, { headers: hdr })).json();
          if (ev.some((x) => x.kind === want[step])) ok = true;
          else if (ev.some((x) => x.kind === "note" && x.payload && x.payload.error && x.payload.step === step)) failed = true;
        } catch (e) {}
      }
      if (ok) { done = true; on(step, "done"); }
      else await new Promise((res) => setTimeout(res, 3000));
     }
     if (!done) return false;
    }
    return true;
  }

  async function watch(job, ctx) {
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
          const au = p.audit;
          const txt = au ? `${T("Audit")}: ${au.paper_value_literal_in_code ? T("paper value found in the code") + ". " : ""}${(au.flags || []).length ? T("flags") + " " + au.flags.join(", ") + ". " : T("no flags") + ". "}${au.audit_summary || au.summary || ""}`
            : p.text || p.summary || p.claim || (p.verdict ? p.verdict : "") || "";
          return `<div class="muted small"><span class="mono">${esc(e.kind)}</span> ${esc(String(txt).slice(0, 220))}</div>`;
        }).join("");
        html += `<div><button class="linkish" type="button" data-openjob="${job}">${esc(T("Open the full run page (history, result, code)"))}</button></div>`;
        box.innerHTML = html;
        // the page asks for the audit itself when a result is in, and again if the model gateway let it down
        if (s.status === "done" && ctx) {
          const audits = er.filter((e) => e.payload && e.payload.audit);
          const errs = er.filter((e) => e.kind === "note" && e.payload && e.payload.error && e.payload.step === "audit");
          const now = Date.now();
          if (!audits.length && ctx.tries < 3 && now - ctx.last > 60000) {
            ctx.tries += 1; ctx.last = now;
            fetch(`${SB_URL}/functions/v1/run-steps`, { method: "POST", headers: { ...hdr, "Content-Type": "application/json" },
              body: JSON.stringify({ job, token: ctx.token, paper: ctx.paper, lang: ctx.lang, step: "audit" }) }).catch(() => {});
          }
          if (audits.length || (ctx.tries >= 3 && errs.length >= 3 && now - ctx.last > 60000)) clearInterval(pollTimer);
        } else if (s.status === "failed") clearInterval(pollTimer);
      } catch (e) {}
    }
    tick();
    pollTimer = setInterval(tick, 8000);
  }

  // buttons depend on the paper: one already reproduced has stored steps 1 to 3 to reuse; a new one must run them first
  function setState(reproduced) {
    const box = $("#kitBtns"), out = $("#kitOut");
    if (!box) return;
    clearInterval(pollTimer);
    if (out) out.innerHTML = "";
    box.innerHTML = reproduced
      ? `<button class="primary" type="button" id="stepsBtn">${esc(T("Get the link now (uses the saved steps 1 to 3)"))}</button>
         <button class="ghost" type="button" id="freshBtn">${esc(T("Read and plan the paper again first (about 2 minutes)"))}</button>`
      : `<button class="primary" type="button" id="stepsBtn">${esc(T("Get the link (reads and plans the paper first, about 2 minutes)"))}</button>`;
    $("#stepsBtn").onclick = () => makeKit("auto");
    const f = $("#freshBtn"); if (f) f.onclick = () => makeKit("fresh");
  }
  window.kitSetState = setState;

  function init() {
    const host = $("#kitBox");
    if (!host) return;
    host.innerHTML = `<h3 class="kith">${esc(T("Run it on your own agent"))}</h3>
      <p class="muted small">${esc(T("We read and plan the paper for you. You then get one link to paste into any agent. The experiment runs on your own machine."))}</p>
      <div class="kitopts"><label class="kitby">${esc(T("Your name (optional, shown on the run)"))}<input id="kitBy" maxlength="80" autocomplete="name"></label>
      <label class="kitby">${esc(T("Time limit for the agent"))}<select id="kitLimit"><option value="30">30 ${esc(T("minutes"))}</option><option value="60">60 ${esc(T("minutes"))}</option><option value="120">120 ${esc(T("minutes"))}</option><option value="240">240 ${esc(T("minutes"))}</option></select></label></div>
      <div class="kitbtns" id="kitBtns"></div><div id="kitOut"></div>`;
    try { $("#kitBy").value = localStorage.getItem("kitBy") || ""; $("#kitLimit").value = localStorage.getItem("kitLimit") || "60"; } catch (e) {}
    setState(false);
    host.addEventListener("click", (e) => {
      const oj = e.target.closest("[data-openjob]");
      if (oj && window.openJob) { window.openJob(oj.dataset.openjob); return; }
      const el = e.target.closest("textarea.kitprompt, #kitLink");
      if (el) { el.select(); return; }
      const b = e.target.closest("[data-copy-from]");
      if (!b) return;
      const src = document.getElementById(b.dataset.copyFrom);
      if (src) copyText(src.value, src, b);
    });
  }

  // Copy that also works inside an embedded page, where the clipboard API can be blocked:
  // try it first, fall back to a selected text field and the old copy command, and always select the text
  async function copyText(text, field, btn) {
    const label = btn.textContent;
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {}
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text; ta.setAttribute("readonly", ""); ta.style.cssText = "position:fixed;top:0;left:0;opacity:0";
        document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
        ok = document.execCommand("copy"); ta.remove();
      } catch (e) {}
    }
    field.focus(); field.select();   // so Ctrl+C works even if both ways were blocked
    btn.textContent = ok ? T("Copied") : T("Press Ctrl+C to copy");
    setTimeout(() => { btn.textContent = label; }, 2500);
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init); else init();
})();
