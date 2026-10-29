// Claim-timing analysis for apyUSD flexible unlocks.
// Model (docs.apyx.fi Unlocking + user-supplied current fee):
//   fee(t) = maxFee − (maxFee − minFee) · (t − tMin) / (tMax − tMin),  tMin ≤ t ≤ tMax
//   r(t)   = (1 − fee(t)) / (1 − d) − 1          (d = purchase discount to gross apxUSD redemption value)
//   APY(t) = (1 + r(t))^(365 / t) − 1            (same compounding convention as the base site)
const $ = (id) => document.getElementById(id);
const NAVY = "#14213d", BLUE = "#2b4bb3", GRID = "#dfe3ec", MUTED = "#5b6475";
const STEPS = 1200;

const state = { live: null, native: null };

function params() {
  const n = (id, fb) => { const v = parseFloat($(id).value); return Number.isFinite(v) ? v : fb; };
  let tMin = Math.max(0.1, n("pMinDays", 3));
  let tMax = Math.max(tMin + 0.1, n("pMaxDays", 20));
  let dMin = Math.max(0, n("pDMin", 1.5)) / 100;
  let dMax = Math.max(dMin + 0.001, n("pDMax", 4.5) / 100);
  return {
    d: Math.min(0.99, Math.max(0, n("pDiscount", 3) / 100)),
    pos: Math.max(0, n("pPosition", 10000)),
    maxFee: Math.max(0, n("pMaxFee", 2.6)) / 100,
    minFee: Math.max(0, n("pMinFee", 0.1)) / 100,
    tMin, tMax, dMin, dMax,
    alt: Math.max(0, n("pAltApr", 13.5)) / 100,
  };
}

const fee = (p, t) => p.maxFee - (p.maxFee - p.minFee) * (Math.min(Math.max(t, p.tMin), p.tMax) - p.tMin) / (p.tMax - p.tMin);
const ret = (p, d, t) => (1 - fee(p, t)) / (1 - d) - 1;
const apy = (r, t) => (r <= -1 ? -1 : Math.pow(1 + r, 365 / t) - 1);

function optimum(p, d) {
  let best = { t: p.tMax, r: ret(p, d, p.tMax) };
  best.apy = apy(best.r, best.t);
  for (let i = 0; i <= STEPS; i++) {
    const t = p.tMin + (p.tMax - p.tMin) * (i / STEPS);
    const r = ret(p, d, t), a = apy(r, t);
    if (a > best.apy + 1e-12) best = { t, r, apy: a };
  }
  return best;
}

function bisect(pred, lo = 0, hi = 0.6) {
  if (!pred(hi)) return NaN;
  if (pred(lo)) return lo;
  for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; pred(m) ? (hi = m) : (lo = m); }
  return hi;
}

const pct = (v, dg = 2) => (Number.isFinite(v) ? `${(v * 100).toFixed(dg)}%` : "--");
const usd = (v) => (Number.isFinite(v) ? `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "--");
const days = (t) => `${t.toFixed(1)} days`;
const trimPct = (v) => `${+(v * 100).toFixed(2)}%`;

function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || 1, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n) || 10 * mag;
  const out = []; for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + 1e-9; v += step) out.push(+v.toFixed(10));
  return out;
}

// Generic single-series SVG line chart
function lineChart(el, o) {
  const W = el.clientWidth || 880, H = o.height || 320;
  const m = { l: 56, r: o.rightFmt ? 76 : 24, t: 28, b: 34 };
  const iw = W - m.l - m.r, ih = H - m.t - m.b;
  const [x0, x1] = o.xDomain;
  let y0 = o.yDomain ? o.yDomain[0] : Math.min(...o.ys), y1 = o.yDomain ? o.yDomain[1] : Math.max(...o.ys);
  if (!o.yDomain) { const pad = (y1 - y0) * 0.12 || Math.abs(y1) * 0.1 || 1; y0 -= pad; y1 += pad; }
  const yt = o.yTicks || niceTicks(y0, y1, 5);
  if (!o.yDomain) { y0 = Math.min(y0, yt[0]); y1 = Math.max(y1, yt[yt.length - 1]); }
  const X = (x) => m.l + ((x - x0) / (x1 - x0)) * iw;
  const Y = (y) => m.t + (1 - (y - y0) / (y1 - y0)) * ih;
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="${o.label || "chart"}">`;
  for (const v of yt) {
    s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${GRID}"/>`;
    s += `<text x="${m.l - 10}" y="${Y(v) + 4}" text-anchor="end" class="tk">${o.yFmt(v)}</text>`;
    if (o.rightFmt) s += `<text x="${W - m.r + 10}" y="${Y(v) + 4}" class="tk">${o.rightFmt(v)}</text>`;
  }
  if (y0 < 0 && y1 > 0) s += `<line x1="${m.l}" x2="${W - m.r}" y1="${Y(0)}" y2="${Y(0)}" stroke="#9aa3b5"/>`;
  s += `<line x1="${m.l}" x2="${W - m.r}" y1="${m.t + ih}" y2="${m.t + ih}" stroke="#9aa3b5"/>`;
  for (const v of o.xTicks || niceTicks(x0, x1, 6)) {
    s += `<line x1="${X(v)}" x2="${X(v)}" y1="${m.t + ih}" y2="${m.t + ih + 5}" stroke="#9aa3b5"/>`;
    s += `<text x="${X(v)}" y="${m.t + ih + 20}" text-anchor="middle" class="tk">${o.xFmt(v)}</text>`;
  }
  if (Number.isFinite(o.marker) && o.marker >= x0 && o.marker <= x1)
    s += `<line x1="${X(o.marker)}" x2="${X(o.marker)}" y1="${m.t}" y2="${m.t + ih}" stroke="${MUTED}" stroke-dasharray="5 4"/>`;
  const cy = (y) => Math.min(Math.max(y, y0), y1);
  const d = o.xs.map((x, i) => `${i ? "L" : "M"}${X(x).toFixed(1)},${Y(cy(o.ys[i])).toFixed(1)}`).join("");
  s += `<path d="${d}" fill="none" stroke="${BLUE}" stroke-width="3" stroke-linejoin="round"/>`;
  for (const pt of o.points || []) {
    if (pt.x < x0 || pt.x > x1) continue;
    const px = X(pt.x), py = Y(cy(pt.y));
    s += `<circle cx="${px}" cy="${py}" r="${pt.big ? 6 : 4}" fill="${pt.big ? "#fff" : BLUE}" stroke="${BLUE}" stroke-width="${pt.big ? 3 : 0}"/>`;
    if (pt.label) {
      const right = px < m.l + iw * 0.8;
      const above = pt.below ? 22 : -10;
      s += `<text x="${px + (right ? 10 : -10)}" y="${py + above}" text-anchor="${right ? "start" : "end"}" class="pl">${pt.label}</text>`;
    }
  }
  s += `</svg>`;
  el.innerHTML = s;
}

