import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CURVE as C, claimFee, unlockFeeCost, lostYield, unlockCost, dexCost, priceImpact, schedule, optimalDay, breakeven, apyFromSharePrice, dexWithYield, unlockVsDexReinvested, breakevenReinvested, firstColTags, dexEquivalentCost } from "../public/sell-math.js";

const near = (a, b, eps = 1e-10) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const u = 0.001;

test("claim fee follows the on-chain curve", () => {
  near(claimFee(C, 0), 0.025);
  near(claimFee(C, 3), 0.025);
  near(claimFee(C, 20), 0);
  near(claimFee(C, 30), 0);
  near(claimFee(C, 11.5), 0.025 - 0.025 * Math.pow(0.5, 0.75));
});

test("unlock fee cost = 1 − (1 − c)/(1 + u)", () => {
  near(unlockFeeCost(C, u, 20), 1 - 1 / 1.001);
  near(unlockFeeCost(C, u, 3), 1 - 0.975 / 1.001);
  near(unlockFeeCost(C, 0, 3), 0.025);
});

test("lost yield compounds the APY over t days", () => {
  near(lostYield(0, 10), 0);
  near(lostYield(0.14, 365), 0.14);
  near(lostYield(0.14, 20), Math.pow(1.14, 20 / 365) - 1);
  assert.ok(lostYield(0.14, 20) < 0.14 * 20 / 365); // compounding < simple for t < 1y
  near(unlockCost(C, u, 0.14, 20), 1 - 1 / 1.001 + Math.pow(1.14, 20 / 365) - 1);
});

test("DEX cost and price impact", () => {
  near(dexCost(14270.94, 10000, 1.450965), 1 - 14270.94 / 14509.65);
  near(dexCost(1450.965, 1000, 1.450965), 0);
  near(priceImpact(1.427, 1.4272), 1 - 1.427 / 1.4272);
});

test("schedule rows (days 3..20) in apxUSD", () => {
  const rows = schedule(C, u, 0.14, 0.0164, 10000);
  assert.equal(rows.length, 18);
  assert.equal(rows[0].t, 3); assert.equal(rows.at(-1).t, 20);
  const r = rows.at(-1);
  near(r.received, 10000 / 1.001, 1e-6);
  near(r.costApx, 10000 * r.total, 1e-6);
  near(r.vsDex, r.total - 0.0164);
});

test("optimal day: day 20 at 14% APY, earlier at extreme APY", () => {
  const o = optimalDay(C, u, 0.14);
  near(o.t, 20, 1e-6); assert.equal(o.day, 20);
  assert.ok(optimalDay(C, u, 3).day < 20); // 300% APY: waiting costs more than the fee saved
});

test("breakeven vs DEX", () => {
  const dex = 0.0164;
  const b = breakeven(C, u, 0.14, dex);
  assert.ok(b.from > 3 && b.from < 20);
  near(unlockCost(C, u, 0.14, b.from), dex, 1e-9);
  assert.equal(b.to, 20);
  assert.equal(b.firstDay, Math.ceil(b.from));
  assert.equal(breakeven(C, u, 0.14, 0.001).never, true); // DEX cheaper than every unlock day
  assert.equal(breakeven(C, u, 0.14, 0.05).always, true); // unlock cheaper on every day
});

test("APY from share price", () => {
  near(apyFromSharePrice(1.14, 1, 365 * 86400), 0.14);
  near(apyFromSharePrice(1, 1, 86400), 0);
});

test("DEX + yield: proceeds compound at the lost-yield APY", () => {
  near(dexWithYield(14000, 0.14, 0), 14000);
  near(dexWithYield(14000, 0.14, 365), 14000 * 1.14, 1e-8);
  near(dexWithYield(14000, 0.14, 10), 14000 * (1 + lostYield(0.14, 10)), 1e-9);
  near(dexWithYield(14000, 0.14, 20), 14000 * Math.pow(1.14, 20 / 365), 1e-9);
  // Δ = unlock net − DEX with yield, per unit of gross value
  const dex = 0.0164, t = 10;
  near(unlockVsDexReinvested(C, u, 0.14, dex, t), (1 - claimFee(C, t)) / (1 + u) - (1 - dex) * Math.pow(1.14, t / 365));
  // with no yield the reinvested comparison equals the plain cost comparison
  near(unlockVsDexReinvested(C, u, 0, dex, t), dex - unlockCost(C, u, 0, t));
  const r = schedule(C, u, 0.14, dex, 10000).find((x) => x.t === 20);
  near(r.dexYield, 10000 * (1 - dex) * Math.pow(1.14, 20 / 365), 1e-8);
  near(r.deltaReinv, r.received - r.dexYield, 1e-8);
});

