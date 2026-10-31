// "Sell apyUSD" tab: cost of exiting apyUSD → apxUSD on a DEX now vs unlocking and claiming on day 3..20.
import { DEFAULT_CURVE, DEFAULT_VAULT_FEE, unlockFeeCost, unlockCost, dexCost, priceImpact, schedule, optimalDay, breakeven, apyFromSharePrice } from "./sell-math.js";

const $ = (id) => document.getElementById(id);
const APX = "0x98A878b1Cd98131B271883B390f68D2c90674665";
const APY_TOKEN = "0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A"; // apyUSD vault (ERC-4626 shares)
const RECEIPT = "0x9bf51F33955EC70f87C4b5C49441815589043237";
const RPCS = [
  "https://ethereum-rpc.publicnode.com/2376b275d18176b907569c0db67d2918a323d0b2a598dd1dee4fd49d2e4865ce",
  "https://eth.drpc.org",
  "https://ethereum-rpc.publicnode.com",
];
const KYBER_URL = "https://aggregator-api.kyberswap.com/ethereum/api/v1/routes";
const DEXSCREENER_URL = `https://api.dexscreener.com/latest/dex/tokens/${APY_TOKEN}`;
const QUOTE_TO = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const REFRESH_MS = 30_000, DEBOUNCE_MS = 400, CHAIN_TTL_MS = 60_000, APY_TTL_MS = 10 * 60_000;
const SPOT_SIZE = 100; // apyUSD used for the reference (spot) quote
const APY_WINDOW_S = 7 * 86400;
const UNLOCK_GAS = 370_000; // measured on-chain: vault unlock request ≈ 250k + receipt claim ≈ 110–120k
const NAVY = "#14213d", BLUE = "#2b4bb3", GRID = "#dfe3ec", MUTED = "#5b6475", RED = "#b4232c";

const wad = (n) => "0x" + (BigInt(Math.round(n)) * 10n ** 18n).toString(16).padStart(64, "0");
const toUnits = (amount) => {
  const [i, f = ""] = String(amount).split(".");
  return (BigInt(i || "0") * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18) || "0")).toString();
};
const fromWad = (hex, i = 0) => Number(BigInt("0x" + hex.slice(2 + 64 * i, 2 + 64 * (i + 1)))) / 1e18;
const word = (hex, i) => BigInt("0x" + hex.slice(2 + 64 * i, 2 + 64 * (i + 1)));

// ---------- formatting ----------
const pct = (v, dg = 2) => (Number.isFinite(v) ? `${v < 0 ? "−" : ""}${Math.abs(v * 100).toFixed(dg)}%` : "--");
const num = (v, dg = 2) => (Number.isFinite(v) ? `${v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: dg, maximumFractionDigits: dg })}` : "--");
const usd = (v) => (Number.isFinite(v) ? `${v < 0 ? "−" : ""}$${num(Math.abs(v))}` : "--");
const dayStr = (t) => (Number.isFinite(t) ? `${+t.toFixed(1)}` : "--");
const time = (d) => d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });

// ---------- network ----------
async function rpc(method, params) {
  let last;
  for (const url of RPCS) {
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const j = await res.json();
      if (j.result !== undefined && j.result !== null && j.result !== "0x") return j.result;
      last = new Error(j.error ? j.error.message : "empty result");
    } catch (e) { last = e; }
  }
  throw last || new Error("RPC failed");
}
const call = (to, data, block = "latest") => rpc("eth_call", [{ to, data }, block]);

let chainCache = null, apyCache = null;
async function loadChain() {
  if (chainCache && Date.now() - chainCache.at < CHAIN_TTL_MS) return chainCache;
  const [c2a, pr, uf, fc] = await Promise.all([
    call(APY_TOKEN, "0x07a2d13a" + wad(1).slice(2)), // convertToAssets(1e18): gross share price
    call(APY_TOKEN, "0x4cdad506" + wad(1).slice(2)), // previewRedeem(1e18): escrow per share (net of vault fee)
    call(APY_TOKEN, "0xceacd9d9"), // unlockingFee()
    call(RECEIPT, "0x856695ea").catch(() => null), // feeCurve()
  ]);
  const curve = fc ? { minFee: fromWad(fc, 0), maxFee: fromWad(fc, 1), tMin: Number(word(fc, 2)) / 86400, tMax: Number(word(fc, 3)) / 86400, k: fromWad(fc, 4) } : { ...DEFAULT_CURVE };
  chainCache = { at: Date.now(), gross: fromWad(c2a), net: fromWad(pr), u: fromWad(uf), curve, curveLive: !!fc };
  return chainCache;
}

