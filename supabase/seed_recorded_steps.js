// Seeds Supabase with the contract, route and plan of every recorded run, so those papers get a kit link at once.
// Run: DBPW=<database password> node supabase/seed_recorded_steps.js   (needs `npm i pg`; WARNING: it first deletes all jobs)
const { Client } = require("pg"); const fs = require("fs");
const dir = require("path").join(__dirname, "..", "web", "demo-runs") + "/";
const strip = (e) => { const o = { ...e }; for (const k of ["seq", "t", "ts", "type"]) delete o[k]; return o; };
(async () => {
  const c = new Client({ host: "aws-0-ap-northeast-2.pooler.supabase.com", port: 5432, user: "postgres.vzvyghmtsakixlhzzuol", password: process.env.DBPW, database: "postgres", ssl: { rejectUnauthorized: false } });
  await c.connect();
  console.log("deleted test jobs:", (await c.query("delete from repro_jobs")).rowCount);
  const idx = JSON.parse(fs.readFileSync(dir + "index.json", "utf8"));
  const seen = new Set();
  for (const r of idx) {
    const m = String(r.paper || "").match(/^([0-9]{4}[.][0-9]{4,5})$/);
    if (!m || seen.has(m[1])) continue;               // one seed per arXiv paper
    const ev = {};
    for (const l of fs.readFileSync(dir + r.file, "utf8").split("\n")) {
      if (!l.trim()) continue; const e = JSON.parse(l);
      if (e.type === "contract" || e.type === "contract_full") ev.contract = { ...(ev.contract || {}), ...strip(e) };
      else if (e.type === "route") ev.route = strip(e); else if (e.type === "plan") ev.plan = strip(e);
    }
    if (!ev.contract || !ev.route || !ev.plan) { console.log("skip (incomplete)", m[1]); continue; }
    seen.add(m[1]);
    const j = await c.query("insert into repro_jobs (arxiv_id,title,lang,status,verdict,agent,created_at) values ($1,$2,'en','done',$3,'recorded-run-seed', now() - interval '7 days') returning id", [m[1], r.title, r.verdict]);
    for (const k of ["contract", "route", "plan"])
      await c.query("insert into repro_events (job_id,kind,agent,payload) values ($1,$2,'recorded-run-seed',$3::jsonb)", [j.rows[0].id, k, JSON.stringify(ev[k])]);
    await c.query("insert into repro_job_tokens (job_id, token) values ($1, encode(gen_random_bytes(18),'hex'))", [j.rows[0].id]);
    console.log("seeded", m[1], r.title.slice(0, 50), Object.keys(ev.contract).length, "contract keys");
  }
  await c.end();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
