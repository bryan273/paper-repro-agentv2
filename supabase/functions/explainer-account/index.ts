// Accounts for Paper Explainer: username + password sign-up and sign-in, the balance, the member's own videos, credit-pack orders,
// the contact form and the usage events behind the admin dashboard.
//   GET  ?me=1              (x-session optional) -> { user|null, quota }
//   GET  ?jobs=1            (x-session)          -> the member's own videos
//   GET  ?ledger=1          (x-session)          -> credit history
//   POST {op:"register"|"login"|"logout"|"password"|"event"|"contact"|"buy", ...}
import { CORS, json, db, sha, clientIp, actorOf, userOf, quotaFor, logEvent, TIERS, interactiveUse, activePlan, hashPassword, sameText, newSession, count, WELCOME_CREDITS, GUEST_DAY, MEMBER_WEEK, monthStart, isAdmin, FREE_KEEP_DAYS, TRASH_DAYS, units, type Quota } from "../_shared/explainer.ts";

const EVENTS = new Set(["visit", "open_signup", "view_pricing", "view_example", "play_example", "click_make", "click_buy", "order_created", "order_paid_claimed", "share", "download", "video_play", "video_download", "leave"]);
import { ADMIN_EMAILS } from "../_shared/explainer.ts";
import { quote, type Quote } from "../_shared/proration.ts";
import { mailReady, sendMail, linkMail } from "../_shared/mail.ts";
const PACKS: Record<string, { credits: number; price: number }> = { "5": { credits: 5, price: 19 }, "20": { credits: 20, price: 59 }, "50": { credits: 50, price: 129 } };   // single videos: about CNY 2.6 to 3.8 each, credits never expire
// subscriptions: the videos of the period are added as credits when the payment is confirmed; the plan sets the monthly interactive videos and the in-depth answers (TIERS in _shared)
const PLANS: Record<string, { credits: number; price: number; days: number }> = {
  // the video credits of a plan (1 credit = a video of up to 5 minutes); the other limits are in TIERS (_shared/explainer.ts)
  plus_month: { credits: 20, price: 29, days: 31 }, plus_year: { credits: 240, price: 290, days: 366 },
  pro_month: { credits: 40, price: 55, days: 31 }, pro_year: { credits: 480, price: 550, days: 366 },
  premium_month: { credits: 80, price: 99, days: 31 }, premium_year: { credits: 960, price: 990, days: 366 },
};
// the same prices in the money of each market (kept in step with the front end, lib/currency.ts); the owner confirms the amount in this money, no exchange rate is involved
const LOCAL: Record<string, { vnd: number; idr: number }> = {
  plus_month: { vnd: 79000, idr: 69000 }, plus_year: { vnd: 790000, idr: 690000 }, pro_month: { vnd: 149000, idr: 129000 }, pro_year: { vnd: 1490000, idr: 1290000 },
  premium_month: { vnd: 269000, idr: 239000 }, premium_year: { vnd: 2690000, idr: 2390000 },
};
// A real welcome offer: the first monthly plan a new member buys within 72 hours of signing up costs 40% less for that first month. The server applies it, so the price on the page is the price charged; the second month is the regular price.
const WELCOME_PCT = 40, WELCOME_HOURS = 72;
const welcomeOffer = async (u: { username: string; created_at: string } | null): Promise<{ pct: number; ends_at: string } | null> => {
  if (!u) return null;
  const ends = Date.parse(u.created_at) + WELCOME_HOURS * 3600_000;
  if (!(Date.now() < ends)) return null;
  const prior = await count(`explainer_orders?email=eq.${encodeURIComponent(`@${u.username}`)}&arxiv=like.plan*&status=in.(paid_claimed,paid,delivered)`).catch(() => 0);
  return prior > 0 ? null : { pct: WELCOME_PCT, ends_at: new Date(ends).toISOString() };
};
const planOf = async (userId: string | undefined): Promise<string | null> => {
  if (!userId) return null;
  const [e] = await db(`explainer_events?user_id=eq.${userId}&type=eq.plan&select=meta&order=created_at.desc&limit=1`).catch(() => []);
  return e?.meta?.until && new Date(e.meta.until) > new Date() ? String(e.meta.plan) : null;
};
const KEY_OF: Record<string, string> = { Silver: "plus", Gold: "pro", Diamond: "premium" };   // plan name shown to people -> the plan key
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** What a person has used of the counted features: quick answers, in-depth answers and research questions (Read).
 *  A guest counts per day, a free member per rolling 7 days, a plan per calendar month (in-depth: always per month). */
type Use = { used: number; cap: number; left: number; period: "day" | "week" | "month" };
async function usageOf(user: { id: string } | null, actor: string, plan: string | null): Promise<{ quick: Use; deep: Use; research: Use }> {
  const tier = plan ?? (user ? "free" : "guest");
  const period: Use["period"] = !user ? "day" : plan ? "month" : "week";
  const since = period === "day" ? new Date(Date.now() - 86400_000).toISOString() : period === "week" ? new Date(Date.now() - 7 * 86400_000).toISOString() : monthStart();
  const who = user ? `user_id=eq.${user.id}` : `actor=eq.${encodeURIComponent(actor)}`;
  const [quick, deep, research] = await Promise.all([
    count(`explainer_asks?${who}&intent=in.(ask,simpler)&created_at=gte.${since}`).catch(() => 0),
    user ? count(`explainer_asks?${who}&intent=eq.deep&created_at=gte.${monthStart()}`).catch(() => 0) : Promise.resolve(0),
    count(`explainer_events?${who}&type=eq.research&created_at=gte.${since}`).catch(() => 0),
  ]);
  const mk = (used: number, cap: number, p: Use["period"]): Use => ({ used, cap, left: Math.max(0, cap - used), period: p });
  return { quick: mk(quick, TIERS[tier].quick, period), deep: mk(deep, TIERS[tier].deep, "month"), research: mk(research, TIERS[tier].research, period) };
}
// The country behind a request: the network's own header when there is one, otherwise a lookup of the address (cached, never slows a request by more than a moment).
const geoCache = new Map<string, string>();
const geoOf = async (req: Request): Promise<string> => {
  const h = (req.headers.get("cf-ipcountry") ?? "").toUpperCase();
  if (/^[A-Z]{2}$/.test(h) && h !== "XX") return h;
  const ip = clientIp(req);
  if (!ip || /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1|fc|fd)/i.test(ip)) return "";
  if (geoCache.has(ip)) return geoCache.get(ip)!;
  let c = "";
  for (const u of [`https://get.geojs.io/v1/ip/country/${encodeURIComponent(ip)}`, `https://ipapi.co/${encodeURIComponent(ip)}/country/`]) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(1500) });
      const x = (await r.text()).trim().toUpperCase();
      if (r.ok && /^[A-Z]{2}$/.test(x)) { c = x; break; }
    } catch { /* try the next one */ }
  }
  if (geoCache.size > 2000) geoCache.clear();
  geoCache.set(ip, c);
  return c;
};
const str = (v: unknown, n: number) => String(v ?? "").slice(0, n);

const publicUser = (u: { id: string; username: string; credits: number; created_at: string }) => ({ id: u.id, username: u.username, credits: u.credits, created_at: u.created_at });