async function loadApy() {
  if (apyCache && Date.now() - apyCache.at < APY_TTL_MS) return apyCache;
  const latestHex = await rpc("eth_blockNumber", []);
  const latest = parseInt(latestHex, 16);
  const block = async (n) => parseInt((await rpc("eth_getBlockByNumber", ["0x" + n.toString(16), false])).timestamp, 16);
  const price = (n) => call(APY_TOKEN, "0x07a2d13a" + wad(1).slice(2), "0x" + n.toString(16)).then((h) => fromWad(h));
  const tNow = await block(latest), pNow = await price(latest);
  for (const win of [APY_WINDOW_S, 86400]) {
    try {
      const past = latest - Math.round(win / 12);
      const [tThen, pThen] = await Promise.all([block(past), price(past)]);
      const apy = apyFromSharePrice(pNow, pThen, tNow - tThen);
      if (Number.isFinite(apy) && apy > -0.5 && apy < 5) {
        apyCache = { at: Date.now(), apy, label: win >= APY_WINDOW_S ? "7d" : "24h", source: `on-chain share price, ${win >= APY_WINDOW_S ? "7d" : "24h"}` };
        return apyCache;
      }
    } catch {}
  }
  throw new Error("APY unavailable");
}

async function kyberQuote(amount) {
  const url = new URL(KYBER_URL);
  url.searchParams.set("tokenIn", APY_TOKEN);
  url.searchParams.set("tokenOut", APX);
  url.searchParams.set("amountIn", toUnits(amount));
  url.searchParams.set("to", QUOTE_TO);
  const res = await fetch(url, { headers: { accept: "application/json", "x-client-id": "apyx-static-arb" } });
  if (!res.ok) throw new Error(`KyberSwap ${res.status}`);
  const s = (await res.json())?.data?.routeSummary;
  if (!s?.amountOut) throw new Error("KyberSwap: no route");
  const out = Number(BigInt(s.amountOut)) / 1e18;
  const gasUsd = Number(s.gasUsd), gas = Number(s.gas), gasPrice = Number(s.gasPrice);
  const ethUsd = gas > 0 && gasPrice > 0 ? gasUsd / ((gas * gasPrice) / 1e18) : NaN;
  return { out, price: out / amount, gasUsd, gasPrice, ethUsd };
}

async function dexScreenerSpot() {
  const res = await fetch(DEXSCREENER_URL, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`DexScreener ${res.status}`);
  const pairs = ((await res.json()).pairs || []).filter((p) => p.chainId === "ethereum" && p.baseToken?.address?.toLowerCase() === APY_TOKEN.toLowerCase() && p.quoteToken?.address?.toLowerCase() === APX.toLowerCase());
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const p = pairs[0];
  const price = p ? Number(p.priceNative) : NaN;
  if (!Number.isFinite(price) || price <= 0) throw new Error("DexScreener: no apyUSD/apxUSD pair");
  return { price, dex: p.dexId, liq: p.liquidity?.usd };
}

async function loadDex(amount) {
  try {
    const [size, spot] = await Promise.all([kyberQuote(amount), amount > SPOT_SIZE ? kyberQuote(SPOT_SIZE) : null]);
    const ref = spot || size;
    return { source: "KyberSwap", out: size.out, price: size.price, spot: ref.price, spotNote: `KyberSwap ${Math.min(amount, SPOT_SIZE)} apyUSD quote`, impact: priceImpact(size.price, ref.price), gasUsd: size.gasUsd, gasPrice: size.gasPrice, ethUsd: size.ethUsd };
  } catch (e) {
    const s = await dexScreenerSpot();
    return { source: `DexScreener (${s.dex})`, out: amount * s.price, price: s.price, spot: s.price, spotNote: "DexScreener pool price", impact: NaN, gasUsd: NaN, fallback: e.message };
  }
}

