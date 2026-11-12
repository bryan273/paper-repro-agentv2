// Shared by the Paper Explainer edge functions: database access, sessions, the daily free allowance and the credit balance.
export const SB_URL = Deno.env.get("SUPABASE_URL")!;
export const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token, x-session, x-visitor-id", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
export const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// free videos: a guest gets 1 per rolling 24 hours, a signed-in member 5 per rolling 7 days; paid credits come on top
export const GUEST_DAY = Number(Deno.env.get("EXPLAINER_GUEST_DAY") ?? "1");
export const MEMBER_WEEK = Number(Deno.env.get("EXPLAINER_MEMBER_WEEK") ?? "3");
export const WELCOME_CREDITS = Number(Deno.env.get("EXPLAINER_WELCOME_CREDITS") ?? "3");
/** What a video costs: 1 video up to 5 minutes, 2 for a longer one (7 or 10 minutes). */
/** Video credits a video uses: one for every started 5 minutes (a 3 minute video is 1, 10 minutes is 2, 20 minutes is 4). */
export const isDeep = (custom?: string | null) => /In-depth: yes/.test(custom || "");
/** Video credits: one per started 5 minutes; an in-depth video uses two, because a stronger model writes it. */
export const units = (sec: number, custom?: string | null) => Math.max(1, Math.ceil((sec || 36) / 300)) * (isDeep(custom) ? 2 : 1);
/** The longest video each plan may make: free 3 minutes, Plus 5, Pro and Premium 10 (pack videos are Pro videos). */
export const maxSeconds = (plan: string | null, packBuyer: boolean) => (plan === "premium" ? 1200 : plan === "pro" || packBuyer ? 600 : plan === "plus" ? 300 : 180);
/** The 9 languages a video can be narrated in (one language per video). */
export const VIDEO_LANGS = ["en", "zh", "vi", "id", "ja", "ko", "es", "fr", "de"];

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

/** Accounts listed in EXPLAINER_ADMIN_EMAILS (comma separated) are the owner and the QA account: no daily limit, no credit charge. */
export const ADMIN_EMAILS = (Deno.env.get("EXPLAINER_ADMIN_EMAILS") ?? "bryantjandra273@gmail.com").toLowerCase().split(",").map((x) => x.trim()).filter(Boolean);
export const isAdmin = (u: { username: string } | null) => !!u && ADMIN_EMAILS.includes(String(u.username).toLowerCase());

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

// What each plan gives. Kept in step with explainer-account PLANS and the front end (Pricing, AdminPricing).
//   interactive: videos on which interactive mode can be turned on; a plan counts per calendar month, free and guest per rolling 7 days
//     (a new free account gets 3 more in its first 7 days, the welcome videos)
//   deep: in-depth answers per calendar month (the strong model, about half a yuan each)
//   quick: quick answers per calendar month (free: per rolling 7 days)
//   research: research questions (Read) per calendar month
//   edits: edits per video (an edit re-makes one part of a finished video and does not use a video credit)
export const TIERS: Record<string, { interactive: number; deep: number; quick: number; research: number; edits: number }> = {
  guest: { interactive: 1, deep: 0, quick: 8, research: 1, edits: 0 },
  free: { interactive: 2, deep: 2, quick: 20, research: 2, edits: 1 },
  plus: { interactive: 20, deep: 10, quick: 100, research: 8, edits: 2 },
  pro: { interactive: 40, deep: 20, quick: 200, research: 15, edits: 3 },
  premium: { interactive: 80, deep: 30, quick: 300, research: 25, edits: 3 },
};
export const WELCOME_INTERACTIVE = 3;
export const PLAN_NAMES = ["plus", "pro", "premium"];
/** The plan running now for a member, or null. */
export async function activePlan(userId: string | undefined | null): Promise<string | null> {
  if (!userId) return null;
  const [e] = await db(`explainer_events?user_id=eq.${userId}&type=eq.plan&select=meta&order=created_at.desc&limit=1`).catch(() => []);
  return e?.meta?.until && new Date(e.meta.until) > new Date() && PLAN_NAMES.includes(String(e.meta.plan)) ? String(e.meta.plan) : null;
}
export const monthStart = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString(); };
const nextMonth = () => { const d = new Date(); return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString(); };
export type Interactive = { used: number; cap: number; left: number; resets: string; jobs: string[]; period: "week" | "month" };
/** How many videos this person opened interactive mode on this calendar month (UTC). Opening it again on the same video is free. */
export async function interactiveUse(user: User | null, actor: string, plan: string | null): Promise<Interactive> {
  const who = user ? `user_id=eq.${user.id}` : `actor=eq.${encodeURIComponent(actor)}&user_id=is.null`;
  const weekly = !plan;
  const since = weekly ? new Date(Date.now() - 7 * 86400_000).toISOString() : monthStart();
  const rows = await db(`explainer_events?${who}&type=eq.interactive&created_at=gte.${since}&select=meta,created_at&order=created_at.asc&limit=2000`).catch(() => []);
  const jobs = [...new Set((rows as { meta?: { job?: string } }[]).map((r) => String(r.meta?.job ?? "")).filter(Boolean))];
  const fresh = !!user && Date.now() - Date.parse(user.created_at) < 7 * 86400_000;
  const cap = TIERS[plan ?? (user ? "free" : "guest")].interactive + (weekly && fresh ? WELCOME_INTERACTIVE : 0);
  const first = (rows as { created_at?: string }[])[0]?.created_at;
  const resets = weekly ? new Date((first ? Date.parse(first) : Date.now()) + 7 * 86400_000).toISOString() : nextMonth();
  return { used: jobs.length, cap, left: Math.max(0, cap - jobs.length), resets, jobs, period: weekly ? "week" : "month" };
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

// day_limit / day_used / day_left keep their names for the apps; period says whether they count a day (guest) or a week (member)
export type Quota = { tier: "guest" | "member"; period: "day" | "week"; day_limit: number; day_used: number; day_left: number; credits: number; resets_in_min: number | null };

/** What this person may still make: the free allowance of the last 24 hours (minus what credits already paid for) plus the credit balance. */
export async function quotaFor(user: User | null, actor: string): Promise<Quota> {
  if (user) await refundFailed(user);
  const span = (user ? 7 : 1) * 86400_000;
  const since = new Date(Date.now() - span).toISOString();
  const who = user ? `user_id=eq.${user.id}` : `visitor=eq.${actor}&user_id=is.null`;
  const rows = await db(`explainer_jobs?${who}&status=neq.failed&created_at=gte.${since}&select=seconds,custom,credit_used,created_at&order=created_at.asc`);
  const used = rows.reduce((n: number, r: { seconds: number; custom: string | null; credit_used: number }) => n + Math.max(0, units(r.seconds, r.custom) - (r.credit_used || 0)), 0);
  const limit = user ? (isAdmin(user) ? 9999 : MEMBER_WEEK) : GUEST_DAY;
  const left = Math.max(0, limit - used);
  const oldest = rows[0] ? Date.parse(rows[0].created_at) + span - Date.now() : null;
  return { tier: user ? "member" : "guest", period: user ? "week" : "day", day_limit: limit, day_used: Math.min(used, limit), day_left: left, credits: user?.credits ?? 0, resets_in_min: oldest && left < limit ? Math.max(1, Math.round(oldest / 60000)) : null };
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
