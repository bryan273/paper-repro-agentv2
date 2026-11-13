// Admin dashboard data for Paper Explainer: who used it, orders, feedback.
// The caller signs in with an emailed code (Supabase Auth); this function asks Auth who the token belongs to and only
// answers for an address on the admin list, so no shared password or extra secret is involved.
//   GET                                      -> { me, counts, perDay, jobs, orders, feedback }
//   POST {op:"grant_plan", username, plan, days} -> { ok, until }   a plan given free by the owner
//   POST {op:"revoke_plan", username} -> { ok }   ends the member's plan now
//   POST {op:"notify", user_id | username, text, about?} -> { ok, to }   a message into the member's inbox
//   POST {op:"order_status", id, status}     -> { ok }   status: new | paid_claimed | paid | delivered | cancelled
import { mailReady, sendMail } from "../_shared/mail.ts";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const ADMINS = (Deno.env.get("EXPLAINER_ADMIN_EMAILS") ?? "bryantjandra273@gmail.com").toLowerCase().split(",").map((s) => s.trim()).filter(Boolean);
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token, x-session", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const db = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`db ${r.status}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : null;
};
let OPS_CACHE: { at: number; ops: unknown } | null = null;   // the last storage count of this function instance
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
const VIEW_OPEN = (Deno.env.get("ADMIN_VIEW_OPEN") ?? "0") !== "0";
const maskEmail = (e: unknown) => { const t = String(e ?? ""); const [u, d] = t.split("@"); return d ? `${u.slice(0, 1)}***@${d}` : t ? "***" : ""; };

