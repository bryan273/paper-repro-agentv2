// Private relay: forwards one chat-completion body to the Paratera gateway. agent-llm and the video renderer call it with an Asian
// x-region header, because the default region reaches that China-hosted gateway badly. Only holders of a project secret key may use it:
// the caller's key is proven by asking Auth for an admin-only listing, which anon and publishable keys cannot read.
const KEY = Deno.env.get("PARATERA_API_KEY");
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const good = new Map<string, number>();   // keys already proven, so a burst of calls checks only once

async function isSecretKey(token: string): Promise<boolean> {
  if (!token) return false;
  if ((good.get(token) ?? 0) > Date.now()) return true;
  const r = await fetch(`${SB_URL}/auth/v1/admin/users?per_page=1`, { headers: { apikey: token, Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (r?.ok) { good.set(token, Date.now() + 10 * 60_000); return true; }
  return false;
}

Deno.serve(async (req) => {
  if (!KEY || !(await isSecretKey((req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "")))) return new Response("forbidden", { status: 403 });
  try {
    const r = await fetch("https://llmapi.paratera.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: await req.text(), signal: AbortSignal.timeout(Math.min(Number(req.headers.get("x-timeout-ms")) || 40_000, 120_000)),
    });
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: (e as Error).message } }), { status: 504, headers: { "Content-Type": "application/json" } });
  }
});
