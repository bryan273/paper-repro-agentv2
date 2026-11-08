// One admin overview for the whole Repro Suite: every app's numbers on one screen.
// Only an admin account (EXPLAINER_ADMIN_EMAILS, signed in with the shared session) is answered; anyone else gets 401 or 403.
//   GET -> { me, apps:[{id,title,stats,...}], users, jobs, repro, requests, orders, feedback, llm, perDay }
// Changing things (credits, bans, order status) is done through explainer-admin with the same session; this function only reads.
import { CORS, json, db, count, userOf, isAdmin } from "../_shared/explainer.ts";

const DAY = 86400_000;
const iso = (ms: number) => new Date(Date.now() - ms).toISOString();
const day = (s: string) => s.slice(0, 10);
const safe = async <T>(p: Promise<T>, fallback: T): Promise<T> => { try { return await p; } catch { return fallback; } };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method !== "GET") return json({ error: "GET only" }, 405);
    const user = await userOf(req);
    if (!user) return json({ error: "Sign in with an admin account (Log in, top right)." }, 401);
    if (!isAdmin(user)) return json({ error: "This account is not an admin." }, 403);

    const since7 = iso(7 * DAY), since1 = iso(DAY), since14 = iso(14 * DAY);
    const [users, jobs, usage, reproJobs, reproEvents, boards, docs, orders, feedback, asks, events, plans, payOrders, costJobs, signups] = await Promise.all([
      safe(db("explainer_users?select=id,username,credits,banned,created_at,last_login&order=created_at.desc&limit=500"), [] as any[]),
      safe(db("explainer_jobs?select=id,arxiv,title,status,stage,user_id,seconds,langs,cost_usd,error,created_at&order=created_at.desc&limit=500"), [] as any[]),
      safe(db(`agent_usage?select=app,visitor,prompt_tokens,completion_tokens,created_at&created_at=gte.${since14}&limit=20000`), [] as any[]),
      safe(db("repro_jobs?select=id,arxiv_id,title,lang,status,verdict,agent,model,created_at&order=created_at.desc&limit=200"), [] as any[]),
      safe(count(`repro_events?created_at=gte.${since7}`), 0),
      safe(db("suite_boards?select=slug,title,created_at,updated_at&order=updated_at.desc&limit=50"), [] as any[]),
      safe(db(`suite_docs?select=id,collection,key,data,created_at&order=created_at.desc&limit=500`), [] as any[]),
      safe(db("explainer_orders?select=id,email,arxiv,status,pay_method,notes,created_at&order=created_at.desc&limit=50"), [] as any[]),
      safe(db("explainer_feedback?select=id,rating,comment,kind,arxiv,created_at&order=created_at.desc&limit=30"), [] as any[]),
      safe(count(`explainer_asks?created_at=gte.${since7}`), 0),
      safe(count(`explainer_events?created_at=gte.${since7}&type=eq.visit`), 0),
      safe(db("explainer_events?type=eq.plan&select=user_id,meta,created_at&order=created_at.desc&limit=500"), [] as any[]),
      safe(db("explainer_orders?status=in.(paid,delivered)&select=id,notes,created_at&order=created_at.desc&limit=5000"), [] as any[]),
      safe(db("explainer_jobs?status=neq.failed&select=created_at,cost_usd&order=created_at.desc&limit=10000"), [] as any[]),
      safe(db("explainer_events?type=eq.signup&select=meta,created_at&order=created_at.desc&limit=10000"), [] as any[]),
    ]);

    // money: income is what the owner confirmed as paid (yuan, the price the order was made at); the cost is the model and renderer estimate stored per video (USD, shown in yuan at 7.2)
    const USD_CNY = 7.2;
    const paid = payOrders.map((o: any) => {
      const n = String(o.notes ?? "");
      const price = Number(/price:(\d+(?:\.\d+)?)/.exec(n)?.[1] ?? 0);
      const kind = /plan:([a-z_]+)/.exec(n)?.[1] ?? (/pack:(\d+)/.exec(n) ? "pack " + /pack:(\d+)/.exec(n)![1] : "other");
      return { price, kind, cur: /cur:([a-z]+)/.exec(n)?.[1] ?? "cny", amt: Number(/amt:(\d+)/.exec(n)?.[1] ?? 0), created_at: o.created_at as string };
    });
    const costOf = (j: any) => (Number(j.cost_usd) || 0) * USD_CNY;
    const days30: { d: string; income: number; cost: number }[] = [];
    for (let i = 29; i >= 0; i--) {
      const d = day(iso(i * DAY));
      days30.push({ d, income: paid.filter((o: any) => day(o.created_at) === d).reduce((n: number, o: any) => n + o.price, 0), cost: Math.round(costJobs.filter((j: any) => day(j.created_at) === d).reduce((n: number, j: any) => n + costOf(j), 0) * 100) / 100 });
    }
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const sumIn = (f: (o: any) => boolean) => paid.filter(f).reduce((n: number, o: any) => n + o.price, 0);
    const sumCost = (f: (j: any) => boolean) => Math.round(costJobs.filter(f).reduce((n: number, j: any) => n + costOf(j), 0) * 100) / 100;
    const byKind: Record<string, { n: number; cny: number }> = {};
    for (const o of paid) { const k = (byKind[o.kind] ??= { n: 0, cny: 0 }); k.n++; k.cny += o.price; }
    const finance = {
      usd_cny: USD_CNY,
      income_total: sumIn(() => true), income_month: sumIn((o: any) => o.created_at >= monthStart.toISOString()), income_30d: sumIn((o: any) => o.created_at >= iso(30 * DAY)),
      cost_total: sumCost(() => true), cost_month: sumCost((j: any) => j.created_at >= monthStart.toISOString()), cost_30d: sumCost((j: any) => j.created_at >= iso(30 * DAY)),
      orders_paid: paid.length, by_kind: Object.entries(byKind).map(([k, v]) => ({ k, ...v })).sort((a, b) => b.cny - a.cny), days: days30,
    };
    // who the members are: where they come from and what they told us at sign-up
    const tally = (pick: (m: any) => string) => {
      const m: Record<string, number> = {};
      for (const s of signups) { const k = pick(s.meta ?? {}) || "unknown"; m[k] = (m[k] || 0) + 1; }
      return Object.entries(m).map(([k, n]) => ({ k, n })).sort((a, b) => b.n - a.n).slice(0, 12);
    };
    const audience = { total: signups.length, countries: tally((m) => m.country), ip_countries: tally((m) => m.ip_country), langs: tally((m) => m.lang), sources: tally((m) => m.source), roles: tally((m) => m.role) };

    // tokens and calls per gateway app (Lite, Companion, IndexBoard, and what Explainer asks through the same gateway)
    const llm: Record<string, { app: string; calls_24h: number; calls_7d: number; tokens_24h: number; tokens_7d: number; visitors_7d: number }> = {};
    const seen: Record<string, Set<string>> = {};
    for (const r of usage) {
      const a = (llm[r.app] ??= { app: r.app, calls_24h: 0, calls_7d: 0, tokens_24h: 0, tokens_7d: 0, visitors_7d: 0 });
      const tok = (r.prompt_tokens || 0) + (r.completion_tokens || 0);
      if (r.created_at >= since7) { a.calls_7d++; a.tokens_7d += tok; (seen[r.app] ??= new Set()).add(r.visitor); }
      if (r.created_at >= since1) { a.calls_24h++; a.tokens_24h += tok; }
    }
    for (const k of Object.keys(llm)) llm[k].visitors_7d = seen[k]?.size ?? 0;

    const by = <T extends { status: string }>(rows: T[]) => rows.reduce((m: Record<string, number>, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
    const jobsByStatus = by(jobs);
    const cost = jobs.reduce((n: number, j: any) => n + (Number(j.cost_usd) || 0), 0);
    const cost7 = jobs.filter((j: any) => j.created_at >= since7).reduce((n: number, j: any) => n + (Number(j.cost_usd) || 0), 0);
    const docsBy = docs.reduce((m: Record<string, number>, d: any) => ((m[d.collection] = (m[d.collection] || 0) + 1), m), {});
    const requests = docs.filter((d: any) => d.collection === "repro_requests").slice(0, 20);
    const checks7 = docs.filter((d: any) => d.collection === "checks" && d.created_at >= since7).length;
    const reading7 = docs.filter((d: any) => d.collection === "reading_sessions" && d.created_at >= since7).length;
    const reproBy = by(reproJobs);
    const jobsPerUser: Record<string, number> = {};
    for (const j of jobs) if (j.user_id) jobsPerUser[j.user_id] = (jobsPerUser[j.user_id] || 0) + 1;

    // the last 14 days, one row per day, so the page can draw a small trend for each app
    const perDay: { d: string; signups: number; videos: number; checks: number; llm_tokens: number }[] = [];
    for (let i = 89; i >= 0; i--) {
      const d = day(iso(i * DAY));
      perDay.push({
        d,
        signups: users.filter((u: any) => day(u.created_at) === d).length,
        videos: jobs.filter((j: any) => day(j.created_at) === d).length,
        checks: reproJobs.filter((j: any) => day(j.created_at) === d).length,
        llm_tokens: usage.filter((r: any) => day(r.created_at) === d).reduce((n: number, r: any) => n + (r.prompt_tokens || 0) + (r.completion_tokens || 0), 0),
      });
    }

    const apps = [
      { id: "explainer", title: "Explain", href: "explainer/", stats: [
        { k: "Videos", v: jobs.length }, { k: "Ready", v: jobsByStatus.done || 0 }, { k: "Failed", v: jobsByStatus.failed || 0 },
        { k: "Questions asked (7d)", v: asks }, { k: "Visits (7d)", v: events }, { k: "Model cost, last 500 jobs (USD)", v: Math.round(cost * 100) / 100 },
        { k: "Model cost 7d (USD)", v: Math.round(cost7 * 100) / 100 },
      ] },
      { id: "agent", title: "Check", href: "repro/index.html", stats: [
        { k: "Reproductions", v: reproJobs.length }, { k: "Done", v: reproBy.done || 0 }, { k: "Running", v: reproBy.running || 0 },
        { k: "Waiting", v: reproBy.waiting || 0 }, { k: "Failed", v: reproBy.failed || 0 }, { k: "Agent events (7d)", v: reproEvents },
      ] },
      { id: "lite", title: "Quick check", href: "lite/", stats: [
        { k: "Quick checks saved (7d)", v: checks7 }, { k: "Model calls (7d)", v: llm["repro-lite"]?.calls_7d ?? 0 }, { k: "Tokens (7d)", v: llm["repro-lite"]?.tokens_7d ?? 0 }, { k: "Visitors (7d)", v: llm["repro-lite"]?.visitors_7d ?? 0 },
      ] },
      { id: "companion", title: "Read", href: "reading/", stats: [
        { k: "Reading sessions (7d)", v: reading7 }, { k: "Model calls (7d)", v: llm["companion"]?.calls_7d ?? 0 }, { k: "Tokens (7d)", v: llm["companion"]?.tokens_7d ?? 0 }, { k: "Visitors (7d)", v: llm["companion"]?.visitors_7d ?? 0 },
      ] },
      { id: "indexboard", title: "Boards", href: "indexboard/", stats: [
        { k: "Boards", v: boards.length }, { k: "Model calls (7d)", v: llm["indexboard"]?.calls_7d ?? 0 }, { k: "Tokens (7d)", v: llm["indexboard"]?.tokens_7d ?? 0 },
      ] },
      { id: "desk", title: "Human check", href: "desk/", stats: [
        { k: "Requests", v: docsBy.repro_requests || 0 }, { k: "Open orders", v: orders.filter((o: any) => ["new", "paid_claimed"].includes(o.status)).length },
      ] },
    ];

    return json({
      me: user.username,
      generated_at: new Date().toISOString(),
      finance,
      audience,
      totals: { users: users.length, banned: users.filter((u: any) => u.banned).length, credits: users.reduce((n: number, u: any) => n + (u.credits || 0), 0), signups_7d: users.filter((u: any) => u.created_at >= since7).length },
      apps,
      users: users.slice(0, 500).map((u: any) => {
        const pe = plans.find((x: any) => x.user_id === u.id);   // newest first
        const until = pe?.meta?.until ?? null;
        return { ...u, jobs: jobsPerUser[u.id] || 0, plan: pe?.meta?.plan ?? null, plan_until: until };
      }),
      active_plans: plans.filter((x: any, k: number) => plans.findIndex((y: any) => y.user_id === x.user_id) === k && x.meta?.until && new Date(x.meta.until) > new Date()).length,
      jobs: jobs.slice(0, 200).map((j: any) => ({ id: j.id, arxiv: j.arxiv, title: j.title, status: j.status, stage: j.stage, seconds: j.seconds, langs: j.langs, cost_usd: j.cost_usd, error: j.error ? String(j.error).slice(0, 160) : null, created_at: j.created_at })),
      repro: reproJobs.slice(0, 200),
      requests: requests.map((r: any) => ({ id: r.id, created_at: r.created_at, data: r.data })),
      boards,
      orders: orders.slice(0, 50),
      feedback: feedback.slice(0, 30),
      llm: Object.values(llm),
      perDay,
    });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