// ---------- state ----------
const state = { amount: 10000, chain: null, apy: null, dex: null, updated: null, error: null, dexTouched: false, apyTouched: false };
let reqId = 0, loading = false, started = false;

function readAmount() {
  const v = Number(String($("sellAmount").value || "").replace(/,/g, ""));
  return Number.isFinite(v) && v > 0 ? v : NaN;
}

async function refresh() {
  const amount = readAmount();
  if (!Number.isFinite(amount)) { $("sDexDetail").textContent = "Enter a valid apyUSD amount."; return; }
  const id = ++reqId;
  loading = true; $("sellPanel").classList.add("updating"); $("sellButton").disabled = true;
  try {
    const [chain, apy, dex] = await Promise.allSettled([loadChain(), loadApy(), loadDex(amount)]);
    if (id !== reqId) return;
    if (chain.status === "fulfilled") state.chain = chain.value;
    if (apy.status === "fulfilled") state.apy = apy.value;
    if (dex.status === "fulfilled") { state.dex = { ...dex.value, amount }; state.updated = new Date(); }
    state.error = [chain, apy, dex].filter((r) => r.status === "rejected").map((r) => r.reason?.message || String(r.reason)).join(" · ") || null;
    state.amount = amount;
  } finally {
    if (id === reqId) { loading = false; $("sellPanel").classList.remove("updating"); $("sellButton").disabled = false; render(); }
  }
}

// ---------- model ----------
function model() {
  const ch = state.chain;
  const curve = ch ? ch.curve : DEFAULT_CURVE;
  const u = ch ? ch.u : DEFAULT_VAULT_FEE;
  const amount = Number.isFinite(readAmount()) ? readAmount() : state.amount;
  const gross = ch ? ch.gross : NaN;
  const value = amount * gross; // gross redemption value in apxUSD
  const d = state.dex && state.dex.amount === amount ? state.dex : null;
  const liveDex = d && Number.isFinite(gross) ? dexCost(d.out, amount, gross) : NaN;
  const liveApy = state.apy ? state.apy.apy : NaN;
  const inDex = parseFloat($("sDexInput").value), inApy = parseFloat($("sApyInput").value);
  const dexBase = state.dexTouched && Number.isFinite(inDex) ? inDex / 100 : liveDex;
  const apy = state.apyTouched && Number.isFinite(inApy) ? inApy / 100 : liveApy;
  const gasOn = $("sGasToggle").checked;
  const dexGas = d && Number.isFinite(d.gasUsd) ? d.gasUsd : NaN;
  const unlockGas = d && Number.isFinite(d.gasPrice) && Number.isFinite(d.ethUsd) ? (UNLOCK_GAS * d.gasPrice / 1e18) * d.ethUsd : NaN;
  const gasDex = gasOn && Number.isFinite(dexGas) && value > 0 ? dexGas / value : 0;
  const gasUnlock = gasOn && Number.isFinite(unlockGas) && value > 0 ? unlockGas / value : 0;
  const dex = Number.isFinite(dexBase) ? dexBase + gasDex : NaN;
  const apyEff = Number.isFinite(apy) ? apy : 0;
  const cost = (t) => unlockCost(curve, u, apyEff, t) + gasUnlock;
  const rows = schedule(curve, u, apyEff, dex - gasUnlock, value).map((r) => ({ ...r, total: r.total + gasUnlock, costApx: value * (r.total + gasUnlock) }));
  const opt = optimalDay(curve, u, apyEff);
  const be = breakeven(curve, u, apyEff, dex - gasUnlock);
  return { curve, u, amount, gross, value, d, liveDex, liveApy, dexBase, dex, apy, apyEff, gasOn, dexGas, unlockGas, gasUnlock, cost, rows, opt, be };
}

