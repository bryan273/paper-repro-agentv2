// Sprout model proxy. The static app on GitHub Pages cannot hold a key, so it calls this function; the key lives only in the
// Supabase secret SPROUT_RKAPI_KEY (and optionally PARATERA_API_KEY as a fallback), never in the browser or a repo.
// The browser sends an OpenAI-style body; we force the model, cap the size, stream from the provider and return one JSON reply.
// Guards: only the Sprout page origins may call it, then limits per connection per hour, per connection per day, and one global daily budget.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const APP = "sprout";
const PROVIDERS = [
  { name: "rkapi", base: "https://rkapi.com/v1", model: Deno.env.get("SPROUT_RKAPI_MODEL") ?? "deepseek-v4.1-flash", key: Deno.env.get("SPROUT_RKAPI_KEY") },
  { name: "paratera", base: "https://llmapi.paratera.com/v1", model: Deno.env.get("SPROUT_PARATERA_MODEL") ?? "DeepSeek-V4-Flash-0731", key: Deno.env.get("PARATERA_API_KEY") },
].filter((p) => p.key);
const PER_IP_HOUR = Number(Deno.env.get("SPROUT_PER_IP_HOUR") ?? "150");
const PER_IP_DAY_TOKENS = Number(Deno.env.get("SPROUT_PER_IP_DAY_TOKENS") ?? "400000");
const DAILY_TOKENS = Number(Deno.env.get("SPROUT_DAILY_TOKENS") ?? "3000000");
const MAX_BODY_CHARS = 20000;
const HEDGES = 3, HEDGE_MS = 6000;
const ORIGINS = new Set(["https://bryan273.github.io", "http://localhost:5173", "http://localhost:4173"]);

async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", Prefer: "return=minimal", ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`db ${r.status}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : null;
}
async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
}
type Row = { prompt_tokens: number; completion_tokens: number };
const sum = (rows: Row[]) => rows.reduce((a, r) => a + r.prompt_tokens + r.completion_tokens, 0);

Deno.serve(async (req) => {
  const origin = req.headers.get("origin") ?? "";
  const ok = ORIGINS.has(origin);
  const cors: Record<string, string> = ok
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "86400" }
    : {};
  const json = (o: unknown, status = 200, extra: Record<string, string> = {}) => new Response(JSON.stringify(o), { status, headers: { ...cors, ...extra, "Content-Type": "application/json", "Cache-Control": "no-store" } });
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method === "GET") return json({ ok: PROVIDERS.length > 0, model: PROVIDERS[0]?.model ?? "" });
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
  // a browser always sends Origin on a cross-site POST; a call without an allowed one is refused
  if (!ok) return json({ error: "origin not allowed" }, 403);
  if (!PROVIDERS.length) return json({ error: "server key not set" }, 503);

  let b: { messages?: { role?: string; content?: unknown }[] } | null = null;
  try { b = await req.json(); } catch { b = null; }
  const msgs = b && Array.isArray(b.messages) ? b.messages : null;
  if (!msgs || !msgs.length || msgs.length > 4) return json({ error: "bad request" }, 400);
  const clean = msgs.map((m) => ({ role: m.role === "system" ? "system" : "user", content: String(m.content ?? "") }));
  if (clean.reduce((n, m) => n + m.content.length, 0) > MAX_BODY_CHARS) return json({ error: "too long" }, 413);

  // limits by connection (the browser cannot change its address) and one global budget
  const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
  const vid = await sha(`${ip}|${APP}`);
  try {
    const hour = new Date(Date.now() - 3600_000).toISOString();
    const day = new Date(Date.now() - 86400_000).toISOString();
    const hourRows = await db(`agent_usage?visitor=eq.${vid}&created_at=gte.${hour}&select=id`);
    if (hourRows.length >= PER_IP_HOUR) return json({ error: "too many requests, try again later" }, 429);
    const dayRows = await db(`agent_usage?visitor=eq.${vid}&created_at=gte.${day}&select=prompt_tokens,completion_tokens`);
    if (sum(dayRows) > PER_IP_DAY_TOKENS) return json({ error: "daily limit reached, try again tomorrow" }, 429);
    const all = await db(`agent_usage?app=eq.${APP}&created_at=gte.${day}&select=prompt_tokens,completion_tokens`);
    if (sum(all) > DAILY_TOKENS) return json({ error: "daily budget reached, try again tomorrow" }, 429);
  } catch {
    // if the counter table cannot be read, refuse rather than run without limits
    return json({ error: "limits unavailable" }, 503);
  }

  const attempt = async (p: (typeof PROVIDERS)[number], signal: AbortSignal) => {
    const body = JSON.stringify({ model: p.model, messages: clean, temperature: 0, max_tokens: 600, stream: true, stream_options: { include_usage: true }, response_format: { type: "json_object" } });
    const r = await fetch(`${p.base}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${p.key}`, "User-Agent": "Mozilla/5.0 (sprout)" }, body, signal });
    if (!r.ok || !r.body) throw new Error(`${p.name} ${r.status}`);
    let text = "", buf = "", pt = 0, ct = 0;
    const dec = new TextDecoder();
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const ln of lines) {
        if (!ln.startsWith("data:")) continue;
        const d = ln.slice(5).trim();
        if (!d || d === "[DONE]") continue;
        try { const j = JSON.parse(d); text += j.choices?.[0]?.delta?.content || ""; if (j.usage) { pt = j.usage.prompt_tokens ?? pt; ct = j.usage.completion_tokens ?? ct; } } catch { /* partial line */ }
      }
    }
    if (!text.trim()) throw new Error(`${p.name} empty`);
    // streams sometimes end early and cut the JSON in half; a broken answer counts as a failure so the hedge retries
    try { JSON.parse(text); } catch { throw new Error(`${p.name} bad json`); }
    return { text, provider: p.name, pt: pt || Math.ceil(clean.reduce((n, m) => n + m.content.length, 0) / 3), ct: ct || Math.ceil(text.length / 3) };
  };
  // Hedge: if an attempt has not finished after HEDGE_MS (or fails), start the next one, rotating providers; the first answer wins.
  const ctrls: AbortController[] = [];
  try {
    const out = await new Promise<Awaited<ReturnType<typeof attempt>>>((resolve, reject) => {
      let started = 0, failed = 0;
      const start = () => {
        if (started >= HEDGES) return;
        const p = PROVIDERS[started % PROVIDERS.length];
        started++;
        const c = new AbortController(); ctrls.push(c);
        attempt(p, c.signal).then(resolve, (err) => { if (++failed >= HEDGES) reject(err); else start(); });
      };
      start();
      for (let i = 1; i < HEDGES; i++) setTimeout(start, HEDGE_MS * i);
      setTimeout(() => reject(new Error("timeout")), 50_000);
    });
    await db("agent_usage", { method: "POST", body: JSON.stringify({ visitor: vid, app: APP, prompt_tokens: out.pt, completion_tokens: out.ct }) }).catch(() => undefined);
    return json({ choices: [{ message: { content: out.text } }] }, 200, { "X-Sprout-Provider": out.provider });
  } catch (e) {
    // the reason is a provider name and status code or "empty"/"timeout", never the key or the prompt
    return json({ error: "upstream failed", reason: String((e as Error)?.message ?? e).slice(0, 60) }, 502);
  } finally {
    ctrls.forEach((c) => c.abort());
  }
});