test("breakeven with DEX proceeds reinvested", () => {
  const dex = 0.0164, b0 = breakeven(C, u, 0.14, dex), b = breakevenReinvested(C, u, 0.14, dex);
  near(unlockVsDexReinvested(C, u, 0.14, dex, b.from), 0, 1e-9);
  assert.ok(b.from <= b0.from); // the yield is earned on the smaller DEX proceeds (1 − dex), so the unlock wins slightly earlier
  assert.ok(b0.from - b.from < 0.5);
  assert.equal(b.to, 20);
  near(breakevenReinvested(C, u, 0, dex).from, breakeven(C, u, 0, dex).from, 1e-6); // identical without yield
  assert.equal(breakevenReinvested(C, u, 0.14, 0.001).never, true);
  assert.equal(breakevenReinvested(C, u, 0.14, 0.05).always, true);
});

test("opportunity yield drives DEX + yield and vs DEX, not the lost yield", () => {
  const dex = 0.0164, base = schedule(C, u, 0.14, dex, 10000), opp8 = schedule(C, u, 0.14, dex, 10000, 0.08);
  // default oppApy = apy: identical to the single-APY schedule
  assert.deepEqual(schedule(C, u, 0.14, dex, 10000, 0.14), base);
  for (let i = 0; i < base.length; i++) {
    const a = base[i], b = opp8[i];
    near(b.lostYield, a.lostYield); near(b.total, a.total); near(b.costApx, a.costApx); near(b.received, a.received); near(b.vsDex, a.vsDex);
    near(b.dexYield, 10000 * (1 - dex) * Math.pow(1.08, a.t / 365), 1e-8);
    assert.ok(b.dexYield < a.dexYield);
    near(b.deltaReinv, b.received - b.dexYield, 1e-8);
    assert.ok(b.deltaReinv > a.deltaReinv); // a lower opportunity yield makes the unlock relatively better
  }
  // the reinvested breakeven moves with the opportunity yield; the cost breakeven and optimal day do not depend on it
  assert.ok(breakevenReinvested(C, u, 0.08, dex).from < breakevenReinvested(C, u, 0.14, dex).from);
});

test("apyUSD APY drives the lost yield, not DEX + yield or vs DEX", () => {
  const dex = 0.0164, a = schedule(C, u, 0.14, dex, 10000, 0.08), b = schedule(C, u, 0.25, dex, 10000, 0.08);
  for (let i = 0; i < a.length; i++) {
    near(a[i].dexYield, b[i].dexYield); near(a[i].deltaReinv, b[i].deltaReinv);
    assert.ok(b[i].lostYield > a[i].lostYield);
    near(b[i].lostYield, lostYield(0.25, b[i].t));
  }
});

test("single breakeven: 'unlock ahead' tag in the first column on the right day, moves with the opportunity yield", () => {
  const dex = 0.0164;
  for (const opp of [0, 0.08, 0.14, 0.30]) {
    const b = breakevenReinvested(C, u, opp, dex);
    const rows = schedule(C, u, 0.14, dex, 10000, opp);
    const first = rows.find((r) => r.deltaReinv >= 0);
    assert.equal(b.firstDay, first ? first.t : null); // tag day = first row where unlock ≥ DEX + yield
    if (first) assert.ok(rows.find((r) => r.t === first.t - 1)?.deltaReinv < 0 || first.t === C.tMin);
    for (const r of rows) {
      const tags = firstColTags(r.t, 20, b.firstDay).map((g) => g.text);
      assert.equal(tags.includes("unlock ahead"), r.t === b.firstDay);
      assert.ok(!tags.includes("breakeven")); // the old cost-based tag no longer exists
    }
  }
  const days = [0, 0.08, 0.14, 0.30].map((o) => breakevenReinvested(C, u, o, dex).firstDay);
  assert.deepEqual(days, [...days].sort((a, b) => a - b)); // higher opportunity yield → later (or equal) unlock-ahead day
  assert.ok(days[0] < days[3]);
  // independent of the apyUSD APY
  assert.deepEqual(schedule(C, u, 0.05, dex, 1, 0.08).map((r) => r.deltaReinv >= 0), schedule(C, u, 0.30, dex, 1, 0.08).map((r) => r.deltaReinv >= 0));
  assert.deepEqual(firstColTags(20, 20, null).map((g) => g.text), ["optimal"]);
});

test("chart DEX threshold crosses the unlock-total curve exactly at the unlock-ahead day", () => {
  const dex = 0.0164;
  for (const [apy, opp] of [[0.14, 0.14], [0.14, 0.08], [0.05, 0.30], [0.30, 0]]) {
    const b = breakevenReinvested(C, u, opp, dex);
    if (b.never || b.always) continue;
    near(unlockCost(C, u, apy, b.from), dexEquivalentCost(apy, opp, dex, b.from), 1e-9);
  }
  near(dexEquivalentCost(0.14, 0.14, dex, 0), dex);
});
