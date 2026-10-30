import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.5/+esm";

const RPC_URL = "https://ethereum-rpc.publicnode.com/2376b275d18176b907569c0db67d2918a323d0b2a598dd1dee4fd49d2e4865ce";
const KYBER_URL = "https://aggregator-api.kyberswap.com/ethereum/api/v1/routes";
const QUOTE_TO = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const REDEEM_DAYS = 20;
// The vault's 0.1% unlockingFee is already netted out of previewWithdraw/previewRedeem (the redeem rate).
// At the end of the schedule the receipt charges feeCurve.minFee (0% on-chain; analysis.js updates it live).
const claimFeeAtFullCooldown = () => (window.APYX_CURVE ? window.APYX_CURVE.minFee : 0);
const NATIVE_APY_LOOKBACK_SECONDS = 60 * 60;
const ETHEREUM_AVERAGE_BLOCK_SECONDS = 12;
const YEAR_SECONDS = 365 * 24 * 60 * 60;
const REDEEM_RATE_TTL_MS = 60_000;
const NATIVE_APY_RETRY_INITIAL_MS = 5_000;
const NATIVE_APY_RETRY_MAX_MS = 60_000;
const WAD = 10n ** 18n;

const TOKENS = {
  apxUSD: {
    address: "0x98A878b1Cd98131B271883B390f68D2c90674665",
    decimals: 18,
  },
  apyUSD: {
    address: "0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A",
    decimals: 18,
  },
  USDC: {
    address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    decimals: 6,
  },
};

const ABI = [
  "function previewWithdraw(uint256 assets) view returns (uint256 shares)",
  "function previewRedeem(uint256 shares) view returns (uint256 assets)",
];

const provider = new ethers.JsonRpcProvider(RPC_URL, 1);

const els = {
  form: document.querySelector("#arbForm"),
  amount: document.querySelector("#amountInput"),
  inputUsd: document.querySelector("#inputUsdMetric"),
  button: document.querySelector(".quote-button"),
  buttonText: document.querySelector(".quote-button span"),
  panel: document.querySelector(".arb-panel"),
  status: document.querySelector("#statusPill"),
  apr: document.querySelector("#aprMetric"),
  nativeApy: document.querySelector("#nativeApyMetric"),
  output: document.querySelector("#outputMetric"),
  outputUsd: document.querySelector("#outputUsdMetric"),
  net: document.querySelector("#netMetric"),
  netUsd: document.querySelector("#netUsdMetric"),
  profit: document.querySelector("#profitMetric"),
  profitUsd: document.querySelector("#profitUsdMetric"),
  spread: document.querySelector("#spreadMetric"),
  rate: document.querySelector("#rateMetric"),
  fairValue: document.querySelector("#fairValueMetric"),
  swapLink: document.querySelector("#swapLink"),
  discountHero: document.querySelector("#discountHero"),
  discount: document.querySelector("#discountMetric"),
  discountDetail: document.querySelector("#discountDetail"),
  discountSource: document.querySelector("#discountSource"),
  discountUpdated: document.querySelector("#discountUpdated"),
};

let latestFairValue = null;
let latestNativeApy = null;
let nativeApyRequest = null;
let nativeApyRetryTimer = null;
let nativeApyRetryDelay = NATIVE_APY_RETRY_INITIAL_MS;
let redeemRateCache = null;
let redeemRateRequest = null;

function parseAmount(value) {
  const normalized = String(value || "").trim().replace(/,/g, "");
  if (!/^\d+(\.\d+)?$/.test(normalized) || Number(normalized) <= 0) {
    throw new Error("Invalid amount");
  }
  return ethers.parseUnits(normalized, TOKENS.apxUSD.decimals);
}

function numberFromWei(value, decimals = 18) {
  return Number(ethers.formatUnits(value, decimals));
}

function formatAmount(value, digits = 2) {
  if (!Number.isFinite(value)) return "--";
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: digits,
  }).format(value);
}

