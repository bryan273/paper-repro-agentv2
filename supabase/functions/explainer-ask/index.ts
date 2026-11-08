// Paper Explainer "Ask": a tutor chat about the paper behind one finished video.
//   POST {job, q, mode: "plus"|"paper", intent: "ask"|"simpler", section?, history?, lang, visitor} -> {blocks, followups, left}
//   GET  ?chat=<job>                                                                               -> {messages}  (this visitor's saved chat)
// Every answer is a list of blocks. A "paper" block carries a short quote that must appear word for word in the paper text; a quote that
// cannot be found downgrades the block to "unverified", and a paper claim with no quote is shown as "general". "General" blocks are
// background, analogies and prerequisites from the model's own knowledge and say so. Mode "paper" allows paper blocks only.
// The model call goes through the shared agent-llm gateway (RKAPI Haiku first, Paratera after), so its budgets and fallbacks apply.
import { CORS, SB_URL, SB_SERVICE, actorOf, db, json, userOf, logEvent, isAdmin } from "../_shared/explainer.ts";

const PER_DAY_GUEST = Number(Deno.env.get("EXPLAINER_ASK_GUEST_DAY") ?? "8");
const PER_DAY_MEMBER = Number(Deno.env.get("EXPLAINER_ASK_MEMBER_DAY") ?? "40");
const MAX_TEXT = 60_000;

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[^\p{L}\p{N}]+/gu, " ").trim();
/** A quote counts when every part of it (a quote may use "..." to skip text) appears in the paper with its words in the same order and
 *  at most MAX_EXTRA other words mixed in (a dropped parenthesis or citation is fine). A paraphrase, or a word the paper never uses,
 *  does not count. Case and punctuation are ignored. */
const MAX_EXTRA = 10;
const ELLIPSIS = String.fromCharCode(8230);
function inOrder(q: string[], t: string[]): boolean {
  for (let i = 0; i < t.length; i++) {
    if (t[i] !== q[0]) continue;
    let k = 1;
    for (let j = i + 1; k < q.length && j < t.length && j - i < q.length + MAX_EXTRA; j++) if (t[j] === q[k]) k++;
    if (k === q.length) return true;
  }
  return false;
}
export function quoteFound(quote: string, text: string): boolean {
  const parts = quote.split("...").flatMap((s) => s.split(ELLIPSIS)).map((s) => norm(s).split(" ").filter(Boolean)).filter((w) => w.length >= 3);
  if (parts.reduce((n, w) => n + w.length, 0) < 4) return false;
  const t = norm(text).split(" ");
  return parts.every((q) => inOrder(q, t));
}

/** The page of the paper a quote is on (1-based), or null when the pages are not known. */
export function pageOf(quote: string, pages: string[] | null | undefined): number | null {
  if (!pages?.length) return null;
  const parts = quote.split("...").flatMap((s) => s.split(ELLIPSIS)).map((s) => norm(s).split(" ").filter(Boolean)).filter((w) => w.length >= 3);
  const np = pages.map((p) => norm(p));
  for (const w of parts) for (let k = 0; k + 4 <= w.length; k += 3) { const win = w.slice(k, k + 5).join(" "); const hit = np.findIndex((p) => p.includes(win)); if (hit >= 0) return hit + 1; }
  return null;
}
type Beat = { t: number; sec: number; x?: string; ev?: string; pg?: number | null };
/** The moment of the video that says (most nearly) what a quote says: the scene whose evidence and narration share the most words with it. */
export function momentOf(quote: string, beats: Beat[] | null | undefined): Beat | null {
  if (!beats?.length) return null;
  const q = new Set(norm(quote).split(" ").filter((w) => w.length > 3));
  let best: Beat | null = null, top = 0;
  for (const b of beats) { const w = new Set(norm(`${b.ev ?? ""} ${b.x ?? ""}`).split(" ")); let n = 0; for (const x of q) if (w.has(x)) n++; if (n > top) { top = n; best = b; } }
  return top >= 3 ? best : null;
}

