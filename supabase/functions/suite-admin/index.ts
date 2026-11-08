// One admin overview for the whole Paperlit suite. Only an admin account (EXPLAINER_ADMIN_EMAILS, signed in with the shared session) is answered.
//   GET -> rows the console filters and draws by itself: daily numbers, signups with where they came from, visits by country, paid orders, videos, members,
//          orders, feedback, LLM usage by app and day, and the balance left at the model gateway (RKAPI).
// Changing things (credits, bans, order status, proofs) goes through explainer-admin; storage sizes come from its `ops` answer. This function only reads.
import { CORS, json, db, count, userOf, isAdmin } from "../_shared/explainer.ts";

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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method !== "GET") return json({ error: "GET only" }, 405);
    const user = await userOf(req);
    if (!user) return json({ error: "Sign in with an admin account (Log in, top right)." }, 401);
    if (!isAdmin(user)) return json({ error: "This account is not an admin." }, 403);

    const since30 = iso(30 * DAY), sinceN = iso(DAYS * DAY), since7 = iso(7 * DAY);
    const [users, jobsRecent, jobsAll, usage, reproRecent, reproAll, orders, feedback, plans, signups, visits, handleEvs, asks7, visits7] = await Promise.all([
      safe(db("explainer_users?select=id,username,credits,banned,created_at,last_login&order=created_at.desc&limit=3000"), [] as any[]),
      safe(db("explainer_jobs?select=id,arxiv,title,status,stage,user_id,seconds,langs,cost_usd,error,created_at&order=created_at.desc&limit=400"), [] as any[]),
      safe(db(`explainer_jobs?select=created_at,status,langs,seconds,cost_usd&created_at=gte.${sinceN}&order=created_at.desc&limit=20000`), [] as any[]),
      safe(db(`agent_usage?select=app,prompt_tokens,completion_tokens,created_at&created_at=gte.${since30}&limit=50000`), [] as any[]),
      safe(db("repro_jobs?select=id,arxiv_id,title,lang,status,verdict,agent,model,created_at&order=created_at.desc&limit=300"), [] as any[]),
      safe(db(`repro_jobs?select=created_at,status&created_at=gte.${sinceN}&limit=10000`), [] as any[]),
      safe(db("explainer_orders?select=id,email,arxiv,status,pay_method,notes,created_at&order=created_at.desc&limit=1000"), [] as any[]),
      safe(db("explainer_feedback?select=id,rating,comment,kind,arxiv,created_at&order=created_at.desc&limit=200"), [] as any[]),
      safe(db("explainer_events?type=eq.plan&select=user_id,meta,created_at&order=created_at.desc&limit=3000"), [] as any[]),
      safe(db(`explainer_events?type=eq.signup&select=user_id,meta,created_at&order=created_at.desc&limit=20000`), [] as any[]),
      safe(db(`explainer_events?type=eq.visit&select=actor,meta,created_at&created_at=gte.${sinceN}&order=created_at.desc&limit=40000`), [] as any[]),
      safe(db("explainer_events?type=eq.handle&select=user_id,meta&order=created_at.desc&limit=5000"), [] as any[]),
      safe(count(`explainer_asks?created_at=gte.${since7}`), 0),
      safe(count(`explainer_events?created_at=gte.${since7}&type=eq.visit`), 0),
    ]);
    const rkapi = await rkapiBalance();

    // ---- members
    const handleOf: Record<string, string> = {};
    for (const h of handleEvs) if (!handleOf[h.user_id] && h.meta?.handle) handleOf[h.user_id] = String(h.meta.handle);
    const countryOf: Record<string, string> = {};
    for (const s of signups) if (s.user_id && !countryOf[s.user_id]) countryOf[s.user_id] = String(s.meta?.country ?? "");
    const jobsPerUser: Record<string, number> = {};
    for (const j of jobsRecent) if (j.user_id) jobsPerUser[j.user_id] = (jobsPerUser[j.user_id] || 0) + 1;
    const planOf: Record<string, any> = {};
    for (const p of plans) if (!planOf[p.user_id]) planOf[p.user_id] = p.meta;   // newest first
    const members = users.map((u: any) => ({
      id: u.id, email: u.username, handle: handleOf[u.id] ?? null, country: countryOf[u.id] ?? "", credits: u.credits, banned: !!u.banned, created_at: u.created_at, last_login: u.last_login,
      jobs: jobsPerUser[u.id] || 0, plan: planOf[u.id]?.plan ?? null, plan_until: planOf[u.id]?.until ?? null, plan_source: planOf[u.id]?.source ?? null,
    }));

    // ---- money
    const orderRows = orders.map((o: any) => {
      const n = String(o.notes ?? "");
      return {
        id: o.id, email: o.email, what: o.arxiv, status: o.status, method: o.pay_method, created_at: o.created_at,
        cny: Number(/price:(\d+(?:\.\d+)?)/.exec(n)?.[1] ?? 0), cur: /cur:([a-z]+)/.exec(n)?.[1] ?? "cny", amt: Number(/amt:(\d+)/.exec(n)?.[1] ?? 0),
        kind: /plan:([a-z_]+)/.exec(n)?.[1] ?? (/pack:(\d+)/.exec(n) ? "pack_" + /pack:(\d+)/.exec(n)![1] : "other"), shot: /shot:\S+/.test(n),
      };
    });
    const USD_CNY = 7.2;

    // ---- one row per day for every number the charts need
    const days: Record<string, any> = {};
    for (let i = DAYS - 1; i >= 0; i--) { const d = day(iso(i * DAY)); days[d] = { d, signups: 0, visitors: 0, videos: 0, failed: 0, checks: 0, income: 0, cost: 0, tokens: 0, calls: 0 }; }
    const bump = (d: string, k: string, n = 1) => { if (days[d]) days[d][k] += n; };
    for (const s of signups) bump(day(s.created_at), "signups");
    const seenV: Record<string, Set<string>> = {};
    for (const v of visits) { const d = day(v.created_at); (seenV[d] ??= new Set()).add(v.actor); }
    for (const d of Object.keys(seenV)) if (days[d]) days[d].visitors = seenV[d].size;
    for (const j of jobsAll) { bump(day(j.created_at), j.status === "failed" ? "failed" : "videos"); if (j.status !== "failed") bump(day(j.created_at), "cost", (Number(j.cost_usd) || 0) * USD_CNY); }
    for (const r of reproAll) bump(day(r.created_at), "checks");
    for (const o of orderRows) if (o.status === "paid" || o.status === "delivered") bump(day(o.created_at), "income", o.cny);
    for (const u of usage) { bump(day(u.created_at), "tokens", (u.prompt_tokens || 0) + (u.completion_tokens || 0)); bump(day(u.created_at), "calls"); }
    for (const d of Object.values(days)) d.cost = Math.round(d.cost * 100) / 100;

    // ---- where people are: chosen country, country of the connection, visitors by country and day
    const visitRows: Record<string, Set<string>> = {};
    for (const v of visits) { const k = `${day(v.created_at)}|${String(v.meta?.country || "??")}`; (visitRows[k] ??= new Set()).add(v.actor); }
    const visitCountry = Object.entries(visitRows).map(([k, set]) => { const [d, c] = k.split("|"); return { d, c, n: set.size }; });
    const signupRows = signups.slice(0, 10000).map((s: any) => ({ d: s.created_at, c: String(s.meta?.country ?? ""), ip: String(s.meta?.ip_country ?? ""), l: String(s.meta?.lang ?? ""), s: String(s.meta?.source ?? ""), r: String(s.meta?.role ?? "") }));

    // ---- usage of the model gateways by app and day (30 days)
    const llmRows: Record<string, { d: string; app: string; calls: number; tokens: number }> = {};
    for (const u of usage) { const k = `${day(u.created_at)}|${u.app}`; const r = (llmRows[k] ??= { d: day(u.created_at), app: u.app, calls: 0, tokens: 0 }); r.calls++; r.tokens += (u.prompt_tokens || 0) + (u.completion_tokens || 0); }

    return json({
      me: user.username,
      generated_at: new Date().toISOString(),
      usd_cny: USD_CNY,
      days: Object.values(days),
      members,
      active_plans: members.filter((m: any) => m.plan_until && new Date(m.plan_until) > new Date()).length,
      orders: orderRows,
      jobs: jobsRecent.map((j: any) => ({ id: j.id, arxiv: j.arxiv, title: j.title, status: j.status, stage: j.stage, seconds: j.seconds, langs: j.langs, cost_usd: j.cost_usd, error: j.error ? String(j.error).slice(0, 160) : null, created_at: j.created_at })),
      job_langs: jobsAll.map((j: any) => ({ d: day(j.created_at), l: j.langs, s: j.status })),
      repro: reproRecent,
      signup_rows: signupRows,
      visit_country: visitCountry,
      llm: Object.values(llmRows),
      feedback,
      asks_7d: asks7,
      visits_7d: visits7,
      rkapi,
    });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