function formatPercent(value) {
  if (!Number.isFinite(value)) return "--";
  return `${formatAmount(value, 2)}%`;
}

function formatUsd(value) {
  if (!Number.isFinite(value)) return "--";
  return `$${formatAmount(value, 2)}`;
}

function readInputNumber() {
  return Number(String(els.amount.value || "").replace(/,/g, ""));
}

function updateInputUsd() {
  const input = readInputNumber();
  els.inputUsd.textContent = Number.isFinite(input) && input > 0 && Number.isFinite(latestFairValue)
    ? `≈ ${formatUsd(input * latestFairValue)}`
    : "--";
}

function setStatus(text, mode = "ready") {
  els.status.classList.toggle("loading", mode === "loading");
  els.status.classList.toggle("error", mode === "error");
  els.status.querySelector("strong").textContent = text;
}

function setSigned(el, value) {
  const finite = Number.isFinite(value);
  el.classList.toggle("positive", finite && value >= 0);
  el.classList.toggle("negative", finite && value < 0);
}

async function fetchQuote(amountInWei, tokenOut = TOKENS.apyUSD) {
  const url = new URL(KYBER_URL);
  url.searchParams.set("tokenIn", TOKENS.apxUSD.address);
  url.searchParams.set("tokenOut", tokenOut.address);
  url.searchParams.set("amountIn", amountInWei.toString());
  url.searchParams.set("to", QUOTE_TO);

  const response = await fetch(url, {
    headers: {
      accept: "application/json",
      "x-client-id": "apyx-static-arb",
    },
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`KyberSwap HTTP ${response.status}: ${text.slice(0, 180)}`);
  }

  const payload = JSON.parse(text);
  const data = payload?.data || payload;
  const summary = data?.routeSummary || data?.route || data;
  const amountOut = summary?.amountOut || summary?.outputAmount || summary?.amount_out;
  if (!amountOut) throw new Error("KyberSwap returned no route");

  return {
    amountOutWei: BigInt(amountOut),
    routeName: summary?.route?.[0]?.[0]?.exchange || summary?.route?.[0]?.[0]?.poolType || "route",
  };
}

async function fetchRedeemRate() {
  const contract = new ethers.Contract(TOKENS.apyUSD.address, ABI, provider);
  const assets = ethers.parseUnits("1000", TOKENS.apxUSD.decimals);

  try {
    const shares = await contract.previewWithdraw(assets);
    if (shares <= 0n) throw new Error("previewWithdraw returned zero");
    return numberFromWei((assets * WAD) / shares, 18);
  } catch {
    return numberFromWei(await contract.previewRedeem(WAD), TOKENS.apxUSD.decimals);
  }
}

async function getRedeemRate() {
  const now = Date.now();
  if (redeemRateCache && now - redeemRateCache.timestamp < REDEEM_RATE_TTL_MS) {
    return redeemRateCache.value;
  }
  if (redeemRateRequest) return redeemRateRequest;

  redeemRateRequest = fetchRedeemRate()
    .then((redeemRate) => {
      redeemRateCache = {
        value: redeemRate,
        timestamp: Date.now(),
      };
      return redeemRate;
    })
    .finally(() => {
      redeemRateRequest = null;
    });

  return redeemRateRequest;
}

async function fetchNativeApy() {
  const contract = new ethers.Contract(TOKENS.apyUSD.address, ABI, provider);
  const latestBlock = await provider.getBlock("latest");
  if (!latestBlock) throw new Error("No latest block");

  const lookbackBlocks = Math.round(NATIVE_APY_LOOKBACK_SECONDS / ETHEREUM_AVERAGE_BLOCK_SECONDS);
  const pastBlockNumber = Math.max(0, latestBlock.number - lookbackBlocks);
  const pastBlock = await provider.getBlock(pastBlockNumber);
  if (!pastBlock) throw new Error("No historical block");

  const [currentAssets, pastAssets] = await Promise.all([
    contract.previewRedeem(WAD, { blockTag: latestBlock.number }),
    contract.previewRedeem(WAD, { blockTag: pastBlock.number }),
  ]);

  const currentRate = numberFromWei(currentAssets, TOKENS.apxUSD.decimals);
  const pastRate = numberFromWei(pastAssets, TOKENS.apxUSD.decimals);
  const elapsedSeconds = latestBlock.timestamp - pastBlock.timestamp;

  if (currentRate <= 0 || pastRate <= 0 || elapsedSeconds <= 0) {
    throw new Error("Invalid on-chain native APY window");
  }

  return (Math.pow(currentRate / pastRate, YEAR_SECONDS / elapsedSeconds) - 1) * 100;
}