// A member signs in with the e-mail address or with a username of their own (the "handle"). The e-mail stays the contact and the account key; the handle is what people see and type.
const RESERVED = new Set(["admin", "root", "support", "paperlit", "help", "staff", "system", "moderator", "owner", "null", "undefined"]);
const HANDLE_RE = /^[a-z0-9_.]{3,24}$/;
const handleOf = async (userId: string): Promise<string | null> => {
  const [e] = await db(`explainer_events?user_id=eq.${userId}&type=eq.handle&select=meta&order=created_at.desc&limit=1`).catch(() => []);
  return e?.meta?.handle ? String(e.meta.handle) : null;
};
const handleTaken = async (h: string, exceptUser?: string): Promise<boolean> => {
  const rows = await db(`explainer_events?type=eq.handle&meta->>handle=eq.${encodeURIComponent(h)}&select=user_id&limit=8`).catch(() => []);
  for (const r of rows as { user_id: string }[]) {
    if (r.user_id === exceptUser) continue;
    if ((await handleOf(r.user_id)) === h) return true;   // only the username a member has NOW counts; an old one they gave up is free again
  }
  return false;
};
const publicUserH = async (u: { id: string; username: string; credits: number; created_at: string }) => ({ ...publicUser(u), handle: await handleOf(u.id) });
/** The e-mail behind what was typed in the sign-in box: an e-mail address as it is, a username looked up. */
const resolveIdent = async (raw: string): Promise<string> => {
  const t = raw.trim().toLowerCase();
  if (t.includes("@")) return t;
  const hs = await db(`explainer_events?type=eq.handle&meta->>handle=eq.${encodeURIComponent(t)}&select=user_id&order=created_at.desc&limit=8`).catch(() => []);
  for (const h of hs as { user_id: string }[]) {
    if ((await handleOf(h.user_id)) !== t) continue;   // they changed it since
    const [u] = await db(`explainer_users?id=eq.${h.user_id}&select=username`).catch(() => []);
    if (u) return String(u.username);
  }
  return t;
};
const suggestHandle = async (email: string): Promise<string> => {
  let base = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_.]/g, "").slice(0, 18);
  if (base.length < 3) base = (base + "user").slice(0, 8);
  for (let i = 0; i < 8; i++) {
    const h = i === 0 ? base : `${base}${Math.floor(Math.random() * 9000 + 1000)}`;
    if (!RESERVED.has(h) && !(await handleTaken(h))) return h;
  }
  return `${base}${Date.now() % 100000}`;
};

const planInfo = async (userId: string | undefined): Promise<{ plan: string | null; plan_until: string | null; plan_source?: string | null }> => {
  if (!userId) return { plan: null, plan_until: null };
  const [e] = await db(`explainer_events?user_id=eq.${userId}&type=eq.plan&select=meta&order=created_at.desc&limit=1`).catch(() => []);
  const until = e?.meta?.until ? String(e.meta.until) : null;
  return until && new Date(until) > new Date() ? { plan: String(e.meta.plan), plan_until: until, plan_source: e.meta.source ? String(e.meta.source) : null } : { plan: null, plan_until: until };
};

