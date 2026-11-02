// Pure formulas for the "Sell apyUSD" (exit) tab. No DOM, no network: imported by sell.js and by test/sell-math.test.mjs.
// All rates are fractions (0.025 = 2.5%), times are days.

export const DEFAULT_CURVE = { minFee: 0, maxFee: 0.025, tMin: 3, tMax: 20, k: 0.75 };
export const DEFAULT_VAULT_FEE = 0.001;

// UnlockReceipt claim fee rate after t days (FeeCurve.fee): maxFee until tMin, minFee from tMax, maxFee − Δ·tHat^k in between.
export function claimFee(c, t) {
  if (t >= c.tMax) return c.minFee;
  if (t <= c.tMin) return c.maxFee;
  const tHat = (t - c.tMin) / (c.tMax - c.tMin);
  return c.maxFee - (c.maxFee - c.minFee) * Math.pow(tHat, c.k);
}

// Fee cost of unlocking vs the gross redemption value (shares × convertToAssets):
// the vault charges u on top (escrow = gross / (1 + u)), the receipt keeps c(t) of the escrow at claim.
export const unlockFeeCost = (c, u, t) => 1 - (1 - claimFee(c, t)) / (1 + u);

// Yield given up by waiting t days instead of holding apyUSD (the share price compounds at `apy`; escrowed apxUSD earns nothing).
export const lostYield = (apy, t) => (apy <= -1 ? 0 : Math.pow(1 + apy, t / 365) - 1);

export const unlockCost = (c, u, apy, t) => unlockFeeCost(c, u, t) + lostYield(apy, t);

// DEX: total discount vs gross redemption value, and the part caused by the trade size.
export const dexCost = (apxOut, shares, grossRate) => 1 - apxOut / (shares * grossRate);
export const priceImpact = (sizePrice, spotPrice) => 1 - sizePrice / spotPrice;

// "If I exit on the DEX": apxUSD received now, left earning the opportunity-cost yield `oppApy` (same compounding as lostYield) for t days.
export const dexWithYield = (apxOut, oppApy, t) => apxOut * (1 + lostYield(oppApy, t));

// Day-t comparison in apxUSD-per-gross-value terms: unlock pays (1 − c(t))/(1 + u) − extraUnlock (e.g. gas);
// the DEX path is (1 − dex)·(1 + oppApy)^(t/365), oppApy = yield the DEX proceeds earn (opportunity cost; not the apyUSD APY,
// which only drives the unlock's lost yield and does not enter this terminal-value comparison). Positive = unlock ends up with more.
export const unlockVsDexReinvested = (c, u, oppApy, dex, t, extraUnlock = 0) =>
  (1 - unlockFeeCost(c, u, t) - extraUnlock) - (1 - dex) * (1 + lostYield(oppApy, t));

// One row per integer day from tMin to tMax. `apy` = apyUSD APY (lost yield); `oppApy` = yield on the DEX proceeds (defaults to `apy`).
export function schedule(c, u, apy, dex, value = 1, oppApy = apy) {
  const rows = [];
  for (let t = Math.ceil(c.tMin); t <= Math.floor(c.tMax); t++) {
    const fee = unlockFeeCost(c, u, t), ly = lostYield(apy, t), total = fee + ly;
    rows.push({
      t, claimFee: claimFee(c, t), fee, lostYield: ly, total,
      received: value * (1 - claimFee(c, t)) / (1 + u),
      costApx: value * total,
      vsDex: Number.isFinite(dex) ? total - dex : NaN,
      dexYield: Number.isFinite(dex) ? dexWithYield(value * (1 - dex), oppApy, t) : NaN,
      deltaReinv: Number.isFinite(dex) ? value * unlockVsDexReinvested(c, u, oppApy, dex, t) : NaN,
    });
  }
  return rows;
}

// Cheapest claim day on [tMin, tMax] (fine grid, then the integer day for display).
export function optimalDay(c, u, apy, step = 0.01) {
  let best = { t: c.tMin, cost: unlockCost(c, u, apy, c.tMin) };
  for (let t = c.tMin; t <= c.tMax + 1e-9; t += step) {
    const v = unlockCost(c, u, apy, t);
    if (v < best.cost - 1e-15) best = { t, cost: v };
  }
  let dayBest = null;
  for (let d = Math.ceil(c.tMin); d <= Math.floor(c.tMax); d++) {
    const v = unlockCost(c, u, apy, d);
    if (!dayBest || v < dayBest.cost - 1e-15) dayBest = { t: d, cost: v };
  }
  return { t: best.t, cost: best.cost, day: dayBest ? dayBest.t : null, dayCost: dayBest ? dayBest.cost : NaN };
}

// Days on which unlocking is cheaper than selling on the DEX.
// Returns { from, to } (fractional days; null when unlocking never beats the DEX), and `firstDay` (first integer day that beats it).
export function breakeven(c, u, apy, dex, step = 0.01) {
  if (!Number.isFinite(dex)) return crossing(null, c, step);
  return crossing((t) => unlockCost(c, u, apy, t) - dex, c, step);
}

// Same, but the DEX proceeds are assumed to earn `oppApy` until day t (terminal-value comparison, see unlockVsDexReinvested).
export function breakevenReinvested(c, u, oppApy, dex, extraUnlock = 0, step = 0.01) {
  if (!Number.isFinite(dex)) return crossing(null, c, step);
  return crossing((t) => -unlockVsDexReinvested(c, u, oppApy, dex, t, extraUnlock), c, step);
}

// g(t) <= 0 means unlocking wins on day t.
function crossing(g, c, step) {
  if (!g) return { from: null, to: null, firstDay: null, always: false, never: true };
  let from = null, to = null, prev = c.tMin;
  if (g(c.tMin) <= 0) from = c.tMin;
  for (let t = c.tMin + step; t <= c.tMax + 1e-9; t += step) {
    const a = g(prev), b = g(t);
    if (from === null && a > 0 && b <= 0) from = bisect(g, prev, t);
    if (from !== null && to === null && a <= 0 && b > 0) to = bisect(g, prev, t);
    prev = t;
  }
  if (from !== null && to === null) to = c.tMax;
  let firstDay = null;
  for (let d = Math.ceil(c.tMin); d <= Math.floor(c.tMax); d++) if (g(d) <= 0) { firstDay = d; break; }
  return { from, to, firstDay, always: from === c.tMin && to === c.tMax, never: from === null };
}

function bisect(g, lo, hi) {
  const up = g(lo) > 0;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if ((g(mid) > 0) === up) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

// Annualized compounding APY from two share prices `dtSeconds` apart.
export const apyFromSharePrice = (pNow, pThen, dtSeconds) => Math.pow(pNow / pThen, (365 * 86400) / dtSeconds) - 1;