function render() {
  const p = params();
  const sel = optimum(p, p.d);
  $("cpFeeTag").textContent = `FLEXIBLE UNLOCK · ${trimPct(p.maxFee)} → ${trimPct(p.minFee)} FEE · DAY ${+p.tMin.toFixed(1)}–${+p.tMax.toFixed(1)}`;

  // 1. Optimal claim time vs discount
  const N = 240, ds = [], ts = [];
  for (let i = 0; i <= N; i++) { const d = p.dMin + (p.dMax - p.dMin) * (i / N); ds.push(d); ts.push(optimum(p, d).t); }
  const eps = (p.tMax - p.tMin) / STEPS * 1.5;
  const dHigh = bisect((d) => optimum(p, d).t < p.tMax - eps);
  const dLow = bisect((d) => optimum(p, d).t <= p.tMin + eps);
  const labelPts = niceTicks(p.dMin, p.dMax, 6).filter((d) => d > p.dMin && d < p.dMax).map((d) => ({ x: d, y: optimum(p, d).t }));
  const tTicks = niceTicks(0, p.tMax, 4); if (!tTicks.includes(+p.tMin.toFixed(6))) tTicks.push(p.tMin);
  lineChart($("chartOptimal"), {
    label: "Optimal claim days vs discount", xs: ds, ys: ts, xDomain: [p.dMin, p.dMax], yDomain: [0, p.tMax * 1.08],
    yTicks: [...new Set(tTicks)].sort((a, b) => a - b), xFmt: (v) => `${(v * 100).toFixed(1)}%`, yFmt: (v) => `${+v.toFixed(1)}`,
    marker: p.d, height: 340,
    points: [...labelPts, { x: p.d, y: sel.t, big: true, label: days(sel.t) }],
  });
  $("sThrHigh").textContent = Number.isFinite(dHigh) ? `${pct(dHigh)} discount` : "none";
  $("sThrHighSub").textContent = `Below it, wait the full ${+p.tMax.toFixed(1)} days`;
  $("sThrLow").textContent = Number.isFinite(dLow) ? `${pct(dLow)} discount` : "none";
  $("sThrLowSub").textContent = `Above it, claim on day ${+p.tMin.toFixed(1)}`;
  $("sSelLabel").textContent = `At a ${trimPct(p.d)} discount`;
  $("sOptDays").textContent = days(sel.t);

  // Example cards
  const full = { t: p.tMax, r: ret(p, p.d, p.tMax) }; full.apy = apy(full.r, full.t);
  $("exTitle").textContent = `Example: buy at a ${trimPct(p.d)} discount`;
  $("exApy").textContent = `${pct(sel.apy, 1)} APY equivalent`;
  $("exApy").classList.toggle("neg", sel.r < 0);
  $("exRet").textContent = `${pct(sel.r)} trade return over ${sel.t.toFixed(1)} days · fee ${pct(fee(p, sel.t))}`;
  $("exUsd").textContent = usd(p.pos * sel.r);
  $("exUsd").classList.toggle("neg", sel.r < 0);
  $("exUsdSub").textContent = `on ${usd(p.pos)} if claimed on day ${sel.t.toFixed(1)}`;
  $("exFull").textContent = `Waiting the full ${+p.tMax.toFixed(1)} days: ${usd(p.pos * full.r)} (${pct(full.r)}, ${pct(full.apy, 1)} APY eq.)`;

  // 2/3. Return and APY vs claim day at selected discount
  const tx = [], rr = [], aa = [];
  for (let i = 0; i <= 200; i++) { const t = p.tMin + (p.tMax - p.tMin) * (i / 200); tx.push(t); const r = ret(p, p.d, t); rr.push(r); aa.push(apy(r, t)); }
  const dayTicks = niceTicks(p.tMin, p.tMax, 6).filter((t) => t >= p.tMin && t <= p.tMax);
  lineChart($("chartReturn"), {
    label: "Trade return vs claim day", xs: tx, ys: rr, xDomain: [p.tMin, p.tMax], xTicks: dayTicks,
    xFmt: (v) => `${+v.toFixed(1)}d`, yFmt: (v) => pct(v, 2), rightFmt: (v) => usd(v * p.pos).replace(".00", ""),
    height: 260, marker: sel.t,
    points: [{ x: sel.t, y: sel.r, big: true, label: `${pct(sel.r)} · ${usd(p.pos * sel.r)}` }, { x: p.tMax, y: full.r }],
  });
  const aMax = Math.max(...aa), aMin = Math.min(...aa);
  const capLo = Math.max(aMin, -1), padA = (aMax - capLo) * 0.15 || 0.05;
  lineChart($("chartApy"), {
    label: "APY vs claim day", xs: tx, ys: aa, xDomain: [p.tMin, p.tMax], xTicks: dayTicks,
    yDomain: [capLo - padA, aMax + padA], yTicks: niceTicks(capLo - padA, aMax + padA, 5),
    xFmt: (v) => `${+v.toFixed(1)}d`, yFmt: (v) => pct(v, 0), height: 260, marker: sel.t,
    points: [{ x: sel.t, y: sel.apy, big: true, label: `${pct(sel.apy, 1)} @ ${sel.t.toFixed(1)}d`, below: true }],
  });

  // 4. Profit vs discount at optimal claim
  const pr = ds.map((d) => optimum(p, d).r);
  lineChart($("chartProfit"), {
    label: "Profit vs discount", xs: ds, ys: pr, xDomain: [p.dMin, p.dMax],
    xFmt: (v) => `${(v * 100).toFixed(1)}%`, yFmt: (v) => pct(v, 1), rightFmt: (v) => usd(v * p.pos).replace(".00", ""),
    height: 300, marker: p.d,
    points: [...labelPts.map((q) => ({ x: q.x, y: optimum(p, q.x).r })), { x: p.d, y: sel.r, big: true, label: `${pct(sel.r)} · ${usd(p.pos * sel.r)}` }],
  });

  // Break-evens
  $("sBeMin").textContent = pct(p.maxFee);
  $("sBeMinSub").textContent = `Claim on day ${+p.tMin.toFixed(1)} pays the ${trimPct(p.maxFee)} max fee`;
  $("sBeMax").textContent = pct(p.minFee);
  $("sBeMaxSub").textContent = `Claim on day ${+p.tMax.toFixed(1)} pays the ${trimPct(p.minFee)} min fee`;
  const dAlt = bisect((d) => optimum(p, d).apy >= p.alt);
  const dAltFull = 1 - (1 - p.minFee) / Math.pow(1 + p.alt, p.tMax / 365);
  $("sBeAlt").textContent = pct(dAlt);
  $("sBeAltSub").textContent = `Best-case APY eq. ≥ ${trimPct(p.alt)} alternative`;
  $("cpNote").textContent = `This optimizes annualized trade return, not total profit or present value at a fixed ${trimPct(p.alt)} APR. Realizing the annualized rate requires comparable reinvestment opportunities after each claim. With only a ${trimPct(p.alt)} APR alternative, waiting the full ${+p.tMax.toFixed(1)} days maximizes total profit; its theoretical break-even discount is ${pct(dAltFull)}. Not a promised yield.`;
}

function sync(fromRange) {
  if (fromRange) $("pDiscount").value = (+$("pDiscountRange").value).toFixed(2);
  else $("pDiscountRange").value = $("pDiscount").value;
  render();
}

document.querySelectorAll("#cpForm input").forEach((el) => el.addEventListener("input", () => sync(el.id === "pDiscountRange")));
$("useLive").addEventListener("click", () => { if (state.live) { $("pDiscount").value = (state.live.discount * 100).toFixed(2); sync(false); } });
$("useNative").addEventListener("click", () => { if (Number.isFinite(state.native)) { $("pAltApr").value = state.native.toFixed(2); render(); } });
window.addEventListener("apyx:live", (e) => {
  state.live = e.detail; $("liveDiscount").textContent = pct(e.detail.discount); $("useLive").disabled = false;
  if (Number.isFinite(e.detail.nativeApy)) window.dispatchEvent(new CustomEvent("apyx:native", { detail: { nativeApy: e.detail.nativeApy } }));
});
window.addEventListener("apyx:native", (e) => { state.native = e.detail.nativeApy; $("liveNative").textContent = `${state.native.toFixed(2)}%`; $("useNative").disabled = false; });
let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(render, 120); });
render();
