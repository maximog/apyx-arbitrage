import { ethers } from "https://cdn.jsdelivr.net/npm/ethers@6.13.5/+esm";

const RPC_URL = "https://ethereum-rpc.publicnode.com/2376b275d18176b907569c0db67d2918a323d0b2a598dd1dee4fd49d2e4865ce";
const KYBER_URL = "https://aggregator-api.kyberswap.com/ethereum/api/v1/routes";
const QUOTE_TO = "0xd8da6bf26964af9d7eed9e03e53415d37aa96045";
const REDEEM_DAYS = 20;
const FULL_COOLDOWN_FEE = 0.001; // 0.1% minimum unlock fee at the end of the linear fee schedule (docs.apyx.fi)
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

function resetMetrics() {
  els.fairValue.textContent = "--";
  els.inputUsd.textContent = "--";
  els.apr.textContent = "--";
  els.output.textContent = "--";
  els.outputUsd.textContent = "--";
  els.net.textContent = "--";
  els.netUsd.textContent = "--";
  els.profit.textContent = "--";
  els.profitUsd.textContent = "--";
  els.spread.textContent = "--";
  els.rate.textContent = "--";
}

async function calculate() {
  const amountText = els.amount.value;
  const input = readInputNumber();
  const amountInWei = parseAmount(amountText);
  const fairValueAmountWei = ethers.parseUnits("10000", TOKENS.apxUSD.decimals);

  setStatus("Loading", "loading");
  els.panel.classList.add("updating");
  els.button.disabled = true;
  els.buttonText.textContent = "Updating";
  resetMetrics();
  els.swapLink.href = swapLink(amountText);

  try {
    if (!Number.isFinite(latestNativeApy)) loadNativeApy().catch(() => {});

    const [quote, fairQuote, redeemRate] = await Promise.all([
      fetchQuote(amountInWei, TOKENS.apyUSD),
      fetchQuote(fairValueAmountWei, TOKENS.USDC),
      getRedeemRate(),
    ]);
    const output = numberFromWei(quote.amountOutWei, TOKENS.apyUSD.decimals);
    const fairUsdc = numberFromWei(fairQuote.amountOutWei, TOKENS.USDC.decimals);
    const fairValue = fairUsdc / 10000;
    latestFairValue = fairValue;
    const gross = output * redeemRate;
    const net = gross * (1 - FULL_COOLDOWN_FEE);
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
    els.rate.textContent = formatAmount(redeemRate, 5);
    els.apr.textContent = formatPercent(apy);
    els.fairValue.textContent = `$${formatAmount(fairValue, 4)}`;
    updateInputUsd();

    setSigned(els.profit, profit);
    setSigned(els.spread, spread);
    setSigned(els.apr, apy);
    setStatus("Live");
    window.dispatchEvent(new CustomEvent("apyx:live", {
      detail: { input, gross, discount: 1 - input / gross, fairValue, nativeApy: latestNativeApy },
    }));
  } catch (error) {
    if (error.name !== "AbortError") {
      setStatus("Error", "error");
    }
  } finally {
    els.panel.classList.remove("updating");
    els.button.disabled = false;
    els.buttonText.textContent = "Calculate";
  }
}

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  calculate().catch(() => {});
});

els.amount.addEventListener("input", updateInputUsd);

loadNativeApy().catch(() => {});
calculate().catch(() => {});
window.setInterval(() => {
  calculate().catch(() => {});
}, 60_000);
