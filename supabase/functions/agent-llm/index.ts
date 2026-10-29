// A small, rate-limited LLM gateway for the apps built on Atoms (Repro Lite, Reading Companion, ...).
// The browser app sends chat messages (and optionally tool definitions); this function adds the DeepSeek key, which lives only
// in the secret DEEPSEEK_API_KEY, and returns the model reply. Limits: per visitor per hour, and a global daily token budget.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const KEY = Deno.env.get("DEEPSEEK_API_KEY");
const MODEL = Deno.env.get("AGENT_MODEL") ?? "deepseek-flash";
const APPS = new Set(["repro-lite", "companion", "indexboard"]);
const PER_VISITOR_HOUR = Number(Deno.env.get("AGENT_PER_VISITOR_HOUR") ?? "80");
const DAILY_TOKENS = Number(Deno.env.get("AGENT_DAILY_TOKENS") ?? "8000000");
const MAX_CHARS = 90_000;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };

async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", Prefer: "return=minimal", ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`db ${r.status}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : null;
}
async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    if (!KEY) return json({ error: "gateway not configured" }, 503);
    const { app, messages, tools, max_tokens, json_mode, visitor } = await req.json();
    if (!APPS.has(app)) return json({ error: "unknown app" }, 400);
    if (!Array.isArray(messages) || !messages.length) return json({ error: "messages required" }, 400);
    if (JSON.stringify(messages).length > MAX_CHARS) return json({ error: "too much text in one call" }, 413);
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
    const vid = await sha(`${ip}|${String(visitor ?? "").slice(0, 64)}|${app}`);
    const since = new Date(Date.now() - 3600_000).toISOString();
    const mine = await db(`agent_usage?visitor=eq.${vid}&created_at=gte.${since}&select=id`, { headers: { Prefer: "count=none" } });
    if (mine.length >= PER_VISITOR_HOUR) return json({ error: "hourly limit reached, try again later" }, 429);
    const day = new Date(Date.now() - 86400_000).toISOString();
    const rows = await db(`agent_usage?created_at=gte.${day}&select=prompt_tokens,completion_tokens`);
    const used = rows.reduce((a: number, r: { prompt_tokens: number; completion_tokens: number }) => a + r.prompt_tokens + r.completion_tokens, 0);
    if (used > DAILY_TOKENS) return json({ error: "daily budget reached, try again tomorrow" }, 429);
    const body: Record<string, unknown> = { model: MODEL, messages, max_tokens: Math.min(Number(max_tokens) || 2000, 4000), temperature: 0.2, thinking: { type: "disabled" } };
    if (Array.isArray(tools) && tools.length && tools.length <= 12) body.tools = tools;
    if (json_mode) body.response_format = { type: "json_object" };
    // DeepSeek first; if its account is out of credit the same model family on the Paratera gateway answers, then StepFun if a key is set
    const PARA = Deno.env.get("PARATERA_API_KEY"), STEP = Deno.env.get("STEPFUN_API_KEY");
    // a call that stalls is cut after `ms` and reported as a 504, so the next provider (or a retry) can take over instead of hanging the visitor
    const post = async (url: string, key: string, b: Record<string, unknown>, ms = 110_000) => {
      try { return await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(ms) }); }
      catch { return new Response(JSON.stringify({ error: { message: "The AI service did not answer in time." } }), { status: 504, headers: { "Content-Type": "application/json" } }); }
    };
    const { thinking: _t, ...plain } = body as Record<string, unknown>;
    // The overseas hop to the gateway stalls now and then, so the call is hedged: a second and third copy start 4 s and 10 s later, the first good answer wins and the rest are dropped
    const viaParatera = async (): Promise<Response> => {
      const bodyP = { ...body, model: Deno.env.get("PARATERA_MODEL") ?? "DeepSeek-V4.1-Flash" };
      const ctl = [0, 1, 2].map(() => new AbortController());
      const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), SB = Deno.env.get("SUPABASE_URL");
      // copy 0 goes straight to the gateway; copies 1 and 2 go through llm-relay running in Asian regions, which reach it far more reliably
      const route = [
        { delay: 0, url: "https://llmapi.paratera.com/v1/chat/completions", headers: { Authorization: `Bearer ${PARA}` } },
        { delay: 4000, url: `${SB}/functions/v1/llm-relay`, headers: { Authorization: `Bearer ${SRV}`, "x-region": "ap-northeast-2" } },
        { delay: 10000, url: `${SB}/functions/v1/llm-relay`, headers: { Authorization: `Bearer ${SRV}`, "x-region": "ap-southeast-1" } },
      ];
      const one = async (i: number): Promise<Response> => {
        await new Promise((res) => setTimeout(res, route[i].delay));
        if (ctl[i].signal.aborted) throw new Error("dropped");
        const rr = await fetch(route[i].url, { method: "POST", headers: { ...route[i].headers, "Content-Type": "application/json" }, body: JSON.stringify(bodyP), signal: AbortSignal.any([ctl[i].signal, AbortSignal.timeout(40_000)]) });
        if (!rr.ok) throw Object.assign(new Error("status " + rr.status), { res: rr });
        const text = await rr.text();   // read the body before the other copies are dropped, or an abort would cut it
        if (ctl[i].signal.aborted) throw new Error("dropped");
        return new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });
      };
      try {
        const win = await Promise.any([0, 1, 2].map((i) => one(i)));
        ctl.forEach((c) => { try { c.abort(); } catch { /* already done */ } });
        return win;
      } catch (e) {
        const errs = (e as AggregateError).errors ?? [];
        const bad = errs.map((x: { res?: Response }) => x.res).find((x: Response | undefined) => x);
        return bad ?? new Response(JSON.stringify({ error: { message: "The AI service did not answer in time." } }), { status: 504, headers: { "Content-Type": "application/json" } });
      }
    };
    // Paratera serves the same DeepSeek models and is the account with credit, so it goes first when its key is set
    let r = PARA ? await viaParatera() : await post("https://api.deepseek.com/v1/chat/completions", KEY, body);
    if (!r.ok && PARA && KEY && [401, 402, 429, 500, 502, 503, 504].includes(r.status)) r = await post("https://api.deepseek.com/v1/chat/completions", KEY, body);
    if (!r.ok && [401, 402, 429, 502, 503, 504].includes(r.status) && STEP) r = await post("https://api.stepfun.com/v1/chat/completions", STEP, { ...plain, model: Deno.env.get("STEPFUN_MODEL") ?? "step-3.5-flash" });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 504) return json({ error: "The AI service is busy right now. Please try again in a minute.", code: "busy" }, 503);
      if ([401, 402].includes(r.status)) return json({ error: "The AI service is temporarily out of credit. Please try again later.", code: "no_credit" }, 503);
      return json({ error: out?.error?.message ?? "model error" }, 502);
    }
    const u = out.usage ?? {};
    await db("agent_usage", { method: "POST", body: JSON.stringify({ visitor: vid, app, prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0 }) });
    return json({ message: out.choices?.[0]?.message, finish_reason: out.choices?.[0]?.finish_reason, usage: u });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
