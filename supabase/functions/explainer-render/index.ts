// Paper Explainer server renders. POST {arxiv, visitor} queues a full video (EN + ZH, 16:9 + 9:16) and starts the
// GitHub Actions renderer; GET ?id=<job> returns the job (status, stage, video URLs); GET ?recent=1 lists finished videos.
// A paper that already has a finished video is returned at once instead of being rendered again.
// Limits: per visitor per day and a global daily cap, because each render spends model tokens and runner minutes.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GH_TOKEN = Deno.env.get("GH_DISPATCH_TOKEN");
const GH_REPO = Deno.env.get("GH_REPO") ?? "bryan273/paper-repro-agentv2";
const PER_VISITOR_DAY = Number(Deno.env.get("EXPLAINER_PER_VISITOR_DAY") ?? "3");
const DAILY = Number(Deno.env.get("EXPLAINER_DAILY") ?? "40");
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const PUBLIC = "id,arxiv,source_url,model,voice,style,status,stage,title,videos,checks,error,created_at,updated_at";

async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`db ${r.status} ${await r.text()}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : null;
}
async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
}
function arxivId(s: string) {
  const m = String(s ?? "").match(/(\d{4}\.\d{4,5})(v\d+)?/);
  return m ? m[1] : null;
}
// Any other paper: a direct PDF link, a paper page or a DOI. The renderer fetches it; here we only normalise and refuse obvious abuse.
function sourceUrl(s: string): string | null {
  let t = String(s ?? "").trim();
  if (/^10\.\d{4,9}\/\S+$/.test(t)) t = "https://doi.org/" + t;
  if (!/^https?:\/\//i.test(t)) return null;
  try {
    const u = new URL(t);
    const h = u.hostname.toLowerCase();
    if (!h.includes(".") || h === "localhost" || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.endsWith(".local") || h.endsWith(".internal")) return null;
    u.hash = "";
    return u.toString().slice(0, 500);
  } catch { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    const u = new URL(req.url);
    if (req.method === "GET") {
      if (u.searchParams.get("recent")) return json(await db(`explainer_jobs?status=eq.done&select=${PUBLIC}&order=updated_at.desc&limit=24`));
      const id = u.searchParams.get("id") ?? "";
      if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "id required" }, 400);
      const rows = await db(`explainer_jobs?id=eq.${id}&select=${PUBLIC}`);
      if (!rows.length) return json({ error: "not found" }, 404);
      const j = rows[0];
      // a job nobody has touched for 20 minutes is dead (renderer offline or crashed): say so instead of spinning forever
      if ((j.status === "queued" || j.status === "running") && Date.now() - Date.parse(j.updated_at) > 20 * 60_000) {
        const error = "The renderer did not pick this up in time. Please try again in a few minutes.";
        await db(`explainer_jobs?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "failed", stage: null, error }) });
        return json({ ...j, status: "failed", stage: null, error });
      }
      return json(j);
    }
    const body = await req.json();
    const { arxiv, visitor } = body;
    const model = ["deepseek", "stepfun"].includes(body.model) ? body.model : "deepseek";
    const voice = ["female", "male"].includes(body.voice) ? body.voice : "female";
    const style = ["classic"].includes(body.style) ? body.style : "classic";
    const url = arxivId(arxiv) ? null : sourceUrl(arxiv);
    const a = arxivId(arxiv) ?? (url ? "u" + (await sha(url)) : null);
    if (!a) return json({ error: "Paste a paper link: an arXiv link or id, a link to a PDF, or a DOI." }, 400);
    const done = await db(`explainer_jobs?arxiv=eq.${a}&model=eq.${model}&voice=eq.${voice}&style=eq.${style}&status=in.(done,queued,running)&select=${PUBLIC}&order=created_at.desc&limit=1`);
    if (done.length) return json({ ...done[0], cached: true });
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
    const vid = await sha(`${ip}|${String(visitor ?? "").slice(0, 64)}|explainer`);
    const day = new Date(Date.now() - 86400_000).toISOString();
    const mine = await db(`explainer_jobs?visitor=eq.${vid}&status=neq.failed&created_at=gte.${day}&select=id`);
    if (mine.length >= PER_VISITOR_DAY) return json({ error: `You can make ${PER_VISITOR_DAY} videos a day. Try again tomorrow.` }, 429);
    const all = await db(`explainer_jobs?status=neq.failed&created_at=gte.${day}&select=id`);
    if (all.length >= DAILY) return json({ error: "Today's video budget is used up. Try again tomorrow." }, 429);
    let title = "";
    if (url) {
      title = new URL(url).hostname.replace(/^www\./, "");   // the renderer replaces this with the real title
    } else {
      const meta = await fetch(`https://export.arxiv.org/api/query?id_list=${a}`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.text());
      const entry = meta.split("<entry>")[1] ?? "";
      title = (entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").replace(/\s+/g, " ").trim();
      if (!title || /Error/.test(title)) return json({ error: "That arXiv id was not found." }, 404);
    }
    const [row] = await db(`explainer_jobs?select=${PUBLIC}`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ arxiv: a, title, source_url: url, model, voice, style, visitor: vid, stage: "waiting for a renderer" }) });
    if (!GH_TOKEN) return json({ ...row, note: "queued; the renderer is started by hand until GH_DISPATCH_TOKEN is set" });
    const gh = await fetch(`https://api.github.com/repos/${GH_REPO}/actions/workflows/explainer-render.yml/dispatches`, {
      method: "POST", headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "paper-explainer" },
      body: JSON.stringify({ ref: "main", inputs: { job_id: row.id } }),
    });
    if (!gh.ok) {
      await db(`explainer_jobs?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify({ status: "failed", error: `could not start the renderer (${gh.status})` }) });
      return json({ error: "Could not start the renderer. Please try again later." }, 502);
    }
    return json(row);
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
