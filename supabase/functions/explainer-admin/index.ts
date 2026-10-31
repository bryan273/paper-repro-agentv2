// Admin dashboard data for Paper Explainer: who used it, orders, feedback.
// The caller signs in with an emailed code (Supabase Auth); this function asks Auth who the token belongs to and only
// answers for an address on the admin list, so no shared password or extra secret is involved.
//   GET                                      -> { me, counts, perDay, jobs, orders, feedback }
//   POST {op:"order_status", id, status}     -> { ok }   status: new | paid_claimed | paid | delivered | cancelled
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const ADMINS = (Deno.env.get("EXPLAINER_ADMIN_EMAILS") ?? "bryantjandra273@gmail.com").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const db = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`db ${r.status}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : null;
};
const count = async (q: string) => {
  const r = await fetch(`${SB_URL}/rest/v1/${q}&select=id`, { headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, Prefer: "count=exact", Range: "0-0" } });
  return Number((r.headers.get("content-range") ?? "").split("/")[1]) || 0;
};

// A passcode (secret EXPLAINER_ADMIN_TOKEN) lets the owner in without any email step; the emailed-code sign-in below still works too
const PASS = Deno.env.get("EXPLAINER_ADMIN_TOKEN") ?? Deno.env.get("SUITE_ADMIN_TOKEN") ?? "";
const sameText = (a: string, b: string) => { let d = a.length ^ b.length; for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0); return d === 0; };

async function grant(userId: string, amount: number, reason: string) {
  const [u] = await db(`explainer_users?id=eq.${userId}&select=credits`);
  await db(`explainer_users?id=eq.${userId}`, { method: "PATCH", body: JSON.stringify({ credits: Math.max(0, u.credits + amount) }) });
  await db("explainer_credit_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: userId, delta: amount, reason }) });
}

// Read-only preview: until ADMIN_VIEW_OPEN is set to "0", anyone can open the dashboard without a passcode. Changing anything
// (order status, credits, bans) still needs the passcode, and e-mail addresses are masked in what the preview shows.
const VIEW_OPEN = (Deno.env.get("ADMIN_VIEW_OPEN") ?? "1") !== "0";
const maskEmail = (e: unknown) => { const t = String(e ?? ""); const [u, d] = t.split("@"); return d ? `${u.slice(0, 1)}***@${d}` : t ? "***" : ""; };

async function whoAmI(req: Request): Promise<string | null> {
  const pass = req.headers.get("x-admin-token");
  if (pass !== null) return PASS && sameText(pass, PASS) ? "admin" : null;
  const token = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const r = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: ANON, Authorization: `Bearer ${token}` } });
  if (!r.ok) return null;
  const u = await r.json();
  return u?.email && u?.email_confirmed_at ? String(u.email).toLowerCase() : null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    let me = await whoAmI(req);
    let viewer = false;
    if (!me && VIEW_OPEN && req.method === "GET" && !req.headers.get("x-admin-token")) { me = "viewer"; viewer = true; }
    if (!me) return json({ error: "Wrong passcode." }, 401);
    if (!viewer && me !== "admin" && !ADMINS.includes(me)) return json({ error: "This account is not an admin.", me }, 403);

    if (req.method === "POST") {
      const body = await req.json();
      if (body.op === "order_status") {
        if (!/^[0-9a-f-]{36}$/.test(String(body.id)) || !["new", "paid_claimed", "paid", "delivered", "cancelled"].includes(String(body.status))) return json({ error: "bad request" }, 400);
        const [prev] = await db(`explainer_orders?id=eq.${body.id}&select=status,notes`);
        await db(`explainer_orders?id=eq.${body.id}`, { method: "PATCH", body: JSON.stringify({ status: body.status }) });
        // a credit pack (notes "pack:10 user:<id> price:9") that becomes paid adds its credits exactly once
        const m = /pack:(\d+) user:([0-9a-f-]{36})/.exec(prev?.notes ?? "");
        if (m && body.status === "paid" && prev.status !== "paid") await grant(m[2], Number(m[1]), `bought pack x${m[1]}`);
        return json({ ok: true });
      }
      if (body.op === "grant") {
        const amount = Math.round(Number(body.amount));
        if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000) return json({ error: "bad amount" }, 400);
        const [usr] = await db(`explainer_users?username=eq.${encodeURIComponent(String(body.username ?? "").toLowerCase())}&select=id`);
        if (!usr) return json({ error: "no such user" }, 404);
        await grant(usr.id, amount, String(body.reason ?? "").slice(0, 80) || "admin grant");
        return json({ ok: true });
      }
      if (body.op === "ban") {
        await db(`explainer_users?username=eq.${encodeURIComponent(String(body.username ?? "").toLowerCase())}`, { method: "PATCH", body: JSON.stringify({ banned: !!body.banned }) });
        return json({ ok: true });
      }
      return json({ error: "unknown op" }, 400);
    }

    const day = new Date(Date.now() - 86400_000).toISOString();
    const week = new Date(Date.now() - 7 * 86400_000).toISOString();
    const jobs = await db("explainer_jobs?select=id,created_at,arxiv,source_url,title,status,model,voice,visitor,error,seconds,cost_usd,usage&order=created_at.desc&limit=200");
    const orders = await db("explainer_orders?select=*&order=created_at.desc&limit=200");
    const feedback = await db("explainer_feedback?select=id,created_at,rating,use_case,comment,email,arxiv,kind&order=created_at.desc&limit=100");
    const perDayMap: Record<string, number> = {};
    for (const j of jobs) { const d = String(j.created_at).slice(0, 10); perDayMap[d] = (perDayMap[d] ?? 0) + 1; }
    const perDay = Object.entries(perDayMap).sort().slice(-14).map(([date, n]) => ({ date, n }));
    const counts: Record<string, number> = {
      jobs_total: await count("explainer_jobs?id=not.is.null"),
      jobs_24h: await count(`explainer_jobs?created_at=gte.${day}`),
      jobs_7d: await count(`explainer_jobs?created_at=gte.${week}`),
      jobs_failed: await count("explainer_jobs?status=eq.failed"),
      visitors: new Set(jobs.map((j: { visitor: string }) => j.visitor)).size,
      orders_total: await count("explainer_orders?id=not.is.null"),
      orders_waiting: await count("explainer_orders?status=eq.paid_claimed"),
      feedback_total: await count("explainer_feedback?id=not.is.null"),
    };
    // ---- cost: summed from the per-render token ledger (an estimate, see explainer/usage.py)
    const costOf = (list: { cost_usd: number | null; created_at: string }[], since?: string) => list.filter((j) => !since || j.created_at >= since).reduce((a, j) => a + Number(j.cost_usd ?? 0), 0);
    const priced = jobs.filter((j: { cost_usd: number | null }) => j.cost_usd !== null);
    const costs = {
      total_usd: Math.round(costOf(jobs) * 100) / 100,
      usd_24h: Math.round(costOf(jobs, day) * 100) / 100,
      usd_7d: Math.round(costOf(jobs, week) * 100) / 100,
      priced_jobs: priced.length,
      avg_usd: priced.length ? Math.round((costOf(jobs) / priced.length) * 1000) / 1000 : 0,
      note: "Estimated from token counts and a price table; only renders since cost tracking started are priced.",
    };
    // ---- members, event log and the funnel (visitor -> made a video -> signed up -> bought)
    const users = await db("explainer_users?select=id,username,credits,banned,created_at,last_login&order=created_at.desc&limit=300");
    const perUser: Record<string, { n: number; last: string }> = {};
    for (const j of await db("explainer_jobs?user_id=not.is.null&select=user_id,created_at&order=created_at.desc&limit=2000")) { const x = perUser[j.user_id] ??= { n: 0, last: j.created_at }; x.n++; }
    const events = await db("explainer_events?select=id,created_at,actor,user_id,type,meta&order=id.desc&limit=300");
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    const evs = await db(`explainer_events?created_at=gte.${since}&select=actor,type,created_at&order=id.desc&limit=20000`);
    const actors = (types: string[]) => new Set(evs.filter((e: { type: string }) => types.includes(e.type)).map((e: { actor: string }) => e.actor)).size;
    const funnel = [
      { step: "Visitors", n: actors(["visit"]) },
      { step: "Started a video", n: actors(["job_created"]) },
      { step: "Hit the free limit", n: actors(["quota_hit"]) },
      { step: "Opened sign-up", n: actors(["open_signup"]) },
      { step: "Signed up", n: actors(["signup"]) },
      { step: "Ordered credits", n: actors(["order_created"]) },
    ];
    const byType: Record<string, number> = {};
    for (const e of evs) byType[e.type] = (byType[e.type] ?? 0) + 1;
    const memberJobs = await count("explainer_jobs?user_id=not.is.null");
    const credits = await db("explainer_credit_log?select=id,created_at,user_id,delta,reason&order=id.desc&limit=100");
    const contacts = feedback.filter((f: { kind: string }) => f.kind === "contact").length;
    // visitors are shown by a short id only (a hash made by the render function), never by IP
    return json({ me, viewer, costs, funnel, byType, contacts, users: users.map((u: { id: string }) => ({ ...u, jobs: perUser[u.id]?.n ?? 0, last_job: perUser[u.id]?.last ?? null })), events: events.map((e: { actor: string }) => ({ ...e, actor: e.actor.slice(0, 8) })), credits, counts: { ...counts, users_total: users.length, member_jobs: memberJobs }, perDay, jobs: jobs.map((j: { visitor: string }) => ({ ...j, visitor: String(j.visitor ?? "").slice(0, 8) })), orders: viewer ? orders.map((o: Record<string, unknown>) => ({ ...o, contact: maskEmail(o.contact), email: maskEmail(o.email) })) : orders, feedback: viewer ? feedback.map((f: { email: string }) => ({ ...f, email: maskEmail(f.email) })) : feedback });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
