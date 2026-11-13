import { quote, type PlanDef } from "./proration.ts";
const PLANS: Record<string, PlanDef> = {
  plus_month: { credits: 20, price: 29, days: 31 }, plus_year: { credits: 240, price: 290, days: 366 },
  pro_month: { credits: 40, price: 55, days: 31 }, pro_year: { credits: 480, price: 550, days: 366 },
  premium_month: { credits: 80, price: 99, days: 31 }, premium_year: { credits: 960, price: 990, days: 366 },
};
const LOC = { plus_month: { vnd: 79000, idr: 69000 }, pro_month: { vnd: 149000, idr: 129000 }, premium_month: { vnd: 269000, idr: 239000 } };
const now = Date.parse("2026-11-13T00:00:00Z");
const inDays = (d: number) => new Date(now + d * 86400_000).toISOString();
const eq = (a: unknown, b: unknown, m = "") => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m} ${JSON.stringify(a)} != ${JSON.stringify(b)}`); };

Deno.test("no plan: full price", () => { eq(quote(now, null, "pro_month", PLANS, LOC, "cny", 55).kind, "full"); });
Deno.test("expired plan: full price", () => { eq(quote(now, { plan: "plus", until: inDays(-1) }, "pro_month", PLANS, LOC, "cny", 55).kind, "full"); });
Deno.test("Plus -> Pro, 15.5 of 31 days left: half of the difference, same end date", () => {
  const q = quote(now, { plan: "plus", until: inDays(15.5) }, "pro_month", PLANS, LOC, "cny", 55);
  if (q.kind !== "upgrade_same_end") throw new Error(q.kind);
  eq(q.amount, 13, "amount");   // (55-29) x 0.5
  eq(q.credits, 10, "credits"); // (40-20) x 0.5
  eq(q.until, inDays(15.5), "until");
});
Deno.test("Pro -> Premium, 15 days left, in VND", () => {
  const q = quote(now, { plan: "pro", until: inDays(15) }, "premium_month", PLANS, LOC, "vnd", 269000);
  if (q.kind !== "upgrade_same_end") throw new Error(q.kind);
  eq(q.amount, 58000, "amount");   // (269000-149000) x 15/31 = 58064 -> 58000
});
Deno.test("Pro -> Premium, 10 days left", () => {
  const q = quote(now, { plan: "pro", until: inDays(10) }, "premium_month", PLANS, LOC, "cny", 99);
  if (q.kind !== "upgrade_same_end") throw new Error(q.kind);
  eq(q.amount, 14, "amount");   // 44 x 10/31 = 14.19
  eq(q.credits, 13, "credits"); // 40 x 10/31 = 12.9
});
Deno.test("same plan early: renew after the end, no day lost", () => {
  const q = quote(now, { plan: "pro", until: inDays(10) }, "pro_month", PLANS, LOC, "cny", 55);
  if (q.kind !== "renew") throw new Error(q.kind);
  eq(q.amount, 55); eq(q.until, inDays(41));
});
Deno.test("lower plan while a higher one runs: refused", () => { eq(quote(now, { plan: "premium", until: inDays(10) }, "plus_month", PLANS, LOC, "cny", 29).kind, "refused"); });
Deno.test("Plus month -> Pro year: unused Plus value comes off, new year starts now", () => {
  const q = quote(now, { plan: "plus", until: inDays(15.5) }, "pro_year", PLANS, LOC, "cny", 550);
  if (q.kind !== "upgrade_new_period") throw new Error(q.kind);
  eq(q.amount, 535, "amount");   // unused Plus value 29 x 0.5 = 14.5 rounds to 15; 550 - 15
});