/** The model sometimes stops mid-answer (token limit, long Chinese text) or leaves a quote unescaped. Keep every block that is complete. */
export function lenientParse(s: string): { blocks?: unknown; followups?: unknown } | null {
  const ok = (v: unknown): v is { blocks: unknown[] } => !!v && typeof v === "object" && Array.isArray((v as { blocks?: unknown }).blocks);
  try { const v = JSON.parse(s); if (ok(v)) return v; } catch { /* repaired below */ }
  const start = s.indexOf("{");
  if (start < 0) return null;
  const body = s.slice(start);
  // walk back over the closing braces: cut after one, close whatever is still open, and take the first cut that parses
  let tries = 0;
  for (let p = body.lastIndexOf("}"); p > 0 && tries < 60; p = body.lastIndexOf("}", p - 1), tries++) {
    const stack: string[] = [];
    let inStr = false, esc = false;
    for (const ch of body.slice(0, p + 1)) {
      if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
      if (ch === '"') inStr = true; else if (ch === "{") stack.push("}"); else if (ch === "[") stack.push("]"); else if (ch === "}" || ch === "]") stack.pop();
    }
    if (inStr) continue;
    try { const v = JSON.parse(body.slice(0, p + 1) + stack.reverse().join("")); if (ok(v)) return v; } catch { /* a shorter cut */ }
  }
  return null;
}

