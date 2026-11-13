// Changing plan in the middle of a period: pay only for what is new, the way subscriptions are usually billed.
//
//  - Same plan again (renew early): full price, and the new period is added after the current one ends, so no day is lost.
//  - A higher plan in the same kind of period (Plus month -> Pro month): the plan switches now and keeps the SAME end date.
//    The member pays (new price - old price) x (days left / days in the period), and gets the extra video credits for those days only.
//  - A higher plan in another kind of period (Pro month -> Premium year): the unused value of the old plan is taken off the new price,
//    and the new period starts now. The credits already given for the unused days are taken off the new plan's credits.
//  - A lower plan while a higher one is running: not sold; it can be bought after the current plan ends.

export type PlanKey = string;   // "plus_month" ...
export type PlanDef = { credits: number; price: number; days: number };
export type Money = "cny" | "vnd" | "idr";
const RANK: Record<string, number> = { plus: 1, pro: 2, premium: 3 };
const DAY = 86400_000;

export type Quote =
  | { kind: "full"; amount: number; credits: number; until: string | null }
  | { kind: "renew"; amount: number; credits: number; until: string }
  | { kind: "upgrade_same_end"; amount: number; credits: number; until: string; daysLeft: number; off: number }
  | { kind: "upgrade_new_period"; amount: number; credits: number; until: string; daysLeft: number; off: number }
  | { kind: "refused"; reason: string; until: string };

/** The money of a plan in one currency. `loc` holds the Vietnamese and Indonesian prices. */
export function priceIn(key: PlanKey, plans: Record<string, PlanDef>, loc: Record<string, { vnd: number; idr: number }>, cur: Money): number {
  return cur === "cny" || !loc[key] ? plans[key].price : loc[key][cur];
}
const roundTo = (x: number, cur: Money) => (cur === "cny" ? Math.round(x) : Math.round(x / 1000) * 1000);

/**
 * @param current the plan running now ({plan: "plus", until}) or null
 * @param want    the plan key being bought ("pro_month")
 * @param regular the full price of `want` in `cur` (the welcome offer, if any, is already in it)
 */
export function quote(now: number, current: { plan: string; until: string } | null, want: PlanKey, plans: Record<string, PlanDef>, loc: Record<string, { vnd: number; idr: number }>, cur: Money, regular: number): Quote {
  const [wantTier, wantPeriod] = want.split("_");
  const end = current ? Date.parse(current.until) : 0;
  if (!current || !(end > now) || !RANK[current.plan] || !RANK[wantTier]) return { kind: "full", amount: regular, credits: plans[want].credits, until: null };
  const daysLeft = (end - now) / DAY;
  // the kind of period the running plan was bought for: more than a month and a bit left means a year
  const curPeriod = daysLeft > 32 ? "year" : "month";
  const curKey = `${current.plan}_${curPeriod}`;
  if (!plans[curKey]) return { kind: "full", amount: regular, credits: plans[want].credits, until: null };
  const frac = Math.min(1, daysLeft / plans[curKey].days);
  if (RANK[wantTier] < RANK[current.plan]) return { kind: "refused", reason: "lower", until: current.until };
  if (RANK[wantTier] === RANK[current.plan]) {
    // early renewal of the same plan: the new period follows the current one
    return { kind: "renew", amount: regular, credits: plans[want].credits, until: new Date(end + plans[want].days * DAY).toISOString() };
  }
  const curPrice = priceIn(curKey, plans, loc, cur);
  if (wantPeriod === curPeriod) {
    const newFull = priceIn(want, plans, loc, cur);
    const amount = Math.max(roundTo((newFull - curPrice) * frac, cur), cur === "cny" ? 1 : 1000);
    const credits = Math.max(0, Math.round((plans[want].credits - plans[curKey].credits) * frac));
    return { kind: "upgrade_same_end", amount, credits, until: current.until, daysLeft: Math.ceil(daysLeft), off: Math.max(0, regular - amount) };
  }
  const unused = roundTo(curPrice * frac, cur);
  const amount = Math.max(regular - unused, cur === "cny" ? 1 : 1000);
  const credits = Math.max(0, plans[want].credits - Math.round(plans[curKey].credits * frac));
  return { kind: "upgrade_new_period", amount, credits, until: new Date(now + plans[want].days * DAY).toISOString(), daysLeft: Math.ceil(daysLeft), off: Math.max(0, regular - amount) };
}
