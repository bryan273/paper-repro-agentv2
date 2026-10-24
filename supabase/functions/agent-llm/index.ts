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
    const r = await fetch("https://api.deepseek.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(110_000) });
    const out = await r.json();
    if (!r.ok) return json({ error: out?.error?.message ?? "model error" }, 502);
    const u = out.usage ?? {};
    await db("agent_usage", { method: "POST", body: JSON.stringify({ visitor: vid, app, prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0 }) });
    return json({ message: out.choices?.[0]?.message, finish_reason: out.choices?.[0]?.finish_reason, usage: u });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
