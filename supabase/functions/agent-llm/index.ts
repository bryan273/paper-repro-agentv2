// A small, rate-limited LLM gateway for the apps built on Atoms (Repro Lite, Reading Companion, ...).
// The browser app sends chat messages (and optionally tool definitions); this function adds the DeepSeek key, which lives only
// in the secret DEEPSEEK_API_KEY, and returns the model reply. Limits: per visitor per hour, and a global daily token budget.
const SB_URL = Deno.env.get("SUPABASE_URL")!;
const SB_SERVICE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const KEY = Deno.env.get("DEEPSEEK_API_KEY");
const MODEL = Deno.env.get("AGENT_MODEL") ?? "deepseek-flash";
const APPS = new Set(["repro-lite", "companion", "indexboard"]);
const PER_VISITOR_HOUR = Number(Deno.env.get("AGENT_PER_VISITOR_HOUR") ?? "80");
const PER_IP_HOUR = Number(Deno.env.get("AGENT_PER_IP_HOUR") ?? "200");
const PER_IP_DAY_TOKENS = Number(Deno.env.get("AGENT_PER_IP_DAY_TOKENS") ?? "1500000");
const DAILY_TOKENS = Number(Deno.env.get("AGENT_DAILY_TOKENS") ?? "8000000");
const MAX_CHARS = 90_000;
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };

async function db(path: string, init: RequestInit = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, { ...init, headers: { apikey: SB_SERVICE, Authorization: `Bearer ${SB_SERVICE}`, "Content-Type": "application/json", Prefer: "return=minimal", ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`db ${r.status}`);
  return r.headers.get("content-type")?.includes("json") ? r.json() : null;
}
async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(b)].slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const json = (o: unknown, status = 200) => new Response(JSON.stringify(o), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  try {
    if (!KEY) return json({ error: "gateway not configured" }, 503);
    const { app, messages, tools, max_tokens, json_mode, visitor, bypass_limits, tier, stream_out } = await req.json();
    // only another edge function (it holds the service key) may ask to skip the visitor and connection limits, for the QA admin account
    const skip = bypass_limits === true && req.headers.get("authorization") === `Bearer ${SB_SERVICE}`;
    if (!APPS.has(app)) return json({ error: "unknown app" }, 400);
    if (!Array.isArray(messages) || !messages.length) return json({ error: "messages required" }, 400);
    // pictures (a pasted figure or slide) are counted apart from the text: at most one call's worth of text, plus about 2.5 MB of pictures
    const textChars = JSON.stringify(messages, (k, v) => (k === "image_url" ? "" : v)).length;
    if (textChars > MAX_CHARS || JSON.stringify(messages).length > MAX_CHARS + 2_600_000) return json({ error: "too much text in one call" }, 413);
    const ip = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim();
    // the visitor id comes from the browser and can be changed at will, so the connection itself is limited too
    const ipid = await sha(`${ip}|${app}`);
    const vid = ipid + (await sha(`${String(visitor ?? "").slice(0, 64)}|${app}`));
    const since = new Date(Date.now() - 3600_000).toISOString();
    const mine = await db(`agent_usage?visitor=eq.${vid}&created_at=gte.${since}&select=id`, { headers: { Prefer: "count=none" } });
    if (!skip && mine.length >= PER_VISITOR_HOUR) return json({ error: "hourly limit reached, try again later" }, 429);
    const fromIp = await db(`agent_usage?visitor=like.${ipid}*&created_at=gte.${since}&select=id`, { headers: { Prefer: "count=none" } });
    if (!skip && fromIp.length >= PER_IP_HOUR) return json({ error: "Too many requests from this connection, please try again later." }, 429);
    const ipDay = await db(`agent_usage?visitor=like.${ipid}*&created_at=gte.${new Date(Date.now() - 86400_000).toISOString()}&select=prompt_tokens,completion_tokens`);
    if (ipDay.reduce((a: number, r: { prompt_tokens: number; completion_tokens: number }) => a + r.prompt_tokens + r.completion_tokens, 0) > PER_IP_DAY_TOKENS && !skip) return json({ error: "Daily limit for this connection reached, please try again tomorrow." }, 429);
    const day = new Date(Date.now() - 86400_000).toISOString();
    const rows = await db(`agent_usage?created_at=gte.${day}&select=prompt_tokens,completion_tokens`);
    const used = rows.reduce((a: number, r: { prompt_tokens: number; completion_tokens: number }) => a + r.prompt_tokens + r.completion_tokens, 0);
    if (used > DAILY_TOKENS) return json({ error: "daily budget reached, try again tomorrow" }, 429);
    const body: Record<string, unknown> = { model: MODEL, messages, max_tokens: Math.min(Number(max_tokens) || 2000, 4000), temperature: 0.2, thinking: { type: "disabled" } };
    if (Array.isArray(tools) && tools.length && tools.length <= 12) body.tools = tools;
    if (json_mode) body.response_format = { type: "json_object" };
    // DeepSeek first; if its account is out of credit the same model family on the Paratera gateway answers, then StepFun if a key is set
    const PARA = Deno.env.get("PARATERA_API_KEY"), STEP = Deno.env.get("STEPFUN_API_KEY");
    // a call that stalls is cut after `ms` and reported as a 504, so the next provider (or a retry) can take over instead of hanging the visitor
    const post = async (url: string, key: string, b: Record<string, unknown>, ms = 110_000) => {
      try { return await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify(b), signal: AbortSignal.timeout(ms) }); }
      catch { return new Response(JSON.stringify({ error: { message: "The AI service did not answer in time." } }), { status: 504, headers: { "Content-Type": "application/json" } }); }
    };
    const { thinking: _t, ...plain } = body as Record<string, unknown>;
    // The overseas hop to the gateway stalls now and then, so the call is hedged: a second and third copy start 4 s and 10 s later, the first good answer wins and the rest are dropped
    const viaParatera = async (): Promise<Response> => {
      const bodyP = { ...body, model: Deno.env.get("PARATERA_MODEL") ?? "DeepSeek-V4.1-Flash" };
      const ctl = [0, 1, 2].map(() => new AbortController());
      const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY"), SB = Deno.env.get("SUPABASE_URL");
      // copy 0 goes straight to the gateway; copies 1 and 2 go through llm-relay running in Asian regions, which reach it far more reliably
      const route: { delay: number; url: string; headers: Record<string, string> }[] = [
        { delay: 0, url: "https://llmapi.paratera.com/v1/chat/completions", headers: { Authorization: `Bearer ${PARA}` } },
        { delay: 4000, url: `${SB}/functions/v1/llm-relay`, headers: { Authorization: `Bearer ${SRV}`, "x-region": "ap-northeast-2" } },
        { delay: 10000, url: `${SB}/functions/v1/llm-relay`, headers: { Authorization: `Bearer ${SRV}`, "x-region": "ap-southeast-1" } },
      ];
      // each copy keeps trying through short bursts of 429 "no deployments available" and 5xx until it succeeds or ~60 s have passed
      const t0 = Date.now();
      const one = async (i: number): Promise<Response> => {
        await new Promise((res) => setTimeout(res, route[i].delay));
        let last: Response | null = null;
        while (!ctl[i].signal.aborted && Date.now() - t0 < 60_000) {
          try {
            const rr = await fetch(route[i].url, { method: "POST", headers: { ...route[i].headers, "Content-Type": "application/json" }, body: JSON.stringify(bodyP), signal: AbortSignal.any([ctl[i].signal, AbortSignal.timeout(30_000)]) });
            if (rr.ok) {
              const text = await rr.text();   // read the body before the other copies are dropped, or an abort would cut it
              if (ctl[i].signal.aborted) throw new Error("dropped");
              return new Response(text, { status: 200, headers: { "Content-Type": "application/json" } });
            }
            last = rr;
            // a 400 "Invalid model name" is the gateway having no deployments for a moment (its model list goes empty for minutes), so it is retried too
            const transient = [429, 500, 502, 503, 504].includes(rr.status) || (rr.status === 400 && /Invalid model name/i.test(await rr.clone().text().catch(() => "")));
            if (!transient) break;   // a real refusal (bad key, bad request): do not hammer
          } catch (e) {
            if ((e as Error).message === "dropped" || ctl[i].signal.aborted) throw e;
          }
          await new Promise((res) => setTimeout(res, 2500));
        }
        throw Object.assign(new Error("gave up"), { res: last });
      };
      try {
        const win = await Promise.any([0, 1, 2].map((i) => one(i)));
        ctl.forEach((c) => { try { c.abort(); } catch { /* already done */ } });
        return win;
      } catch (e) {
        ctl.forEach((c) => { try { c.abort(); } catch { /* already done */ } });
        const errs = (e as AggregateError).errors ?? [];
        const bad = errs.map((x: { res?: Response }) => x.res).find((x: Response | undefined) => x);
        return bad ?? new Response(JSON.stringify({ error: { message: "The AI service did not answer in time." } }), { status: 504, headers: { "Content-Type": "application/json" } });
      }
    };
    // RKAPI first when its key is set: Claude Haiku answers in a few seconds and does tool calls. It must be streamed (RKAPI holds a whole answer for a minute or more),
    // so the stream is read here and put back together as an ordinary chat-completion answer.
    const RK = Deno.env.get("RKAPI_API_KEY");
    const viaRkapi = async (): Promise<Response | null> => {
      if (!RK) return null;
      const t0 = Date.now();
      for (let attempt = 0; attempt < 2 && Date.now() - t0 < 50_000; attempt++) {
        try {
          const rb: Record<string, unknown> = { model: (tier === "deep" && req.headers.get("authorization") === `Bearer ${SB_SERVICE}` ? (Deno.env.get("RKAPI_DEEP_MODEL") ?? "claude-sonnet-4-6") : Deno.env.get("RKAPI_APP_MODEL") ?? "claude-haiku-4-5-20251001"), messages, max_tokens: body.max_tokens, temperature: 0.2, stream: true, stream_options: { include_usage: true } };
          if (body.tools) rb.tools = body.tools;
          const rr = await fetch("https://rkapi.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${RK}`, "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (repro-suite)" }, body: JSON.stringify(rb), signal: AbortSignal.timeout(45_000) });
          if (!rr.ok || !rr.body) { if ([429, 500, 502, 503, 504].includes(rr.status)) continue; return null; }
          let text = "", fin = "stop", usage: Record<string, number> = {};
          const calls: Record<number, { id: string; name: string; args: string }> = {};
          const dec = new TextDecoder(); let buf = "";
          for await (const chunk of rr.body) {
            buf += dec.decode(chunk, { stream: true });
            const lines = buf.split("\n"); buf = lines.pop() ?? "";
            for (const l of lines) {
              if (!l.startsWith("data:") || l.includes("[DONE]")) continue;
              let ch; try { ch = JSON.parse(l.slice(5)); } catch { continue; }
              if (ch.usage) usage = ch.usage;
              const c = ch.choices?.[0]; if (!c) continue;
              if (c.finish_reason) fin = c.finish_reason;
              text += c.delta?.content ?? "";
              for (const tc of c.delta?.tool_calls ?? []) {
                const k = calls[tc.index ?? 0] ??= { id: "", name: "", args: "" };
                k.id ||= tc.id ?? ""; k.name += tc.function?.name ?? ""; k.args += tc.function?.arguments ?? "";
              }
            }
          }
          if (json_mode) text = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "");   // JSON mode is ignored by Claude: it wraps the answer in a code block
          const tool_calls = Object.keys(calls).length ? Object.entries(calls).map(([i, k]) => ({ id: k.id || `call_${i}`, type: "function", function: { name: k.name, arguments: k.args || "{}" } })) : undefined;
          if (!text.trim() && !tool_calls) continue;
          const message: Record<string, unknown> = { role: "assistant", content: text || null };
          if (tool_calls) message.tool_calls = tool_calls;
          return new Response(JSON.stringify({ choices: [{ message, finish_reason: tool_calls ? "tool_calls" : fin }], usage: { prompt_tokens: usage.prompt_tokens ?? 0, completion_tokens: usage.completion_tokens ?? 0 } }), { status: 200, headers: { "Content-Type": "application/json" } });
        } catch { /* try again, then fall through to the Paratera chain */ }
      }
      return null;
    };
    // Streaming out: the words are sent on as the model writes them (data: {"d": "..."}), then one line with the usage. Only another edge function may ask for it.
    // If the gateway does not answer, the ordinary path below runs and the caller gets one JSON answer instead.
    if (stream_out === true && req.headers.get("authorization") === `Bearer ${SB_SERVICE}` && RK) {
      try {
        const rb: Record<string, unknown> = { model: tier === "deep" ? (Deno.env.get("RKAPI_DEEP_MODEL") ?? "claude-sonnet-4-6") : Deno.env.get("RKAPI_APP_MODEL") ?? "claude-haiku-4-5-20251001", messages, max_tokens: body.max_tokens, temperature: 0.2, stream: true, stream_options: { include_usage: true } };
        const rr = await fetch("https://rkapi.com/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${RK}`, "Content-Type": "application/json", "User-Agent": "Mozilla/5.0 (repro-suite)" }, body: JSON.stringify(rb), signal: AbortSignal.timeout(120_000) });
        if (rr.ok && rr.body) {
          const enc = new TextEncoder(), dec = new TextDecoder();
          const src = rr.body;
          const out = new ReadableStream({
            async start(ctl) {
              let buf = "", usage: Record<string, number> = {}, fin = "stop";
              try {
                for await (const chunk of src) {
                  buf += dec.decode(chunk, { stream: true });
                  const lines = buf.split("\n"); buf = lines.pop() ?? "";
                  for (const l of lines) {
                    if (!l.startsWith("data:") || l.includes("[DONE]")) continue;
                    let ch; try { ch = JSON.parse(l.slice(5)); } catch { continue; }
                    if (ch.usage) usage = ch.usage;
                    const c = ch.choices?.[0]; if (!c) continue;
                    if (c.finish_reason) fin = c.finish_reason;
                    const d = c.delta?.content ?? "";
                    if (d) ctl.enqueue(enc.encode(`data: ${JSON.stringify({ d })}\n\n`));
                  }
                }
              } catch (e) { ctl.enqueue(enc.encode(`data: ${JSON.stringify({ error: String(e).slice(0, 120) })}\n\n`)); }
              ctl.enqueue(enc.encode(`data: ${JSON.stringify({ done: true, finish: fin, usage: { prompt_tokens: usage.prompt_tokens ?? 0, completion_tokens: usage.completion_tokens ?? 0 } })}\n\n`));
              ctl.close();
              await db("agent_usage", { method: "POST", body: JSON.stringify({ visitor: vid, app, prompt_tokens: usage.prompt_tokens ?? 0, completion_tokens: usage.completion_tokens ?? 0 }) }).catch(() => undefined);
            },
          });
          return new Response(out, { headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
        }
      } catch { /* fall through to the ordinary answer */ }
    }
    // Paratera serves the same DeepSeek models and is the account with credit, so it goes first when its key is set
    let r = (await viaRkapi()) ?? (PARA ? await viaParatera() : await post("https://api.deepseek.com/v1/chat/completions", KEY, body));
    const paraFailed = !!PARA && !r.ok;
    if (!r.ok && PARA && KEY && [401, 402, 429, 500, 502, 503, 504].includes(r.status)) r = await post("https://api.deepseek.com/v1/chat/completions", KEY, body);
    if (!r.ok && [401, 402, 429, 502, 503, 504].includes(r.status) && STEP) r = await post("https://api.stepfun.com/v1/chat/completions", STEP, { ...plain, model: Deno.env.get("STEPFUN_MODEL") ?? "step-3.5-flash" });
    const out = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (r.status === 504) return json({ error: "The AI service is busy right now. Please try again in a minute.", code: "busy" }, 503);
      if (paraFailed && [401, 402, 429, 500, 502, 503, 504].includes(r.status)) return json({ error: "The AI service is busy right now. Please try again in a minute.", code: "busy" }, 503);
      if ([401, 402].includes(r.status)) return json({ error: "The AI service is temporarily out of credit. Please try again later.", code: "no_credit" }, 503);
      return json({ error: out?.error?.message ?? "model error" }, 502);
    }
    const u = out.usage ?? {};
    await db("agent_usage", { method: "POST", body: JSON.stringify({ visitor: vid, app, prompt_tokens: u.prompt_tokens ?? 0, completion_tokens: u.completion_tokens ?? 0 }) });
    return json({ message: out.choices?.[0]?.message, finish_reason: out.choices?.[0]?.finish_reason, usage: u });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
});