/** Last resort for JSON that will not parse (typically an unescaped " inside a sentence): read the blocks by their shape instead. */
export function salvage(s: string): { blocks: unknown[]; followups: string[] } | null {
  const blocks: unknown[] = [];
  const re = /"kind"\s*:\s*"(paper|general)"\s*,\s*"text"\s*:\s*"([\s\S]*?)"\s*,\s*"quote"\s*:\s*(?:null|"([\s\S]*?)")\s*\}/g;
  for (const m of s.matchAll(re)) blocks.push({ kind: m[1], text: m[2].replace(/\\n/g, " ").replace(/\\"/g, '"'), quote: m[3] ?? null });
  if (!blocks.length) return null;
  const followups = [...(s.split('"followups"')[1] ?? "").matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]).slice(0, 3);
  return { blocks, followups };
}

const clean = (h: string) =>
  h.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<\/(p|div|h\d|li|tr)>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#?\w+;/g, " ")
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n").trim();

/** Videos made before the paper text was saved: an arXiv paper can be read again from arXiv. */
async function arxivText(id: string): Promise<string> {
  const get = async (u: string) => {
    const r = await fetch(u, { headers: { "User-Agent": "paper-explainer/1.0" }, signal: AbortSignal.timeout(20_000) });
    if (!r.ok) throw new Error(String(r.status));
    return r.text();
  };
  let abstract = "";
  try { abstract = ((await get(`https://export.arxiv.org/api/query?id_list=${id}`)).split("<summary>")[1] ?? "").split("</summary>")[0].replace(/\s+/g, " ").trim(); } catch { /* the full text may still load */ }
  let full = "";
  for (const u of [`https://arxiv.org/html/${id}`, `https://ar5iv.labs.arxiv.org/html/${id}`]) {
    try { full = clean(await get(u)); if (full.length > 3000) break; } catch { /* try the next host */ }
  }
  return `${abstract}\n${full}`.slice(0, MAX_TEXT);
}

const LANGNAME: Record<string, string> = { zh: "Simplified Chinese", vi: "Vietnamese", id: "Indonesian", en: "English" };
const DEEP_PER_VIDEO_PLUS = 30;   // Plus: 30 per video; Pro: unlimited
const DEEP_PER_VIDEO = 10;   // a free member gets this many Deep answers for each video; any plan makes it unlimited
const QUIZ_GUEST = 3, QUIZ_MEMBER = 12;
const SYSTEM = (text: string, mode: string, lang: string) => `You are a patient tutor helping one person understand ONE research paper. They just watched a short video about it and want to understand more. Be warm, plain and concrete.
Write every answer in ${LANGNAME[lang] ?? "English"}.
Return ONLY JSON: {"blocks":[{"kind":"paper"|"general","text":string,"quote":string|null}],"followups":[string,string,string]}
Rules:
- kind "paper": something the paper itself says. Put ONE short quote (at most 30 words) in "quote", copied WORD FOR WORD from the PAPER TEXT below, in the paper's own language. Never invent or paraphrase a quote. If you cannot quote it, use kind "general".
- kind "general": background, definitions, analogies, prerequisites or related work from your general knowledge. "quote" is null. Never present this paper's own numbers or results as general knowledge.
- Start from what the person does not understand. Short sentences, define every technical term, and give one everyday example or analogy when it helps.
- 2 to 5 blocks, each at most 3 sentences. "followups" are 3 short questions the person might ask next.
${mode === "paper" ? '- PAPER ONLY mode: use only kind "paper" blocks. If the paper does not say it, say that plainly in one block with kind "general" and quote null; do not add outside knowledge.' : "- Mix both kinds: ground the answer in the paper, then add background where it helps understanding."}
- Plain text only: no markdown, no asterisks, no bullet symbols, no headings.
PAPER TEXT (may be cut off):
"""
${text.slice(0, 48_000)}
"""`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const user = await userOf(req);
    if (req.method === "GET") {
      const u = new URL(req.url);
      const id = u.searchParams.get("chat") ?? "";
      if (!/^[0-9a-f-]{36}$/.test(id)) return json({ error: "job required" }, 400);
      const actor = await actorOf(req, req.headers.get("x-visitor-id"));
      const [row] = await db(`explainer_chats?job_id=eq.${id}&owner=eq.${encodeURIComponent(user?.id ?? actor)}&select=messages`);
      return json({ messages: row?.messages ?? [] });
    }
    const b = await req.json();
    const jobId = String(b.job ?? "");
    if (!/^[0-9a-f-]{36}$/.test(jobId)) return json({ error: "job required" }, 400);
    const intent = b.intent === "simpler" ? "simpler" : b.intent === "quiz" ? "quiz" : b.intent === "quizall" ? "quizall" : "ask";
    const deep = b.model === "deep" && intent !== "quiz" && intent !== "quizall";
    const mode = b.mode === "paper" ? "paper" : "plus";
    const lang = ["zh", "vi", "id"].includes(b.lang) ? b.lang : "en";
    const q = String(b.q ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
    const secIdx = Number.isInteger(b.section) ? Number(b.section) : -1;
    if (intent === "ask" && q.length < 2) return json({ error: "Type a question first." }, 400);

    const [job] = await db(`explainer_jobs?id=eq.${jobId}&select=id,arxiv,title,status,expired_at,paper_text,sections,paper_pages,timeline`);
    if (!job || job.status !== "done") return json({ error: "Open a finished video first." }, 404);
    if (job.expired_at) return json({ error: "This video has expired, so its paper text is gone. Make it again to ask questions." }, 410);

    const qsetKey = `quizset:${jobId}:${lang}`;
    if (intent === "quizall" && !b.final) {   // the questions of the parts are written once for a video and then shared
      const [hit] = await db(`explainer_events?actor=eq.${encodeURIComponent(qsetKey)}&type=eq.quizset&select=meta&order=created_at.desc&limit=1`).catch(() => []);
      if (hit?.meta?.quizzes?.length) return json({ quizzes: hit.meta.quizzes, cached: true });
    }
    const actor = await actorOf(req, b.visitor);
    const limit = user ? PER_DAY_MEMBER : PER_DAY_GUEST;
    const since = new Date(Date.now() - 86400_000).toISOString();
    const used = (await db(`explainer_asks?actor=eq.${encodeURIComponent(actor)}&created_at=gte.${since}&select=id`)).length;
    if (used >= limit && !isAdmin(user)) {
      return json({ error: user ? "You reached today's question limit. Try again tomorrow." : `You used your ${limit} free questions today. Sign up free for more.`, code: user ? "ask_member" : "ask_guest" }, 429);
    }

    let plan: string | null = null;
    if (user) {
      const [pe] = await db(`explainer_events?user_id=eq.${user.id}&type=eq.plan&select=meta&order=created_at.desc&limit=1`).catch(() => []);
      plan = pe?.meta?.until && new Date(pe.meta.until) > new Date() ? String(pe.meta.plan) : null;
    }
    if (deep && !isAdmin(user) && plan !== "pro") {
      if (!user) return json({ error: "The stronger model is free to try once you sign up.", code: "deep_signup" }, 402);
      const cap = plan === "plus" ? DEEP_PER_VIDEO_PLUS : DEEP_PER_VIDEO;
      const tried = (await db(`explainer_asks?actor=eq.${encodeURIComponent(actor)}&job_id=eq.${jobId}&intent=eq.deep&select=id`)).length;
      if (tried >= cap) return json({ error: plan === "plus" ? `You used the ${cap} careful answers Plus gives for this video. Pro makes them unlimited.` : `You used your ${cap} free careful answers for this video. Plus gives ${DEEP_PER_VIDEO_PLUS}, Pro is unlimited.`, code: "deep_premium" }, 402);
    }
    if ((intent === "quiz" || intent === "quizall") && !isAdmin(user) && !plan) {
      const qs = (await db(`explainer_asks?actor=eq.${encodeURIComponent(actor)}&intent=eq.quiz&created_at=gte.${since}&select=id`)).length;
      if (qs >= (user ? QUIZ_MEMBER : QUIZ_GUEST)) return json({ error: user ? "You used today's free interactive checks. Unlimited checks are part of Plus." : "That was your free taste of interactive mode. Sign up free for more.", code: user ? "quiz_premium" : "quiz_signup" }, 402);
    }

    // what this member told us about themselves (Settings > Personalize): the tutor pitches the answer to them
    let who = "";
    if (user) {
      const [pr] = await db(`explainer_events?user_id=eq.${user.id}&type=eq.profile&select=meta&order=created_at.desc&limit=1`).catch(() => []);
      const m = pr?.meta;
      if (m && (m.level || m.field || m.goal || m.purpose)) {
        const lv = ({ beginner: "a beginner", intermediate: "at an intermediate level", expert: "an expert" } as Record<string, string>)[m.level] ?? "";
        who = `\nABOUT THE LEARNER (adapt depth, vocabulary and examples to them; never mention this note): ${[lv && `they are ${lv}`, m.field && `their field is ${m.field}`, m.goal && `their goal: ${m.goal}`, m.purpose && `they use this for ${({ study: "studying a course", research: "reading research", teach: "teaching others", share: "making content to share", curious: "curiosity" } as Record<string, string>)[m.purpose] ?? m.purpose}`].filter(Boolean).join("; ")}.`;
      }
    }

    let text: string = job.paper_text ?? "";
    if (text.length < 1500 && /^\d{4}\.\d{4,5}$/.test(job.arxiv)) {
      text = await arxivText(job.arxiv);
      if (text.length > 1500) await db(`explainer_jobs?id=eq.${jobId}`, { method: "PATCH", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ paper_text: text }) });
    }
    if (text.length < 300) return json({ error: "The text is not available for this video. Ask works for videos made after this update, and for arXiv papers.", code: "no_text" }, 409);

    const sec = secIdx >= 0 && Array.isArray(job.sections) ? job.sections[secIdx] : null;
    const secTitle = sec ? String((sec[`title_${lang}`] ?? sec.title) || sec.title || "") : "";
    const secText = sec ? String((sec[`text_${lang}`] ?? sec.text) || sec.text || "") : "";
    if (intent === "quiz") {
      const qsys = `You write ONE multiple-choice question that checks whether a viewer understood one part of a research-paper video. Use only the PAPER TEXT. Write in ${LANGNAME[lang]}. Return ONLY JSON: {"question":str,"options":[str,str,str],"answer":0|1|2,"why":str}. Options are short; exactly one is correct; the wrong ones are plausible, not silly; "why" is one or two sentences saying why the right option is right, using the paper's idea. Vary which position is correct.\n\nPAPER TEXT:\n${text.slice(0, 16000)}`;
      const qr = await fetch(`${SB_URL}/functions/v1/agent-llm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SB_SERVICE}`, apikey: SB_SERVICE, "x-forwarded-for": req.headers.get("x-forwarded-for") ?? "" },
        body: JSON.stringify({ app: "companion", messages: [{ role: "system", content: qsys }, { role: "user", content: `The video part: "${secTitle}". ${secText}\nAsk one question about it.` }], max_tokens: 700, json_mode: true, visitor: actor, ...(isAdmin(user) ? { bypass_limits: true } : {}) }),
      });
      const qo = await qr.json().catch(() => ({}));
      if (!qr.ok) return json({ error: qo.error ?? "The tutor is busy. Please try again in a minute.", code: qo.code ?? "busy" }, qr.status === 429 ? 429 : 503);
      let qz: { question?: string; options?: unknown; answer?: unknown; why?: string } = {};
      try { qz = JSON.parse(String(qo.message?.content ?? "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "")); } catch { /* unreadable */ }
      const opts = Array.isArray(qz.options) ? qz.options.map((o) => String(o).slice(0, 140)).slice(0, 3) : [];
      const ans = Number(qz.answer);
      if (!qz.question || opts.length !== 3 || !(ans >= 0 && ans <= 2)) return json({ error: "Could not write a question for this part. Try again.", code: "bad_quiz" }, 502);
      const qu = qo.usage ?? {};
      await db("explainer_asks", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ job_id: jobId, actor, user_id: user?.id ?? null, intent: "quiz", tokens: (qu.prompt_tokens ?? 0) + (qu.completion_tokens ?? 0) }) });
      return json({ quiz: { question: String(qz.question).slice(0, 300), options: opts, answer: ans, why: String(qz.why ?? "").slice(0, 400) } });
    }
    if (intent === "quizall") {
      const final = !!b.final;
      const secs: { title: string; text: string }[] = (Array.isArray(job.sections) ? job.sections : []).map((x: any) => ({ title: String((x[`title_${lang}`] ?? x.title) || x.title || ""), text: String((x[`text_${lang}`] ?? x.text) || x.text || "") }));
      if (secs.length === 0) return json({ error: "This video has no parts to ask about.", code: "bad_quiz" }, 400);
      const n = final ? Math.min(8, Math.max(5, secs.length + 1)) : secs.length;
      const outline = secs.map((x, i) => `PART ${i + 1}: ${x.title}. ${x.text}`.slice(0, 1400)).join("\n");
      const qsys = final
        ? `You write a final test of ${n} multiple-choice questions that checks whether a viewer understood a whole research-paper video. Cover every part at least once and mix easy and harder questions. Use only the PAPER TEXT. Write in ${LANGNAME[lang]}. Return ONLY JSON: {"quizzes":[{"section":0-based index of the part the question is about,"question":str,"options":[str,str,str],"answer":0|1|2,"why":str}]} with exactly ${n} items. Options are short; exactly one is correct; the wrong ones are plausible, not silly; "why" is one or two sentences. Vary which position is correct.\n\nPAPER TEXT:\n${text.slice(0, 14000)}`
        : `You write ONE multiple-choice question for each of the ${n} parts of a research-paper video, to check that a viewer understood that part. Use only the PAPER TEXT. Write in ${LANGNAME[lang]}. Return ONLY JSON: {"quizzes":[{"section":0-based index of the part,"question":str,"options":[str,str,str],"answer":0|1|2,"why":str}]} with exactly ${n} items, in the order of the parts. Options are short; exactly one is correct; the wrong ones are plausible, not silly; "why" is one or two sentences saying why the right option is right. Vary which position is correct.\n\nPAPER TEXT:\n${text.slice(0, 14000)}`;
      const qr = await fetch(`${SB_URL}/functions/v1/agent-llm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SB_SERVICE}`, apikey: SB_SERVICE, "x-forwarded-for": req.headers.get("x-forwarded-for") ?? "" },
        body: JSON.stringify({ app: "companion", messages: [{ role: "system", content: qsys }, { role: "user", content: `The parts of the video:\n${outline}\nWrite the ${final ? "final test" : "questions"}.` }], max_tokens: 3200, json_mode: true, visitor: actor, ...(isAdmin(user) ? { bypass_limits: true } : {}) }),
      });
      const qo = await qr.json().catch(() => ({}));
      if (!qr.ok) return json({ error: qo.error ?? "The tutor is busy. Please try again in a minute.", code: qo.code ?? "busy" }, qr.status === 429 ? 429 : 503);
      let parsed: { quizzes?: any[] } = {};
      try { parsed = JSON.parse(String(qo.message?.content ?? "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "")); } catch { /* unreadable */ }
      const quizzes = (Array.isArray(parsed.quizzes) ? parsed.quizzes : []).map((z: any, k: number) => {
        const opts = Array.isArray(z.options) ? z.options.map((o: unknown) => String(o).slice(0, 140)).slice(0, 3) : [];
        const ans = Number(z.answer);
        const sec = Number.isInteger(z.section) && z.section >= 0 && z.section < secs.length ? Number(z.section) : Math.min(k, secs.length - 1);
        return z.question && opts.length === 3 && ans >= 0 && ans <= 2 ? { section: sec, question: String(z.question).slice(0, 300), options: opts, answer: ans, why: String(z.why ?? "").slice(0, 400) } : null;
      }).filter(Boolean);
      if (quizzes.length < Math.min(3, n)) return json({ error: "Could not write the questions. Try again.", code: "bad_quiz" }, 502);
      const qu = qo.usage ?? {};
      await db("explainer_asks", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ job_id: jobId, actor, user_id: user?.id ?? null, intent: "quiz", tokens: (qu.prompt_tokens ?? 0) + (qu.completion_tokens ?? 0) }) });
      if (!final) await db("explainer_events", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ actor: qsetKey, type: "quizset", user_id: null, meta: { quizzes } }) }).catch(() => undefined);
      return json({ quizzes });
    }
    const ask = intent === "simpler"
      ? `I did not understand this part of the video${secTitle ? ` ("${secTitle}")` : ""}: ${secText || q}\nExplain it again for a complete beginner, with an everyday analogy, and say what I should know first.`
      : sec ? `${q}\n(I am asking about the video part "${secTitle}": ${secText})` : q;
    const history = (Array.isArray(b.history) ? b.history : []).slice(-6).map((m: { role?: string; text?: string }) => ({ role: m.role === "ai" ? "assistant" : "user", content: String(m.text ?? "").slice(0, 700) })).filter((m: { content: string }) => m.content);
    const messages = [{ role: "system", content: SYSTEM(text, mode, lang) + who }, ...history, { role: "user", content: ask }];

    let out: { message?: { content?: string }; usage?: Record<string, number>; finish_reason?: string; error?: string; code?: string } = {};
    let content = "";
    let parsed: { blocks?: unknown; followups?: unknown } | null = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {   // an answer that cannot be read is asked for once more
      const r = await fetch(`${SB_URL}/functions/v1/agent-llm`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SB_SERVICE}`, apikey: SB_SERVICE, "x-forwarded-for": req.headers.get("x-forwarded-for") ?? "" },
        body: JSON.stringify({ app: "companion", messages, max_tokens: lang === "zh" ? 2600 : 1600, json_mode: true, visitor: actor, ...(deep ? { tier: "deep" } : {}), ...(isAdmin(user) ? { bypass_limits: true } : {}) }),
      });
      out = await r.json().catch(() => ({}));
      if (!r.ok) return json({ error: out.error ?? "The tutor is busy. Please try again in a minute.", code: out.code ?? "busy" }, r.status === 429 ? 429 : 503);
      content = String(out.message?.content ?? "").replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");
      parsed = lenientParse(content) ?? salvage(content);
    }
    type Block = { kind: "paper" | "general" | "unverified"; text: string; quote?: string; page?: number; t?: number; sec?: number };
    const beats = (job.timeline?.[lang] ?? job.timeline?.en ?? job.timeline?.zh) as Beat[] | undefined;
    const blocks: Block[] = [];
    for (const x of (Array.isArray(parsed?.blocks) ? parsed!.blocks as Record<string, unknown>[] : []).slice(0, 6)) {
      const t = String(x?.text ?? "").trim().slice(0, 900);
      if (!t) continue;
      const quote = String(x?.quote ?? "").trim().slice(0, 300);
      if (x?.kind === "paper" && quote) blocks.push(quoteFound(quote, text) ? { kind: "paper", text: t, quote, ...(() => { const pg = pageOf(quote, job.paper_pages); const m = momentOf(quote, beats); return { ...(pg ? { page: pg } : {}), ...(m ? { t: m.t, sec: m.sec } : {}) }; })() } : { kind: "unverified", text: t, quote });
      else if (mode !== "paper") blocks.push({ kind: "general", text: t });
      else blocks.push({ kind: "general", text: t });
    }
    if (!blocks.length) blocks.push({ kind: "general", text: (content && !parsed && !/"blocks"/.test(content) ? content : lang === "zh" ? "抱歉，这次没能整理出答案，请换个问法再试一次。" : "Sorry, I could not put an answer together this time. Please try asking it another way.").slice(0, 900) });
    const followups = (Array.isArray(parsed?.followups) ? parsed!.followups as unknown[] : []).map((f) => String(f).trim().slice(0, 140)).filter(Boolean).slice(0, 3);

    const owner = user?.id ?? actor;
    const [prev] = await db(`explainer_chats?job_id=eq.${jobId}&owner=eq.${encodeURIComponent(owner)}&select=messages`);
    const now = new Date().toISOString();
    const messages2 = [...(prev?.messages ?? []), { role: "user", text: q || (lang === "zh" ? "再讲得简单一点" : "Explain it more simply"), section: secIdx >= 0 ? secIdx : null, t: now }, { role: "ai", blocks, followups, t: now }].slice(-40);
    await db("explainer_chats?on_conflict=job_id,owner", { method: "POST", headers: { Prefer: "resolution=merge-duplicates,return=minimal" }, body: JSON.stringify([{ job_id: jobId, owner, messages: messages2, updated_at: now }]) });
    const u = out.usage ?? {};
    await db("explainer_asks", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify({ job_id: jobId, actor, user_id: user?.id ?? null, intent: deep ? "deep" : intent, tokens: (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0) }) });
    await logEvent(actor, "ask", { intent, mode }, user?.id ?? null).catch(() => undefined);
    return json({ blocks, followups, left: Math.max(0, limit - used - 1), finish: out.finish_reason ?? null });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