function scheduleNativeApyRetry() {
  if (Number.isFinite(latestNativeApy) || nativeApyRequest || nativeApyRetryTimer) return;

  nativeApyRetryTimer = window.setTimeout(() => {
    nativeApyRetryTimer = null;
    loadNativeApy();
  }, nativeApyRetryDelay);
  nativeApyRetryDelay = Math.min(nativeApyRetryDelay * 2, NATIVE_APY_RETRY_MAX_MS);
}

async function loadNativeApy() {
  if (Number.isFinite(latestNativeApy)) return latestNativeApy;
  if (nativeApyRequest) return nativeApyRequest;

  if (nativeApyRetryTimer) {
    window.clearTimeout(nativeApyRetryTimer);
    nativeApyRetryTimer = null;
  }

  els.nativeApy.textContent = "Loading";
  nativeApyRequest = fetchNativeApy()
    .then((nativeApy) => {
      latestNativeApy = nativeApy;
      nativeApyRetryDelay = NATIVE_APY_RETRY_INITIAL_MS;
      els.nativeApy.textContent = formatPercent(nativeApy);
      window.dispatchEvent(new CustomEvent("apyx:native", { detail: { nativeApy } }));
      return nativeApy;
    })
    .catch(() => {
      els.nativeApy.textContent = "Loading";
      return null;
    })
    .finally(() => {
      nativeApyRequest = null;
      if (!Number.isFinite(latestNativeApy)) scheduleNativeApyRetry();
    });

  return nativeApyRequest;
}

function swapLink(amount) {
  const url = new URL("https://meta.matcha.xyz/");
  url.searchParams.set("chainId", "1");
  url.searchParams.set("sellToken", TOKENS.apxUSD.address.toLowerCase());
  url.searchParams.set("buyToken", TOKENS.apyUSD.address.toLowerCase());
  url.searchParams.set("sellAmount", amount);
  return url.toString();
}

function setMetricsError() {
  for (const k of ["apr", "output", "outputUsd", "net", "netUsd", "profit", "profitUsd", "spread"]) els[k].textContent = "--";
}

// ---------- Live refresh (top input → quote → results, current discount, recommendation, curves) ----------
// The KyberSwap quote is for the amount typed in the top input, so the price (incl. price impact), the
// headline discount, the optimal-claim card and the lower section's live discount all share one basis.
// discount = 1 − DEX price / gross apxUSD redemption value per apyUSD
//   DEX price   = input apxUSD / apyUSD out (KyberSwap; fallback: DexScreener spot of the deepest pool)
//   gross value = redeem rate (previewWithdraw, net of the vault fee) × (1 + vault unlockingFee)
const REFRESH_MS = 30_000;
const INPUT_DEBOUNCE_MS = 400;
const FAIR_REF_APX = 10_000; // fair value (USD per apxUSD) is a per-unit price, quoted at a fixed reference size
const DEXSCREENER_URL = `https://api.dexscreener.com/latest/dex/tokens/${TOKENS.apyUSD.address}`;
let refreshSeq = 0;
let lastDiscount = null;
let debounceTimer = null;

const vaultFee = () => (window.APYX_CURVE ? window.APYX_CURVE.vaultFee : 0.001);

