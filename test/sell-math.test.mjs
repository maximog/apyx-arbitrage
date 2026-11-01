import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_CURVE as C, claimFee, unlockFeeCost, lostYield, unlockCost, dexCost, priceImpact, schedule, optimalDay, breakeven, apyFromSharePrice, dexWithYield, unlockVsDexReinvested, breakevenReinvested } from "../public/sell-math.js";

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
