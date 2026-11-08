// Accounts for Paper Explainer: username + password sign-up and sign-in, the balance, the member's own videos, credit-pack orders,
// the contact form and the usage events behind the admin dashboard.
//   GET  ?me=1              (x-session optional) -> { user|null, quota }
//   GET  ?jobs=1            (x-session)          -> the member's own videos
//   GET  ?ledger=1          (x-session)          -> credit history
//   POST {op:"register"|"login"|"logout"|"password"|"event"|"contact"|"buy", ...}
import { CORS, json, db, sha, clientIp, actorOf, userOf, quotaFor, logEvent, hashPassword, sameText, newSession, count, WELCOME_CREDITS, GUEST_DAY, MEMBER_DAY } from "../_shared/explainer.ts";

const EVENTS = new Set(["visit", "open_signup", "view_pricing", "view_example", "play_example", "click_make", "click_buy", "order_created", "order_paid_claimed", "share", "download", "video_play", "video_download"]);
import { ADMIN_EMAILS } from "../_shared/explainer.ts";
const PACKS: Record<string, { credits: number; price: number }> = { "5": { credits: 5, price: 19 }, "20": { credits: 20, price: 59 }, "50": { credits: 50, price: 129 } };   // single videos: about CNY 2.6 to 3.8 each, credits never expire
// subscriptions: the videos of the period are added as credits when the payment is confirmed; the plan switches on the unlimited interactive checks (and Deep answers for Pro)
const PLANS: Record<string, { credits: number; price: number; days: number }> = {
  plus_month: { credits: 100, price: 33, days: 31 }, plus_year: { credits: 1200, price: 330, days: 366 },
  pro_month: { credits: 300, price: 129, days: 31 }, pro_year: { credits: 3600, price: 1290, days: 366 },   // Pro is "unlimited" under a fair-use ceiling of 300 videos a month
};
const planOf = async (userId: string | undefined): Promise<string | null> => {
  if (!userId) return null;
  const [e] = await db(`explainer_events?user_id=eq.${userId}&type=eq.plan&select=meta&order=created_at.desc&limit=1`).catch(() => []);
  return e?.meta?.until && new Date(e.meta.until) > new Date() ? String(e.meta.plan) : null;
};
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const str = (v: unknown, n: number) => String(v ?? "").slice(0, n);

const publicUser = (u: { id: string; username: string; credits: number; created_at: string }) => ({ id: u.id, username: u.username, credits: u.credits, created_at: u.created_at });

const planInfo = async (userId: string | undefined): Promise<{ plan: string | null; plan_until: string | null }> => {
  if (!userId) return { plan: null, plan_until: null };
  const [e] = await db(`explainer_events?user_id=eq.${userId}&type=eq.plan&select=meta&order=created_at.desc&limit=1`).catch(() => []);
  const until = e?.meta?.until ? String(e.meta.until) : null;
  return until && new Date(until) > new Date() ? { plan: String(e.meta.plan), plan_until: until } : { plan: null, plan_until: until };
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const u = new URL(req.url);
    if (req.method === "GET") {
      const user = await userOf(req);
      const actor = await actorOf(req, req.headers.get("x-visitor-id"));
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
      return json({ ...(await planInfo(user?.id)), admin: !!user && ADMIN_EMAILS.includes(String(user.username).toLowerCase()), user: user ? publicUser(user) : null, quota: await quotaFor(user, actor), limits: { guest: GUEST_DAY, member: MEMBER_DAY, welcome: WELCOME_CREDITS }, packs: PACKS });
    }

    const body = await req.json();
    const actor = await actorOf(req, body.visitor);
    const op = String(body.op ?? "");

    if (op === "event") {
      const type = String(body.type ?? "");
      if (!EVENTS.has(type)) return json({ error: "unknown event" }, 400);
      const user = await userOf(req);
      await logEvent(actor, type, { path: str(body.path, 80), ref: str(body.ref, 80), arxiv: str(body.arxiv, 60), k: str(body.k, 12) }, user?.id ?? null);
      return json({ ok: true });
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
      const username = str(body.username, 80).trim().toLowerCase(), password = String(body.password ?? "");
      if (!EMAIL.test(username) || username.length > 80) return json({ error: "Enter a valid email address." }, 400);
      if (password.length < 8 || password.length > 72) return json({ error: "Password: 8 to 72 characters." }, 400);
      if (await count(`explainer_events?actor=eq.${actor}&type=eq.signup&created_at=gte.${new Date(Date.now() - 3600_000).toISOString()}`) >= 3) return json({ error: "Too many sign-ups from here. Try again later." }, 429);
      // the visitor id comes from the browser, so sign-ups are also counted per network address (generous, for shared campus connections)
      const ipActor = await sha(`${clientIp(req)}|explainer-ip`);
      if (await count(`explainer_events?actor=eq.${ipActor}&type=eq.signup_ip&created_at=gte.${new Date(Date.now() - 86400_000).toISOString()}`) >= 10) return json({ error: "Too many sign-ups from this network today. Try again tomorrow." }, 429);
      if ((await db(`explainer_users?username=eq.${encodeURIComponent(username)}&select=id`)).length) return json({ error: "That email already has an account. Log in instead." }, 409);
      const { salt, hash } = await hashPassword(password);
      const [user] = await db("explainer_users?select=id,username,credits,created_at", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ username, salt, pass_hash: hash, credits: WELCOME_CREDITS, last_login: new Date().toISOString() }) });
      await db("explainer_credit_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: user.id, delta: WELCOME_CREDITS, reason: "welcome gift" }) });
      await logEvent(actor, "signup", { username }, user.id);
      await logEvent(ipActor, "signup_ip", {}, user.id);
      const token = await newSession(user.id);
      return json({ token, user: publicUser(user), quota: await quotaFor(user, actor) });
    }

    if (op === "login") {
      const username = str(body.username, 80).trim().toLowerCase(), password = String(body.password ?? "");
      const since = new Date(Date.now() - 15 * 60_000).toISOString();
      if (await count(`explainer_events?actor=eq.${actor}&type=eq.login_fail&created_at=gte.${since}`) >= 8) return json({ error: "Too many wrong attempts. Wait 15 minutes." }, 429);
      const rows = await db(`explainer_users?username=eq.${encodeURIComponent(username)}&select=id,username,credits,created_at,salt,pass_hash,banned`);
      const row = rows[0];
      const ok = row && sameText((await hashPassword(password, row.salt)).hash, row.pass_hash);
      if (!ok) { await logEvent(actor, "login_fail", { username }); return json({ error: "Wrong email or password." }, 401); }
      if (row.banned) return json({ error: "This account is disabled. Please contact us." }, 403);
      await db(`explainer_users?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify({ last_login: new Date().toISOString() }) });
      await logEvent(actor, "login", {}, row.id);
      const token = await newSession(row.id);
      return json({ token, user: publicUser(row), quota: await quotaFor(row, actor) });
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
      const [order] = await db("explainer_orders?select=id", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ email: `@${user.username}`, arxiv: plan ? `plan ${plan}` : `credits x${pack.credits}`, language: "en", notes: `pack:${pack.credits} user:${user.id} price:${pack.price}${plan ? ` plan:${plan}` : ""}`, status: "new" }) });
      await logEvent(actor, "order_created", { pack: pack.credits, price: pack.price }, user.id);
      return json({ id: order.id, price: pack.price, credits: pack.credits });
    }

    return json({ error: "unknown op" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