// Students and teachers: two free weeks of Silver after an admin has looked at a proof (student card, enrolment letter, staff card or school page).
// A request is an event of type "verify" with meta {role, path, school, status: pending | approved | rejected}; the admin decides in explainer-admin.
const UP_BUCKET = "explainer-uploads";
// E-mail confirmation and password reset. Only active when a mail provider is set up (see _shared/mail.ts); members who joined before it was switched on count as confirmed.
const VERIFY_SINCE = Date.parse(Deno.env.get("EMAIL_VERIFY_SINCE") ?? "2026-11-09T06:00:00Z");
const APP_URL = Deno.env.get("APP_URL") ?? "https://bryan273.github.io/repro-suite";
const isVerified = async (u: { id: string; created_at: string }): Promise<boolean> => {
  if (Date.parse(u.created_at) < VERIFY_SINCE) return true;
  return (await count(`explainer_events?user_id=eq.${u.id}&type=eq.emailverified`).catch(() => 0)) > 0;
};
// a link token is random, only its hash is stored, and it works once
// links open the new site (/paperlit/) when the request came from it, otherwise the older explainer page
const V2_URL = Deno.env.get("V2_URL") ?? "https://bryan273.github.io/paperlit";
const sendLink = async (u: { id: string; username: string }, kind: "verify" | "reset", lang: string, app = "") => {
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const exp = new Date(Date.now() + (kind === "verify" ? 24 : 1) * 3600_000).toISOString();
  await db("explainer_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor: `mt:${await sha(token, 32)}`, type: "mailtoken", user_id: u.id, meta: { kind, exp, used: false } }) });
  const m = linkMail(kind, lang, `${app === "paperlit" ? `${V2_URL}/` : `${APP_URL}/explainer/`}?${kind === "verify" ? "verify" : "reset"}=${token}`);
  await sendMail(u.username, m.subject, m.html, m.text);
};
const takeToken = async (token: string, kind: string): Promise<{ id: string; user_id: string; meta: Record<string, unknown> } | null> => {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const [ev] = await db(`explainer_events?actor=eq.${encodeURIComponent(`mt:${await sha(token, 32)}`)}&type=eq.mailtoken&select=id,user_id,meta&order=created_at.desc&limit=1`).catch(() => []);
  if (!ev || ev.meta?.kind !== kind || ev.meta?.used || new Date(String(ev.meta?.exp)) < new Date()) return null;
  await db(`explainer_events?id=eq.${ev.id}`, { method: "PATCH", body: JSON.stringify({ meta: { ...ev.meta, used: true } }) });
  return ev;
};
const verifyOf = async (user: { id: string } | null): Promise<{ role: string; status: string } | null> => {
  if (!user) return null;
  const [e] = await db(`explainer_events?user_id=eq.${user.id}&type=eq.verify&select=meta&order=created_at.desc&limit=1`).catch(() => []);
  return e?.meta ? { role: String(e.meta.role), status: String(e.meta.status) } : null;
};
// inviting a friend: 2 free videos for the member who shared the link AND 2 for the friend who signs up with it, up to 5 friends; the two become friends
const REFERRAL_VIDEOS = 2, REFERRAL_MAX = 5;
const refCode = (id: string) => id.slice(0, 8);
const referralOf = async (user: { id: string } | null) => {
  if (!user) return null;
  const rows = await db(`explainer_events?user_id=eq.${user.id}&type=eq.referral&select=id,meta,created_at&order=created_at.desc&limit=20`).catch(() => []) as { id: string; meta: { friend?: string }; created_at: string }[];
  const names = await handlesOf(rows.map((x) => String(x.meta?.friend ?? "")).filter(Boolean));
  return { code: refCode(user.id), invited: rows.length, reward: REFERRAL_VIDEOS, max: REFERRAL_MAX, recent: rows.slice(0, 10).map((x) => ({ id: x.id, handle: names[String(x.meta?.friend ?? "")] ?? null, at: x.created_at })) };
};
/** The usernames of several members at once (the newest username of each). */
const handlesOf = async (ids: string[]): Promise<Record<string, string>> => {
  const u = [...new Set(ids)].filter((x) => /^[0-9a-f-]{36}$/.test(x));
  if (!u.length) return {};
  const rows = await db(`explainer_events?type=eq.handle&user_id=in.(${u.join(",")})&select=user_id,meta&order=created_at.desc&limit=${u.length * 6}`).catch(() => []) as { user_id: string; meta: { handle?: string } }[];
  const out: Record<string, string> = {};
  for (const x of rows) if (!out[x.user_id] && x.meta?.handle) out[x.user_id] = String(x.meta.handle);
  return out;
};

// ---- friends: a pair is friends when both sides have a "friend" event pointing at the other and no later "unfriend"; a request is a "friend_req" event on the person asked
type Ev = { id: string; user_id: string; type: string; meta: Record<string, unknown>; created_at: string };
async function friendIds(userId: string): Promise<string[]> {
  const rows = await db(`explainer_events?user_id=eq.${userId}&type=in.(friend,unfriend)&select=type,meta,created_at&order=created_at.asc&limit=2000`).catch(() => []) as Ev[];
  const st = new Map<string, boolean>();
  for (const e of rows) st.set(String(e.meta?.other ?? ""), e.type === "friend");
  return [...st.entries()].filter(([k, v]) => v && k).map(([k]) => k);
}
const befriend = async (a: string, b: string, via: string) => {
  await db("explainer_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([{ actor: "", type: "friend", user_id: a, meta: { other: b, via } }, { actor: "", type: "friend", user_id: b, meta: { other: a, via } }]) });
};
// ---- who can see a video: "private" (only the owner, and anyone the owner sends the link to), "friends" (listed for friends), "public" (listed in Explore). The newest choice counts.
const VIS = ["private", "friends", "public"];
async function visibilityOf(jobIds: string[]): Promise<Record<string, string>> {
  const ids = jobIds.filter((x) => /^[0-9a-f-]{36}$/.test(x));
  if (!ids.length) return {};
  const rows = await db(`explainer_events?type=eq.visibility&meta->>job=in.(${ids.join(",")})&select=meta,created_at&order=created_at.asc&limit=${ids.length * 8}`).catch(() => []) as Ev[];
  const out: Record<string, string> = {};
  for (const e of rows) out[String(e.meta.job)] = String(e.meta.v);
  return out;
}
/** A member's folders, rebuilt from their "folder" events (make, rename, drop, put, take), newest folder first. Trashed videos drop out. */
type Folder = { id: string; title: string; created_at: string; updated_at: string; jobs: string[] };
async function foldersOf(userId: string): Promise<Folder[]> {
  const [evs, trash] = await Promise.all([
    db(`explainer_events?user_id=eq.${userId}&type=eq.folder&select=meta,created_at&order=created_at.asc&limit=5000`).catch(() => []) as Promise<{ meta: { act: string; f: string; title?: string; job?: string }; created_at: string }[]>,
    db(`explainer_events?user_id=eq.${userId}&type=eq.trash&select=meta&order=created_at.asc&limit=3000`).catch(() => []) as Promise<{ meta: { job?: string; on?: boolean } }[]>,
  ]);
  const gone = new Set<string>();   // the newest trash event of a video counts: deleted, or restored (on: false)
  for (const t of trash) { const j = String(t.meta?.job ?? ""); if (t.meta?.on === false) gone.delete(j); else gone.add(j); }
  const by = new Map<string, Folder>();
  for (const e of evs) {
    const m = e.meta ?? ({} as typeof e.meta);
    if (m.act === "make") { by.set(m.f, { id: m.f, title: m.title ?? "Folder", created_at: e.created_at, updated_at: e.created_at, jobs: [] }); continue; }
    const f = by.get(m.f);
    if (!f) continue;
    f.updated_at = e.created_at;
    if (m.act === "rename" && m.title) f.title = m.title;
    else if (m.act === "drop") by.delete(m.f);
    else if (m.act === "put" && m.job && !f.jobs.includes(m.job)) f.jobs.push(m.job);
    else if (m.act === "take" && m.job) f.jobs = f.jobs.filter((j) => j !== m.job);
  }
  return [...by.values()].map((f) => ({ ...f, jobs: f.jobs.filter((j) => !gone.has(j)) })).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
}

type Card = { id: string; title: string | null; arxiv: string | null; langs: string | null; seconds: number | null; created_at: string; owner: string | null; source_url?: string | null; sections?: unknown };
/** Finished, not expired videos with these ids, with the owner's username, newest first. */
async function cardsOf(jobIds: string[]): Promise<Card[]> {
  const ids = jobIds.filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 300);
  if (!ids.length) return [];
  const jobs = await db(`explainer_jobs?id=in.(${ids.join(",")})&status=eq.done&expired_at=is.null&select=id,title,arxiv,langs,seconds,created_at,user_id,source_url,sections&order=created_at.desc`).catch(() => []) as (Card & { user_id: string })[];
  const names = await handlesOf(jobs.map((j) => j.user_id));
  return jobs.map(({ user_id, ...j }) => ({ ...j, sections: Array.isArray(j.sections) ? (j.sections as { poster?: string }[]).filter((x) => x?.poster).slice(0, 1).map((x) => ({ poster: x.poster })) : null, owner: names[user_id] ?? null }));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const u = new URL(req.url);
    if (req.method === "GET") {
      const user = await userOf(req);
      const actor = await actorOf(req, req.headers.get("x-visitor-id"));
      if (u.searchParams.get("whereami")) return json({ country: (await geoOf(req)) || null });   // the caller's own country as the network reports it
      if (u.searchParams.get("inbox")) {   // replies from the team to this member
        if (!user) return json({ error: "Sign in first." }, 401);
        const rows = await db(`explainer_events?user_id=eq.${user.id}&type=eq.reply&select=id,meta,created_at&order=created_at.desc&limit=50`).catch(() => []) as { id: string; meta: { text: string; about?: string }; created_at: string }[];
        return json(rows.map((r) => ({ id: r.id, text: r.meta.text, about: r.meta.about ?? "", at: r.created_at })));
      }
      if (u.searchParams.get("jobs")) {
        if (!user) return json({ error: "Sign in first." }, 401);
        const [rows, edits] = await Promise.all([
          db(`explainer_jobs?user_id=eq.${user.id}&select=id,arxiv,title,status,stage,style,tone,seconds,custom,langs,source_url,videos,sections,credit_used,refunded,created_at,expired_at&order=created_at.desc&limit=100`),
          db(`explainer_events?user_id=eq.${user.id}&type=eq.edit&select=meta&limit=500`).catch(() => []),
        ]);
        const pinfo = await planInfo(user.id);
        const forever = isAdmin(user) || !!pinfo.plan;   // a paid plan (or an admin) keeps videos; without one they go FREE_KEEP_DAYS after the later of "made" and "plan ended"
        const planEnd = pinfo.plan_until && !pinfo.plan ? Date.parse(pinfo.plan_until) : 0;
        const editJobs = new Set((edits as { meta: { job?: string } }[]).map((e) => String(e.meta?.job ?? "")));
        const vis = await visibilityOf((rows as { id: string }[]).map((r) => r.id));
        // a member's own tidying: "trash" hides a video from their list for good, "archive" parks it out of the main list (the newest choice counts)
        const flags = await db(`explainer_events?user_id=eq.${user.id}&type=in.(archive,trash)&select=type,meta&order=created_at.asc&limit=3000`).catch(() => []) as { type: string; meta: { job?: string; on?: boolean } }[];
        const trashed = new Set<string>(), archived = new Set<string>();
        for (const e of flags) { const j = String(e.meta?.job ?? ""); if (e.type === "trash") { if (e.meta?.on === false) trashed.delete(j); else trashed.add(j); } else if (e.meta?.on) archived.add(j); else archived.delete(j); }
        // a failed try that was started again and worked (or is still being made) is only noise: keep the newest try of each source
        type Row = { id: string; status: string; source_url?: string | null; arxiv?: string | null; title?: string | null };
        const live = new Set<string>();
        for (const r of rows as Row[]) if (r.status !== "failed") { const k = String(r.source_url || r.arxiv || r.title || ""); if (k) live.add(k); }
        const retried = (r: Row) => r.status === "failed" && live.has(String(r.source_url || r.arxiv || r.title || ""));
        const expiry = (r: { status: string; created_at?: string; expired_at?: string | null }) => r.status === "done" && !r.expired_at && r.created_at && !forever ? new Date(Math.max(Date.parse(r.created_at), planEnd) + FREE_KEEP_DAYS * 86400_000).toISOString() : null;
        return json((rows as Row[]).filter((r) => !trashed.has(r.id) && !retried(r)).map((r) => ({ ...r, is_edit: editJobs.has(r.id), visibility: vis[r.id] ?? "private", archived: archived.has(r.id), expires_at: expiry(r as never), kept_while_plan: forever })));
      }
      if (u.searchParams.get("trash")) {   // "Recently deleted": videos the member deleted in the last TRASH_DAYS days, each with the date it goes for good
        if (!user) return json({ error: "Sign in first." }, 401);
        const evs = await db(`explainer_events?user_id=eq.${user.id}&type=in.(trash,purged)&select=type,meta,created_at&order=created_at.asc&limit=3000`).catch(() => []) as { type: string; meta: { job?: string; on?: boolean }; created_at: string }[];
        const at = new Map<string, string>(), purged = new Set<string>();
        for (const e of evs) { const j = String(e.meta?.job ?? ""); if (e.type === "purged") purged.add(j); else if (e.meta?.on === false) at.delete(j); else at.set(j, e.created_at); }
        const ids = [...at.keys()].filter((j) => !purged.has(j) && /^[0-9a-f-]{36}$/.test(j)).slice(-100);
        if (!ids.length) return json([]);
        const rows = await db(`explainer_jobs?user_id=eq.${user.id}&id=in.(${ids.join(",")})&select=id,arxiv,title,status,seconds,langs,source_url,videos,sections,created_at,expired_at`).catch(() => []) as { id: string }[];
        return json(rows.map((r) => ({ ...r, trashed_at: at.get(r.id), purge_at: new Date(Date.parse(at.get(r.id)!) + TRASH_DAYS * 86400_000).toISOString() })).sort((a, b) => b.trashed_at!.localeCompare(a.trashed_at!)));
      }
      if (u.searchParams.get("folders")) {   // the member's folders (projects), each with its videos in the order they were put in
        if (!user) return json({ error: "Sign in first." }, 401);
        return json(await foldersOf(user.id));
      }
      if (u.searchParams.get("explore")) {   // public videos, newest first, for everyone (no sign-in needed); ?lang= narrows to one narration language
        const lang = str(u.searchParams.get("lang"), 5);
        const pub = await db(`explainer_events?type=eq.visibility&meta->>v=eq.public&select=meta&order=created_at.desc&limit=600`).catch(() => []) as Ev[];
        const ids = [...new Set(pub.map((e) => String(e.meta.job)))];
        const vis = await visibilityOf(ids);
        let cards = await cardsOf(ids.filter((id) => vis[id] === "public"));
        if (lang) cards = cards.filter((c) => (c.langs === "both" ? ["en", "zh"] : [c.langs || "en"]).includes(lang));
        const langs = [...new Set(cards.flatMap((c) => (c.langs === "both" ? ["en", "zh"] : [c.langs || "en"])))];
        return json({ videos: cards.slice(0, 120), langs });
      }
      if (u.searchParams.get("social")) {   // the member's friends with what each is learning, requests waiting for an answer, and friends who joined by the invite link
        if (!user) return json({ error: "Sign in first." }, 401);
        const [ids, reqs] = await Promise.all([
          friendIds(user.id),
          db(`explainer_events?user_id=eq.${user.id}&type=in.(friend_req,friend_req_done)&select=id,type,meta,created_at&order=created_at.asc&limit=500`).catch(() => []) as Promise<Ev[]>,
        ]);
        const open = new Map<string, string>();
        for (const e of reqs) { const f = String(e.meta?.from ?? ""); if (e.type === "friend_req") open.set(f, e.created_at); else open.delete(f); }
        for (const f of ids) open.delete(f);
        const [names, vEvs] = await Promise.all([
          handlesOf([...ids, ...open.keys()]),
          ids.length ? db(`explainer_events?type=eq.visibility&user_id=in.(${ids.join(",")})&select=user_id,meta,created_at&order=created_at.asc&limit=2000`).catch(() => []) as Promise<Ev[]> : Promise.resolve([] as Ev[]),
        ]);
        const latest = new Map<string, { v: string; owner: string }>();
        for (const e of vEvs) latest.set(String(e.meta.job), { v: String(e.meta.v), owner: e.user_id });
        const shown = [...latest.entries()].filter(([, x]) => x.v === "public" || x.v === "friends").map(([id]) => id);
        const cards = await cardsOf(shown);
        return json({
          friends: ids.map((id) => ({ id, handle: names[id] ?? null, videos: cards.filter((c) => latest.get(c.id)?.owner === id).slice(0, 6) })),
          requests: [...open.entries()].map(([from, at]) => ({ from, handle: names[from] ?? null, at })),
        });
      }
      if (u.searchParams.get("orders")) {   // the member's own orders, newest first, for the billing page
        if (!user) return json({ error: "Sign in first." }, 401);
        const rows = await db(`explainer_orders?email=eq.${encodeURIComponent("@" + user.username)}&select=id,arxiv,status,pay_method,notes,created_at&order=created_at.desc&limit=50`);
        return json(rows.map((o: { id: string; arxiv: string; status: string; pay_method: string | null; notes: string | null; created_at: string }) => {
          const n = String(o.notes ?? "");
          return { id: o.id, what: o.arxiv, status: o.status, method: o.pay_method, created_at: o.created_at, cur: /cur:([a-z]+)/.exec(n)?.[1] ?? "cny", amount: Number(/amt:(\d+)/.exec(n)?.[1] ?? /price:(\d+(?:\.\d+)?)/.exec(n)?.[1] ?? 0), shot: /shot:\S+/.test(n) };
        }));
      }
      if (u.searchParams.get("profile")) {
        if (!user) return json({ error: "Sign in first." }, 401);
        const [row] = await db(`explainer_events?user_id=eq.${user.id}&type=eq.profile&select=meta&order=created_at.desc&limit=1`);
        return json({ profile: row?.meta ?? null });
      }
      if (u.searchParams.get("ledger")) {
        if (!user) return json({ error: "Sign in first." }, 401);
        if (u.searchParams.get("ledger") === "2") {   // balance, plan, the credit log and every video with what it used (free allowance or credits)
          const [log, jobs, pe] = await Promise.all([
            db(`explainer_credit_log?user_id=eq.${user.id}&select=created_at,delta,reason&order=created_at.desc&limit=200`),
            db(`explainer_jobs?user_id=eq.${user.id}&select=id,title,arxiv,status,seconds,custom,credit_used,refunded,created_at&order=created_at.desc&limit=100`),
            planInfo(user.id),
          ]);
          const q = await quotaFor(user, "");
          const month = new Date(monthStart());
          const vids = (jobs as { id: string; title: string | null; arxiv: string | null; status: string; seconds: number; custom: string | null; credit_used: number; refunded: boolean; created_at: string }[]).map((j) => ({ id: j.id, title: j.title || j.arxiv || "Video", status: j.status, minutes: Math.round((j.seconds || 0) / 60), deep: /In-depth: yes/.test(j.custom ?? ""), credits: j.credit_used || 0, units: units(j.seconds, j.custom), refunded: !!j.refunded, created_at: j.created_at }));
          const made = vids.filter((v) => v.status !== "failed" && new Date(v.created_at) >= month);
          return json({ balance: user.credits, plan: pe.plan, plan_until: pe.plan_until, free: { limit: q.day_limit, left: q.day_left, resets_in_min: q.resets_in_min }, month: { videos: made.length, credits: made.reduce((n, v) => n + v.credits, 0), free: made.reduce((n, v) => n + Math.max(0, v.units - v.credits), 0) }, log, videos: vids });
        }
        return json(await db(`explainer_credit_log?user_id=eq.${user.id}&select=created_at,delta,reason&order=created_at.desc&limit=50`));
      }
      // everything the app needs about this person, asked of the database at the same time (one round trip instead of a dozen)
      const [pi, plan] = await Promise.all([planInfo(user?.id), user ? activePlan(user.id) : Promise.resolve(null)]);
      const [iu, usage, su, offer, verify, referral, pu, quota] = await Promise.all([
        interactiveUse(user, actor, plan), usageOf(user, actor, plan),
        user ? db(`explainer_events?user_id=eq.${user.id}&type=eq.signup&select=meta&limit=1`).then((x: unknown[]) => x[0] as { meta?: { country?: string } } | undefined).catch(() => undefined) : Promise.resolve(undefined),
        welcomeOffer(user), verifyOf(user), referralOf(user), user ? publicUserH(user) : Promise.resolve(null), quotaFor(user, actor),
      ]);
      // the country given at sign-up: the pricing page shows that money first
      if (isAdmin(user) && !pi.plan) { pi.plan = "premium"; pi.plan_until = new Date(Date.now() + 3650 * 86400_000).toISOString(); pi.plan_source = "admin"; }   // an admin account is never shown as Free
      return json({ ...pi, country: su?.meta?.country ?? null, interactive: { used: iu.used, cap: iu.cap, left: iu.left, resets: iu.resets, jobs: iu.jobs, period: iu.period }, usage, tiers: TIERS, offer, verify, referral, admin: !!user && ADMIN_EMAILS.includes(String(user.username).toLowerCase()), user: pu, quota, limits: { guest: GUEST_DAY, member: MEMBER_WEEK, welcome: WELCOME_CREDITS }, packs: PACKS });
    }

    const body = await req.json();
    const actor = await actorOf(req, body.visitor);
    const op = String(body.op ?? "");

    if (op === "event") {
      const type = String(body.type ?? "");
      if (!EVENTS.has(type)) return json({ error: "unknown event" }, 400);
      const user = await userOf(req);
      await logEvent(actor, type, type === "leave"
        ? { path: str(body.path, 80), sec: Math.max(0, Math.min(7200, Math.round(Number(body.sec) || 0))), sid: str(body.sid, 12), pages: Math.max(1, Math.min(200, Math.round(Number(body.pages) || 1))) }
        : { path: str(body.path, 80), ref: str(body.ref, 80), arxiv: str(body.arxiv, 60), k: str(body.k, 12), ...(type === "visit" ? { country: await geoOf(req), iph: await sha(`${clientIp(req)}|explainer-ip`, 6) } : {}) }, user?.id ?? null);
      return json({ ok: true });
    }

    if (op === "proof_upload_url") {   // step 1 of sending a proof: a one-time address into the private bucket
      const user = await userOf(req);
      if (!user) return json({ error: "Sign in first." }, 401);
      const ext = String(body.ext ?? "").toLowerCase();
      const size = Math.round(Number(body.size) || 0);
      if (!["jpg", "jpeg", "png", "webp", "pdf"].includes(ext)) return json({ error: "Send a photo (JPG, PNG, WebP) or a PDF." }, 400);
      if (!(size >= 1000 && size <= 6 * 1024 * 1024)) return json({ error: size > 6 * 1024 * 1024 ? "That file is larger than 6 MB." : "That file looks empty." }, 400);
      const st = body.purpose === "payment" ? null : await verifyOf(user);   // a payment screenshot is not a student proof and may be sent any time
      if (st && (st.status === "pending" || st.status === "approved")) return json({ error: st.status === "pending" ? "Your proof is already being checked." : "You already used your free month." }, 409);
      const path = `proof/${user.id}/${crypto.randomUUID()}.${ext}`;
      const sg = await fetch(`${Deno.env.get("SUPABASE_URL")}/storage/v1/object/upload/sign/${UP_BUCKET}/${path}`, { method: "POST", headers: { apikey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, Authorization: `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!}`, "Content-Type": "application/json" }, body: "{}" });
      if (!sg.ok) throw new Error(`upload address ${sg.status}`);
      const { url: signed } = await sg.json();
      return json({ path, upload_url: `${Deno.env.get("SUPABASE_URL")}/storage/v1${signed}` });
    }
    if (op === "set_handle") {
      const user = await userOf(req);
      if (!user) return json({ error: "Sign in first." }, 401);
      const h = str(body.handle, 24).trim().toLowerCase();
      if (!HANDLE_RE.test(h) || RESERVED.has(h)) return json({ error: "Username: 3 to 24 letters, numbers, dots or underscores.", code: "bad_handle" }, 400);
      if (await handleTaken(h, user.id)) return json({ error: "That username is taken. Choose another one.", code: "handle_taken" }, 409);
      if ((await count(`explainer_events?user_id=eq.${user.id}&type=eq.handle&created_at=gte.${new Date(Date.now() - 86400_000).toISOString()}`)) >= 3) return json({ error: "You changed it a lot today. Try again tomorrow.", code: "slow_down" }, 429);
      await logEvent("", "handle", { handle: h }, user.id);
      return json({ ok: true, handle: h });
    }
    if (op === "order_proof") {   // attach a payment screenshot to one of the member's own orders, so the owner can see it when confirming
      const user = await userOf(req);
      if (!user) return json({ error: "Sign in first." }, 401);
      const orderId = String(body.order ?? "");
      const path = String(body.path ?? "");
      if (!/^[0-9a-f-]{36}$/.test(orderId) || !path.startsWith(`proof/${user.id}/`) || !/^proof\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$/.test(path)) return json({ error: "That file was not found. Please choose it again." }, 400);
      const [o] = await db(`explainer_orders?id=eq.${orderId}&select=notes`);
      if (!o || !String(o.notes ?? "").includes(`user:${user.id}`)) return json({ error: "Order not found." }, 404);
      await db(`explainer_orders?id=eq.${orderId}`, { method: "PATCH", body: JSON.stringify({ notes: `${String(o.notes).replace(/ shot:\S+/g, "")} shot:${path}` }) });
      return json({ ok: true });
    }
    if (op === "proof_submit") {
      const user = await userOf(req);
      if (!user) return json({ error: "Sign in first." }, 401);
      const role = body.role === "teacher" ? "teacher" : "student";
      const path = String(body.path ?? "");
      if (!path.startsWith(`proof/${user.id}/`) || !/^proof\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(jpg|jpeg|png|webp|pdf)$/.test(path)) return json({ error: "That file was not found. Please choose it again." }, 400);
      const st = await verifyOf(user);
      if (st && (st.status === "pending" || st.status === "approved")) return json({ error: "You already sent a proof." }, 409);
      await logEvent("", "verify", { role, path, school: str(body.school, 120), status: "pending" }, user.id);
      return json({ ok: true, verify: { role, status: "pending" } });
    }

    if (op === "folder") {   // make, rename or remove a folder; put a video in or take it out (a video may sit in several folders)
      const user = await userOf(req);
      if (!user) return json({ error: "Sign in first." }, 401);
      const act = String(body.act ?? "");
      const mine = await foldersOf(user.id);
      if (act === "make") {
        const title = str(body.title, 80).replace(/\s+/g, " ").trim();
        if (!title) return json({ error: "Give the folder a name." }, 400);
        if (mine.length >= 50) return json({ error: "You have 50 folders. Remove one first." }, 409);
        const f = crypto.randomUUID();
        await logEvent("", "folder", { act, f, title }, user.id);
        return json({ ok: true, folder: { id: f, title, created_at: new Date().toISOString(), jobs: [] } });
      }
      const f = String(body.f ?? "");
      const cur = mine.find((x) => x.id === f);
      if (!cur) return json({ error: "That folder was not found." }, 404);
      if (act === "rename") {
        const title = str(body.title, 80).replace(/\s+/g, " ").trim();
        if (!title) return json({ error: "Give the folder a name." }, 400);
        await logEvent("", "folder", { act, f, title }, user.id);
        return json({ ok: true });
      }
      if (act === "drop") { await logEvent("", "folder", { act, f }, user.id); return json({ ok: true }); }   // the videos themselves stay in the library
      if (act === "put" || act === "take") {
        const job = String(body.job ?? "");
        if (!/^[0-9a-f-]{36}$/.test(job)) return json({ error: "Choose a video." }, 400);
        if (act === "put") {
          const [own] = await db(`explainer_jobs?id=eq.${job}&user_id=eq.${user.id}&select=id`).catch(() => []);
          if (!own) return json({ error: "Only your own videos can go in your folders." }, 403);
          if (cur.jobs.length >= 100) return json({ error: "A folder holds up to 100 videos." }, 409);
        }
        await logEvent("", "folder", { act, f, job }, user.id);
        return json({ ok: true });
      }
      return json({ error: "Unknown folder action." }, 400);
    }
    if (op === "rename_job") {   // the maker gives one of their own videos another title
      const user = await userOf(req);
      if (!user) return json({ error: "Sign in first." }, 401);
      const job = String(body.job ?? "");
      const title = str(body.title, 140).replace(/\s+/g, " ").trim();
      if (!/^[0-9a-f-]{36}$/.test(job)) return json({ error: "Choose a video." }, 400);
      if (title.length < 1) return json({ error: "Write a title." }, 400);
      const [own] = await db(`explainer_jobs?id=eq.${job}&user_id=eq.${user.id}&select=id`).catch(() => []);
      if (!own) return json({ error: "Only the person who made a video can do this." }, 403);
      await db(`explainer_jobs?id=eq.${job}&user_id=eq.${user.id}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ title }) });
      return json({ ok: true, title });
    }
    if (op === "archive_job" || op === "delete_job" || op === "restore_job") {   // the maker tidies their own library: archive and delete can be undone (a deleted video is removed for good after 7 days)
      const user = await userOf(req);
      if (!user) return json({ error: "Sign in first." }, 401);
      const job = String(body.job ?? "");
      if (!/^[0-9a-f-]{36}$/.test(job)) return json({ error: "Choose a video." }, 400);
      const [own] = await db(`explainer_jobs?id=eq.${job}&user_id=eq.${user.id}&select=id,status`).catch(() => []);
      if (!own) return json({ error: "Only the person who made a video can do this." }, 403);
      if (op === "restore_job") {
        await logEvent("", "trash", { job, on: false }, user.id);
        return json({ ok: true, restored: true });
      }
      if (op === "delete_job") {
        if (own.status === "queued" || own.status === "running") return json({ error: "This video is still being made. Delete it when it is ready or has failed." }, 409);
        await logEvent("", "trash", { job, on: true }, user.id);
        await logEvent("", "visibility", { job, v: "private" }, user.id);   // and it leaves Explore and friends' lists at once
        return json({ ok: true, deleted: true });
      }
      const on = body.on !== false;
      await logEvent("", "archive", { job, on }, user.id);
      return json({ ok: true, archived: on });
    }
    if (op === "set_visibility") {   // who can find one of the member's own videos
      const user = await userOf(req);
      if (!user) return json({ error: "Sign in first." }, 401);
      const job = String(body.job ?? ""), v = String(body.v ?? "");
      if (!/^[0-9a-f-]{36}$/.test(job) || !VIS.includes(v)) return json({ error: "Choose private, friends or public." }, 400);
      const [own] = await db(`explainer_jobs?id=eq.${job}&user_id=eq.${user.id}&select=id`).catch(() => []);
      // an admin may also list any finished video in Explore (the examples on the landing page belong to no account)
      if (!own && !isAdmin(user)) return json({ error: "Only the person who made a video can change who sees it." }, 403);
      await logEvent("", "visibility", { job, v }, user.id);
      return json({ ok: true, visibility: v });
    }
    if (op === "friend_add" || op === "friend_answer" || op === "friend_remove") {
      const user = await userOf(req);
      if (!user) return json({ error: "Sign in first." }, 401);
      if (op === "friend_remove") {
        const other = String(body.id ?? "");
        if (!/^[0-9a-f-]{36}$/.test(other)) return json({ error: "Unknown friend." }, 400);
        await db("explainer_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([{ actor: "", type: "unfriend", user_id: user.id, meta: { other } }, { actor: "", type: "unfriend", user_id: other, meta: { other: user.id } }]) });
        return json({ ok: true });
      }
      if (op === "friend_answer") {
        const from = String(body.from ?? "");
        if (!/^[0-9a-f-]{36}$/.test(from)) return json({ error: "Unknown request." }, 400);
        const asked = await count(`explainer_events?user_id=eq.${user.id}&type=eq.friend_req&meta->>from=eq.${from}`).catch(() => 0);
        if (!asked) return json({ error: "That request was not found." }, 404);
        await logEvent("", "friend_req_done", { from, accepted: body.accept === true }, user.id);
        if (body.accept === true && !(await friendIds(user.id)).includes(from)) await befriend(user.id, from, "request");
        return json({ ok: true });
      }
      const h = str(body.handle, 40).trim().toLowerCase().replace(/^@/, "");
      if (!HANDLE_RE.test(h)) return json({ error: "Write their username (3 to 24 letters, numbers, dots or underscores)." }, 400);
      const target = await resolveIdent(h);
      const [t] = target.includes("@") ? await db(`explainer_users?username=eq.${encodeURIComponent(target)}&select=id,banned`).catch(() => []) : [];
      if (!t || t.banned) return json({ error: "No member has that username.", code: "no_user" }, 404);
      if (t.id === user.id) return json({ error: "That is your own username." }, 400);
      if ((await friendIds(user.id)).includes(t.id)) return json({ ok: true, state: "friends" });
      // they asked me already: this answers it
      const theyAsked = await count(`explainer_events?user_id=eq.${user.id}&type=eq.friend_req&meta->>from=eq.${t.id}`).catch(() => 0);
      if (theyAsked) { await logEvent("", "friend_req_done", { from: t.id, accepted: true }, user.id); await befriend(user.id, t.id, "request"); return json({ ok: true, state: "friends" }); }
      if ((await count(`explainer_events?actor=eq.${user.id}&type=eq.friend_req&created_at=gte.${new Date(Date.now() - 86400_000).toISOString()}`).catch(() => 0)) >= 30) return json({ error: "That is a lot of requests today. Try again tomorrow.", code: "slow_down" }, 429);
      await logEvent(user.id, "friend_req", { from: user.id }, t.id);
      return json({ ok: true, state: "sent" });
    }

    if (op === "profile_save") {
      const user = await userOf(req);
      if (!user) return json({ error: "Sign in first." }, 401);
      const pick = (v: unknown, ok: string[]) => (ok.includes(String(v)) ? String(v) : "");
      const profile = {
        purpose: pick(body.purpose, ["study", "research", "teach", "share", "curious"]),
        level: pick(body.level, ["beginner", "intermediate", "expert"]),
        field: str(body.field, 60), goal: str(body.goal, 140),
        size: pick(body.size, ["sm", "md", "lg"]), font: pick(body.font, ["sans", "serif", "plain"]),
        interactive: body.interactive === true, askModel: pick(body.askModel, ["fast", "deep"]),
        // what the member is here to get done, and the day it is due (the exam, the lesson): the make page and the home page start from it
        aim: pick(body.aim, ["exam", "homework", "understand", "teach", "skim"]),
        deadline: /^\d{4}-\d{2}-\d{2}$/.test(String(body.deadline ?? "")) ? String(body.deadline) : "",
      };
      await logEvent("", "profile", profile, user.id);
      return json({ ok: true });
    }

    if (op === "register") {
      // the sign-in name is an e-mail address; nothing is sent to it and it is not verified (the stored column is still called username)
      const username = str(body.email ?? body.username, 80).trim().toLowerCase(), password = String(body.password ?? "");
      if (!EMAIL.test(username) || username.length > 80) return json({ error: "Enter a valid email address." }, 400);
      let handle = str(body.handle, 24).trim().toLowerCase();
      if (handle && (!HANDLE_RE.test(handle) || RESERVED.has(handle))) return json({ error: "Username: 3 to 24 letters, numbers, dots or underscores.", code: "bad_handle" }, 400);
      const country = str(body.country, 2).toUpperCase(), plang = str(body.lang, 2).toLowerCase();
      if (!/^[A-Z]{2}$/.test(country)) return json({ error: "Choose your country.", code: "need_country" }, 400);
      if (!["en", "zh", "vi", "id"].includes(plang)) return json({ error: "Choose your preferred language.", code: "need_lang" }, 400);
      if (password.length < 8 || password.length > 72) return json({ error: "Password: 8 to 72 characters." }, 400);
      // the visitor id comes from the browser, so sign-ups are also counted per network address (generous, for shared campus connections)
      const ipActor = await sha(`${clientIp(req)}|explainer-ip`);
      const rc = String(body.ref ?? "").toLowerCase();
      // every check at once: the limits, the address, the username, the country of the connection, the friend's link, and the password hash
      const [perBrowser, perNet, existing, taken, ipCountry, inviter, pw] = await Promise.all([
        count(`explainer_events?actor=eq.${actor}&type=eq.signup&created_at=gte.${new Date(Date.now() - 3600_000).toISOString()}`),
        count(`explainer_events?actor=eq.${ipActor}&type=eq.signup_ip&created_at=gte.${new Date(Date.now() - 86400_000).toISOString()}`),
        db(`explainer_users?username=eq.${encodeURIComponent(username)}&select=id`),
        handle ? handleTaken(handle) : Promise.resolve(false),
        geoOf(req),
        /^[0-9a-f]{8}$/.test(rc) ? (async () => {
          const [inv] = await db(`explainer_users?id=gte.${rc}-0000-0000-0000-000000000000&id=lte.${rc}-ffff-ffff-ffff-ffffffffffff&select=id,credits&limit=1`).catch(() => []);
          if (!inv) return null;
          const [same, done] = await Promise.all([count(`explainer_events?actor=eq.${actor}&user_id=eq.${inv.id}&type=eq.signup`), count(`explainer_events?user_id=eq.${inv.id}&type=eq.referral`)]);
          return !same && done < REFERRAL_MAX ? inv as { id: string; credits: number } : null;   // never from the inviter's own browser, at most 5 friends
        })().catch(() => null) : Promise.resolve(null),
        hashPassword(password),
      ]);
      if (perBrowser >= 3) return json({ error: "Too many sign-ups from here. Try again later." }, 429);
      if (perNet >= 10) return json({ error: "Too many sign-ups from this network today. Try again tomorrow." }, 429);
      if ((existing as unknown[]).length) return json({ error: "That email already has an account. Log in instead." }, 409);
      if (taken) return json({ error: "That username is taken. Choose another one.", code: "handle_taken" }, 409);
      const bonus = inviter ? REFERRAL_VIDEOS : 0;
      const [user] = await db("explainer_users?select=id,username,credits,created_at", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ username, salt: pw.salt, pass_hash: pw.hash, credits: WELCOME_CREDITS + bonus, last_login: new Date().toISOString() }) });
      if (!handle) handle = await suggestHandle(username);
      const later: Promise<unknown>[] = [
        db("explainer_credit_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify([{ user_id: user.id, delta: WELCOME_CREDITS, reason: "welcome gift" }, ...(bonus ? [{ user_id: user.id, delta: bonus, reason: "joined with a friend's link" }] : [])]) }),
        logEvent("", "handle", { handle }, user.id),
        logEvent(actor, "signup", { username, country, lang: plang, source: str(body.source, 24), role: str(body.role, 24), ip_country: ipCountry, ref: inviter ? inviter.id : "" }, user.id),
        logEvent(ipActor, "signup_ip", {}, user.id),
      ];
      if (inviter && inviter.id !== user.id) {
        later.push((async () => {
          await db(`explainer_users?id=eq.${inviter.id}`, { method: "PATCH", body: JSON.stringify({ credits: inviter.credits + REFERRAL_VIDEOS }) });
          await db("explainer_credit_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: inviter.id, delta: REFERRAL_VIDEOS, reason: "friend joined" }) });
          await logEvent(actor, "referral", { friend: user.id }, inviter.id);
          await befriend(inviter.id, user.id, "invite");
        })().catch(() => undefined));   // a failed reward never blocks a sign-up
      }
      await Promise.all(later);
      const pub = { ...publicUser(user), handle };
      if (mailReady()) {
        try { await sendLink(user, "verify", plang, str(body.app, 16)); return json({ pending: true, email: username, user: pub }); }
        catch { await logEvent(actor, "mail_fail", { kind: "verify" }, user.id); /* never lock a new member out because the mail provider failed */ }
      }
      const token = await newSession(user.id);
      // a brand-new account has made nothing yet, so its allowance is known without asking the database
      const quota: Quota = { tier: "member", period: "week", day_limit: isAdmin(user) ? 9999 : MEMBER_WEEK, day_used: 0, day_left: isAdmin(user) ? 9999 : MEMBER_WEEK, credits: user.credits, resets_in_min: null };
      return json({ token, user: pub, quota, friend_bonus: bonus });
    }

    if (op === "verify_email") {
      const ev = await takeToken(String(body.token ?? ""), "verify");
      if (!ev) return json({ error: "This confirmation link is not valid any more. Log in and ask for a new one.", code: "bad_token" }, 400);
      await logEvent("", "emailverified", {}, ev.user_id);
      const [row] = await db(`explainer_users?id=eq.${ev.user_id}&select=id,username,credits,created_at`);
      return json({ token: await newSession(row.id), user: await publicUserH(row), quota: await quotaFor(row, actor) });
    }

    if (op === "resend_verify") {
      const username = await resolveIdent(str(body.username, 80));
      if (!mailReady()) return json({ error: "E-mail is not set up yet. Please contact us.", code: "mail_off" }, 503);
      const [row] = await db(`explainer_users?username=eq.${encodeURIComponent(username)}&select=id,username,created_at`);
      if (row && !(await isVerified(row))) {
        if ((await count(`explainer_events?user_id=eq.${row.id}&type=eq.mailtoken&created_at=gte.${new Date(Date.now() - 3600_000).toISOString()}`)) >= 3) return json({ error: "Too many e-mails. Try again in an hour.", code: "slow_down" }, 429);
        await sendLink(row, "verify", ["zh", "vi", "id"].includes(str(body.lang, 2)) ? str(body.lang, 2) : "en", str(body.app, 16)).catch(() => undefined);
      }
      return json({ ok: true });   // the same answer whether the address has an account or not
    }

    if (op === "reset_request") {
      const username = await resolveIdent(str(body.username, 80));
      if (!mailReady()) return json({ error: "Resetting by e-mail is not set up yet. Please contact us and we will reset it for you.", code: "mail_off" }, 503);
      const [row] = await db(`explainer_users?username=eq.${encodeURIComponent(username)}&select=id,username,created_at,banned`);
      if (row && !row.banned) {
        if ((await count(`explainer_events?user_id=eq.${row.id}&type=eq.mailtoken&created_at=gte.${new Date(Date.now() - 3600_000).toISOString()}`)) >= 3) return json({ error: "Too many e-mails. Try again in an hour.", code: "slow_down" }, 429);
        await sendLink(row, "reset", ["zh", "vi", "id"].includes(str(body.lang, 2)) ? str(body.lang, 2) : "en", str(body.app, 16)).catch(() => undefined);
      }
      return json({ ok: true });
    }

    if (op === "reset_confirm") {
      const password = String(body.password ?? "");
      if (password.length < 8 || password.length > 72) return json({ error: "Password: 8 to 72 characters.", code: "bad_password" }, 400);
      const ev = await takeToken(String(body.token ?? ""), "reset");
      if (!ev) return json({ error: "This reset link is not valid any more. Ask for a new one.", code: "bad_token" }, 400);
      const { salt, hash } = await hashPassword(password);
      await db(`explainer_users?id=eq.${ev.user_id}`, { method: "PATCH", body: JSON.stringify({ salt, pass_hash: hash }) });
      await db(`explainer_sessions?user_id=eq.${ev.user_id}`, { method: "DELETE" }).catch(() => undefined);   // anyone who was signed in with the old password is signed out
      if (!(await count(`explainer_events?user_id=eq.${ev.user_id}&type=eq.emailverified`).catch(() => 0))) await logEvent("", "emailverified", {}, ev.user_id);   // the link proves the address
      const [row] = await db(`explainer_users?id=eq.${ev.user_id}&select=id,username,credits,created_at`);
      return json({ token: await newSession(row.id), user: await publicUserH(row), quota: await quotaFor(row, actor) });
    }

    if (op === "login") {
      const username = await resolveIdent(str(body.username, 80)), password = String(body.password ?? "");
      const since = new Date(Date.now() - 15 * 60_000).toISOString();
      if (await count(`explainer_events?actor=eq.${actor}&type=eq.login_fail&created_at=gte.${since}`) >= 8) return json({ error: "Too many wrong attempts. Wait 15 minutes." }, 429);
      const rows = await db(`explainer_users?username=eq.${encodeURIComponent(username)}&select=id,username,credits,created_at,salt,pass_hash,banned`);
      const row = rows[0];
      const ok = row && sameText((await hashPassword(password, row.salt)).hash, row.pass_hash);
      if (!ok) { await logEvent(actor, "login_fail", { username }); return json({ error: "Wrong email or password." }, 401); }
      if (row.banned) return json({ error: "This account is disabled. Please contact us." }, 403);
      if (mailReady() && !(await isVerified(row))) return json({ error: "Please confirm your e-mail first. We sent you a link.", code: "need_verify", email: row.username }, 403);
      const [token, pu, quota] = await Promise.all([
        newSession(row.id), publicUserH(row), quotaFor(row, actor),
        db(`explainer_users?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify({ last_login: new Date().toISOString() }) }),
        logEvent(actor, "login", {}, row.id),
      ]);
      return json({ token, user: pu, quota });
    }

    const user = await userOf(req);

    if (op === "logout") {
      const t = req.headers.get("x-session") ?? "";
      if (/^[0-9a-f]{64}$/.test(t)) await db(`explainer_sessions?token_hash=eq.${await sha(t, 32)}`, { method: "DELETE" });
      return json({ ok: true });
    }

    if (op === "password") {
      if (!user) return json({ error: "Sign in first." }, 401);
      const rows = await db(`explainer_users?id=eq.${user.id}&select=salt,pass_hash`);
      if (!sameText((await hashPassword(String(body.old ?? ""), rows[0].salt)).hash, rows[0].pass_hash)) return json({ error: "Current password is wrong." }, 401);
      const next = String(body.password ?? "");
      if (next.length < 8 || next.length > 72) return json({ error: "Password: 8 to 72 characters." }, 400);
      const { salt, hash } = await hashPassword(next);
      await db(`explainer_users?id=eq.${user.id}`, { method: "PATCH", body: JSON.stringify({ salt, pass_hash: hash }) });
      await db(`explainer_sessions?user_id=eq.${user.id}`, { method: "DELETE" });
      const token = await newSession(user.id);
      return json({ ok: true, token });
    }

    if (op === "contact") {
      const message = str(body.message, 3000).trim(), email = str(body.email, 200).trim();
      if (message.length < 5) return json({ error: "Please write a message." }, 400);
      if (email && !EMAIL.test(email)) return json({ error: "That email does not look right." }, 400);
      if (await count(`explainer_events?actor=eq.${actor}&type=eq.contact&created_at=gte.${new Date(Date.now() - 3600_000).toISOString()}`) >= 5) return json({ error: "Too many messages. Try again later." }, 429);
      await db("explainer_feedback", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ rating: 0, use_case: str(body.topic, 40) || "question", comment: message, email: email || (user ? `@${user.username}` : ""), arxiv: str(body.name, 80), kind: "contact" }) });
      await logEvent(actor, "contact", { topic: str(body.topic, 40) }, user?.id ?? null);
      // the owner hears about it at once when e-mail is set up; otherwise the admin page shows it with a badge
      const owner = Deno.env.get("SUPPORT_NOTIFY_EMAIL") ?? ADMIN_EMAILS[0];
      if (owner && mailReady()) {
        const who = email || (user ? user.username : "a visitor");
        const plain = `${who} wrote (${str(body.topic, 40) || "question"}):

${message}`;
        sendMail(owner, `Paperlit: a person asked for help (${str(body.topic, 40) || "question"})`, `<pre style="font:14px/1.5 system-ui;white-space:pre-wrap">${plain.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</pre>`, plain).catch(() => undefined);
      }
      return json({ ok: true });
    }

    if (op === "research_start") {   // Read: one research question is counted when it starts (guest per day, free per week, plan per month)
      const plan = user ? await activePlan(user.id) : null;
      const u = (await usageOf(user, actor, plan)).research;
      if (u.left <= 0 && !(user && ADMIN_EMAILS.includes(String(user.username).toLowerCase()))) {
        const next = ({ free: "Silver", plus: "Gold", pro: "Diamond" } as Record<string, string>)[plan ?? (user ? "free" : "")];
        const per = u.period === "day" ? "today" : u.period === "week" ? "this week" : "this month";
        return json({ error: !user ? "Sign up free to ask more research questions." : next ? `You used the ${u.cap} research questions your plan gives ${per}. ${next} gives ${TIERS[KEY_OF[next]].research} a month.` : `You used the ${u.cap} research questions for ${per}. They come back on the 1st.`, code: user ? "research_quota" : "research_signup", usage: u }, 429);
      }
      await logEvent(actor, "research", { goal: str(body.goal, 200) }, user?.id ?? null);
      return json({ ok: true, left: u.left - 1, cap: u.cap, period: u.period });
    }

    if (op === "buy") {   // a credit pack: the member pays by WeChat / Alipay, the owner confirms in the admin page and the credits are added
      if (!user) return json({ error: "Sign in to buy credits." }, 401);
      const plan = body.plan ? String(body.plan) : ""; const pack = plan ? PLANS[plan] : PACKS[String(body.pack)];
      if (!pack) return json({ error: "Unknown pack." }, 400);
const cur = body.currency === "vnd" || body.currency === "idr" ? body.currency as "vnd" | "idr" : "cny";
      const loc = LOCAL[plan || `pack_${String(body.pack)}`];
      const regular = cur === "cny" || !loc ? pack.price : loc[cur];
      // a plan bought while another is running: pay only for what is new (see _shared/proration.ts)
      let q: Quote | null = null;
      if (plan) {
        const [ev] = await db(`explainer_events?user_id=eq.${user.id}&type=eq.plan&select=meta&order=created_at.desc&limit=1`).catch(() => []);
        q = quote(Date.now(), ev?.meta?.plan && ev.meta.until ? { plan: String(ev.meta.plan), until: String(ev.meta.until) } : null, plan, PLANS, LOCAL, cur, regular);
        if (q.kind === "refused") return json({ error: `You already have a higher plan until ${q.until.slice(0, 10)}. You can choose this one after it ends.`, code: "plan_lower" }, 409);
      }
      const prorated = q && (q.kind === "upgrade_same_end" || q.kind === "upgrade_new_period") ? q : null;
      const offer = plan.endsWith("_month") && !prorated && q?.kind !== "renew" ? await welcomeOffer(user) : null;
      const amt = prorated ? prorated.amount : offer ? (cur === "cny" ? Math.round(regular * (100 - offer.pct) / 100) : Math.round(regular * (100 - offer.pct) / 100 / 1000) * 1000) : regular;
      const credits = prorated ? prorated.credits : pack.credits;
      const upg = prorated ? ` upg:${prorated.kind === "upgrade_same_end" ? "A" : "B"}:${prorated.until}` : q?.kind === "renew" ? " renew:1" : "";
      const [order] = await db("explainer_orders?select=id", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ email: `@${user.username}`, arxiv: plan ? `plan ${plan}` : `credits x${pack.credits}`, language: "en", notes: `pack:${credits} user:${user.id} price:${pack.price}${plan ? ` plan:${plan}` : ""} cur:${cur} amt:${amt}${offer ? " offer:welcome" : ""}${upg}`, status: "new" }) });
      await logEvent(actor, "order_created", { pack: credits, price: pack.price, ...(prorated ? { upgrade: prorated.kind } : {}) }, user.id);
      return json({ id: order.id, price: pack.price, credits, currency: cur, amount: amt, ...(prorated ? { prorated: { days_left: prorated.daysLeft, off: prorated.off, regular, same_end: prorated.kind === "upgrade_same_end", until: prorated.until } } : {}), ...(q?.kind === "renew" ? { renew_until: q.until } : {}) });
    }

    return json({ error: "unknown op" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
