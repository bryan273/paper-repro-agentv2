// Feedback and Studio orders for Paper Explainer, so the site does not depend on any one host's own database.
//   POST {type:"feedback", id?, data:{rating,use_case,comment,email,arxiv,kind}}  -> {id}
//   POST {type:"order", data:{email,arxiv,language,notes}}                          -> {id}
//   POST {type:"order_paid", id, method:"wechat"|"alipay"}                          -> {ok}   (customer taps "I have paid")
//   GET  ?count=1                                                                   -> {count}
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const db = async (path: string, init: RequestInit = {}) => {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`db ${r.status}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : null;
};
const str = (v: unknown, n: number) => String(v ?? "").slice(0, n);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method === "GET") {
      const r = await fetch(`${SB_URL}/rest/v1/explainer_feedback?select=id&limit=1`, { headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, Prefer: "count=exact" } });
      const total = Number((r.headers.get("content-range") ?? "*/0").split("/")[1]);
      return json({ count: Number.isFinite(total) ? total : 0 });
    }
    const body = await req.json();
    const d = body.data ?? {};
    if (body.type === "feedback") {
      const row = { rating: Math.max(0, Math.min(5, Number(d.rating) || 0)), use_case: str(d.use_case, 80), comment: str(d.comment, 2000), email: str(d.email, 200), arxiv: str(d.arxiv, 120), kind: str(d.kind, 20) || "general" };
      if (row.email && !EMAIL.test(row.email)) return json({ error: "bad email" }, 400);
      if (body.id) {
        if (!/^[0-9a-f-]{36}$/.test(String(body.id))) return json({ error: "bad id" }, 400);
        await db(`explainer_feedback?id=eq.${body.id}`, { method: "PATCH", body: JSON.stringify({ ...row, updated_at: new Date().toISOString() }) });
        return json({ id: body.id });
      }
      const [r] = await db("explainer_feedback?select=id", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
      return json({ id: r.id });
    }
    if (body.type === "order") {
      const row = { email: str(d.email, 200), arxiv: str(d.arxiv, 500), language: ["en", "zh", "both"].includes(d.language) ? d.language : "en", notes: str(d.notes, 2000), status: "new" };
      if (!EMAIL.test(row.email) || !row.arxiv) return json({ error: "email and paper link are required" }, 400);
      const [r] = await db("explainer_orders?select=id", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify(row) });
      return json({ id: r.id });
    }
    if (body.type === "order_paid") {
      // the customer says they paid; the owner checks the payment and confirms in the admin dashboard
      if (!/^[0-9a-f-]{36}$/.test(String(body.id))) return json({ error: "bad id" }, 400);
      const method = ["wechat", "alipay", "techcombank", "bidv", "qris"].includes(String(body.method)) ? String(body.method) : "";
      await db(`explainer_orders?id=eq.${body.id}&status=eq.new`, { method: "PATCH", body: JSON.stringify({ status: "paid_claimed", pay_method: method, paid_at: new Date().toISOString() }) });
      return json({ ok: true });
    }
    return json({ error: "unknown type" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
