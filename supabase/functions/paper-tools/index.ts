// Read-only helpers for the Reading Companion app: search arXiv, get an abstract, read a slice of a paper's text.
// Only arxiv.org hosts are fetched. No keys, no writes. A small in-memory cache keeps arXiv happy.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const cache = new Map<string, { t: number; v: unknown }>();
const UA = { "User-Agent": "paper-tools/0.1 (research reading companion)" };
const ID = /^(\d{4}\.\d{4,5}|[a-z\-]+(\.[A-Z]{2})?\/\d{7})$/;

function clean(html: string) {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<nav[\s\S]*?<\/nav>|<header[\s\S]*?<\/header>|<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<annotation[^>]*>[\s\S]*?<\/annotation>/gi, " ").replace(/<\/(p|div|h[1-6]|li|tr|table|figure|section)>/gi, "\n").replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();
}
async function get(url: string, ms = 20_000) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.t < 600_000) return hit.v as string;
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status}`);
  const v = await r.text();
  if (cache.size > 40) cache.clear();
  cache.set(url, { t: Date.now(), v });
  return v;
}
function entries(xml: string) {
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => {
    const e = m[1], g = (tag: string) => (e.match(new RegExp(`<${tag}[^>]*>([^]*?)</${tag}>`)) ?? [, ""])[1].replace(/\s+/g, " ").trim();
    return { id: g("id").replace(/^.*\/abs\//, "").replace(/v\d+$/, ""), title: g("title"), summary: g("summary"), published: g("published").slice(0, 10), authors: [...e.matchAll(/<name>([^<]*)<\/name>/g)].map((a) => a[1]).slice(0, 6) };
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    const { action, query, id, offset, limit } = await req.json();
    if (action === "search") {
      const q = String(query ?? "").slice(0, 200);
      if (q.length < 3) return json({ error: "query too short" }, 400);
      const xml = await get(`https://export.arxiv.org/api/query?search_query=${encodeURIComponent("all:" + q)}&max_results=${Math.min(Number(limit) || 6, 10)}&sortBy=relevance`);
      return json({ results: entries(xml).map((e) => ({ ...e, summary: e.summary.slice(0, 700) })) });
    }
    if (!ID.test(String(id ?? ""))) return json({ error: "bad arXiv id" }, 400);
    if (action === "abstract") {
      const e = entries(await get(`https://export.arxiv.org/api/query?id_list=${id}`))[0];
      return json(e ? { paper: e } : { error: "not found" }, e ? 200 : 404);
    }
    if (action === "text") {
      let text = "", src = "";
      for (const u of [`https://arxiv.org/html/${id}`, `https://ar5iv.labs.arxiv.org/html/${id}`]) {
        try { text = clean(await get(u, 25_000)); src = u; if (text.length > 2000) break; } catch (_) { /* try the next host */ }
      }
      if (text.length < 2000) return json({ error: "no readable HTML version of this paper (PDF only)" }, 404);
      const o = Math.max(0, Number(offset) || 0), n = 9000;
      return json({ source: src, total_chars: text.length, offset: o, text: text.slice(o, o + n), next_offset: o + n < text.length ? o + n : null });
    }
    return json({ error: "action must be search, abstract or text" }, 400);
  } catch (e) {
    return json({ error: (e as Error).message }, 502);
  }
});
