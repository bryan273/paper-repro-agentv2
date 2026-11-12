// One admin overview for the whole Paperlit suite. Only an admin account (EXPLAINER_ADMIN_EMAILS, signed in with the shared session) is answered.
//   GET -> rows the console filters and draws by itself: daily numbers, signups with where they came from, visits by country, paid orders, videos, members,
//          orders, feedback, LLM usage by app and day, and the balance left at the model gateway (RKAPI).
// Changing things (credits, bans, order status, proofs) goes through explainer-admin; storage sizes come from its `ops` answer. This function only reads.
import { CORS, json, db, count, userOf, isAdmin, ADMIN_EMAILS } from "../_shared/explainer.ts";
import { mailReady, sendMail } from "../_shared/mail.ts";

const DAY = 86400_000;
const iso = (ms: number) => new Date(Date.now() - ms).toISOString();
const day = (s: string) => s.slice(0, 10);
const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => { try { return await p; } catch { return fallback; } };
const DAYS = 180;   // how far back the daily numbers go

/** What the model gateway says about the money left. Several shapes exist, so try them in turn and return what answered; the key is never sent out. */
async function rkapiBalance() {
  const key = Deno.env.get("RKAPI_API_KEY");
  if (!key) return { configured: false };
  const H = { Authorization: `Bearer ${key}`, "User-Agent": "Mozilla/5.0 (paperlit-admin)" };
  const get = async (u: string) => {
    try {
      const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(8000) });
      const text = await r.text();
      let j: unknown = null; try { j = JSON.parse(text); } catch { /* not JSON */ }
      return { status: r.status, json: j, text: j ? undefined : text.slice(0, 160) };
    } catch (e) { return { error: String(e).slice(0, 120) }; }
  };
  const today = new Date().toISOString().slice(0, 10), start = new Date(Date.now() - 90 * DAY).toISOString().slice(0, 10);
  const [token, subscription, usage] = await Promise.all([
    get("https://rkapi.com/api/usage/token"),
    get("https://rkapi.com/v1/dashboard/billing/subscription"),
    get(`https://rkapi.com/v1/dashboard/billing/usage?start_date=${start}&end_date=${today}`),
  ]);
  return { configured: true, token, subscription, usage };
}

