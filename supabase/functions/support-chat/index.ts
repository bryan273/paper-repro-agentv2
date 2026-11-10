// Paperlit support assistant. POST {messages: [{role, content}], visitor} -> {answer, team}
// The knowledge base and the instructions live here, not in the browser: the browser sends only what the person typed, and this function
// picks the sections that fit the question, so the model answers from the product's own facts and nothing else. The model call goes through
// the shared agent-llm gateway; this function limits each visitor and each connection itself.
import { CORS, SB_URL, SB_SERVICE, actorOf, count, json, logEvent } from "../_shared/explainer.ts";

type Sec = { id: string; tags: string; text: string; always?: boolean };
const KB: Sec[] = [
  { id: "core", always: true, tags: "paperlit about what is", text: "Paperlit turns a paper, an article, pasted text or a file into a short narrated video with chapters, questions inside it, answers that quote the source with the page, notes and flashcards, and a check of whether a paper's results come out again. It works in 9 languages and takes payment in yuan, dong and rupiah. Pages: New video, Library, Research, Check, Pricing, Help, Account." },
  { id: "plans", always: true, tags: "plan plans price pricing cost how much gói paket harga giá 价格 套餐", text: "Plans per month (China / Vietnam / Indonesia). Free: 0, 3 videos a week up to 3 minutes, edit each video once, interactive mode on 2 videos a week, 20 quick answers and 2 research questions a week, 2 in-depth answers a month, videos kept 7 days, plus 3 welcome videos with interactive mode. Plus: ¥29 / 79.000đ / Rp69.000, 20 videos up to 5 minutes, edit each video up to 2 times, interactive mode on every video, 100 quick and 10 in-depth answers, 8 research questions, notes and flashcards, answers pitched to your level, videos kept 30 days. Pro: ¥55 / 149.000đ / Rp129.000, 40 videos up to 10 minutes, edit up to 3 times, 200 quick and 20 in-depth answers, 15 research questions, kept 90 days, everything in Plus. Premium: ¥99 / 269.000đ / Rp239.000, 80 videos up to 20 minutes, edit up to 3 times, 300 quick and 30 in-depth answers, 25 research questions, kept 270 days, new features first, everything in Pro. Yearly costs 10 months for 12. Plans never renew on their own. Video credit packs: 5, 20 or 50 credits (¥19, ¥59, ¥129), never expire, videos up to 10 minutes." },
  { id: "choose", tags: "difference choose should which better recommend student plus pro premium compare perbedaan pilih khác chọn sinh viên mahasiswa 学生 区别 选择", text: "Choosing a plan. Plus is the right start for most students: 20 videos a month of up to 5 minutes covers a course's readings, interactive mode is on for every video so each video asks questions, and notes and flashcards turn what you watched and asked into study material. Pro is for long papers and heavy study: 40 videos of up to 10 minutes and about twice the answers and research questions. Premium is for teaching and heavy use: 20 minute lessons, 80 videos, 300 quick answers, and new features first. If you only need a few videos, a credit pack never expires. Free is enough to try one video and see the quality." },
  { id: "discount", tags: "discount cheaper cheap expensive coupon promo sale offer off giảm khuyến mãi diskon murah mahal promo 优惠 折扣 便宜 贵", text: "Discounts and offers that really exist: (1) New members get 40% off the first month of any monthly plan when they buy within 72 hours of signing up; the second month is the regular price and nothing renews on its own. (2) Yearly plans cost 10 months for 12. (3) Students and teachers get one free month of Plus after sending a photo of a student or staff card (Account > Students and teachers). (4) Inviting a friend gives you 2 free videos when they sign up with your link, up to 5 friends. (5) Credit packs for people who only need a few videos. Never invent a coupon code or promise a special price; for a class, lab or team, offer a custom plan through the team." },
  { id: "value", tags: "better other platform compare competitor chatgpt expensive worth why choose unique versus lebih baik so sánh khác biệt 比较 为什么", text: "What Paperlit does that a general AI chat does not: every quote in a video or answer is matched word for word against the source and removed if it does not match, and answers show the page they come from; the video stops after each part with one question and explains the answer (interactive mode); you can edit one part of a finished video without remaking it and without using a credit; notes and flashcards are built from what you watched and asked, can be edited and downloaded; Check re-runs a paper's public code to see whether its numbers come out again; it works in 9 languages; you can pay with WeChat Pay, Alipay, VietQR or QRIS; plans never renew on their own. Do not claim anything about a named competitor; compare only with general AI chat tools and say what Paperlit adds." },
  { id: "video", tags: "make create video length language style voice how credit minute buat tạo video 视频 制作 bahasa ngôn ngữ", text: "Making a video: New video, choose Link, Paste text or Upload file (PDF, TXT or Markdown, up to 5 files of 20 MB), pick one of 9 video languages (English, Chinese, Vietnamese, Indonesian, Japanese, Korean, Spanish, French, German; each extra language is its own video), the length (Free 3 minutes, Plus 5, Pro 10, Premium 20), the style (or your own style in your words), the voice, optionally a focus line and interactive mode, then press Make video. It takes about 4 to 8 minutes and keeps going if the tab is closed. A video reads the first 60,000 characters of the source. Every started 5 minutes uses one video credit (3 min = 1, 10 min = 2, 20 min = 4). A failed video gives its credit back and the page says why, with a retry button." },
  { id: "inside", tags: "interactive ask answer quick deep quiz edit notes flashcards source tab chat tanya pertanyaan hỏi", text: "Inside a video: interactive mode puts one question at the end of each part and explains the answer (it can be turned on for older videos too, and the page shows how many interactive videos are left); the Ask tab gives quick answers and in-depth answers from a stronger AI that quote the source with page numbers, and you can ask in any language: the answer follows the language of the question; the Quiz tab keeps your answers and a final quiz; Notes builds notes and flashcards from the video, your questions and the quiz questions you missed, with an Update button for what is new, editing, and download as .md and .csv for Anki (Plus and up); Source opens the original at the right page and can show which passages each part of the script was written from. Edit: choose a part, say what to change, only that part is made again, no video credit used; Free 1 edit per video, Plus 2, Pro and Premium 3." },
  { id: "research", tags: "research check reproduce repro papers question", text: "Research: ask one question and Paperlit searches papers, reads the best ones and writes an answer where every number opens the quote it came from. Counted per plan (Free 2 a week, Plus 8, Pro 15, Premium 25 a month). Check: a list of papers whose code was re-run, each marked reproduced, partly reproduced or not reproduced, with the full log; you can send an arXiv link to ask for one to be checked." },
  { id: "pay", tags: "pay payment bayar thanh toán wechat alipay qris vietqr gopay bank order paid refund hoàn tiền 付款 退款", text: "Payment: choose yuan (WeChat Pay or Alipay), dong (VietQR: Techcombank or BIDV) or rupiah (QRIS: GoPay, OVO, DANA or any Indonesian bank app). Scan the code, pay the exact amount, write the order number in the note, add a screenshot and press I have paid. The plan switches on once the payment is confirmed, usually within a few hours and always within a day. Refunds, payment checks and account changes are handled by a person: use Message the team." },
  { id: "account", tags: "account login password invite friend student teacher verify email akun daftar đăng ký 账户 邀请", text: "Account: log in with email or username; the profile picture at the top right has settings, theme, language and switching between saved accounts. After signing up the home page asks what you want to get done (exam, homework, understand a topic, prepare a lesson, read a paper quickly) and sets the make page for it. Students and teachers: send a photo of a student or staff card in Account > Students and teachers for a free month of Plus. Invite a friend: 2 videos each time a friend signs up with your link, up to 5 friends. Shared video links are watch only; asking questions needs a free account." },
  { id: "teach", tags: "teacher class lesson school team company guru giáo viên 老师 班级", text: "Teachers: make a video from a reading, share it by link (watch only, questions inside it), use interactive mode so students answer as they watch, and print or download the notes as a handout. Premium makes 20 minute lessons with 3 edits per video. For a whole class, lab or team there are custom plans with seats, invoices and one person to talk to: use Message the team." },
  { id: "privacy", tags: "privacy files kept delete data keep days private", text: "Uploaded files are used to make the video and are removed after processing; videos are kept 7 days (Free), 30 (Plus), 90 (Pro) or 270 days (Premium) and can be downloaded while kept. Notes and flashcards are saved in your browser and can be downloaded." },
];