async function fetchDexScreenerPrice() {
  const response = await fetch(DEXSCREENER_URL, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`DexScreener HTTP ${response.status}`);
  const payload = await response.json();
  const apx = TOKENS.apxUSD.address.toLowerCase();
  const apy = TOKENS.apyUSD.address.toLowerCase();
  const pairs = (payload?.pairs || []).filter((pair) =>
    pair?.baseToken?.address?.toLowerCase() === apy && pair?.quoteToken?.address?.toLowerCase() === apx
    && Number(pair.priceNative) > 0);
  if (!pairs.length) throw new Error("DexScreener: no apyUSD/apxUSD pool");
  pairs.sort((a, b) => (b.liquidity?.usd || 0) - (a.liquidity?.usd || 0));
  const top = pairs[0];
  return { price: Number(top.priceNative), source: `DexScreener · ${top.dexId} pool`, size: "Spot (no size)", detail: "Spot price of the deepest apyUSD/apxUSD pool (KyberSwap quote unavailable)" };
}

function renderDiscount() {
  if (!lastDiscount) return;
  const d = lastDiscount;
  els.discount.textContent = formatPercent(d.discount * 100);
  setSigned(els.discount, d.discount);
  els.discountDetail.textContent = "";
  els.discountDetail.hidden = true;
  document.querySelector("#discountRows").hidden = false;
  document.querySelector("#dPrice").textContent = formatAmount(d.price, 5);
  document.querySelector("#dGross").textContent = formatAmount(d.gross, 5);
  document.querySelector("#dSize").textContent = d.size;
  document.querySelector("#dNote").textContent = d.detail;
  els.discountSource.textContent = d.source;
  els.discountUpdated.textContent = new Date(d.time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function publishDiscount(dex, redeemRate, amount) {
  const gross = redeemRate * (1 + vaultFee());
  lastDiscount = { ...dex, redeemRate, gross, amount, discount: 1 - dex.price / gross, time: Date.now() };
  els.discountHero.classList.remove("error");
  renderDiscount();
  window.APYX_LIVE_DISCOUNT = lastDiscount;
  window.dispatchEvent(new CustomEvent("apyx:discount", { detail: lastDiscount }));
}

function discountError() {
  els.discountHero.classList.add("error");
  els.discountDetail.hidden = false;
  els.discountDetail.textContent = lastDiscount
    ? "Refresh failed (KyberSwap, DexScreener or RPC unreachable); showing last value. Retrying…"
    : "Couldn't load the live DEX price (KyberSwap, DexScreener or RPC unreachable). Retrying…";
  if (!lastDiscount) els.discountSource.textContent = "unavailable";
  window.dispatchEvent(new CustomEvent("apyx:discount-error"));
}

function setLoading(on) {
  els.panel.classList.toggle("updating", on);
  els.discountHero.classList.toggle("loading", on);
  els.button.disabled = on;
  els.buttonText.textContent = on ? "Updating" : "Calculate";
  if (on) setStatus("Loading", "loading");
}

async function calculate() {
  window.clearTimeout(debounceTimer);
  debounceTimer = null;
  const amountText = String(els.amount.value || "").trim().replace(/,/g, "");
  const seq = ++refreshSeq;
  let amountInWei;
  try {
    amountInWei = parseAmount(amountText);
  } catch {
    setMetricsError();
    setLoading(false);
    setStatus("Invalid amount", "error");
    return;
  }
  const input = Number(amountText);
  els.swapLink.href = swapLink(amountText);
  setLoading(true);
  if (!Number.isFinite(latestNativeApy)) loadNativeApy().catch(() => {});

  const [quoteR, fairR, rateR] = await Promise.allSettled([
    fetchQuote(amountInWei, TOKENS.apyUSD),
    fetchQuote(ethers.parseUnits(String(FAIR_REF_APX), TOKENS.apxUSD.decimals), TOKENS.USDC),
    getRedeemRate(),
  ]);
  if (seq !== refreshSeq) return; // a newer input superseded this request

  try {
    if (fairR.status === "fulfilled") {
      latestFairValue = numberFromWei(fairR.value.amountOutWei, TOKENS.USDC.decimals) / FAIR_REF_APX;
    }
    if (rateR.status !== "fulfilled") throw new Error("redeem rate unavailable");
    const redeemRate = rateR.value;
    const fairValue = latestFairValue;
    els.rate.textContent = formatAmount(redeemRate, 5);
    els.fairValue.textContent = Number.isFinite(fairValue) ? `$${formatAmount(fairValue, 4)}` : "--";
    updateInputUsd();

    // Current discount: same quote as the results below (typed size); spot fallback if KyberSwap fails
    let dex = null;
    if (quoteR.status === "fulfilled") {
      const out = numberFromWei(quoteR.value.amountOutWei, TOKENS.apyUSD.decimals);
      if (out > 0) dex = { price: input / out, source: "KyberSwap quote", size: `${formatAmount(input, 2)} apxUSD → apyUSD (top input)`, detail: "Includes price impact for the input amount" };
    }
    if (!dex) {
      try { dex = await fetchDexScreenerPrice(); } catch { dex = null; }
      if (seq !== refreshSeq) return;
    }
    if (dex) publishDiscount(dex, redeemRate, input); else discountError();

    if (quoteR.status !== "fulfilled") throw new Error("quote unavailable");
    const output = numberFromWei(quoteR.value.amountOutWei, TOKENS.apyUSD.decimals);
    const gross = output * redeemRate;
    const net = gross * (1 - claimFeeAtFullCooldown());
    const profit = net - input;
    const spread = (profit / input) * 100;
    const apy = (Math.pow(1 + spread / 100, 365 / REDEEM_DAYS) - 1) * 100;
    const netUsd = net * fairValue;
    const profitUsd = profit * fairValue;

    els.output.textContent = formatAmount(output, 2);
    els.outputUsd.textContent = `≈ ${formatUsd(netUsd)}`;
    els.net.textContent = formatAmount(net, 2);
    els.netUsd.textContent = `≈ ${formatUsd(netUsd)}`;
    els.profit.textContent = formatAmount(profit, 2);
    els.profitUsd.textContent = `≈ ${formatUsd(profitUsd)}`;
    els.spread.textContent = formatPercent(spread);
    els.apr.textContent = formatPercent(apy);
    setSigned(els.profit, profit);
    setSigned(els.spread, spread);
    setSigned(els.apr, apy);
    setLoading(false);
    setStatus("Live");
    window.dispatchEvent(new CustomEvent("apyx:live", {
      detail: { input, escrow: gross, fairValue, nativeApy: latestNativeApy },
    }));
  } catch {
    setMetricsError();
    setLoading(false);
    setStatus("Error", "error");
  }
}

function scheduleCalculate() {
  window.clearTimeout(debounceTimer);
  els.swapLink.href = swapLink(String(els.amount.value || "").trim().replace(/,/g, ""));
  updateInputUsd();
  debounceTimer = window.setTimeout(() => { debounceTimer = null; calculate().catch(() => {}); }, INPUT_DEBOUNCE_MS);
}

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  calculate().catch(() => {});
});
let lastAmountSeen = els.amount.value;
for (const ev of ["input", "change", "keyup", "paste"]) {
  els.amount.addEventListener(ev, () => {
    if (els.amount.value === lastAmountSeen && ev !== "change") return;
    lastAmountSeen = els.amount.value;
    scheduleCalculate();
  });
}

// Vault fee may update once on-chain params load; recompute the headline without refetching.
window.addEventListener("apyx:curve", () => {
  if (!lastDiscount) return;
  lastDiscount.gross = lastDiscount.redeemRate * (1 + vaultFee());
  lastDiscount.discount = 1 - lastDiscount.price / lastDiscount.gross;
  renderDiscount();
  window.dispatchEvent(new CustomEvent("apyx:discount", { detail: lastDiscount }));
});

loadNativeApy().catch(() => {});
calculate().catch(() => {});
window.setInterval(() => {
  if (debounceTimer) return; // a debounced re-quote for a new input is about to run
  calculate().catch(() => {});
}, REFRESH_MS);
