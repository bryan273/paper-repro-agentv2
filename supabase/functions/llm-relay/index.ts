// Private relay: forwards one chat-completion body to the Paratera gateway. agent-llm calls it with an Asian x-region header,
// because the default region reaches that China-hosted gateway badly. Only callers holding the service key may use it.
const KEY = Deno.env.get("PARATERA_API_KEY");
const SRV = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

Deno.serve(async (req) => {
  if (!KEY || !SRV || req.headers.get("authorization") !== `Bearer ${SRV}`) return new Response("forbidden", { status: 403 });
  try {
    const r = await fetch("https://llmapi.paratera.com/v1/chat/completions", {
      method: "POST", headers: { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" }, body: await req.text(), signal: AbortSignal.timeout(Math.min(Number(req.headers.get("x-timeout-ms")) || 40_000, 120_000)),
    });
    return new Response(await r.text(), { status: r.status, headers: { "Content-Type": "application/json" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: { message: (e as Error).message } }), { status: 504, headers: { "Content-Type": "application/json" } });
  }
});
