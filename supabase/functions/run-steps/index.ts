// Steps 1 to 3 (Reader, Router, Planner) of the Paper Repro Agent, run on Supabase so the viewer needs
// no runner. The model key is a secret of this function (PARATERA_API_KEY) and never reaches a browser.
// It does no code execution: the experiment (step 4) is done by the user's own agent from the kit link,
// and picks up the contract, route and plan this function posts to the job.
//
// POST { job, token, paper, lang }  ->  202 at once; progress and results arrive as repro_events.
import prompts from "./prompts.json" with { type: "json" };
import { extractText, getDocumentProxy } from "https://esm.sh/unpdf@0.12.1";

const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
// Any OpenAI-compatible provider. The model of a step is a secret of this function, so it can be changed without a deploy:
// REPRO_MODEL_<STEP> (READER, CRITIC, ROUTER, PLANNER, AUDIT) or REPRO_MODEL, written "provider:model" or just "model" (Paratera).
const PROVIDERS: Record<string, { base: string; key: string }> = {
  paratera: { base: Deno.env.get("PARATERA_BASE_URL") ?? "https://llmapi.paratera.com/v1", key: "PARATERA_API_KEY" },
  stepfun: { base: "https://api.stepfun.com/v1", key: "STEPFUN_API_KEY" },
};
function pick(step: string): { provider: string; model: string } {
  const v = Deno.env.get(`REPRO_MODEL_${step.toUpperCase()}`) ?? Deno.env.get("REPRO_MODEL") ?? "DeepSeek-V4.1-Flash";
  const i = v.indexOf(":");
  return i > 0 && PROVIDERS[v.slice(0, i)] ? { provider: v.slice(0, i), model: v.slice(i + 1) } : { provider: "paratera", model: v };
}
let CUR = pick("reader");
const MODEL = () => CUR.model;
const MAX_TEXT = 70000;
const HOURLY_LIMIT = Number(Deno.env.get("REPRO_HOURLY_LIMIT") ?? "60");
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
// an Edge Function request is cut off at about 150 s without a word, so every step works to its own deadline
let deadline = 0;
const sb = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" };

