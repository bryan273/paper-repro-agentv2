// Accounts for Paper Explainer: username + password sign-up and sign-in, the balance, the member's own videos, credit-pack orders,
// the contact form and the usage events behind the admin dashboard.
//   GET  ?me=1              (x-session optional) -> { user|null, quota }
//   GET  ?jobs=1            (x-session)          -> the member's own videos
//   GET  ?ledger=1          (x-session)          -> credit history
//   POST {op:"register"|"login"|"logout"|"password"|"event"|"contact"|"buy", ...}
import { CORS, json, db, sha, clientIp, actorOf, userOf, quotaFor, logEvent, TIERS, interactiveUse, activePlan, hashPassword, sameText, newSession, count, WELCOME_CREDITS, GUEST_DAY, MEMBER_DAY } from "../_shared/explainer.ts";

const EVENTS = new Set(["visit", "open_signup", "view_pricing", "view_example", "play_example", "click_make", "click_buy", "order_created", "order_paid_claimed", "share", "download", "video_play", "video_download"]);
import { ADMIN_EMAILS } from "../_shared/explainer.ts";
import { mailReady, sendMail, linkMail } from "../_shared/mail.ts";
const PACKS: Record<string, { credits: number; price: number }> = { "5": { credits: 5, price: 19 }, "20": { credits: 20, price: 59 }, "50": { credits: 50, price: 129 } };   // single videos: about CNY 2.6 to 3.8 each, credits never expire
// subscriptions: the videos of the period are added as credits when the payment is confirmed; the plan sets the monthly interactive videos and the in-depth answers (TIERS in _shared)
const PLANS: Record<string, { credits: number; price: number; days: number }> = {
  plus_month: { credits: 50, price: 33, days: 31 }, plus_year: { credits: 600, price: 330, days: 366 },   // Plus: 50 videos, 10 interactive, 10 in-depth answers per video
  pro_month: { credits: 120, price: 59, days: 31 }, pro_year: { credits: 1440, price: 590, days: 366 },   // Pro: 120 videos, 30 interactive, 20 in-depth, 10 minute videos
  premium_month: { credits: 250, price: 109, days: 31 }, premium_year: { credits: 3000, price: 1090, days: 366 },   // Premium: 250 videos, 80 interactive, 30 in-depth
};
// the same prices in the money of each market (kept in step with the front end, lib/currency.ts); the owner confirms the amount in this money, no exchange rate is involved
const LOCAL: Record<string, { vnd: number; idr: number }> = {
  plus_month: { vnd: 89000, idr: 79000 }, plus_year: { vnd: 890000, idr: 790000 }, pro_month: { vnd: 159000, idr: 139000 }, pro_year: { vnd: 1590000, idr: 1390000 },
  premium_month: { vnd: 299000, idr: 259000 }, premium_year: { vnd: 2990000, idr: 2590000 },
  pack_5: { vnd: 69000, idr: 45000 }, pack_20: { vnd: 209000, idr: 139000 }, pack_50: { vnd: 459000, idr: 299000 },
};
const planOf = async (userId: string | undefined): Promise<string | null> => {
  if (!userId) return null;
  const [e] = await db(`explainer_events?user_id=eq.${userId}&type=eq.plan&select=meta&order=created_at.desc&limit=1`).catch(() => []);
  return e?.meta?.until && new Date(e.meta.until) > new Date() ? String(e.meta.plan) : null;
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
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

// Students and teachers: one free month of Plus after an admin has looked at a proof (student card, enrolment letter, staff card or school page).
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
const sendLink = async (u: { id: string; username: string }, kind: "verify" | "reset", lang: string) => {
  const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const exp = new Date(Date.now() + (kind === "verify" ? 24 : 1) * 3600_000).toISOString();
  await db("explainer_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor: `mt:${await sha(token, 32)}`, type: "mailtoken", user_id: u.id, meta: { kind, exp, used: false } }) });
  const m = linkMail(kind, lang, `${APP_URL}/explainer/?${kind === "verify" ? "verify" : "reset"}=${token}`);
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
// inviting a friend: 10 free videos for the member who shared the link, up to 5 friends
const REFERRAL_VIDEOS = 3, REFERRAL_MAX = 5;
const refCode = (id: string) => id.slice(0, 8);
const referralOf = async (user: { id: string } | null) => {
  if (!user) return null;
  const n = await count(`explainer_events?user_id=eq.${user.id}&type=eq.referral`).catch(() => 0);
  return { code: refCode(user.id), invited: n, reward: REFERRAL_VIDEOS, max: REFERRAL_MAX };
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const u = new URL(req.url);
    if (req.method === "GET") {
      const user = await userOf(req);
      const actor = await actorOf(req, req.headers.get("x-visitor-id"));
      if (u.searchParams.get("whereami")) return json({ country: (await geoOf(req)) || null });   // the caller's own country as the network reports it
      if (u.searchParams.get("jobs")) {
        if (!user) return json({ error: "Sign in first." }, 401);
        return json(await db(`explainer_jobs?user_id=eq.${user.id}&select=id,arxiv,title,status,stage,style,tone,seconds,videos,sections,created_at,expired_at&order=created_at.desc&limit=50`));
      }
      if (u.searchParams.get("profile")) {
        if (!user) return json({ error: "Sign in first." }, 401);
        const [row] = await db(`explainer_events?user_id=eq.${user.id}&type=eq.profile&select=meta&order=created_at.desc&limit=1`);
        return json({ profile: row?.meta ?? null });
      }
      if (u.searchParams.get("ledger")) {
        if (!user) return json({ error: "Sign in first." }, 401);
        return json(await db(`explainer_credit_log?user_id=eq.${user.id}&select=created_at,delta,reason&order=created_at.desc&limit=50`));
      }
      const pi = await planInfo(user?.id);
      const iu = await interactiveUse(user, actor, user ? await activePlan(user.id) : null);
      return json({ ...pi, interactive: { used: iu.used, cap: iu.cap, left: iu.left, resets: iu.resets, jobs: iu.jobs }, tiers: TIERS, verify: await verifyOf(user), referral: await referralOf(user), admin: !!user && ADMIN_EMAILS.includes(String(user.username).toLowerCase()), user: user ? await publicUserH(user) : null, quota: await quotaFor(user, actor), limits: { guest: GUEST_DAY, member: MEMBER_DAY, welcome: WELCOME_CREDITS }, packs: PACKS });
    }

    const body = await req.json();
    const actor = await actorOf(req, body.visitor);
    const op = String(body.op ?? "");

    if (op === "event") {
      const type = String(body.type ?? "");
      if (!EVENTS.has(type)) return json({ error: "unknown event" }, 400);
      const user = await userOf(req);
      await logEvent(actor, type, { path: str(body.path, 80), ref: str(body.ref, 80), arxiv: str(body.arxiv, 60), k: str(body.k, 12), country: (type === "visit" ? await geoOf(req) : "") }, user?.id ?? null);
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
      };
      await logEvent("", "profile", profile, user.id);
      return json({ ok: true });
    }

    if (op === "register") {
      // the sign-in name is an e-mail address; nothing is sent to it and it is not verified (the stored column is still called username)
      const username = str(body.email ?? body.username, 80).trim().toLowerCase(), password = String(body.password ?? "");
      if (!EMAIL.test(username) || username.length > 80) return json({ error: "Enter a valid email address." }, 400);
      let handle = str(body.handle, 24).trim().toLowerCase();
      if (handle) {
        if (!HANDLE_RE.test(handle) || RESERVED.has(handle)) return json({ error: "Username: 3 to 24 letters, numbers, dots or underscores.", code: "bad_handle" }, 400);
        if (await handleTaken(handle)) return json({ error: "That username is taken. Choose another one.", code: "handle_taken" }, 409);
      }
      const country = str(body.country, 2).toUpperCase(), plang = str(body.lang, 2).toLowerCase();
      if (!/^[A-Z]{2}$/.test(country)) return json({ error: "Choose your country.", code: "need_country" }, 400);
      if (!["en", "zh", "vi", "id"].includes(plang)) return json({ error: "Choose your preferred language.", code: "need_lang" }, 400);
      if (password.length < 8 || password.length > 72) return json({ error: "Password: 8 to 72 characters." }, 400);
      if (await count(`explainer_events?actor=eq.${actor}&type=eq.signup&created_at=gte.${new Date(Date.now() - 3600_000).toISOString()}`) >= 3) return json({ error: "Too many sign-ups from here. Try again later." }, 429);
      // the visitor id comes from the browser, so sign-ups are also counted per network address (generous, for shared campus connections)
      const ipActor = await sha(`${clientIp(req)}|explainer-ip`);
      if (await count(`explainer_events?actor=eq.${ipActor}&type=eq.signup_ip&created_at=gte.${new Date(Date.now() - 86400_000).toISOString()}`) >= 10) return json({ error: "Too many sign-ups from this network today. Try again tomorrow." }, 429);
      if ((await db(`explainer_users?username=eq.${encodeURIComponent(username)}&select=id`)).length) return json({ error: "That email already has an account. Log in instead." }, 409);
      const { salt, hash } = await hashPassword(password);
      const [user] = await db("explainer_users?select=id,username,credits,created_at", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ username, salt, pass_hash: hash, credits: WELCOME_CREDITS, last_login: new Date().toISOString() }) });
      await db("explainer_credit_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: user.id, delta: WELCOME_CREDITS, reason: "welcome gift" }) });
      if (!handle) handle = await suggestHandle(username);
      await logEvent("", "handle", { handle }, user.id);
      await logEvent(actor, "signup", { username, country, lang: plang, source: str(body.source, 24), role: str(body.role, 24), ip_country: await geoOf(req) }, user.id);
      const rc = String(body.ref ?? "").toLowerCase();
      if (/^[0-9a-f]{8}$/.test(rc)) {   // came through a friend's link: the friend gets free videos (a few per friend, never from the same browser)
        try {
          const [inv] = await db(`explainer_users?id=gte.${rc}-0000-0000-0000-000000000000&id=lte.${rc}-ffff-ffff-ffff-ffffffffffff&select=id,credits&limit=1`);
          const same = inv ? await count(`explainer_events?actor=eq.${actor}&user_id=eq.${inv.id}&type=eq.signup`) : 1;
          const done = inv ? await count(`explainer_events?user_id=eq.${inv.id}&type=eq.referral`) : REFERRAL_MAX;
          if (inv && !same && done < REFERRAL_MAX && inv.id !== user.id) {
            await db(`explainer_users?id=eq.${inv.id}`, { method: "PATCH", body: JSON.stringify({ credits: inv.credits + REFERRAL_VIDEOS }) });
            await db("explainer_credit_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: inv.id, delta: REFERRAL_VIDEOS, reason: "friend joined" }) });
            await logEvent(actor, "referral", { friend: user.id }, inv.id);
          }
        } catch { /* a failed reward never blocks a sign-up */ }
      }
      await logEvent(ipActor, "signup_ip", {}, user.id);
      if (mailReady()) {
        try { await sendLink(user, "verify", plang); return json({ pending: true, email: username, user: await publicUserH(user) }); }
        catch { await logEvent(actor, "mail_fail", { kind: "verify" }, user.id); /* never lock a new member out because the mail provider failed */ }
      }
      const token = await newSession(user.id);
      return json({ token, user: await publicUserH(user), quota: await quotaFor(user, actor) });
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
        await sendLink(row, "verify", ["zh", "vi", "id"].includes(str(body.lang, 2)) ? str(body.lang, 2) : "en").catch(() => undefined);
      }
      return json({ ok: true });   // the same answer whether the address has an account or not
    }

    if (op === "reset_request") {
      const username = await resolveIdent(str(body.username, 80));
      if (!mailReady()) return json({ error: "Resetting by e-mail is not set up yet. Please contact us and we will reset it for you.", code: "mail_off" }, 503);
      const [row] = await db(`explainer_users?username=eq.${encodeURIComponent(username)}&select=id,username,created_at,banned`);
      if (row && !row.banned) {
        if ((await count(`explainer_events?user_id=eq.${row.id}&type=eq.mailtoken&created_at=gte.${new Date(Date.now() - 3600_000).toISOString()}`)) >= 3) return json({ error: "Too many e-mails. Try again in an hour.", code: "slow_down" }, 429);
        await sendLink(row, "reset", ["zh", "vi", "id"].includes(str(body.lang, 2)) ? str(body.lang, 2) : "en").catch(() => undefined);
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
      await db(`explainer_users?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify({ last_login: new Date().toISOString() }) });
      await logEvent(actor, "login", {}, row.id);
      const token = await newSession(row.id);
      return json({ token, user: await publicUserH(row), quota: await quotaFor(row, actor) });
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
      return json({ ok: true });
    }

    if (op === "buy") {   // a credit pack: the member pays by WeChat / Alipay, the owner confirms in the admin page and the credits are added
      if (!user) return json({ error: "Sign in to buy credits." }, 401);
      const plan = body.plan ? String(body.plan) : ""; const pack = plan ? PLANS[plan] : PACKS[String(body.pack)];
      if (!pack) return json({ error: "Unknown pack." }, 400);
const cur = body.currency === "vnd" || body.currency === "idr" ? body.currency as "vnd" | "idr" : "cny";
      const loc = LOCAL[plan || `pack_${String(body.pack)}`];
      const amt = cur === "cny" || !loc ? pack.price : loc[cur];
      const [order] = await db("explainer_orders?select=id", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ email: `@${user.username}`, arxiv: plan ? `plan ${plan}` : `credits x${pack.credits}`, language: "en", notes: `pack:${pack.credits} user:${user.id} price:${pack.price}${plan ? ` plan:${plan}` : ""} cur:${cur} amt:${amt}`, status: "new" }) });
      await logEvent(actor, "order_created", { pack: pack.credits, price: pack.price }, user.id);
      return json({ id: order.id, price: pack.price, credits: pack.credits, currency: cur, amount: amt });
    }

    return json({ error: "unknown op" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