/** The gateway cannot say how much is left, so the spend is written down instead: the total the key has used is saved at most once every 6 hours, and the difference between two saved totals is what was spent in between. */
async function rkapiSpend(rk: { configured: boolean; token?: { json?: unknown } }) {
  const t = (rk.token?.json as { data?: { total_used?: number } } | null | undefined)?.data;
  if (!rk.configured || typeof t?.total_used !== "number") return null;
  const now = t.total_used / 500000;   // 500,000 units per credit (the gateway writes credit as "$")
  const rows = await db(`explainer_events?type=eq.rkapi_spend&select=meta,created_at&order=created_at.asc&limit=400`).catch(() => []) as { meta: { usd: number }; created_at: string }[];
  const last = rows[rows.length - 1];
  if (!last || Date.now() - Date.parse(last.created_at) > 6 * HOUR) {
    await db("explainer_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor: "system", type: "rkapi_spend", user_id: null, meta: { usd: now } }) }).catch(() => undefined);
  }
  // what was spent since the saved total that is nearest to (and not after) the start of each window
  const since = (hours: number) => {
    const at = Date.now() - hours * HOUR;
    const base = [...rows].reverse().find((r) => Date.parse(r.created_at) <= at) ?? rows[0];
    return base ? { usd: Math.max(0, now - base.meta.usd), from: base.created_at, full: Date.parse(base.created_at) <= at } : null;
  };
  const days: { d: string; usd: number }[] = [];
  const byDay = new Map<string, number>();
  for (const r of rows) byDay.set(r.created_at.slice(0, 10), r.meta.usd);   // the last total saved on each day
  const keys = [...byDay.keys()].sort();
  for (let i = 1; i < keys.length; i++) days.push({ d: keys[i], usd: Math.max(0, (byDay.get(keys[i]) as number) - (byDay.get(keys[i - 1]) as number)) });
  return { total: now, credit_usd: CREDIT_USD, h24: since(24), d7: since(24 * 7), d30: since(24 * 30), first: rows[0]?.created_at ?? null, days: days.slice(-30) };
}

/** Test accounts: the QA admin and the accounts it creates. The real admin never sees them; the QA admin sees everything. */
const QA_ADMIN = (Deno.env.get("EXPLAINER_QA_ADMIN") ?? "qa-admin@repro-suite.dev").toLowerCase();
const isTest = (email: string) => /^qa[-_.]|^qa\d|@example\.(com|org)$|@repro-suite\.dev$|^oldclient\d/i.test(email.replace(/^@/, ""));
// Model prices per million tokens, input and output, in gateway CREDITS (RKAPI prices its models in "$", but that is credit, not money):
// quick answers and research run on Claude Haiku 4.5 ($1 / $5 credit), in-depth answers on Claude Sonnet 4.6 ($3 / $15 credit).
// One credit costs CREDIT_USD real dollars (0.196 yuan per credit at top-up, as explainer/usage.py), so the real cost is credit x CREDIT_USD.
// The ledger keeps total tokens; 90% of them are assumed to be input (an answer reads the paper and writes a little).
const PRICE = { fast: { in: Number(Deno.env.get("PRICE_FAST_IN") ?? "1"), out: Number(Deno.env.get("PRICE_FAST_OUT") ?? "5") }, deep: { in: Number(Deno.env.get("PRICE_DEEP_IN") ?? "3"), out: Number(Deno.env.get("PRICE_DEEP_OUT") ?? "15") } };
const CREDIT_USD = Number(Deno.env.get("RKAPI_CREDIT_USD") ?? String(0.196 / 6.75));   // the same rate the renderer uses (explainer/usage.py): one credit costs 0.196 yuan at top-up
const creditsOf = (tokens: number, tier: "fast" | "deep") => (tokens * 0.9 * PRICE[tier].in + tokens * 0.1 * PRICE[tier].out) / 1e6;
const usdOf = (tokens: number, tier: "fast" | "deep") => creditsOf(tokens, tier) * creditUsdNow;
const HOUR = 3600_000;

/** Where visitors go, per day: how many came, how many looked at something (pricing, an example), how many tried something (make, sign-up, buy), how many claimed a payment,
 *  and how long they stayed (a visit saves its active seconds when the page is left; the longest figure of a visit counts). Only visits since this was added have a time. */
function funnelOf(visits: any[], acts: any[], leaves: any[], _keep: (e: string) => boolean) {
  const person = new Map<string, string>();
  for (const v of visits) if (v.meta?.iph && !person.has(v.actor)) person.set(v.actor, String(v.meta.iph));
  const P = (a: string) => person.get(a) ?? a;
  acts = acts.map((e) => ({ ...e, actor: P(e.actor) })); leaves = leaves.map((e) => ({ ...e, actor: P(e.actor) }));
  const LOOK = new Set(["view_pricing", "view_example", "play_example"]), TRY = new Set(["click_make", "open_signup", "click_buy", "order_created", "video_play"]);
  const day = (iso: string) => String(iso).slice(0, 10);
  const days = new Map<string, { looked: Set<string>; tried: Set<string>; claimed: Set<string>; engaged: Set<string>; n: number; sec: number; b: number[] }>();
  const at = (d: string) => { let x = days.get(d); if (!x) { x = { looked: new Set(), tried: new Set(), claimed: new Set(), engaged: new Set(), n: 0, sec: 0, b: [0, 0, 0, 0, 0] }; days.set(d, x); } return x; };
  for (const e of acts) {
    const x = at(day(e.created_at));
    if (LOOK.has(e.type)) { x.looked.add(e.actor); x.engaged.add(e.actor); }
    if (TRY.has(e.type)) { x.tried.add(e.actor); x.engaged.add(e.actor); }
    if (e.type === "order_paid_claimed") x.claimed.add(e.actor);
  }
  const longest = new Map<string, { d: string; sec: number }>();
  for (const e of leaves) { const k = `${e.actor}:${e.meta?.sid ?? day(e.created_at)}`; const sec = Math.min(Number(e.meta?.sec) || 0, 7200); const cur = longest.get(k); if (!cur || sec > cur.sec) longest.set(k, { d: day(e.created_at), sec }); }
  for (const { d, sec } of longest.values()) { const x = at(d); x.n++; x.sec += sec; x.b[sec < 10 ? 0 : sec < 30 ? 1 : sec < 60 ? 2 : sec < 180 ? 3 : 4]++; }
  return [...days.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([d, x]) => ({ d, looked: x.looked.size, tried: x.tried.size, claimed: x.claimed.size, engaged: x.engaged.size, n: x.n, sec: x.sec, b: x.b }));
}

const REPOS = ["repro-suite-hub", "bryan273.github.io", "paper-explainer", "reading-companion", "paper-repro-agentv2", "repro-lite", "repro-desk", "indexboard"];
// ---- exchange rates: costs come in dollars and members pay in yuan, dong or rupiah, so the admin needs real rates.
// Google has no rate service one may call; open.er-api.com gives the daily market rate for free without a key. The rate of each day is saved
// (one record a day), so an order is counted at the rate of the day it was made. Before the first saved day, the oldest saved rate is used.
type Rates = { date: string; CNY: number; VND: number; IDR: number };
const FX_FALLBACK: Rates = { date: "", CNY: 7.2, VND: 26000, IDR: 16500 };
let creditUsdNow = Number(Deno.env.get("RKAPI_CREDIT_USD") ?? String(0.196 / 6.75));
async function fxRates() {
  const rows = await db(`explainer_events?type=eq.fx_rate&select=meta&order=created_at.asc&limit=800`).catch(() => []) as { meta: Rates }[];
  const byDate = new Map<string, Rates>(rows.filter((r) => r.meta?.date && r.meta.CNY > 0).map((r) => [r.meta.date, r.meta]));
  const today = new Date().toISOString().slice(0, 10);
  let source = "saved";
  if (!byDate.has(today)) {
    try {
      const r = await fetch("https://open.er-api.com/v6/latest/USD", { signal: AbortSignal.timeout(8000) });
      const j = await r.json() as { result?: string; rates?: Record<string, number> };
      const rt = j.rates ?? {};
      if (j.result === "success" && rt.CNY > 0 && rt.VND > 0 && rt.IDR > 0) {
        const rec: Rates = { date: today, CNY: rt.CNY, VND: rt.VND, IDR: rt.IDR };
        byDate.set(today, rec); source = "live";
        await db("explainer_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor: "system", type: "fx_rate", user_id: null, meta: rec }) }).catch(() => undefined);
      }
    } catch { /* the last saved rate is used */ }
  }
  const dates = [...byDate.keys()].sort();
  const latest = dates.length ? byDate.get(dates[dates.length - 1])! : FX_FALLBACK;
  const on = (d: string): Rates => { let best = dates.length ? byDate.get(dates[0])! : FX_FALLBACK; for (const k of dates) { if (k <= d) best = byDate.get(k)!; else break; } return best; };
  creditUsdNow = 0.196 / latest.CNY;   // one credit costs 0.196 yuan at top-up
  return { today: latest, on, source: dates.length ? source : "default", days: dates.length };
}
/** What was paid, in yuan, at the rate of the day it was paid. */
const toCny = (amt: number, cur: string, r: Rates) => (cur === "vnd" ? (amt / r.VND) * r.CNY : cur === "idr" ? (amt / r.IDR) * r.CNY : amt);

/** Merged pull requests of every app, newest first. Saved in the database, so GitHub is asked at most once every 30 minutes (60 requests an hour are allowed without a key,
 *  GITHUB_TOKEN raises that); when GitHub refuses, the last saved list is returned with its age. */
async function releases(fresh: boolean) {
  const [cached] = await db("explainer_events?type=eq.gh_cache&select=id,meta,created_at&order=created_at.desc&limit=1").catch(() => []) as { id: string; meta: { prs: unknown[] }; created_at: string }[];
  if (cached && !fresh && Date.now() - Date.parse(cached.created_at) < 30 * 60_000) return { prs: cached.meta.prs, at: cached.created_at, source: "saved" };
  const tok = Deno.env.get("GITHUB_TOKEN") ?? Deno.env.get("GH_TOKEN");
  const H: Record<string, string> = { "User-Agent": "paperlit-admin", Accept: "application/vnd.github+json", ...(tok ? { Authorization: `Bearer ${tok}` } : {}) };
  let refused = 0;
  const got = await Promise.all(REPOS.map(async (repo) => {
    try {
      const r = await fetch(`https://api.github.com/repos/bryan273/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=40`, { headers: H, signal: AbortSignal.timeout(8000) });
      if (!r.ok) { refused++; return []; }
      const arr = await r.json() as { number: number; title: string; merged_at: string | null; html_url: string; body: string | null }[];
      return arr.filter((p) => p.merged_at).map((p) => ({ n: p.number, title: p.title, at: p.merged_at, url: p.html_url, repo,
        bullets: (p.body ?? "").split("\n").filter((l) => /^\s*[-*]\s+/.test(l)).map((l) => l.replace(/^\s*[-*]\s*/, "").trim()).filter((l) => l && !/^🤖|generated with/i.test(l)).slice(0, 8) }));
    } catch { refused++; return []; }
  }));
  const prs = got.flat().sort((a, b) => String(b.at).localeCompare(String(a.at)));
  if (prs.length && refused < REPOS.length) {
    await db("explainer_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor: "system", type: "gh_cache", user_id: null, meta: { prs } }) }).catch(() => undefined);
    if (cached) await db(`explainer_events?type=eq.gh_cache&created_at=lt.${new Date(Date.now() - 86400_000).toISOString()}`, { method: "DELETE" }).catch(() => undefined);   // keep only recent copies
    return { prs, at: new Date().toISOString(), source: "github" };
  }
  if (cached) return { prs: cached.meta.prs, at: cached.created_at, source: "saved", note: "GitHub did not answer just now, so this is the last saved list." };
  return { prs: [], at: null, source: "none", note: refused ? "GitHub is refusing requests from the server right now. Try again in a while." : "No merged pull requests." };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method !== "GET" && req.method !== "POST") return json({ error: "GET or POST only" }, 405);
    const user = await userOf(req);
    if (!user) return json({ error: "Sign in with an admin account (Log in, top right)." }, 401);
    if (!isAdmin(user)) return json({ error: "This account is not an admin." }, 403);

    // Reply to a message from the contact form or the support chat. A member finds it in their inbox in the app (and gets an e-mail when e-mail is set up);
    // a visitor who left an e-mail address gets it by e-mail; if neither is possible the answer says so.
    if (req.method === "POST") {
      const b = await req.json().catch(() => ({}));
      if (b.op === "close") {
        if (!/^[0-9a-f-]{36}$/.test(String(b.id))) return json({ error: "Unknown message." }, 400);
        await db("explainer_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor: "admin", type: "reply", user_id: null, meta: { fid: b.id, text: "(marked as done, no reply sent)", done: true } }) });
        return json({ ok: true, reply: { text: "(marked as done, no reply sent)", at: new Date().toISOString(), done: true } });
      }
      if (b.op !== "reply") return json({ error: "unknown op" }, 400);
      const text = String(b.text ?? "").trim().slice(0, 2000);
      if (text.length < 2 || !/^[0-9a-f-]{36}$/.test(String(b.id))) return json({ error: "Write a reply first." }, 400);
      const [msg] = await db(`explainer_feedback?id=eq.${b.id}&select=id,email,comment`).catch(() => []) as { id: string; email: string; comment: string }[];
      if (!msg) return json({ error: "That message was not found." }, 404);
      const to = String(msg.email ?? "").trim();
      let uid: string | null = null, mailTo = "";
      if (to.startsWith("@")) {
        const [u] = await db(`explainer_users?username=eq.${encodeURIComponent(to.slice(1))}&select=id,username`).catch(() => []) as { id: string; username: string }[];
        if (u) { uid = u.id; mailTo = u.username; }
      } else if (to.includes("@")) mailTo = to;
      await db("explainer_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor: "admin", type: "reply", user_id: uid, meta: { fid: msg.id, text, to, about: String(msg.comment ?? "").slice(0, 160) } }) });
      let mailed = false;
      if (mailTo.includes("@") && mailReady()) {
        const plain = `${text}\n\n---\nYou wrote: ${String(msg.comment ?? "").slice(0, 400)}`;
        mailed = await sendMail(mailTo, "Paperlit: a reply to your message", `<pre style="font:14px/1.5 system-ui;white-space:pre-wrap">${plain.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</pre>`, plain).then(() => true).catch(() => false);
      }
      return json({ ok: true, reply: { text, at: new Date().toISOString(), done: false }, delivered: uid ? (mailed ? "inbox and e-mail" : "inbox") : mailed ? "e-mail" : "nowhere", note: uid || mailed ? "" : "This person left no e-mail address and has no account, so the reply could not be delivered." });
    }
    if (new URL(req.url).searchParams.get("releases")) return json(await releases(new URL(req.url).searchParams.get("fresh") === "1"));
    const qaView = String(user.username).toLowerCase() === QA_ADMIN;

    const since30 = iso(30 * DAY), sinceN = iso(DAYS * DAY), since7 = iso(7 * DAY);
    const [users, jobsRecent, jobsAll, usage, reproRecent, reproAll, orders, feedback, plans, signups, visits, handleEvs, asks30, visits7, research30, edits30, actEvs, leaveEvs, replyEvs] = await Promise.all([
      safe(db("explainer_users?select=id,username,credits,banned,created_at,last_login&order=created_at.desc&limit=3000"), [] as any[]),
      safe(db("explainer_jobs?select=id,arxiv,title,status,stage,user_id,seconds,langs,cost_usd,error,created_at&order=created_at.desc&limit=400"), [] as any[]),
      safe(db(`explainer_jobs?select=created_at,status,langs,seconds,cost_usd,usage,user_id&created_at=gte.${sinceN}&order=created_at.desc&limit=20000`), [] as any[]),
      safe(db(`agent_usage?select=app,prompt_tokens,completion_tokens,created_at&created_at=gte.${since30}&limit=50000`), [] as any[]),
      safe(db("repro_jobs?select=id,arxiv_id,title,lang,status,verdict,agent,model,created_at&order=created_at.desc&limit=300"), [] as any[]),
      safe(db(`repro_jobs?select=created_at,status&created_at=gte.${sinceN}&limit=10000`), [] as any[]),
      safe(db("explainer_orders?select=id,email,arxiv,status,pay_method,notes,created_at&order=created_at.desc&limit=1000"), [] as any[]),
      safe(db("explainer_feedback?select=id,rating,comment,kind,use_case,email,arxiv,created_at&order=created_at.desc&limit=300"), [] as any[]),
      safe(db("explainer_events?type=eq.plan&select=user_id,meta,created_at&order=created_at.desc&limit=3000"), [] as any[]),
      safe(db(`explainer_events?type=eq.signup&select=user_id,meta,created_at&order=created_at.desc&limit=20000`), [] as any[]),
      safe(db(`explainer_events?type=eq.visit&select=actor,user_id,meta,created_at&created_at=gte.${sinceN}&order=created_at.desc&limit=40000`), [] as any[]),
      safe(db("explainer_events?type=eq.handle&select=user_id,meta&order=created_at.desc&limit=5000"), [] as any[]),
      safe(db(`explainer_asks?select=intent,tokens,user_id,created_at&created_at=gte.${since30}&limit=50000`), [] as any[]),
      safe(count(`explainer_events?created_at=gte.${since7}&type=eq.visit`), 0),
      safe(db(`explainer_events?type=eq.research&select=user_id,created_at&created_at=gte.${since30}&limit=20000`), [] as any[]),
      safe(db(`explainer_events?type=eq.edit&select=user_id,meta,created_at&created_at=gte.${since30}&limit=20000`), [] as any[]),
      safe(db(`explainer_events?type=in.(view_pricing,view_example,play_example,click_make,open_signup,click_buy,order_created,order_paid_claimed,video_play)&select=actor,type,created_at&created_at=gte.${sinceN}&limit=40000`), [] as any[]),
      safe(db(`explainer_events?type=eq.leave&select=actor,meta,created_at&created_at=gte.${sinceN}&limit=40000`), [] as any[]),
      safe(db("explainer_events?type=eq.reply&select=meta,created_at&order=created_at.desc&limit=1000"), [] as any[]),
    ]);
    const rkapi = await rkapiBalance();
    const spend = await safe(rkapiSpend(rkapi), null);

    // ---- which rows belong to test accounts; the real admin sees none of them
    const testIds = new Set<string>(users.filter((u: any) => isTest(String(u.username))).map((u: any) => u.id));
    const keepU = (id: string | null | undefined) => qaView || !id || !testIds.has(id);
    const keepE = (email: string | null | undefined) => qaView || !email || !isTest(String(email));
    const U = users.filter((u: any) => keepU(u.id));
    const JR = jobsRecent.filter((j: any) => keepU(j.user_id)), JA = jobsAll.filter((j: any) => keepU(j.user_id));
    const O = orders.filter((o: any) => keepE(o.email)), F = feedback.filter((f: any) => keepE(f.email));
    const S = signups.filter((s: any) => keepU(s.user_id)), V = visits.filter((v: any) => keepU(v.user_id));
    const A = asks30.filter((a: any) => keepU(a.user_id)), R = research30.filter((r: any) => keepU(r.user_id)), E = edits30.filter((r: any) => keepU(r.user_id));

    // ---- members
    const handleOf: Record<string, string> = {};
    for (const h of handleEvs) if (!handleOf[h.user_id] && h.meta?.handle) handleOf[h.user_id] = String(h.meta.handle);
    const countryOf: Record<string, string> = {};
    for (const s of signups) if (s.user_id && !countryOf[s.user_id]) countryOf[s.user_id] = String(s.meta?.country ?? "");
    const jobsPerUser: Record<string, number> = {};
    for (const j of JR) if (j.user_id) jobsPerUser[j.user_id] = (jobsPerUser[j.user_id] || 0) + 1;
    const planOf: Record<string, any> = {};
    for (const p of plans) if (!planOf[p.user_id]) planOf[p.user_id] = p.meta;   // newest first
    const members = U.map((u: any) => ({
      id: u.id, email: u.username, handle: handleOf[u.id] ?? null, country: countryOf[u.id] ?? "", credits: u.credits, banned: !!u.banned, created_at: u.created_at, last_login: u.last_login,
      jobs: jobsPerUser[u.id] || 0, admin: ADMIN_EMAILS.includes(String(u.username).toLowerCase()), plan: planOf[u.id]?.plan ?? null, plan_until: planOf[u.id]?.until ?? null, plan_source: planOf[u.id]?.source ?? null, test: testIds.has(u.id),
    }));

    // ---- money
    const fx = await fxRates();
    const orderRows = O.map((o: any) => {
      const n = String(o.notes ?? "");
      return {
        id: o.id, email: o.email, what: o.arxiv, status: o.status, method: o.pay_method, created_at: o.created_at,
        price_cny: Number(/price:(\d+(?:\.\d+)?)/.exec(n)?.[1] ?? 0), cur: /cur:([a-z]+)/.exec(n)?.[1] ?? "cny", amt: Number(/amt:(\d+)/.exec(n)?.[1] ?? 0),
        kind: /plan:([a-z_]+)/.exec(n)?.[1] ?? (/pack:(\d+)/.exec(n) ? "pack_" + /pack:(\d+)/.exec(n)![1] : "other"), shot: /shot:\S+/.test(n),
      };
    });
    // what each order really brought in, in yuan at the rate of its day (a yuan order is its price; a dong or rupiah order is its amount converted)
    for (const o of orderRows as any[]) o.cny = o.cur !== "cny" && o.amt ? Math.round(toCny(o.amt, o.cur, fx.on(day(o.created_at))) * 100) / 100 : o.price_cny;
    const USD_CNY = fx.today.CNY;
    const askCny = (a: any) => usdOf(Number(a.tokens) || 0, a.intent === "deep" ? "deep" : "fast") * USD_CNY;

    // ---- one row per day (180 days) and one per hour (the last 7 days) for every number the charts need
    const blank = (k: string) => ({ d: k, signups: 0, visitors: 0, videos: 0, failed: 0, checks: 0, income: 0, cost: 0, tokens: 0, calls: 0, asks: 0 });
    const days: Record<string, any> = {}, hours: Record<string, any> = {};
    for (let i = DAYS - 1; i >= 0; i--) { const d = day(iso(i * DAY)); days[d] = blank(d); }
    for (let i = 7 * 24 - 1; i >= 0; i--) { const h = iso(i * HOUR).slice(0, 13); hours[h] = blank(h); }
    const bump = (when: string, k: string, n = 1) => { const d = days[day(when)]; if (d) d[k] += n; const h = hours[String(when).slice(0, 13)]; if (h) h[k] += n; };
    for (const s of S) bump(s.created_at, "signups");
    const seenD: Record<string, Set<string>> = {}, seenH: Record<string, Set<string>> = {};
    const who = (v: any) => String(v.meta?.iph || v.actor);
    for (const v of V) { (seenD[day(v.created_at)] ??= new Set()).add(who(v)); (seenH[String(v.created_at).slice(0, 13)] ??= new Set()).add(who(v)); }
    for (const [k, set] of Object.entries(seenD)) if (days[k]) days[k].visitors = set.size;
    for (const [k, set] of Object.entries(seenH)) if (hours[k]) hours[k].visitors = set.size;
    for (const j of JA) { bump(j.created_at, j.status === "failed" ? "failed" : "videos"); bump(j.created_at, "cost", (Number(j.cost_usd) || 0) * fx.on(day(j.created_at)).CNY); }
    for (const r of reproAll) bump(r.created_at, "checks");
    for (const o of orderRows) if (o.status === "paid" || o.status === "delivered") bump(o.created_at, "income", o.cny);
    for (const a of A) { bump(a.created_at, "cost", askCny(a)); bump(a.created_at, "asks"); }
    for (const u of usage) { bump(u.created_at, "tokens", (u.prompt_tokens || 0) + (u.completion_tokens || 0)); bump(u.created_at, "calls"); }
    for (const x of [...Object.values(days), ...Object.values(hours)]) x.cost = Math.round(x.cost * 100) / 100;

    // ---- what each feature costs (30 days, CNY): measured from the renders and the answer ledger
    const done30 = JA.filter((j: any) => j.status === "done" && j.created_at >= since30 && j.cost_usd !== null);
    const perMin = done30.reduce((n: number, j: any) => n + (Number(j.cost_usd) || 0), 0) / Math.max(1, done30.reduce((n: number, j: any) => n + (j.seconds || 0) / 60, 0)) * USD_CNY;
    const byIntent = (want: (i: string) => boolean) => { const l = A.filter((a: any) => want(String(a.intent))); const c = l.reduce((n: number, a: any) => n + askCny(a), 0); return { n: l.length, total: Math.round(c * 100) / 100, each: l.length ? Math.round((c / l.length) * 1000) / 1000 : null, tokens: l.length ? Math.round(l.reduce((n: number, a: any) => n + (Number(a.tokens) || 0), 0) / l.length) : null }; };
    // what a minute of video costs in each narration language (some languages are longer to say, or need more tokens per sentence)
    const byLangM = new Map<string, { n: number; usd: number; min: number }>();
    for (const j of done30) { const k = String(j.langs || "en"); const x = byLangM.get(k) ?? { n: 0, usd: 0, min: 0 }; x.n++; x.usd += Number(j.cost_usd) || 0; x.min += (j.seconds || 0) / 60; byLangM.set(k, x); }
    const byLang = [...byLangM.entries()].map(([l, x]) => ({ l, n: x.n, per_min: x.min ? Math.round((x.usd / x.min) * USD_CNY * 1000) / 1000 : null, avg_min: Math.round((x.min / x.n) * 10) / 10 })).sort((a, b) => b.n - a.n);
    const firstResearch = R.reduce((m: string, r: any) => (r.created_at < m ? r.created_at : m), "9999");   // only model use since research questions are counted
    const researchTok = usage.filter((u: any) => (u.app === "repro-lite" || u.app === "reader") && u.created_at >= firstResearch);
    const costs = {
      video_per_minute: done30.length ? Math.round(perMin * 1000) / 1000 : null, videos: done30.length,
      video_total: Math.round(done30.reduce((n: number, j: any) => n + (Number(j.cost_usd) || 0), 0) * USD_CNY * 100) / 100,
      quick: byIntent((i) => i === "ask" || i === "simpler"), deep: byIntent((i) => i === "deep"), quiz: byIntent((i) => i === "quiz" || i === "quizall"),
      research: { n: R.length, tokens: researchTok.reduce((n: number, u: any) => n + (u.prompt_tokens || 0) + (u.completion_tokens || 0), 0), each: R.length ? Math.round(researchTok.reduce((n: number, u: any) => n + usdOf((u.prompt_tokens || 0) + (u.completion_tokens || 0), "fast"), 0) * USD_CNY / R.length * 1000) / 1000 : null },
      edits: E.length,
      prices: PRICE, credit_usd: CREDIT_USD,
      by_lang: byLang,
      // where the video money goes (30 days, CNY): every model call of every render, finished or failed, by step and by model
      steps: (() => {
        const all30 = JA.filter((j: any) => j.created_at >= since30 && j.usage);
        const add = (m: Map<string, { calls: number; cny: number }>, k: string, calls: number, usd: number) => { const x = m.get(k) ?? { calls: 0, cny: 0 }; x.calls += calls; x.cny += usd * USD_CNY; m.set(k, x); };
        const part = new Map<string, { calls: number; cny: number }>(), model = new Map<string, { calls: number; cny: number }>();
        for (const j of all30) {
          for (const [k, v] of Object.entries(j.usage?.by_part ?? {}) as [string, any][]) add(part, k, v.calls || 0, Number(v.usd) || 0);
          for (const [k, v] of Object.entries(j.usage?.by_model ?? {}) as [string, any][]) add(model, k, v.calls || 0, Number(v.usd) || 0);
        }
        const out = (m: Map<string, { calls: number; cny: number }>) => [...m.entries()].map(([k, x]) => ({ k, calls: x.calls, cny: Math.round(x.cny * 1000) / 1000 })).sort((a, b) => b.cny - a.cny);
        return { by_step: out(part), by_model: out(model), measured: all30.length, older: JA.filter((j: any) => j.created_at >= since30 && !j.usage).length };
      })(),
      failed: (() => {
        const f = JA.filter((j: any) => j.status === "failed" && j.created_at >= since30);
        const cny = f.reduce((n: number, j: any) => n + (Number(j.cost_usd) || 0), 0) * USD_CNY;
        return { n: f.length, total: Math.round(cny * 1000) / 1000, each: f.length ? Math.round((cny / f.length) * 1000) / 1000 : null };
      })(),
    };

    // ---- where people are: chosen country, country of the connection, visitors by country and day
    const visitRows: Record<string, Set<string>> = {};
    for (const v of V) { const k = `${day(v.created_at)}|${String(v.meta?.country || "??")}`; (visitRows[k] ??= new Set()).add(who(v)); }
    const visitCountry = Object.entries(visitRows).map(([k, set]) => { const [d, c] = k.split("|"); return { d, c, n: set.size }; });
    const signupRows = S.slice(0, 10000).map((s: any) => ({ d: s.created_at, c: String(s.meta?.country ?? ""), ip: String(s.meta?.ip_country ?? ""), l: String(s.meta?.lang ?? ""), s: String(s.meta?.source ?? ""), r: String(s.meta?.role ?? "") }));

    // ---- usage of the model gateways by app and day (30 days)
    const llmRows: Record<string, { d: string; app: string; calls: number; tokens: number; usd: number }> = {};
    for (const u of usage) { const k = `${day(u.created_at)}|${u.app}`; const r = (llmRows[k] ??= { d: day(u.created_at), app: u.app, calls: 0, tokens: 0, usd: 0 }); r.calls++; r.tokens += (u.prompt_tokens || 0) + (u.completion_tokens || 0);
      r.usd += ((u.prompt_tokens || 0) * PRICE.fast.in + (u.completion_tokens || 0) * PRICE.fast.out) / 1e6 * creditUsdNow; }   // the ledger does not keep the model: priced as the fast model, which is most of the calls

    return json({
      me: user.username,
      view: qaView ? "qa" : "real",
      hidden_test_accounts: qaView ? 0 : testIds.size,
      generated_at: new Date().toISOString(),
      usd_cny: USD_CNY,
      fx: { date: fx.today.date, CNY: fx.today.CNY, VND: fx.today.VND, IDR: fx.today.IDR, source: fx.source, days: fx.days },
      days: Object.values(days),
      hours: Object.values(hours),
      members,
      active_plans: members.filter((m: any) => m.plan_until && new Date(m.plan_until) > new Date()).length,
      orders: orderRows,
      jobs: JR.map((j: any) => ({ id: j.id, user_id: j.user_id ?? null, who: j.user_id ? (handleOf[j.user_id] ?? users.find((u: any) => u.id === j.user_id)?.username ?? null) : null, who_email: j.user_id ? (users.find((u: any) => u.id === j.user_id)?.username ?? null) : null, arxiv: j.arxiv, title: j.title, status: j.status, stage: j.stage, seconds: j.seconds, langs: j.langs, cost_usd: j.cost_usd, error: j.error ? String(j.error).slice(0, 300) : null, created_at: j.created_at })),
      job_langs: JA.map((j: any) => ({ d: day(j.created_at), l: j.langs, s: j.status })),
      repro: reproRecent,
      signup_rows: signupRows,
      visit_country: visitCountry,
      llm: Object.values(llmRows),
      feedback: F.map((f: any) => { const reps = (replyEvs as any[]).filter((e) => e.meta?.fid === f.id).reverse().map((e) => ({ text: String(e.meta.text), at: e.created_at, done: !!e.meta.done })); return { ...f, replies: reps, reply: reps[reps.length - 1] ?? null, closed: reps.some((x) => x.done) }; }),
      funnel: funnelOf(V, actEvs, leaveEvs, keepE),
      costs,
      asks_7d: A.filter((a: any) => a.created_at >= since7).length,
      visits_7d: visits7,
      rkapi: { ...rkapi, spend },
    });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