// ---------- render ----------
function setHint(id, live) { const h = $(id); h.textContent = live ? "live" : "manual"; h.classList.toggle("off", !live); }

function render() {
  const m = model();
  const ch = state.chain, d = m.d;
  $("sellValue").textContent = Number.isFinite(m.value) ? `≈ ${num(m.value, 0)} apxUSD` : "--";

  // live / manual inputs
  if (!state.dexTouched) $("sDexInput").value = Number.isFinite(m.liveDex) ? (m.liveDex * 100).toFixed(3) : "";
  if (!state.apyTouched) $("sApyInput").value = Number.isFinite(m.liveApy) ? (m.liveApy * 100).toFixed(2) : "";
  setHint("sDexHint", !state.dexTouched); setHint("sApyHint", !state.apyTouched);
  $("sLiveDex").textContent = pct(m.liveDex, 3); $("sUseDex").disabled = !Number.isFinite(m.liveDex);
  $("sLiveApy").textContent = Number.isFinite(m.liveApy) ? `${pct(m.liveApy)} (${state.apy.label})` : "--"; $("sUseApy").disabled = !Number.isFinite(m.liveApy);
  $("sGasHint").textContent = Number.isFinite(m.dexGas) ? `swap ${usd(m.dexGas)} · unlock ${usd(m.unlockGas)}` : "n/a";
  $("sGasHint").classList.toggle("off", !m.gasOn);

  // DEX hero
  const hero = $("sellHero");
  hero.classList.toggle("error", !d && !!state.error);
  $("sDexCost").textContent = pct(m.liveDex, 3);
  if (d && ch) {
    $("sDexRows").hidden = false;
    $("sDexDetail").textContent = `Selling ${num(m.amount)} apyUSD on the DEX loses ${num(m.value - d.out)} apxUSD vs the gross redemption value.` + (d.fallback ? ` KyberSwap unavailable (${d.fallback}); spot price, no price impact.` : "");
    $("sOut").textContent = num(d.out); $("sGross").textContent = num(m.value);
    $("sPx").textContent = d.price.toFixed(6); $("sSpot").textContent = d.spot.toFixed(6); $("sSpotNote").textContent = d.spotNote;
    $("sSpotDisc").textContent = pct(1 - d.spot / m.gross, 3); $("sImpact").textContent = Number.isFinite(d.impact) ? pct(d.impact, 3) : "n/a";
    $("sRate").textContent = m.gross.toFixed(6); $("sGas").textContent = Number.isFinite(d.gasUsd) ? usd(d.gasUsd) : "n/a";
    $("sSource").textContent = d.source; $("sUpdated").textContent = state.updated ? time(state.updated) : "--";
  } else if (state.error && !loading) {
    $("sDexDetail").textContent = `Live data unavailable: ${state.error}`;
  }

  // chain status
  const c = m.curve;
  $("sChainStatus").textContent = ch
    ? `On-chain: share price ${ch.gross.toFixed(6)} apxUSD (previewRedeem ${ch.net.toFixed(6)} net of the ${pct(ch.u, 2)} vault fee) · claim fee ${pct(c.maxFee)} → ${pct(c.minFee)} between day ${dayStr(c.tMin)} and ${dayStr(c.tMax)}, k = ${+c.k.toFixed(3)}${ch.curveLive ? "" : " (fallback curve)"} · APY ${state.apy ? `${pct(state.apy.apy)} (${state.apy.source})` : "loading…"}`
    : (state.error ? `On-chain data unavailable (${state.error}); using fallback fee curve.` : "On-chain data: loading…");
  $("sFeeTag").textContent = `UNLOCK ${dayStr(c.tMin)}–${dayStr(c.tMax)} DAYS`;

  const ready = Number.isFinite(m.value);
  const V = (x) => (ready ? m.value * x : NaN);
  const first = m.rows[0], optRow = m.rows.find((r) => r.t === m.opt.day) || m.rows.at(-1);
  // cards
  $("cDex").textContent = pct(m.dex); $("cDex").className = "neg";
  $("cDexSub").textContent = ready && Number.isFinite(m.dex) ? `${usd(V(m.dex))} · receive now` : "--";
  $("cOptLabel").textContent = `Unlock, optimal day (${optRow ? optRow.t : "--"})`;
  $("cOpt").textContent = optRow ? pct(optRow.total) : "--";
  $("cOptSub").textContent = optRow && ready ? `${usd(optRow.costApx)} · fees ${pct(optRow.fee)} + yield ${pct(optRow.lostYield)}` : "--";
  document.querySelector("#cFirst").previousElementSibling.textContent = `Unlock, earliest claim (day ${first ? first.t : "--"})`;
  $("cFirst").textContent = first ? pct(first.total) : "--";
  $("cFirstSub").textContent = first && ready ? `${usd(first.costApx)} · fees ${pct(first.fee)} + yield ${pct(first.lostYield)}` : "--";
  const be = m.be;
  $("cBe").textContent = !Number.isFinite(m.dex) ? "--" : be.never ? "never" : be.always ? `day ${dayStr(c.tMin)}` : `day ${dayStr(be.from)}`;
  $("cBeSub").textContent = !Number.isFinite(m.dex) ? "--" : be.never ? "DEX is cheaper on every claim day" : be.always ? "Unlock beats the DEX on every claim day" : `Unlock is cheaper from day ${be.firstDay}${be.to < c.tMax - 1e-6 ? ` to day ${dayStr(be.to)}` : " onward"}`;

  // recommendation
  const dexWins = Number.isFinite(m.dex) && optRow && m.dex <= optRow.total;
  $("sBest").textContent = !Number.isFinite(m.dex) || !optRow ? "--" : dexWins ? "DEX now" : `Unlock day ${optRow.t}`;
  $("sBest").classList.toggle("dex", !!dexWins);
  $("sBestSub").textContent = !Number.isFinite(m.dex) || !optRow ? "--" : dexWins ? `costs ${pct(m.dex)} · ${usd(V(m.dex))}` : `costs ${pct(optRow.total)} · ${usd(optRow.costApx)}`;
  $("sRec").textContent = Number.isFinite(m.dex) && optRow && ready
    ? `Sell on DEX: ${pct(m.dex)} (${usd(V(m.dex))}) vs Unlock day ${optRow.t}: ${pct(optRow.total)} (${usd(optRow.costApx)})`
    : (state.error && !loading ? `Live data unavailable: ${state.error}` : "Loading live DEX quote and on-chain data…");
  $("sBe").textContent = $("cBe").textContent;
  $("sOpt").textContent = optRow ? `day ${optRow.t}` : "--";
  $("sSave").textContent = Number.isFinite(m.dex) && optRow && ready ? `${pct(Math.abs(m.dex - optRow.total))} · ${usd(Math.abs(V(m.dex) - optRow.costApx))}` : "--";
  $("sRecNote").textContent = `Costs vs the gross redemption value (apyUSD × share price). Unlock = ${pct(m.u)} vault fee + claim fee + yield lost at ${Number.isFinite(m.apy) ? pct(m.apy) : "--"} APY${state.apyTouched ? " (manual)" : ""}${state.dexTouched ? "; DEX discount is manual" : ""}${m.gasOn ? "; gas included" : "; gas excluded"}. apxUSD ≈ $1.`;

  renderTable(m);
  renderChart(m);
}

