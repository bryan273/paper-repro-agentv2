// Data for the Repro Suite apps, so none of them depends on one host's own backend.
//   POST {op:"create", collection, data, key?}   collections: checks, reading_sessions, repro_requests, site_events
//   POST {op:"list" | "get", collection, ...}     public for checks and reading_sessions only
//   POST {op:"board_create" | "board_get" | "board_list" | "board_update" | "board_verify", ...}   IndexBoard boards (public slug + private edit key)
//   POST {op:"model_data", models, top}           real model prices and context lengths from OpenRouter (Artificial Analysis too if AA_API_KEY is set)
//   POST {op:"admin_list" | "admin_update" | "admin_stats" | "board_import", ...}   need the x-admin-token header (secret SUITE_ADMIN_TOKEN)
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN = Deno.env.get("SUITE_ADMIN_TOKEN") ?? "";
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
class Fail extends Error { constructor(public status: number, msg: string) { super(msg); } }
const rest = (path: string, init: RequestInit = {}) =>
  fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", ...(init.headers ?? {}) } });
const db = async (path: string, init: RequestInit = {}) => {
  const r = await rest(path, init);
  if (!r.ok) throw new Error(`db ${r.status}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : null;
};
const str = (v: unknown, n: number) => String(v ?? "").slice(0, n);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const hex = async (s: string, alg = "SHA-256") => [...new Uint8Array(await crypto.subtle.digest(alg, new TextEncoder().encode(s)))].map((x) => x.toString(16).padStart(2, "0")).join("");
const rand = (n: number, alphabet: string) => { const b = crypto.getRandomValues(new Uint8Array(n)); return [...b].map((x) => alphabet[x % alphabet.length]).join(""); };

const COLL: Record<string, { max: number; perHour: number; publicRead: boolean }> = {
  checks: { max: 300_000, perHour: 40, publicRead: true },
  reading_sessions: { max: 1_500_000, perHour: 40, publicRead: true },
  repro_requests: { max: 20_000, perHour: 6, publicRead: false },
  site_events: { max: 2_000, perHour: 120, publicRead: false },
};
const HIDDEN = new Set(["visitor", "ip", "email"]);   // never returned by the public read ops

async function limited(table: string, extra: string, ip: string, perHour: number) {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const rows = await db(`${table}?ip=eq.${ip}&created_at=gte.${since}&${extra}select=${table === "suite_boards" ? "slug" : "id"}&limit=${perHour + 1}`);
  if (rows.length >= perHour) throw new Fail(429, "Too many requests from this connection, please try again later.");
}
const publicItem = (r: { id: number; created_at: string; data: Record<string, unknown> }) => {
  const out: Record<string, unknown> = { id: r.id, created_at: r.created_at };
  for (const [k, v] of Object.entries(r.data ?? {})) if (!HIDDEN.has(k)) out[k] = v;
  return out;
};
const needAdmin = (req: Request) => { if (!ADMIN || req.headers.get("x-admin-token") !== ADMIN) throw new Fail(403, "forbidden"); };

// ---------- boards ----------
const MAX_PAYLOAD = 600_000, MAX_ITEMS = 300, MAX_METRICS = 40;
function checkPayload(payload: unknown) {
  const p = payload as { metrics?: unknown[]; items?: unknown[] };
  if (!p || typeof p !== "object" || !Array.isArray(p.metrics) || !p.metrics.length) throw new Fail(400, "A board needs at least one metric.");
  if (!Array.isArray(p.items) || !p.items.length) throw new Fail(400, "A board needs at least one item.");
  if (p.metrics.length > MAX_METRICS || p.items.length > MAX_ITEMS) throw new Fail(400, "Too many metrics or items for one board.");
  if (JSON.stringify(payload).length > MAX_PAYLOAD) throw new Fail(413, "Board data is too large.");
}
const boardOut = (b: Record<string, unknown>) => ({ slug: b.slug, title: b.title, description: b.description ?? "", payload: b.payload, created_at: b.created_at, updated_at: b.updated_at });
function boardSummary(b: Record<string, any>) {   // eslint-disable-line @typescript-eslint/no-explicit-any
  const payload = b.payload ?? {};
  const metrics = (payload.metrics ?? []).filter((m: unknown) => m && typeof m === "object");
  const items = (payload.items ?? []).filter((i: unknown) => i && typeof i === "object");
  const primary = metrics.find((m: any) => m.id === payload.primary_metric_id) ?? metrics.find((m: any) => m.direction !== "lower") ?? metrics[0]; // eslint-disable-line @typescript-eslint/no-explicit-any
  let top: { name: string; value: number }[] = [];
  if (primary) {
    const rows = items.map((it: any) => ({ name: String(it.name ?? ""), value: it.scores?.[primary.id]?.value })).filter((r: any) => typeof r.value === "number"); // eslint-disable-line @typescript-eslint/no-explicit-any
    rows.sort((a: any, b: any) => (primary.direction === "lower" ? a.value - b.value : b.value - a.value)); // eslint-disable-line @typescript-eslint/no-explicit-any
    top = rows.slice(0, 3);
  }
  return {
    data_source: payload.live?.source ?? null, slug: b.slug, title: b.title, description: String(b.description ?? "").slice(0, 280),
    item_count: items.length, metric_count: metrics.length,
    primary_metric: primary ? { name: String(primary.name ?? ""), unit: String(primary.unit ?? "") } : null, top, created_at: b.created_at,
  };
}
async function findBoard(slug: string) {
  if (!/^[a-z0-9]{6,32}$/.test(slug)) throw new Fail(404, "Board not found.");
  const rows = await db(`suite_boards?slug=eq.${slug}&select=*`);
  if (!rows.length) throw new Fail(404, "Board not found.");
  return rows[0];
}
const keyMatches = async (b: { edit_hash: string }, key: string) => (await hex(str(key, 200).trim())) === b.edit_hash;

// ---------- model data (OpenRouter public list; Artificial Analysis when its key is set) ----------
const FAMILIES: Record<string, [string[], string | null]> = {
  gpt: [["openai"], "gpt"], chatgpt: [["openai"], "gpt"], openai: [["openai"], null], claude: [["anthropic"], null], anthropic: [["anthropic"], null],
  deepseek: [["deepseek"], null], gemini: [["google"], "gemini"], google: [["google"], "gemini"], llama: [["meta"], "llama"], meta: [["meta"], "llama"],
  qwen: [[], "qwen"], alibaba: [[], "qwen"], mistral: [["mistral"], null], grok: [["xai"], null], xai: [["xai"], null], kimi: [[], "kimi"], moonshot: [[], "kimi"], glm: [[], "glm"], zhipu: [[], "glm"],
};
const VARIANT = ["mini", "nano", "lite", "oss", "audio", "image", "search", "realtime", "embed", "distill", "tts", "transcribe", "guard", "vision", "free", "batch"];
const SMALL = ["haiku", "flash", "small", "tiny", "instant", "air", "turbo", "8b", "7b", "3b", "1b"];
const MAJOR = ["openai", "anthropic", "google", "deepseek", "meta", "qwen", "mistral", "xai", "moonshot"];
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const norm = (t: unknown) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null);
const rnd = (v: number | null, d = 4) => (v === null ? null : Math.round(v * 10 ** d) / 10 ** d);
const emptyRow = (): Row => ({ intelligence: null, coding: null, math: null, price_blended: null, price_input: null, price_output: null, speed: null, ttft: null, context_length: null });
function normalizeOr(data: Row): Row[] {
  const rows: Row[] = [];
  for (const m of data?.data ?? []) {
    const id = String(m?.id ?? "");
    if (!id || id.includes(":") || id.startsWith("openrouter/") || id.startsWith("~")) continue;
    let pin = num(m.pricing?.prompt), pout = num(m.pricing?.completion);
    if (pin === null || pout === null || pin < 0 || pout < 0) continue;
    pin *= 1e6; pout *= 1e6;
    const rawName = String(m.name ?? id);
    const [label, short] = rawName.includes(": ") ? [rawName.split(": ")[0], rawName.split(": ").slice(1).join(": ")] : ["", rawName];
    const created = num(m.created);
    rows.push({ ...emptyRow(), key: id, name: short || rawName, creator: label || id.split("/")[0], released: created ? new Date(created * 1000).toISOString().slice(0, 10) : "", price_blended: rnd((3 * pin + pout) / 4), price_input: rnd(pin), price_output: rnd(pout), context_length: num(m.context_length) });
  }
  return rows;
}
function normalizeAa(data: Row): Row[] {
  const rows: Row[] = [];
  for (const m of data?.data ?? []) {
    const name = String(m?.name ?? m?.slug ?? "").trim();
    if (!name) continue;
    const ev = m.evaluations ?? {}, pr = m.pricing ?? {};
    rows.push({ ...emptyRow(), key: String(m.slug ?? m.id ?? name), name, creator: String(m.model_creator?.name ?? ""), released: String(m.release_date ?? ""),
      intelligence: rnd(num(ev.artificial_analysis_intelligence_index), 2), coding: rnd(num(ev.artificial_analysis_coding_index), 2), math: rnd(num(ev.artificial_analysis_math_index), 2),
      price_blended: rnd(num(pr.price_1m_blended_3_to_1)), price_input: rnd(num(pr.price_1m_input_tokens)), price_output: rnd(num(pr.price_1m_output_tokens)),
      speed: rnd(num(m.median_output_tokens_per_second), 2), ttft: rnd(num(m.median_time_to_first_token_seconds), 3) });
  }
  return rows;
}
const cache: Record<string, { rows: Row[]; at: number }> = {};
async function dataset() {
  const aaKey = (Deno.env.get("AA_API_KEY") ?? "").trim();
  for (const source of aaKey ? ["artificial_analysis", "openrouter"] : ["openrouter"]) {
    const hit = cache[source];
    if (hit && Date.now() - hit.at < 6 * 3600_000) return { source, rows: hit.rows, fetched_at: new Date(hit.at).toISOString(), stale: false, from_cache: true };
    try {
      const r = source === "artificial_analysis"
        ? await fetch("https://artificialanalysis.ai/api/v2/data/llms/models", { headers: { "x-api-key": aaKey }, signal: AbortSignal.timeout(25_000) })
        : await fetch("https://openrouter.ai/api/v1/models", { signal: AbortSignal.timeout(25_000) });
      if (!r.ok) throw new Error(String(r.status));
      const body = await r.json();
      const rows = source === "artificial_analysis" ? normalizeAa(body) : normalizeOr(body);
      if (!rows.length) throw new Error("empty");
      cache[source] = { rows, at: Date.now() };
      return { source, rows, fetched_at: new Date().toISOString(), stale: false, from_cache: false };
    } catch {
      if (hit) return { source, rows: hit.rows, fetched_at: new Date(hit.at).toISOString(), stale: true, from_cache: true };
    }
  }
  throw new Fail(503, "Model data sources are unavailable right now.");
}
const isVariant = (r: Row) => { const n = norm(r.name) + norm(r.key); return VARIANT.some((w) => n.includes(w)); };
const pick = (c: Row[]) => {
  if (!c.length) return null;
  const scored = c.filter((x) => x.intelligence !== null);
  const pool = scored.length ? scored : c;
  return pool.reduce((best, x) => {
    const a = scored.length ? [x.intelligence, x.released ?? ""] : [x.released ?? "", x.name ?? ""];
    const b = scored.length ? [best.intelligence, best.released ?? ""] : [best.released ?? "", best.name ?? ""];
    return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]) ? x : best;
  });
};
function matchOne(query: string, rows: Row[]): Row | null {
  const nq = norm(query);
  if (!nq) return null;
  const fam = FAMILIES[nq];
  if (fam) {
    const [creators, kw] = fam;
    const f = rows.filter((r) => (!creators.length || creators.some((c) => norm(r.creator).includes(c) || norm(r.key).includes(c))) && (kw === null || norm(r.name).includes(kw)));
    const main = f.filter((r) => !isVariant(r)); const m = main.length ? main : f;
    const flag = m.filter((r) => !SMALL.some((w) => norm(r.name).includes(w)));
    return pick(flag.length ? flag : m);
  }
  const exact = rows.filter((r) => norm(r.name) === nq || norm(r.key) === nq || (String(r.key).includes("/") && norm(String(r.key).split("/").slice(1).join("/")) === nq));
  if (exact.length) return pick(exact);
  const contains = rows.filter((r) => norm(r.name).includes(nq) || norm(r.key).includes(nq));
  if (contains.length) return pick(contains);
  const tokens = query.split(/[^A-Za-z0-9.]+/).map(norm).filter(Boolean);
  if (tokens.length) return pick(rows.filter((r) => tokens.every((t) => (norm(r.name) + norm(r.key) + norm(r.creator)).includes(t))));
  return null;
}
async function modelData(namesIn: unknown, topIn: unknown) {
  const names: string[] = [];
  for (const n of Array.isArray(namesIn) ? namesIn : []) { const s = str(n, 80).trim(); if (s && !names.some((x) => x.toLowerCase() === s.toLowerCase())) names.push(s); }
  names.splice(12);
  const top = num(topIn);
  if (!names.length && !top) throw new Fail(400, "Give model names or top N.");
  const ds = await dataset();
  const chosen: Row[] = [], matches: Row[] = [], seen = new Set<string>();
  let selection = "names";
  if (names.length) {
    for (const q of names) {
      const hit = matchOne(q, ds.rows);
      matches.push({ query: q, key: hit?.key ?? null, name: hit?.name ?? null, creator: hit?.creator ?? null });
      if (hit && !seen.has(hit.key)) { seen.add(hit.key); chosen.push(hit); }
    }
  } else {
    const n = Math.max(1, Math.min(Number(top) || 5, 20));
    let pool: Row[];
    if (ds.source === "artificial_analysis") { selection = "top_intelligence"; pool = ds.rows.filter((r) => r.intelligence !== null).sort((a, b) => b.intelligence - a.intelligence); }
    else {
      selection = "top_newest";
      pool = ds.rows.filter((r) => !isVariant(r) && !SMALL.some((w) => norm(r.name).includes(w)) && MAJOR.some((c) => (norm(r.creator) + norm(r.key)).includes(c))).sort((a, b) => String(b.released ?? "").localeCompare(String(a.released ?? "")));
    }
    for (const r of pool) { if (seen.has(r.key)) continue; seen.add(r.key); chosen.push(r); if (chosen.length >= n) break; }
  }
  const info = ds.source === "artificial_analysis"
    ? { label: "Artificial Analysis", url: "https://artificialanalysis.ai/", metrics: ["intelligence", "coding", "math", "price", "speed", "ttft"] }
    : { label: "OpenRouter", url: "https://openrouter.ai/", metrics: ["price", "context"] };
  return { source: ds.source, source_label: info.label, source_url: info.url, fetched_at: ds.fetched_at, stale: ds.stale, from_cache: ds.from_cache, metrics_available: info.metrics, selection, matches, rows: chosen };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method !== "POST") throw new Fail(405, "POST only");
    const body = await req.json();
    const op = String(body.op ?? "");
    const ipRaw = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
    const ip = (await hex(`${ipRaw}|suite`)).slice(0, 16);

    if (op === "create") {
      const c = COLL[String(body.collection)];
      if (!c) throw new Fail(400, "unknown collection");
      const data = body.data;
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new Fail(400, "data required");
      if (JSON.stringify(data).length > c.max) throw new Fail(413, "Too much data in one save.");
      const doc: Record<string, unknown> = { ...data };
      let key: string | null = null;
      if (body.collection === "repro_requests") {
        if (!EMAIL.test(str(doc.email, 200)) || !str(doc.paper_link, 600) || !str(doc.claim, 4000)) throw new Fail(400, "email, paper link and claim are required");
        doc.email = str(doc.email, 200); doc.paper_link = str(doc.paper_link, 600); doc.claim = str(doc.claim, 4000); doc.status = "new";
      }
      if (body.collection === "reading_sessions") {
        key = str(doc.share_id, 40);
        if (!/^[a-zA-Z0-9]{6,40}$/.test(key)) throw new Fail(400, "bad share id");
      }
      await limited("suite_docs", `collection=eq.${body.collection}&`, ip, c.perHour);
      const [r] = await db("suite_docs?select=id,created_at", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ collection: body.collection, key, data: doc, ip }) });
      return json({ id: r.id, created_at: r.created_at });
    }

    if (op === "list") {
      const coll = String(body.collection);
      if (!COLL[coll]?.publicRead) throw new Fail(403, "forbidden");
      const limit = Math.max(1, Math.min(Number(body.limit) || 12, 50));
      const fields: string[] = Array.isArray(body.fields) ? body.fields.map(String).filter((f: string) => /^[a-z_]{1,40}$/.test(f)).slice(0, 15) : [];
      const sel = fields.length ? `id,created_at,${fields.map((f) => `${f}:data->${f}`).join(",")}` : "id,created_at,data";
      const rows = await db(`suite_docs?collection=eq.${coll}&select=${sel}&order=created_at.desc&limit=${limit}`);
      return json({ items: fields.length ? rows : rows.map(publicItem) });
    }

    if (op === "get") {
      const coll = String(body.collection);
      if (!COLL[coll]?.publicRead) throw new Fail(403, "forbidden");
      let filter = "";
      if (body.id !== undefined && /^\d{1,12}$/.test(String(body.id))) filter = `id=eq.${body.id}`;
      else if (body.key && /^[a-zA-Z0-9]{6,40}$/.test(String(body.key))) filter = `key=eq.${body.key}`;
      else throw new Fail(400, "id or key required");
      const rows = await db(`suite_docs?collection=eq.${coll}&${filter}&select=id,created_at,data&limit=1`);
      if (!rows.length) throw new Fail(404, "not found");
      return json({ item: publicItem(rows[0]) });
    }

    if (op === "board_create") {
      const title = str(body.title, 200).trim();
      if (!title) throw new Fail(400, "A board needs a title.");
      checkPayload(body.payload);
      await limited("suite_boards", "", ip, 12);
      let slug = "";
      for (let i = 0; i < 6 && !slug; i++) { const cand = rand(10, "abcdefghijklmnopqrstuvwxyz0123456789"); if (!(await db(`suite_boards?slug=eq.${cand}&select=slug`)).length) slug = cand; }
      if (!slug) throw new Fail(500, "Could not allocate a share link, please retry.");
      const edit_key = rand(24, "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_");
      const [b] = await db("suite_boards?select=*", { method: "POST", headers: { Prefer: "return=representation" }, body: JSON.stringify({ slug, title, description: str(body.description, 8000).trim(), payload: body.payload, edit_hash: await hex(edit_key), ip }) });
      return json({ slug, edit_key, board: boardOut(b) });
    }
    if (op === "board_get") return json(boardOut(await findBoard(String(body.slug ?? ""))));
    if (op === "board_list") {
      const limit = Math.max(1, Math.min(Number(body.limit) || 9, 24));
      const rows = await db(`suite_boards?select=slug,title,description,payload,created_at&order=created_at.desc&limit=${limit}`);
      return json({ items: rows.map(boardSummary) });
    }
    if (op === "board_update") {
      const b = await findBoard(String(body.slug ?? ""));
      if (!(await keyMatches(b, String(body.edit_key ?? "")))) throw new Fail(403, "The edit key does not match this board.");
      const title = str(body.title, 200).trim();
      if (!title) throw new Fail(400, "A board needs a title.");
      checkPayload(body.payload);
      const [u] = await db(`suite_boards?slug=eq.${b.slug}&select=*`, { method: "PATCH", headers: { Prefer: "return=representation" }, body: JSON.stringify({ title, description: str(body.description, 8000).trim(), payload: body.payload, updated_at: new Date().toISOString() }) });
      return json(boardOut(u));
    }
    if (op === "board_verify") {
      const b = await findBoard(String(body.slug ?? ""));
      return json({ valid: await keyMatches(b, String(body.edit_key ?? "")) });
    }

    if (op === "model_data") return json(await modelData(body.models, body.top));

    if (op.startsWith("admin_") || op === "board_import") {
      needAdmin(req);
      if (op === "board_import") {
        checkPayload(body.payload);
        await db("suite_boards?on_conflict=slug", { method: "POST", headers: { Prefer: "resolution=merge-duplicates" }, body: JSON.stringify({ slug: str(body.slug, 32), title: str(body.title, 200), description: str(body.description, 8000), payload: body.payload, edit_hash: await hex(rand(32, "abcdef0123456789")), created_at: body.created_at ?? new Date().toISOString() }) });
        return json({ ok: true });
      }
      if (op === "admin_list") {
        const skip = Math.max(0, Number(body.skip) || 0), limit = Math.max(1, Math.min(Number(body.limit) || 25, 100));
        const status = /^[a-z_]{1,20}$/.test(String(body.status ?? "")) ? `&data->>status=eq.${body.status}` : "";
        const r = await rest(`suite_docs?collection=eq.repro_requests${status}&select=id,created_at,data&order=created_at.desc&offset=${skip}&limit=${limit}`, { headers: { Prefer: "count=exact" } });
        if (!r.ok) throw new Error(`db ${r.status}`);
        const total = Number((r.headers.get("content-range") ?? "").split("/")[1]) || 0;
        const rows = await r.json();
        return json({ items: rows.map((x: { id: number; created_at: string; data: Row }) => ({ id: x.id, created_at: x.created_at, ...x.data })), total });
      }
      if (op === "admin_update") {
        const id = String(body.id ?? ""), status = String(body.status ?? "");
        if (!/^\d{1,12}$/.test(id) || !["new", "in_review", "done", "declined"].includes(status)) throw new Fail(400, "bad request");
        const rows = await db(`suite_docs?id=eq.${id}&collection=eq.repro_requests&select=data`);
        if (!rows.length) throw new Fail(404, "not found");
        await db(`suite_docs?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ data: { ...rows[0].data, status } }) });
        return json({ ok: true });
      }
      if (op === "admin_stats") {
        const count = async (q: string) => { const r = await rest(`suite_docs?${q}&select=id`, { headers: { Prefer: "count=exact", Range: "0-0" } }); return Number((r.headers.get("content-range") ?? "").split("/")[1]) || 0; };
        const visits = await count("collection=eq.site_events&data->>event_type=eq.visit");
        const form_starts = await count("collection=eq.site_events&data->>event_type=eq.form_start");
        const submissions = await count("collection=eq.repro_requests");
        return json({ visits, form_starts, submissions, conversion_rate: visits ? Math.round(1000 * submissions / visits) / 10 : 0, form_start_rate: visits ? Math.round(1000 * form_starts / visits) / 10 : 0 });
      }
    }
    throw new Fail(400, "unknown op");
  } catch (e) {
    if (e instanceof Fail) return json({ error: e.message, detail: e.message }, e.status);
    return json({ error: (e as Error).message }, 500);
  }
});