const LANGS = "the same language the person writes in";
const words = (s: string) => {
  const w = new Set<string>();
  for (const m of s.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)) {
    const x = m[0];
    if (/[一-鿿]/.test(x)) { for (let i = 0; i < x.length - 1; i++) w.add(x.slice(i, i + 2)); } else if (x.length >= 3) w.add(x);
  }
  return w;
};
function pick(question: string): string {
  const q = words(question);
  const scored = KB.filter((s) => !s.always).map((s) => {
    const hay = words(`${s.tags} ${s.text}`); let n = 0;
    for (const w of q) if (hay.has(w)) n += s.tags.toLowerCase().includes(w) ? 3 : 1;
    return { s, n };
  }).filter((x) => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 4);
  const chosen = [...KB.filter((s) => s.always), ...scored.map((x) => x.s)];
  return chosen.map((s) => s.text).join("\n\n");
}

const SYSTEM = (facts: string) => `You are the support and sales assistant of Paperlit. Answer in ${LANGS}, in at most 6 short sentences, plain text with no markdown. Be warm, direct and genuinely helpful: when someone asks what to choose, ask nothing back, recommend one plan and say why in terms of what they will do. When someone says the price is high, explain what they get and which real offer lowers the first month; never invent a discount, a coupon code or a feature. Use only the facts below. If the answer is not in them, say so plainly. If the person needs a refund, a payment check, an account change, a custom plan or a discount that is not listed, say a person will help and end the reply with the marker [TEAM].

FACTS
${facts}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    if (req.method !== "POST") return json({ error: "POST only" }, 405);
    const b = await req.json().catch(() => ({}));
    const msgs = (Array.isArray(b.messages) ? b.messages : []).slice(-8)
      .map((m: { role?: string; content?: string }) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "").slice(0, 1200) }))
      .filter((m: { content: string }) => m.content.trim());
    if (!msgs.length || msgs[msgs.length - 1].role !== "user") return json({ error: "Ask a question first." }, 400);

    const actor = await actorOf(req, b.visitor);
    const since = new Date(Date.now() - 3600_000).toISOString();
    if ((await count(`explainer_events?actor=eq.${encodeURIComponent(actor)}&type=eq.support_chat&created_at=gte.${since}`).catch(() => 0)) >= 40) {
      return json({ error: "That is a lot of questions in an hour. Please try again a little later, or message the team.", code: "slow_down" }, 429);
    }
    await logEvent(actor, "support_chat", {});

    const question = msgs.filter((m: { role: string }) => m.role === "user").slice(-3).map((m: { content: string }) => m.content).join(" ");
    const r = await fetch(`${SB_URL}/functions/v1/agent-llm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${SB_SERVICE}`, apikey: SB_SERVICE },
      body: JSON.stringify({ app: "companion", visitor: actor, max_tokens: 700, bypass_limits: true, messages: [{ role: "system", content: SYSTEM(pick(question)) }, ...msgs] }),
    });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) return json({ error: "The assistant is busy right now. Please try again in a minute, or message the team.", code: "busy" }, 503);
    const raw = String(out?.message?.content ?? "").trim();
    if (!raw) return json({ error: "The assistant is busy right now. Please try again in a minute, or message the team.", code: "busy" }, 503);
    return json({ answer: raw.replace(/\[TEAM\]/g, "").trim(), team: raw.includes("[TEAM]") });
  } catch (e) {
    return json({ error: String(e).slice(0, 160) }, 500);
  }
});