function renderTable(m) {
  const be = m.be;
  $("sRows").innerHTML = m.rows.map((r) => {
    const tags = (r.t === m.opt.day ? '<span class="tag">optimal</span>' : "") + (be.firstDay === r.t ? '<span class="tag be">breakeven</span>' : "");
    const vs = Number.isFinite(m.dex) ? r.total - m.dex : NaN;
    const cls = Number.isFinite(vs) ? (vs <= 0 ? "gain" : "loss") : "";
    return `<tr class="${cls}${r.t === m.opt.day ? " opt" : ""}"><td>Day ${r.t}${tags}</td><td>${pct(r.claimFee, 3)}</td><td>${pct(r.fee, 3)}</td><td>${pct(r.lostYield, 3)}</td><td>${pct(r.total, 3)}</td><td>${num(r.costApx)}</td><td>${num(r.received)}</td><td class="v">${Number.isFinite(vs) ? `${vs > 0 ? "+" : ""}${pct(vs, 3)}` : "--"}</td></tr>`;
  }).join("");
}

function niceTicks(lo, hi, n = 5) {
  const span = hi - lo || 1, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((s) => s * mag).find((s) => span / s <= n) || 10 * mag;
  const out = []; for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) out.push(+v.toFixed(12));
  return out;
}

function renderChart(m) {
  const el = $("sChart");
  if (!el || el.offsetParent === null) return; // hidden tab: re-rendered on activation
  const W = el.clientWidth || 880, H = W < 520 ? 260 : 320;
  const mg = { l: 54, r: Number.isFinite(m.value) ? (W < 520 ? 62 : 80) : 20, t: 24, b: 34 };
  const iw = W - mg.l - mg.r, ih = H - mg.t - mg.b, c = m.curve;
  const xs = []; for (let t = c.tMin; t <= c.tMax + 1e-9; t += (c.tMax - c.tMin) / 300) xs.push(t);
  const tot = xs.map((t) => m.cost(t)), feeOnly = xs.map((t) => unlockFeeCost(c, m.u, t) + m.gasUnlock);
  const all = [...tot, ...feeOnly, 0]; if (Number.isFinite(m.dex)) all.push(m.dex);
  let y0 = Math.min(...all), y1 = Math.max(...all); const pad = (y1 - y0) * 0.1 || 0.001; y1 += pad; y0 = Math.max(y0 - pad, Math.min(0, y0));
  const yt = niceTicks(y0, y1, 6); y0 = Math.min(y0, yt[0]); y1 = Math.max(y1, yt.at(-1));
  const X = (x) => mg.l + ((x - c.tMin) / (c.tMax - c.tMin)) * iw, Y = (y) => mg.t + (1 - (y - y0) / (y1 - y0)) * ih;
  const path = (ys) => xs.map((x, i) => `${i ? "L" : "M"}${X(x).toFixed(1)},${Y(ys[i]).toFixed(1)}`).join("");
  let s = `<svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" role="img" aria-label="Exit cost by claim day">`;
  for (const v of yt) {
    s += `<line x1="${mg.l}" x2="${W - mg.r}" y1="${Y(v)}" y2="${Y(v)}" stroke="${GRID}"/><text x="${mg.l - 8}" y="${Y(v) + 4}" text-anchor="end" class="tk">${+(v * 100).toFixed(2)}%</text>`;
    if (Number.isFinite(m.value)) s += `<text x="${W - mg.r + 8}" y="${Y(v) + 4}" class="tk">$${Math.round(v * m.value).toLocaleString("en-US")}</text>`;
  }
  s += `<line x1="${mg.l}" x2="${W - mg.r}" y1="${mg.t + ih}" y2="${mg.t + ih}" stroke="#9aa3b5"/>`;
  const step = W < 520 ? 3 : 1;
  for (let t = Math.ceil(c.tMin); t <= c.tMax; t += 1) {
    s += `<line x1="${X(t)}" x2="${X(t)}" y1="${mg.t + ih}" y2="${mg.t + ih + 4}" stroke="#9aa3b5"/>`;
    if ((t - Math.ceil(c.tMin)) % step === 0 || t === Math.floor(c.tMax)) s += `<text x="${X(t)}" y="${mg.t + ih + 19}" text-anchor="middle" class="tk">${t}</text>`;
  }
  if (Number.isFinite(m.dex)) {
    const be = m.be;
    if (!be.never) s += `<rect x="${X(be.from)}" y="${mg.t}" width="${Math.max(0, X(be.to) - X(be.from))}" height="${ih}" fill="rgba(29,122,70,.08)"/>`;
    s += `<line x1="${mg.l}" x2="${W - mg.r}" y1="${Y(m.dex)}" y2="${Y(m.dex)}" stroke="${RED}" stroke-width="2.5" stroke-dasharray="7 5"/>`;
    s += `<text x="${W - mg.r - 6}" y="${Y(m.dex) - 8}" text-anchor="end" class="bl" fill="${RED}">DEX now ${pct(m.dex)}</text>`;
    if (!be.never && !be.always) {
      s += `<line x1="${X(be.from)}" x2="${X(be.from)}" y1="${mg.t}" y2="${mg.t + ih}" stroke="#1d7a46" stroke-dasharray="4 4"/>`;
      s += `<text x="${X(be.from) + 6}" y="${mg.t + 12}" class="bl">breakeven day ${dayStr(be.from)}</text>`;
    }
  }
  s += `<path d="${path(feeOnly)}" fill="none" stroke="${NAVY}" stroke-width="1.5" stroke-dasharray="3 4" opacity=".7"/>`;
  s += `<path d="${path(tot)}" fill="none" stroke="${BLUE}" stroke-width="3" stroke-linejoin="round"/>`;
  const o = m.opt, oy = m.cost(o.day ?? o.t);
  s += `<circle cx="${X(o.day ?? o.t)}" cy="${Y(oy)}" r="6" fill="#fff" stroke="${BLUE}" stroke-width="3"/>`;
  const right = X(o.day ?? o.t) < mg.l + iw * 0.7;
  s += `<text x="${X(o.day ?? o.t) + (right ? 10 : -10)}" y="${Y(oy) + 22}" text-anchor="${right ? "start" : "end"}" class="pl">optimal day ${o.day ?? dayStr(o.t)} · ${pct(oy)}</text>`;
  s += `</svg>`;
  el.innerHTML = s;
}

