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
const MODEL = Deno.env.get("REPRO_MODEL") ?? "DeepSeek-V4-Flash";
const BASE = Deno.env.get("PARATERA_BASE_URL") ?? "https://llmapi.paratera.com/v1";
const MAX_TEXT = 70000;
const HOURLY_LIMIT = Number(Deno.env.get("REPRO_HOURLY_LIMIT") ?? "30");
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const sb = { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" };

async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { ...sb, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`db ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.status === 204 ? null : await r.json();
}

async function post(job: string, kind: string, payload: unknown) {
  await db("repro_events", { method: "POST", body: JSON.stringify({ job_id: job, kind, agent: "viewer-steps-1-3", payload }) });
  await db(`repro_jobs?id=eq.${job}`, {
    method: "PATCH",
    body: JSON.stringify({ status: "running", agent: "viewer-steps-1-3", updated_at: new Date().toISOString() }),
  });
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
  return (text as string[]).map((t, i) => `[page ${i + 1}]\n${t}`).join("\n\n").slice(0, MAX_TEXT);
}

async function chat(system: string, user: string, maxTokens = 16000): Promise<string> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${Deno.env.get("PARATERA_API_KEY")}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: MODEL, stream: true, max_tokens: maxTokens, temperature: 0,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
        }),
      });
      if (!r.ok || !r.body) throw new Error(`model ${r.status}`);
      const dec = new TextDecoder();
      let buf = "", out = "";
      for await (const chunk of r.body) {
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
      if (out.trim()) return out;
    } catch (e) {
      if (attempt === 2) throw e;
      await new Promise((res) => setTimeout(res, 3000 * (attempt + 1)));
    }
  }
  throw new Error("empty model answer");
}

function asJson(s: string): unknown {
  const a = s.indexOf("{"), b = s.lastIndexOf("}");
  if (a < 0 || b < a) throw new Error("model did not return JSON");
  return JSON.parse(s.slice(a, b + 1));
}

async function work(job: string, paper: string, lang: string) {
  try {
    const zh = lang === "zh" ? "\nWrite every free-text field (summaries, why, descriptions) in Chinese; keep keys, numbers, quotes and code in their original form." : "";
    await post(job, "progress", { text: "Reading the paper" });
    const text = await paperText(paper);
    await post(job, "progress", { text: `Paper text extracted (${text.length} characters). Reader is working.` });
    const contract = asJson(await chat(prompts.READER + zh, `Paper text:\n\n${text}`)) as Record<string, unknown>;
    await post(job, "contract", contract);
    const route = asJson(await chat(
      prompts.ROUTER + zh,
      `Claim contract:\n${JSON.stringify(contract)}\n\nYou cannot run commands here. Judge from the paper text and its stated links only; ` +
        `set "can_run_here" from the paper's stated compute.\n\nPaper text:\n\n${text.slice(0, 30000)}`,
    ));
    await post(job, "route", route);
    const plan = await chat(
      prompts.PLANNER + zh,
      `Claim contract:\n${JSON.stringify(contract)}\n\nRoute:\n${JSON.stringify(route)}\n\nReturn JSON as specified.`,
    );
    let planJson: unknown;
    try { planJson = asJson(plan); } catch { planJson = { text: plan }; }
    await post(job, "plan", planJson);
    await post(job, "note", { text: "Steps 1 to 3 are done. Step 4 (implement, run, verify) is done by your own agent from the kit link." });
  } catch (e) {
    await post(job, "note", { text: `Steps 1 to 3 stopped: ${(e as Error).message}`, error: true }).catch(() => {});
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    const { job, token, paper, lang } = await req.json();
    if (!job || !token || !paper || String(paper).length > 300) return json({ error: "job, token and paper are required" }, 400);
    const ok = await db(`repro_job_tokens?job_id=eq.${job}&token=eq.${encodeURIComponent(token)}&select=job_id`);
    if (!ok.length) return json({ error: "bad job or token" }, 403);
    const since = new Date(Date.now() - 3600_000).toISOString();
    const recent = await db(`repro_events?kind=eq.contract&created_at=gte.${since}&select=id`);
    if (recent.length >= HOURLY_LIMIT) return json({ error: "hourly limit reached, try again later" }, 429);
    const started = await db(`repro_events?job_id=eq.${job}&kind=eq.progress&select=id&limit=1`);
    if (started.length) return json({ error: "steps already started for this job" }, 409);
    // @ts-ignore EdgeRuntime is provided by the Supabase runtime
    EdgeRuntime.waitUntil(work(job, String(paper), lang === "zh" ? "zh" : "en"));
    return json({ ok: true }, 202);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
