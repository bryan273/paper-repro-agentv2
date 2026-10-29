// Shared by the Paper Explainer edge functions: database access, sessions, the daily free allowance and the credit balance.
export const SB_URL = Deno.env.get("SUPABASE_URL")!;
export const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token, x-session, x-visitor-id", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
export const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// free units per rolling 24 hours: a guest gets a taste, a signed-in member gets much more; paid credits come on top
export const GUEST_DAY = Number(Deno.env.get("EXPLAINER_GUEST_DAY") ?? "2");
export const MEMBER_DAY = Number(Deno.env.get("EXPLAINER_MEMBER_DAY") ?? "8");
export const WELCOME_CREDITS = Number(Deno.env.get("EXPLAINER_WELCOME_CREDITS") ?? "3");
export const units = (sec: number) => Math.max(1, Math.ceil((sec || 36) / 180));

export async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`db ${r.status} ${await r.text()}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : null;
}
export async function count(q: string) {
  const r = await fetch(`${SB_URL}/rest/v1/${q}${q.includes("?") ? "&" : "?"}select=id`, { headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, Prefer: "count=exact", Range: "0-0" } });
  return Number((r.headers.get("content-range") ?? "").split("/")[1]) || 0;
}
export async function sha(s: string, bytes = 8) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, bytes).map((x) => x.toString(16).padStart(2, "0")).join("");
}
export const clientIp = (req: Request) => (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
/** One id for "this browser on this network", used for the guest quota and for the event log. */
export const actorOf = async (req: Request, visitor: unknown) => sha(`${clientIp(req)}|${String(visitor ?? "").slice(0, 64)}|explainer`);

export type User = { id: string; username: string; credits: number; banned: boolean; created_at: string };

/** The signed-in member behind the x-session header, or null. */
export async function userOf(req: Request): Promise<User | null> {
  const token = req.headers.get("x-session") ?? "";
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const rows = await db(`explainer_sessions?token_hash=eq.${await sha(token, 32)}&expires_at=gt.${new Date().toISOString()}&select=user_id`);
  if (!rows.length) return null;
  const us = await db(`explainer_users?id=eq.${rows[0].user_id}&select=id,username,credits,banned,created_at`);
  return us[0] && !us[0].banned ? us[0] : null;
}

export async function logEvent(actor: string, type: string, meta: Record<string, unknown> = {}, userId: string | null = null) {
  try { await db("explainer_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor, user_id: userId, type, meta }) }); } catch { /* logging must never break a request */ }
}

/** Credits of failed jobs go back to the member (lazily, whenever the balance is looked at). */
async function refundFailed(user: User) {
  const failed = await db(`explainer_jobs?user_id=eq.${user.id}&status=eq.failed&refunded=eq.false&credit_used=gt.0&select=id,credit_used`);
  for (const j of failed) {
    await db(`explainer_jobs?id=eq.${j.id}&refunded=eq.false`, { method: "PATCH", body: JSON.stringify({ refunded: true }) });
    await db(`explainer_users?id=eq.${user.id}`, { method: "PATCH", body: JSON.stringify({ credits: user.credits + j.credit_used }) });
    await db("explainer_credit_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: user.id, delta: j.credit_used, reason: "refund: video failed" }) });
    user.credits += j.credit_used;
  }
}

export type Quota = { tier: "guest" | "member"; day_limit: number; day_used: number; day_left: number; credits: number; resets_in_min: number | null };

/** What this person may still make: the free allowance of the last 24 hours (minus what credits already paid for) plus the credit balance. */
export async function quotaFor(user: User | null, actor: string): Promise<Quota> {
  if (user) await refundFailed(user);
  const since = new Date(Date.now() - 86400_000).toISOString();
  const who = user ? `user_id=eq.${user.id}` : `visitor=eq.${actor}&user_id=is.null`;
  const rows = await db(`explainer_jobs?${who}&status=neq.failed&created_at=gte.${since}&select=seconds,credit_used,created_at&order=created_at.asc`);
  const used = rows.reduce((n: number, r: { seconds: number; credit_used: number }) => n + Math.max(0, units(r.seconds) - (r.credit_used || 0)), 0);
  const limit = user ? MEMBER_DAY : GUEST_DAY;
  const left = Math.max(0, limit - used);
  const oldest = rows[0] ? Date.parse(rows[0].created_at) + 86400_000 - Date.now() : null;
  return { tier: user ? "member" : "guest", day_limit: limit, day_used: Math.min(used, limit), day_left: left, credits: user?.credits ?? 0, resets_in_min: oldest && left < limit ? Math.max(1, Math.round(oldest / 60000)) : null };
}

// ---- passwords: PBKDF2-SHA256
const hex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
export async function hashPassword(pw: string, salt = hex(crypto.getRandomValues(new Uint8Array(16)))) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(pw), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: new TextEncoder().encode(salt), iterations: 100_000 }, key, 256);
  return { salt, hash: hex(bits) };
}
export const sameText = (a: string, b: string) => { let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; };
export async function newSession(userId: string) {
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await db("explainer_sessions", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ token_hash: await sha(token, 32), user_id: userId, expires_at: new Date(Date.now() + 30 * 86400_000).toISOString() }) });
  return token;
}