async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { ...sb, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`db ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const text = await r.text();   // inserts and updates answer with an empty body
  return text ? JSON.parse(text) : null;
}

async function post(job: string, kind: string, payload: unknown) {
  await db("repro_events", { method: "POST", body: JSON.stringify({ job_id: job, kind, agent: "viewer-steps-1-3", payload }) });
  // a new job starts as "waiting"; after that the server only notes activity, so it can never reopen a finished job
  // or replace the name of the agent that did the work
  const now = new Date().toISOString();
  await db(`repro_jobs?id=eq.${job}&status=eq.waiting`, { method: "PATCH", body: JSON.stringify({ status: "running", agent: "viewer-steps-1-3", updated_at: now }) });
  await db(`repro_jobs?id=eq.${job}`, { method: "PATCH", body: JSON.stringify({ updated_at: now }) });
}

function arxivId(s: string): string | null {
  const m = s.match(/(\d{4}\.\d{4,5})(v\d+)?/);
  return m ? m[1] : null;
}

async function paperText(paper: string): Promise<string> {
  const id = arxivId(paper);
  const url = id && paper.length <= 40 ? `https://arxiv.org/pdf/${id}` : paper;
  if (!/^https?:\/\//.test(url)) throw new Error("paper must be an arXiv id or a PDF URL");
  const r = await fetch(url, { redirect: "follow" });
  if (!r.ok) throw new Error(`could not fetch the PDF (${r.status})`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > 25_000_000) throw new Error("PDF too large");
  const pdf = await getDocumentProxy(buf);
  const { text } = await extractText(pdf, { mergePages: false });
  const raw = (text as string[]).map((t, i) => `[page ${i + 1}]\n${t}`).join("\n\n").slice(0, MAX_TEXT);
  // PDF text can hold NUL and other control characters and lone surrogates; the model gateway can stall on them
  return raw.toWellFormed().replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

async function chat(system: string, user: string, maxTokens = 9000, job = ""): Promise<string> {
  const note = (t: string) => (job ? post(job, "progress", { text: t }).catch(() => {}) : Promise.resolve());
  // the gateway sometimes answers 429 "no deployments available"; wait, then try the sibling model
  const SIBLING = CUR.provider !== "paratera" ? CUR.model : MODEL() === "DeepSeek-V4-Flash" ? "DeepSeek-V4.1-Flash" : "DeepSeek-V4-Flash";
  // an Edge Function request ends after about 150 s, so thinking is off here (it took 90 s+ for the Reader alone)
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      // V4-Flash has been answering 429 "no deployments" for days; the sibling is only a last resort
      const model = attempt === 4 ? SIBLING : MODEL();
      await note(`Calling ${model} (attempt ${attempt + 1})`);
      const ctl = new AbortController();
      const left = deadline - Date.now();
      if (left < 15_000) throw new Error("out of time for this step");
      // the gateway sometimes accepts a request and then says nothing: give up after 20 s of silence and retry
      let timer = setTimeout(() => ctl.abort(), Math.min(30_000, left - 5_000));
      const rearm = () => { clearTimeout(timer); timer = setTimeout(() => ctl.abort(), Math.min(20_000, Math.max(deadline - Date.now() - 3_000, 1_000))); };
      const prov = PROVIDERS[CUR.provider];
      const r = await fetch(`${prov.base}/chat/completions`, {
        method: "POST", signal: ctl.signal,
        headers: { Authorization: `Bearer ${Deno.env.get(prov.key)}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model, ...(CUR.provider === "paratera" && /^DeepSeek/.test(model) ? { thinking: { type: "disabled" } } : {}), stream: true, max_tokens: maxTokens, temperature: 0,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
      });
      if (!r.ok || !r.body) throw new Error(`model ${r.status}: ${(await r.text()).slice(0, 160)}`);
      await note("Model is answering");
      const dec = new TextDecoder();
      let buf = "", out = "";
      for await (const chunk of r.body) {
        rearm();
        buf += dec.decode(chunk, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const l of lines) {
          if (!l.startsWith("data:")) continue;
          const d = l.slice(5).trim();
          if (d === "[DONE]") continue;
          try { out += JSON.parse(d).choices?.[0]?.delta?.content ?? ""; } catch { /* partial line */ }
        }
      }
      clearTimeout(timer);
      if (out.trim()) return out;
    } catch (e) {
      await note(`Model call failed: ${(e as Error).message}`);
      if (attempt === 4) throw e;
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    }
  }
  throw new Error("empty model answer");
}

function asJson(s: string): unknown {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("model did not return JSON");
  return JSON.parse(s.slice(a, b + 1));
}

const CRITIC = `You are the CRITIC. A fast reader wrote a claim contract from the paper without time to think. Check it against the paper text and fix it.
Verify: every number and its table reference; the metric and dataset of the match target; every hyperparameter, architecture size, split and schedule in the assumptions and requirements (use the paper's exact wording: for example "10 hidden units" means dimension 10); whether a validation split really exists in the released data; and the tolerance. The tolerance must follow the FIRST rule that applies and must not be widened: 1. the paper reports a std over repeated runs for the target: 3 x that std; 2. an accuracy-like percentage on a test set of 2,000+ examples: 1.0 point (0.01 as a fraction); 3. a bounded score on a smaller set: 2.0 points (0.02 as a fraction); 4. otherwise 10 percent relative.
Return the FULL corrected contract as ONE JSON object with the same keys as the input, plus "corrections": [{"field": str, "was": str, "now": str, "evidence": str}] (an empty list if nothing was wrong). Change only what the paper text shows to be wrong. Never invent a number or a quote.`;

const AUDIT_NOTE = `
This audit has no system re-run. Judge the code, the posted clean-run log and the numbers in the result. A hard-coded or copied paper value is a flag even if the program runs. Return the JSON object described above.`;

async function latest(job: string, kind: string): Promise<unknown | null> {
  const r = await db(`repro_events?job_id=eq.${job}&kind=eq.${kind}&select=payload&order=id.desc&limit=1`);
  return r.length ? r[0].payload : null;
}

// One role per call: an Edge Function request has a wall-clock limit, so the viewer calls this three
// times (reader, router, planner), each time after the previous event has arrived.
async function work(job: string, step: string, paper: string, lang: string) {
  deadline = Date.now() + 135_000;
  CUR = pick(step);
  try {
    const zh = lang === "zh" ? "\nWrite every free-text field (summaries, why, descriptions) in Chinese; keep keys, numbers, quotes and code in their original form." : "";
    if (step === "reader") {
      await post(job, "progress", { text: "Reading the paper" });
      const text = await paperText(paper);
      await post(job, "progress", { text: `Paper text extracted (${text.length} characters). Reader is working.` });
      const contract = asJson(await chat(prompts.READER + zh, `Paper text:

${text}`, 9000, job)) as Record<string, unknown>;
      await post(job, "contract", contract);
    } else if (step === "critic") {
      const contract = await latest(job, "contract");
      if (!contract) throw new Error("the Reader has not finished");
      await post(job, "progress", { text: "Critic is checking the contract against the paper" });
      const text = await paperText(paper);
      const fixed = asJson(await chat(CRITIC + zh, `Claim contract:
${JSON.stringify(contract)}

Paper text:

${text}`, 9000, job)) as Record<string, unknown>;
      await post(job, "contract", fixed);
    } else if (step === "audit") {
      const contract = await latest(job, "contract"), result = await latest(job, "result") as Record<string, unknown> | null;
      if (!result) throw new Error("no result to audit yet");
      await post(job, "progress", { text: "Auditor is checking the code and the clean run" });
      const files = await db(`repro_events?job_id=eq.${job}&kind=eq.file&select=payload&order=id`);
      let code = "";
      for (const f of files) {
        const body = String(f.payload?.content ?? "").slice(0, 15000);
        if (code.length + body.length < 45000) code += `
--- ${f.payload?.name ?? "file"} ---
${body}`;
      }
      // a plain check that needs no model: does a paper value appear as a literal in the code?
      const pv = result.paper_value == null ? "" : String(result.paper_value);
      const literal = pv.length >= 3 && code.includes(pv);
      const { files: _drop, ...resultNoFiles } = result;
      const audit = asJson(await chat(
        prompts.VERIFIER + AUDIT_NOTE + zh,
        `Claim contract:
${JSON.stringify(contract).slice(0, 14000)}

Result posted by the implementing agent:
${JSON.stringify(resultNoFiles).slice(0, 8000)}

Source code the agent uploaded (empty means none was uploaded):
${code || "(none)"}`,
        9000, job,
      )) as Record<string, unknown>;
      await post(job, "note", { audit: { ...audit, code_uploaded: code.length > 0, paper_value_literal_in_code: literal } });
    } else if (step === "router") {
      const contract = await latest(job, "contract");
      if (!contract) throw new Error("the Reader has not finished");
      await post(job, "progress", { text: "Router is working" });
      const text = (await paperText(paper)).slice(0, 30000);
      const route = asJson(await chat(
        prompts.ROUTER + zh,
        `Claim contract:
${JSON.stringify(contract)}

You cannot run commands here. Judge from the paper text and its stated links only; ` +
          `judge compute from what the paper says it used.

Paper text:

${text}`,
        9000, job,
      ));
      await post(job, "route", route);
    } else {
      const contract = await latest(job, "contract"), route = await latest(job, "route");
      if (!contract || !route) throw new Error("the Reader and Router have not finished");
      await post(job, "progress", { text: "Planner is working" });
      const plan = await chat(
        prompts.PLANNER + zh,
        `Claim contract:
${JSON.stringify(contract)}

Route:
${JSON.stringify(route)}

Return JSON as specified.`,
        9000, job,
      );
      let planJson: unknown;
      try { planJson = asJson(plan); } catch { planJson = { text: plan }; }
      await post(job, "plan", planJson);
      await post(job, "note", { text: "Steps 1 to 3 are done. Step 4 (implement, run, verify) is done by your own agent from the kit link." });
    }
  } catch (e) {
    await post(job, "note", { text: `The ${step} step stopped: ${(e as Error).message}`, error: true, step }).catch(() => {});
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    const { job, token, paper, lang, step } = await req.json();
    if (!["reader", "critic", "router", "planner", "audit"].includes(step)) return json({ error: "step must be reader, critic, router, planner or audit" }, 400);
    if (!job || !token || !paper || String(paper).length > 300) return json({ error: "job, token and paper are required" }, 400);
    const ok = await db(`repro_job_tokens?job_id=eq.${job}&token=eq.${encodeURIComponent(token)}&select=job_id`);
    if (!ok.length) return json({ error: "bad job or token" }, 403);
    if (step === "reader") {
      const since = new Date(Date.now() - 3600_000).toISOString();
      const recent = await db(`repro_events?kind=eq.contract&created_at=gte.${since}&select=id`);
      if (recent.length >= HOURLY_LIMIT) return json({ error: "hourly limit reached, try again later" }, 429);
      const started = await db(`repro_events?job_id=eq.${job}&kind=eq.contract&select=id&limit=1`);
      if (started.length) return json({ error: "steps already done for this job" }, 409);
    }
    if (step === "audit") {
      const done = await db(`repro_events?job_id=eq.${job}&kind=eq.note&payload->audit=not.is.null&select=id&limit=1`);
      if (done.length) return json({ error: "already audited" }, 409);
    }
    // @ts-ignore EdgeRuntime is provided by the Supabase runtime
    EdgeRuntime.waitUntil(work(job, step, String(paper), lang === "zh" ? "zh" : "en"));
    return json({ ok: true }, 202);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