async function whoAmI(req: Request): Promise<string | null> {
  const pass = req.headers.get("x-admin-token");
  if (pass !== null) return PASS && sameText(pass, PASS) ? "admin" : null;
  // a signed-in member of the suite whose address is on the admin list (the same sign-in as the navbar)
  const sess = req.headers.get("x-session");
  if (sess) {
    const r = await fetch(`${SB_URL}/functions/v1/explainer-account?me=1`, { headers: { apikey: ANON, Authorization: `Bearer ${ANON}`, "x-session": sess } });
    const j = r.ok ? await r.json().catch(() => null) : null;
    const name = String(j?.user?.username ?? "").toLowerCase();
    return name ? name : null;
  }
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
    if (!me) return json({ error: "Sign in with an admin account (Log in, top right)." }, 401);
    if (!viewer && me !== "admin" && !ADMINS.includes(me)) return json({ error: "This account is not an admin.", me }, 403);

    const q = new URL(req.url).searchParams;
    if (req.method === "GET" && q.get("ops")) {   // only the storage numbers; counting them scans several tables (3 to 4 s), so the answer is kept for an hour. ?fresh=1 counts again.
      if (!q.get("fresh") && OPS_CACHE && Date.now() - OPS_CACHE.at < 3600_000) return json({ ops: OPS_CACHE.ops, counted_at: new Date(OPS_CACHE.at).toISOString(), cached: true });
      const ops = await db("rpc/ops_stats", { method: "POST", body: "{}" }).catch(() => null);
      if (ops) OPS_CACHE = { at: Date.now(), ops };
      return json({ ops: ops ?? OPS_CACHE?.ops ?? null, counted_at: new Date(ops ? Date.now() : OPS_CACHE?.at ?? 0).toISOString(), cached: !ops });
    }
    if (req.method === "GET" && !viewer && q.get("member")) {   // one member's credits: balance, plan, and what every credit was used for
      const id = String(q.get("member"));
      if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "bad id" }, 400);
      const [usr, ledger, jobs, plan] = await Promise.all([
        db(`explainer_users?id=eq.${id}&select=id,username,credits,created_at`),
        db(`explainer_credit_log?user_id=eq.${id}&select=id,created_at,delta,reason&order=id.desc&limit=200`),
        db(`explainer_jobs?user_id=eq.${id}&select=id,title,arxiv,status,seconds,custom,credit_used,refunded,created_at,cost_usd&order=created_at.desc&limit=200`),
        db(`explainer_events?user_id=eq.${id}&type=eq.plan&select=meta,created_at&order=created_at.desc&limit=1`),
      ]);
      if (!usr[0]) return json({ error: "no such member" }, 404);
      return json({ user: usr[0], plan: plan[0]?.meta ?? null, ledger, jobs });
    }
    if (req.method === "GET" && !viewer && (q.get("proof") || q.get("shot"))) {   // a proof or payment file, shown to the admin; a photo sent as a PDF is unwrapped so the browser can show it
      let path = "";
      if (q.get("proof")) {
        if (!/^\d+$/.test(q.get("proof")!)) return json({ error: "bad id" }, 400);
        const [ev] = await db(`explainer_events?id=eq.${q.get("proof")}&type=eq.verify&select=meta`);
        path = String(ev?.meta?.path ?? "");
      } else {
        if (!/^[0-9a-f-]{36}$/.test(q.get("shot")!)) return json({ error: "bad id" }, 400);
        const [o] = await db(`explainer_orders?id=eq.${q.get("shot")}&select=notes`);
        path = /shot:(\S+)/.exec(String(o?.notes ?? ""))?.[1] ?? "";
      }
      if (!/^proof\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.(pdf|jpg|jpeg|png|webp)$/.test(path)) return json({ error: "No file was sent." }, 404);
      const fr = await fetch(`${SB_URL}/storage/v1/object/explainer-uploads/${path}`, { headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}` } });
      if (!fr.ok) return json({ error: "The file could not be read from storage." }, 404);
      const bytes = new Uint8Array(await fr.arrayBuffer());
      let type = path.endsWith(".pdf") ? "application/pdf" : path.endsWith(".png") ? "image/png" : path.endsWith(".webp") ? "image/webp" : "image/jpeg";
      let out = bytes;
      if (type === "application/pdf") {   // the browser sends a photo as a one-page PDF around the picture: take the picture out again
        let lat = ""; for (let i = 0; i < bytes.length; i += 8192) lat += String.fromCharCode(...bytes.subarray(i, i + 8192));
        const k = lat.indexOf("/DCTDecode");
        if (k > 0) {
          const s0 = lat.indexOf("stream", k);
          const start = s0 + (lat.charAt(s0 + 6) === "\r" ? 8 : 7);
          const end = lat.lastIndexOf("\nendstream");
          if (s0 > 0 && end > start) {
            const img = bytes.slice(start, end);
            if (img[0] === 0xff && img[1] === 0xd8) { out = img; type = "image/jpeg"; }
            else if (img[0] === 0x89 && img[1] === 0x50) { out = img; type = "image/png"; }
          }
        }
      }
      return new Response(out, { headers: { ...CORS, "Content-Type": type, "Cache-Control": "no-store" } });
    }

    if (req.method === "POST") {
      const body = await req.json();
      if (body.op === "order_status") {
        if (!/^[0-9a-f-]{36}$/.test(String(body.id)) || !["new", "paid_claimed", "paid", "delivered", "cancelled"].includes(String(body.status))) return json({ error: "bad request" }, 400);
        const [prev] = await db(`explainer_orders?id=eq.${body.id}&select=status,notes`);
        await db(`explainer_orders?id=eq.${body.id}`, { method: "PATCH", body: JSON.stringify({ status: body.status }) });
        // a credit pack (notes "pack:10 user:<id> price:9") that becomes paid adds its credits exactly once
        const m = /pack:(\d+) user:([0-9a-f-]{36})/.exec(prev?.notes ?? "");
        if (m && body.status === "paid" && prev.status !== "paid") await grant(m[2], Number(m[1]), `bought pack x${m[1]}`);
        const pl = /plan:(plus|pro|premium)_(month|year)/.exec(prev?.notes ?? "");
        if (m && pl && body.status === "paid" && prev.status !== "paid") {
          const days = (pl[2] === "year" ? 366 : 31) * 86400_000, now = Date.now();
          const up = /upg:(A|B):(\S+)/.exec(prev?.notes ?? "");
          let until = new Date(now + days).toISOString();
          if (up && up[1] === "A" && Date.parse(up[2]) > now) until = up[2];   // an upgrade keeps the end date of the period already running
          else if (!up && /renew:1/.test(prev?.notes ?? "")) {   // an early renewal starts when the running period ends, so no paid day is lost
            const [cur] = await db(`explainer_events?user_id=eq.${m[2]}&type=eq.plan&select=meta&order=created_at.desc&limit=1`).catch(() => []);
            if (cur?.meta?.until && Date.parse(cur.meta.until) > now) until = new Date(Date.parse(cur.meta.until) + days).toISOString();
          }
          await db("explainer_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor: "", type: "plan", user_id: m[2], meta: { plan: pl[1], until } }) });
        }
        return json({ ok: true });
      }
      if (body.op === "verify_list") {   // proofs waiting for a decision, with a one-hour link to look at each file
        const rows = await db(`explainer_events?type=eq.verify&select=id,user_id,created_at,meta&order=created_at.desc&limit=60`);
        const out = [];
        for (const r of rows) {
          const [usr] = await db(`explainer_users?id=eq.${r.user_id}&select=username`).catch(() => []);
          let link = "";
          try {
            const sg = await fetch(`${SB_URL}/storage/v1/object/sign/explainer-uploads/${r.meta.path}`, { method: "POST", headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" }, body: JSON.stringify({ expiresIn: 3600 }) });
            if (sg.ok) link = `${SB_URL}/storage/v1${(await sg.json()).signedURL}`;
          } catch { /* no link */ }
          out.push({ id: r.id, user_id: r.user_id, username: usr?.username ?? "", created_at: r.created_at, role: r.meta.role, school: r.meta.school, status: r.meta.status, link });
        }
        return json({ items: out });
      }
      if (body.op === "verify_decide") {
        if (!/^\d+$/.test(String(body.id))) return json({ error: "bad request" }, 400);   // the event id is a number
        const [ev] = await db(`explainer_events?id=eq.${body.id}&type=eq.verify&select=user_id,meta`);
        if (!ev || ev.meta.status !== "pending") return json({ error: "already decided" }, 409);
        const ok = !!body.approve;
        await db(`explainer_events?id=eq.${body.id}`, { method: "PATCH", body: JSON.stringify({ meta: { ...ev.meta, status: ok ? "approved" : "rejected" } }) });
        const until = new Date(Date.now() + 31 * 86400_000).toISOString();
        if (ok) {   // a free month of Plus: the plan and its 50 videos
          await db("explainer_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor: "", type: "plan", user_id: ev.user_id, meta: { plan: "plus", until, source: ev.meta.role } }) });
          await grant(ev.user_id, 20, `free Plus month (${ev.meta.role})`);
        }
        if (mailReady()) {   // the member is told by e-mail; a failure here never undoes the decision
          try {
            const [usr] = await db(`explainer_users?id=eq.${ev.user_id}&select=username`);
            const [sg] = await db(`explainer_events?user_id=eq.${ev.user_id}&type=eq.signup&select=meta&order=created_at.asc&limit=1`).catch(() => []);
            const lang = ["zh", "vi", "id"].includes(String(sg?.meta?.lang)) ? String(sg.meta.lang) : "en";
            const D = new Date(until).toLocaleDateString(lang === "zh" ? "zh-CN" : lang === "vi" ? "vi-VN" : lang === "id" ? "id-ID" : "en-GB", { day: "numeric", month: "long", year: "numeric" });
            const T: Record<string, { s1: string; b1: string; s0: string; b0: string }> = {
              en: { s1: "Your free month of Plus is active", b1: `Thank you for sending your proof. Plus is on until ${D}: 50 videos, 10 interactive videos and in-depth answers.`, s0: "We could not verify your proof", b0: "We could not verify that proof. Please send a clearer photo or a school letter from your account page." },
              zh: { s1: "你的 Plus 免费月已开通", b1: `感谢提交证明。Plus 已开通，有效期至 ${D}：50 个视频、10 个互动视频和深入回答。`, s0: "未能验证你的证明", b0: "这份证明未能通过验证。请在账户页重新发送更清晰的照片或学校证明。" },
              vi: { s1: "Tháng Plus miễn phí của bạn đã được kích hoạt", b1: `Cảm ơn bạn đã gửi giấy tờ. Plus có hiệu lực đến ${D}: 50 video, 10 video tương tác và câu trả lời chuyên sâu.`, s0: "Chúng tôi chưa xác minh được giấy tờ của bạn", b0: "Chưa xác minh được giấy tờ đó. Hãy gửi lại ảnh rõ hơn hoặc giấy xác nhận của trường trong trang tài khoản." },
              id: { s1: "Bulan Plus gratis Anda sudah aktif", b1: `Terima kasih sudah mengirim bukti. Plus aktif sampai ${D}: 50 video, 10 video interaktif, dan jawaban mendalam.`, s0: "Kami belum bisa memverifikasi bukti Anda", b0: "Bukti itu belum bisa diverifikasi. Kirim foto yang lebih jelas atau surat dari sekolah di halaman akun Anda." },
            };
            const m = T[lang];
            await sendMail(String(usr.username), ok ? m.s1 : m.s0, `<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;padding:24px"><h2>${ok ? m.s1 : m.s0}</h2><p style="line-height:1.5">${ok ? m.b1 : m.b0}</p></div>`, ok ? m.b1 : m.b0);
          } catch { /* the mail is a courtesy */ }
        }
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
      if (body.op === "grant_plan") {   // a plan given by the owner, no payment: Plus, Pro or Premium for a number of days
        const plan = String(body.plan ?? "");
        const days = Math.round(Number(body.days ?? 31));
        if (!["plus", "pro", "premium"].includes(plan) || !Number.isFinite(days) || days < 1 || days > 400) return json({ error: "bad request" }, 400);
        const [usr] = await db(`explainer_users?username=eq.${encodeURIComponent(String(body.username ?? "").toLowerCase())}&select=id`);
        if (!usr) return json({ error: "no such user" }, 404);
        const until = new Date(Date.now() + days * 86400_000).toISOString();
        await db("explainer_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor: "", type: "plan", user_id: usr.id, meta: { plan, until, source: "admin" } }) });
        // a plan is its video credits: a paid plan adds them when the payment is confirmed, so a gift must add them too (without them the member fell back to the 3 free videos a week)
        const perMonth = ({ plus: 20, pro: 40, premium: 80 } as Record<string, number>)[plan];
        const credits = body.credits === false ? 0 : Math.max(1, Math.round((perMonth * days) / 31));
        if (credits > 0) await grant(usr.id, credits, `plan gift: ${plan}, ${days} days`);
        return json({ ok: true, until, credits });
      }
      if (body.op === "revoke_plan") {   // ends a member's plan now (a gift or a mistake): a newer plan record that is already over
        const [usr] = await db(`explainer_users?username=eq.${encodeURIComponent(String(body.username ?? "").toLowerCase())}&select=id`);
        if (!usr) return json({ error: "no such user" }, 404);
        await db("explainer_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor: "", type: "plan", user_id: usr.id, meta: { plan: "plus", until: new Date(Date.now() - 1000).toISOString(), source: "admin" } }) });
        return json({ ok: true });
      }
      if (body.op === "notify") {   // a note from the team to one member: it lands in their inbox in the app (the bell at the top)
        const text = String(body.text ?? "").trim().slice(0, 700);
        if (text.length < 3) return json({ error: "Write the message first." }, 400);
        const id = String(body.user_id ?? "");
        const [usr] = /^[0-9a-f-]{36}$/.test(id) ? await db(`explainer_users?id=eq.${id}&select=id,username`) : await db(`explainer_users?username=eq.${encodeURIComponent(String(body.username ?? "").toLowerCase())}&select=id,username`);
        if (!usr) return json({ error: "no such user" }, 404);
        await db("explainer_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor: "admin", type: "reply", user_id: usr.id, meta: { text, about: String(body.about ?? "").slice(0, 120) } }) });
        return json({ ok: true, to: usr.username });
      }
      if (body.op === "ban") {
        await db(`explainer_users?username=eq.${encodeURIComponent(String(body.username ?? "").toLowerCase())}`, { method: "PATCH", body: JSON.stringify({ banned: !!body.banned }) });
        return json({ ok: true });
      }
      return json({ error: "unknown op" }, 400);
    }

    const day = new Date(Date.now() - 86400_000).toISOString();
    const week = new Date(Date.now() - 7 * 86400_000).toISOString();
    const since = new Date(Date.now() - 30 * 86400_000).toISOString();
    // every query is independent and the database is in another region from the function, so run them all at once: one after another this took 5 s
    const [jobs, orders, feedback, jobsTotal, jobs24h, jobs7d, jobsFailed, ordersTotal, ordersWaiting, feedbackTotal, users, userJobs, events, evs, memberJobs, credits, ops] = await Promise.all([
      db("explainer_jobs?select=id,created_at,arxiv,source_url,title,status,model,voice,visitor,error,seconds,cost_usd,usage&order=created_at.desc&limit=200"),
      db("explainer_orders?select=*&order=created_at.desc&limit=200"),
      db("explainer_feedback?select=id,created_at,rating,use_case,comment,email,arxiv,kind&order=created_at.desc&limit=100"),
      count("explainer_jobs?id=not.is.null"),
      count(`explainer_jobs?created_at=gte.${day}`),
      count(`explainer_jobs?created_at=gte.${week}`),
      count("explainer_jobs?status=eq.failed"),
      count("explainer_orders?id=not.is.null"),
      count("explainer_orders?status=eq.paid_claimed"),
      count("explainer_feedback?id=not.is.null"),
      db("explainer_users?select=id,username,credits,banned,created_at,last_login&order=created_at.desc&limit=300"),
      db("explainer_jobs?user_id=not.is.null&select=user_id,created_at&order=created_at.desc&limit=2000"),
      db("explainer_events?select=id,created_at,actor,user_id,type,meta&order=id.desc&limit=300"),
      db(`explainer_events?created_at=gte.${since}&select=actor,type,created_at&order=id.desc&limit=20000`),
      count("explainer_jobs?user_id=not.is.null"),
      db("explainer_credit_log?select=id,created_at,user_id,delta,reason&order=id.desc&limit=100"),
      // sizes against the free-plan limits, LLM calls and the last backup (see supabase/ops.sql); a failure here must not hide the rest of the dashboard
      db("rpc/ops_stats", { method: "POST", body: "{}" }).catch(() => null),
    ]);
    const perDayMap: Record<string, number> = {};
    for (const j of jobs) { const d = String(j.created_at).slice(0, 10); perDayMap[d] = (perDayMap[d] ?? 0) + 1; }
    const perDay = Object.entries(perDayMap).sort().slice(-14).map(([date, n]) => ({ date, n }));
    const counts: Record<string, number> = {
      jobs_total: jobsTotal,
      jobs_24h: jobs24h,
      jobs_7d: jobs7d,
      jobs_failed: jobsFailed,
      visitors: new Set(jobs.map((j: { visitor: string }) => j.visitor)).size,
      orders_total: ordersTotal,
      orders_waiting: ordersWaiting,
      feedback_total: feedbackTotal,
    };
    // ---- cost: summed from the per-render token ledger (an estimate, see explainer/usage.py)
    const costOf = (list: { cost_usd: number | null; created_at: string }[], since?: string) => list.filter((j) => !since || j.created_at >= since).reduce((a, j) => a + Number(j.cost_usd ?? 0), 0);
    const priced = jobs.filter((j: { cost_usd: number | null }) => j.cost_usd !== null);
    const costs = {
      total_usd: Math.round(costOf(jobs) * 10000) / 10000,
      usd_24h: Math.round(costOf(jobs, day) * 10000) / 10000,
      usd_7d: Math.round(costOf(jobs, week) * 10000) / 10000,
      priced_jobs: priced.length,
      avg_usd: priced.length ? Math.round((costOf(jobs) / priced.length) * 10000) / 10000 : 0,
      note: "Real USD, estimated from token counts, the RKAPI price table and the credit rate (0.196 RMB per credit); only renders since cost tracking started are priced.",
    };
    // ---- members, event log and the funnel (visitor -> made a video -> signed up -> bought)
    const perUser: Record<string, { n: number; last: string }> = {};
    for (const j of userJobs) { const x = perUser[j.user_id] ??= { n: 0, last: j.created_at }; x.n++; }
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
    const contacts = feedback.filter((f: { kind: string }) => f.kind === "contact").length;
    // visitors are shown by a short id only (a hash made by the render function), never by IP
    return json({ me, viewer, ops, costs, funnel, byType, contacts, users: users.map((u: { id: string; username: string }) => ({ ...u, username: viewer ? maskEmail(u.username) : u.username, jobs: perUser[u.id]?.n ?? 0, last_job: perUser[u.id]?.last ?? null })), events: events.map((e: { actor: string; meta?: Record<string, unknown> }) => ({ ...e, actor: e.actor.slice(0, 8), meta: viewer && e.meta && typeof e.meta.username === "string" ? { ...e.meta, username: maskEmail(e.meta.username) } : e.meta })), credits, counts: { ...counts, users_total: users.length, member_jobs: memberJobs }, perDay, jobs: jobs.map((j: { visitor: string }) => ({ ...j, visitor: String(j.visitor ?? "").slice(0, 8) })), orders: viewer ? orders.map((o: Record<string, unknown>) => ({ ...o, contact: maskEmail(o.contact), email: maskEmail(o.email) })) : orders, feedback: viewer ? feedback.map((f: { email: string }) => ({ ...f, email: maskEmail(f.email) })) : feedback });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