// ---------- tabs ----------
function activate(tabId, push) {
  for (const t of document.querySelectorAll(".tab")) {
    const on = t.id === tabId;
    t.setAttribute("aria-selected", String(on)); t.tabIndex = on ? 0 : -1;
    $(t.getAttribute("aria-controls")).hidden = !on;
  }
  if (push) history.replaceState(null, "", location.pathname + location.search + ($(tabId).dataset.hash || ""));
  if (tabId === "tabSell") {
    if (!started || !state.updated || Date.now() - state.updated.getTime() > REFRESH_MS) { started = true; refresh(); }
    render();
  } else {
    window.dispatchEvent(new Event("resize")); // let the buy-side charts re-measure after being hidden
  }
}
const sellVisible = () => !$("paneSell").hidden && document.visibilityState === "visible";

document.querySelectorAll(".tab").forEach((t) => {
  t.addEventListener("click", () => activate(t.id, true));
  t.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const next = t.id === "tabBuy" ? "tabSell" : "tabBuy"; activate(next, true); $(next).focus();
  });
});
window.addEventListener("hashchange", () => activate(location.hash === "#sell" ? "tabSell" : "tabBuy", false));

// ---------- inputs ----------
let debounce;
const onAmount = () => { render(); clearTimeout(debounce); debounce = setTimeout(refresh, DEBOUNCE_MS); };
$("sellAmount").addEventListener("input", onAmount);
$("sellForm").addEventListener("submit", (e) => { e.preventDefault(); clearTimeout(debounce); refresh(); });
$("sDexInput").addEventListener("input", () => { state.dexTouched = true; render(); });
$("sApyInput").addEventListener("input", () => { state.apyTouched = true; render(); });
$("sGasToggle").addEventListener("change", render);
$("sUseDex").addEventListener("click", () => { state.dexTouched = false; render(); });
$("sUseApy").addEventListener("click", () => { state.apyTouched = false; render(); });
let rz; window.addEventListener("resize", () => { clearTimeout(rz); rz = setTimeout(() => { if (!$("paneSell").hidden) render(); }, 120); });
setInterval(() => { if (sellVisible() && !loading) refresh(); }, REFRESH_MS);
document.addEventListener("visibilitychange", () => { if (sellVisible() && state.updated && Date.now() - state.updated.getTime() > REFRESH_MS) refresh(); });

activate(location.hash === "#sell" ? "tabSell" : "tabBuy", false);
