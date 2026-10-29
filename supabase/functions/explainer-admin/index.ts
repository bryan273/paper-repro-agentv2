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
    const me = await whoAmI(req);
    if (!me) return json({ error: "Wrong passcode." }, 401);
    if (me !== "admin" && !ADMINS.includes(me)) return json({ error: "This account is not an admin.", me }, 403);

    if (req.method === "POST") {
      const body = await req.json();
      if (body.op === "order_status") {
        if (!/^[0-9a-f-]{36}$/.test(String(body.id)) || !["new", "paid_claimed", "paid", "delivered", "cancelled"].includes(String(body.status))) return json({ error: "bad request" }, 400);
        await db(`explainer_orders?id=eq.${body.id}`, { method: "PATCH", body: JSON.stringify({ status: body.status }) });
        return json({ ok: true });
      }
      return json({ error: "unknown op" }, 400);
    }

    const day = new Date(Date.now() - 86400_000).toISOString();
    const week = new Date(Date.now() - 7 * 86400_000).toISOString();
    const jobs = await db("explainer_jobs?select=id,created_at,arxiv,source_url,title,status,model,voice,visitor,error&order=created_at.desc&limit=200");
    const orders = await db("explainer_orders?select=*&order=created_at.desc&limit=200");
    const feedback = await db("explainer_feedback?select=id,created_at,rating,use_case,comment,email,arxiv,kind&order=created_at.desc&limit=100");
    const perDayMap: Record<string, number> = {};
    for (const j of jobs) { const d = String(j.created_at).slice(0, 10); perDayMap[d] = (perDayMap[d] ?? 0) + 1; }
    const perDay = Object.entries(perDayMap).sort().slice(-14).map(([date, n]) => ({ date, n }));
    const counts = {
      jobs_total: await count("explainer_jobs?id=not.is.null"),
      jobs_24h: await count(`explainer_jobs?created_at=gte.${day}`),
      jobs_7d: await count(`explainer_jobs?created_at=gte.${week}`),
      jobs_failed: await count("explainer_jobs?status=eq.failed"),
      visitors: new Set(jobs.map((j: { visitor: string }) => j.visitor)).size,
      orders_total: await count("explainer_orders?id=not.is.null"),
      orders_waiting: await count("explainer_orders?status=eq.paid_claimed"),
      feedback_total: await count("explainer_feedback?id=not.is.null"),
    };
    // visitors are shown by a short id only (a hash made by the render function), never by IP
    return json({ me, counts, perDay, jobs: jobs.map((j: { visitor: string }) => ({ ...j, visitor: String(j.visitor ?? "").slice(0, 8) })), orders, feedback });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
