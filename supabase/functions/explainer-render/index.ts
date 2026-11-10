// Paper Explainer server renders. POST {arxiv, visitor} queues a full video (EN + ZH, 16:9 + 9:16) and starts the
// GitHub Actions renderer; GET ?id=<job> returns the job (status, stage, video URLs); GET ?recent=1 lists finished videos.
// A paper that already has a finished video is returned at once instead of being rendered again.
// Limits: per visitor per day and a global daily cap, because each render spends model tokens and runner minutes.
// PDF upload: POST {op:"upload_url", name, size} returns a one-time address into the private explainer-uploads bucket; the browser PUTs the file
// there, then POST {upload: path, name} queues a video from it. The renderer reads the file and deletes it when the video is made.
import { userOf, quotaFor, actorOf, logEvent, isAdmin, activePlan, maxSeconds, units, VIDEO_LANGS, TIERS, count } from "../_shared/explainer.ts";
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const GH_TOKEN = Deno.env.get("GH_DISPATCH_TOKEN");
const GH_REPO = Deno.env.get("GH_REPO") ?? "bryan273/paper-repro-agentv2";
// quota is counted in units: a video of up to 3 minutes is 1 unit, longer ones cost more because they take more renderer time
const PER_VISITOR_DAY = Number(Deno.env.get("EXPLAINER_PER_VISITOR_DAY") ?? "4");
const DAILY = Number(Deno.env.get("EXPLAINER_DAILY") ?? "40");
const UP_BUCKET = "explainer-uploads", MAX_UPLOAD = 20 * 1024 * 1024;
const PER_ACTOR_UPLOADS = Number(Deno.env.get("EXPLAINER_UPLOADS_PER_ACTOR") ?? "12"), DAILY_UPLOADS = Number(Deno.env.get("EXPLAINER_UPLOADS_DAILY") ?? "100");
const cleanName = (s: unknown) => String(s ?? "").replace(/\.(pdf|txt|md)$/i, "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
const STYLES = ["animated", "cinema", "classic", "light", "sunset", "mono"], TONES = ["teacher", "casual", "academic", "eli5", "story"];
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-session, x-visitor-id", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const PUBLIC = "id,arxiv,source_url,model,voice,style,tone,seconds,custom,langs,status,stage,title,videos,sections,checks,error,created_at,updated_at,expired_at";

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
      const paper = u.searchParams.get("paper");
      if (paper) {   // every video that already exists (or is being made) for this paper, so the page can offer "watch" before "make a new one"
        const url = arxivId(paper) ? null : sourceUrl(paper);
        const a = arxivId(paper) ?? (url ? "u" + (await sha(url)) : null);
        if (!a) return json([]);
        return json(await db(`explainer_jobs?arxiv=eq.${a}&status=in.(done,queued,running)&expired_at=is.null&select=${PUBLIC}&order=created_at.desc&limit=12`));
      }
      if (u.searchParams.get("recent")) return json(await db(`explainer_jobs?status=eq.done&or=(style.like.animated*,style.eq.cinema)&select=${PUBLIC}&order=updated_at.desc&limit=24`));
      const id = u.searchParams.get("id") ?? "";
      if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "id required" }, 400);
      const rows = await db(`explainer_jobs?id=eq.${id}&select=${PUBLIC},timeline`);
      if (!rows.length) return json({ error: "not found" }, 404);
      const j = rows[0];
      // a job nobody has touched for 20 minutes is dead (renderer offline or crashed): say so instead of spinning forever
      if ((j.status === "queued" || j.status === "running") && Date.now() - Date.parse(j.updated_at) > (j.seconds > 150 ? 60 : 20) * 60_000) {
        const error = "The renderer did not pick this up in time. Please try again in a few minutes.";
        await db(`explainer_jobs?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ status: "failed", stage: null, error }) });
        return json({ ...j, status: "failed", stage: null, error });
      }
      return json(j);
    }
    const body = await req.json();
    const { arxiv, visitor } = body;
    if (body.op === "edit") {   // re-make one part of a finished video as a new version; it does not use a video credit
      const user = await userOf(req);
      if (!user) return json({ error: "Sign in to edit a video.", code: "edit_signin" }, 401);
      const jobId = String(body.job ?? "");
      if (!/^[0-9a-f-]{36}$/.test(jobId)) return json({ error: "Unknown video." }, 400);
      const [p] = await db(`explainer_jobs?id=eq.${jobId}&select=*`);
      if (!p) return json({ error: "Unknown video." }, 404);
      if (p.user_id !== user.id && !isAdmin(user)) return json({ error: "You can only edit your own videos.", code: "edit_owner" }, 403);
      if (p.status !== "done" || p.expired_at) return json({ error: "Only a finished video can be edited.", code: "edit_state" }, 409);
      const secs = Array.isArray(p.sections) ? p.sections : [];
      const part = Math.round(Number(body.part));
      if (!(part >= 0 && part < secs.length)) return json({ error: "Choose the part to change." }, 400);
      const note = String(body.note ?? "").replace(/\s+/g, " ").trim().slice(0, 500);
      if (note.length < 5) return json({ error: "Say what to change in a few words." }, 400);
      const kind = ["fix", "add", "simpler", "deeper", "other"].includes(body.kind) ? body.kind : "other";
      // edits are counted per original video, across all its versions
      const [pe] = await db(`explainer_events?type=eq.edit&meta->>job=eq.${jobId}&select=meta&limit=1`).catch(() => []);
      const root = String(pe?.meta?.root ?? jobId);
      const done = await count(`explainer_events?type=eq.edit&meta->>root=eq.${root}`);
      const plan = await activePlan(user.id);
      const cap = TIERS[plan ?? "free"].edits;
      if (done >= cap && !isAdmin(user)) return json({ error: cap ? `This video has used its ${cap} edit${cap > 1 ? "s" : ""}. Make a new video, or choose a plan with more edits.` : "Editing is part of the plans.", code: "edit_quota", used: done, cap }, 402);
      const [row] = await db(`explainer_jobs?select=${PUBLIC}`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ arxiv: p.arxiv, title: p.title, source_url: p.source_url, model: p.model, voice: p.voice, style: p.style, tone: p.tone, langs: p.langs, seconds: p.seconds, custom: p.custom, visitor: p.visitor, user_id: p.user_id, credit_used: 0, paper_text: p.paper_text, stage: "editing" }) });
      await logEvent(await actorOf(req, body.visitor), "edit", { job: row.id, parent: jobId, root, part, note, kind, n: done + 1 }, user.id);
      if (!GH_TOKEN) return json({ ...row, edit: { used: done + 1, cap } });
      const gh = await fetch(`https://api.github.com/repos/${GH_REPO}/actions/workflows/explainer-render.yml/dispatches`, {
        method: "POST", headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github+json", "User-Agent": "paper-explainer" },
        body: JSON.stringify({ ref: "main", inputs: { job_id: row.id } }),
      });
      if (!gh.ok) {
        await db(`explainer_jobs?id=eq.${row.id}`, { method: "PATCH", body: JSON.stringify({ status: "failed", error: `could not start the renderer (${gh.status})` }) });
        return json({ error: "Could not start the renderer. Please try again later." }, 502);
      }
      return json({ ...row, edit: { used: done + 1, cap } });
    }
    if (body.op === "edits") {   // how many edits a video has left
      const user = await userOf(req);
      const jobId = String(body.job ?? "");
      if (!user || !/^[0-9a-f-]{36}$/.test(jobId)) return json({ used: 0, cap: 0 });
      const [pe] = await db(`explainer_events?type=eq.edit&meta->>job=eq.${jobId}&select=meta&limit=1`).catch(() => []);
      const root = String(pe?.meta?.root ?? jobId);
      const versions = await db(`explainer_events?type=eq.edit&meta->>root=eq.${root}&select=meta,created_at&order=created_at.asc`).catch(() => []);
      const plan = await activePlan(user.id);
      return json({ used: versions.length, cap: isAdmin(user) ? 99 : TIERS[plan ?? "free"].edits, root, versions: versions.map((v: { meta: Record<string, unknown>; created_at: string }) => ({ job: v.meta.job, part: v.meta.part, note: v.meta.note, at: v.created_at })) });
    }
    if (body.op === "upload_url") {   // step 1 of a PDF upload: a one-time upload address into the private bucket
      const asText = body.kind === "text";   // pasted text or a .txt/.md file: read as plain text by the renderer
      const size = Math.round(Number(body.size) || 0);
      if (asText && !(size >= 300 && size <= 2_000_000)) return json({ error: size > 2_000_000 ? "That text is too long. Keep it under 2 MB." : "That text is too short. Paste at least 300 characters." }, 400);
      if (!asText && !(size >= 1000 && size <= MAX_UPLOAD)) return json({ error: size > MAX_UPLOAD ? "That PDF is larger than 20 MB." : "That file looks empty." }, 400);
      const actor = await actorOf(req, visitor);
      const since = new Date(Date.now() - 86400_000).toISOString();
      const mine = await db(`explainer_uploads?actor=eq.${encodeURIComponent(actor)}&created_at=gte.${since}&select=path`);
      if (mine.length >= PER_ACTOR_UPLOADS) return json({ error: "Too many uploads today. Try again tomorrow." }, 429);
      const everyone = await db(`explainer_uploads?created_at=gte.${since}&select=path`);
      if (everyone.length >= DAILY_UPLOADS) return json({ error: "Uploads are paused for today. Try again tomorrow." }, 429);
      if (asText) {   // the private bucket was made for PDFs only: let it take plain text too (idempotent)
        await fetch(`${SB_URL}/storage/v1/bucket/${UP_BUCKET}`, { method: "PUT", headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" }, body: JSON.stringify({ public: false, file_size_limit: MAX_UPLOAD, allowed_mime_types: ["application/pdf", "text/plain"] }) }).catch(() => undefined);
      }
      const path = `${await sha(actor)}/${crypto.randomUUID()}.${asText ? "txt" : "pdf"}`;
      const s = await fetch(`${SB_URL}/storage/v1/object/upload/sign/${UP_BUCKET}/${path}`, { method: "POST", headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" }, body: "{}" });
      if (!s.ok) throw new Error(`upload address ${s.status}`);
      const { url: signed } = await s.json();
      await db("explainer_uploads", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ path, actor, name: cleanName(body.name), size }) });
      return json({ path, upload_url: `${SB_URL}/storage/v1${signed}` });
    }
    const model = ["deepseek", "stepfun"].includes(body.model) ? body.model : "deepseek";
    const voice = ["female", "male"].includes(body.voice) ? body.voice : "female";
    // "animated" (the AI draws each part) with a look after the colon: auto (chosen from the topic), classic, light, paper, chalk, fresh, sunset, mono, cinema, or own (described in the note)
    const style = STYLES.includes(body.style) || /^animated:(auto|own|classic|light|paper|chalk|fresh|sunset|mono|cinema)$/.test(String(body.style)) ? String(body.style) : "animated";
    const tone = TONES.includes(body.tone) ? body.tone : "teacher";
    const langs = VIDEO_LANGS.includes(body.langs) ? body.langs : "en";   // one language per video; another language is another video
    const seconds = Math.min(1200, Math.max(60, Math.round(Number(body.seconds) || 180)));
    const custom = String(body.custom ?? "").replace(/[ -]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 460);   // the note: focus, narration style, and the look ("Look: ...")
    const up = typeof body.upload === "string" && /^[0-9a-f]{16}\/[0-9a-f-]{36}\.(pdf|txt)$/.test(body.upload) ? body.upload : "";
    const url = up ? null : arxivId(arxiv) ? null : sourceUrl(arxiv);
    const a = up ? "f" + (await sha(up)) : (arxivId(arxiv) ?? (url ? "u" + (await sha(url)) : null));
    if (!a) return json({ error: "Paste a paper link (an arXiv link or id, a link to a PDF, or a DOI) or upload a PDF." }, 400);
    let upName = "";
    if (up) {   // the file must be this visitor's own, unused, and really a PDF
      const [rec] = await db(`explainer_uploads?path=eq.${encodeURIComponent(up)}&select=actor,job_id,name`);
      if (!rec || rec.actor !== (await actorOf(req, visitor))) return json({ error: "That upload was not found. Please choose the file again." }, 404);
      if (rec.job_id && rec.job_id !== String(body.retry_of ?? "")) return json({ error: "That file was already used. Please choose it again." }, 409);   // a retry of the failed video may use its own file again
      const head = await fetch(`${SB_URL}/storage/v1/object/${UP_BUCKET}/${up}`, { headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, Range: "bytes=0-7" } });
      const magic = head.ok ? new TextDecoder().decode((await head.arrayBuffer()).slice(0, 5)) : "";
      if (!up.endsWith(".txt") && magic !== "%PDF-") {
        await fetch(`${SB_URL}/storage/v1/object/${UP_BUCKET}`, { method: "DELETE", headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json" }, body: JSON.stringify({ prefixes: [up] }) });
        return json({ error: "That file is not a readable PDF." }, 400);
      }
      upName = cleanName(body.name) || cleanName(rec.name);
    }
    if (!body.force_new) {   // the same paper with the same settings is not rendered twice; "make a new one" sends force_new
      const done = await db(`explainer_jobs?arxiv=eq.${a}&model=eq.${model}&voice=eq.${voice}&style=eq.${style}&tone=eq.${tone}&langs=eq.${langs}&seconds=eq.${seconds}&custom=eq.${encodeURIComponent(custom)}&status=in.(done,queued,running)&expired_at=is.null&select=${PUBLIC}&order=created_at.desc&limit=1`);
      if (done.length) return json({ ...done[0], cached: true });
    }
    const user = await userOf(req);
    if (seconds > 180 && !isAdmin(user)) {   // free: up to 3 minutes; Plus: 5; Pro, Premium and pack videos: 10
      const plan = user ? await activePlan(user.id) : null;
      const pack = !!user && !plan && (await db(`explainer_credit_log?user_id=eq.${user.id}&reason=like.bought%20pack*&select=id&limit=1`).catch(() => [])).length > 0;
      if (seconds > maxSeconds(plan, pack)) {
        return seconds > 600
          ? json({ error: "Videos longer than 10 minutes are part of Premium. Choose 10 minutes or less.", code: "length_premium" }, 402)
          : seconds > 300
          ? json({ error: "Videos longer than 5 minutes are part of Pro. Choose 5 minutes or less.", code: "length_pro" }, 402)
          : json({ error: "Videos longer than 3 minutes are part of Plus. Choose 3 minutes or less.", code: "length_plus" }, 402);
      }
    }
    const vid = await actorOf(req, visitor);
    const day = new Date(Date.now() - 86400_000).toISOString();
    const sum = (rows: { seconds: number }[]) => rows.reduce((n, r) => n + units(r.seconds), 0);
    // free allowance of the last 24 hours first (guest: little, member: more), then the member's credits
    const q = await quotaFor(user, vid);
    const need = units(seconds), fromCredits = Math.max(0, need - q.day_left);
    if (fromCredits > q.credits) {
      await logEvent(vid, "quota_hit", { tier: q.tier, need }, user?.id ?? null);
      const error = user
        ? `Your ${q.day_limit} free videos for this week are used${q.resets_in_min ? ` (more in about ${Math.ceil(q.resets_in_min / 60)} h)` : ""}. Choose a plan or buy videos to keep going.`
        : `You have used your ${q.day_limit} free guest videos. Sign up free for more every day, plus welcome credits.`;
      return json({ error, code: user ? "quota_member" : "quota_guest", quota: q }, 429);
    }
    const all = await db(`explainer_jobs?status=neq.failed&created_at=gte.${day}&select=seconds`);
    if (sum(all) + need > DAILY) return json({ error: "Today's video budget is used up. Try again tomorrow." }, 429);
    let title = "";
    if (up) {
      title = upName || "Uploaded paper";   // the renderer replaces this with the real title
    } else if (url) {
      title = new URL(url).hostname.replace(/^www\./, "");   // the renderer replaces this with the real title
    } else {
      const meta = await fetch(`https://export.arxiv.org/api/query?id_list=${a}`, { signal: AbortSignal.timeout(20_000) }).then((r) => r.text());
      const entry = meta.split("<entry>")[1] ?? "";
      title = (entry.match(/<title>([\s\S]*?)<\/title>/)?.[1] ?? "").replace(/\s+/g, " ").trim();
      if (!title || /Error/.test(title)) return json({ error: "That arXiv id was not found." }, 404);
    }
    const [row] = await db(`explainer_jobs?select=${PUBLIC}`, { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ arxiv: a, title, source_url: up ? "upload:" + up : url, model, voice, style, tone, langs, seconds, custom, visitor: vid, user_id: user?.id ?? null, credit_used: fromCredits, stage: "waiting for a renderer" }) });
    if (user && fromCredits > 0) {
      await db(`explainer_users?id=eq.${user.id}`, { method: "PATCH", body: JSON.stringify({ credits: user.credits - fromCredits }) });
      await db("explainer_credit_log", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ user_id: user.id, delta: -fromCredits, reason: `video ${a}` }) });
    }
    if (up) await db(`explainer_uploads?path=eq.${encodeURIComponent(up)}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ job_id: row.id }) });
    await logEvent(vid, "job_created", { arxiv: a, seconds, tier: q.tier, credits: fromCredits }, user?.id ?? null);
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
