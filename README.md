# APYX apyUSD Arbitrage + Claim Timing

Static site based on arbitrageapyusd.netlify.app (live apxUSD→apyUSD quote via KyberSwap + on-chain redeem rate), plus profit curves and optimal claim-time curves for the apyUSD flexible unlock.

Fee model, verified against the on-chain source (Sourcify/Etherscan) and read live via public RPC:
- UnlockReceipt `0x9bf51F33955EC70f87C4b5C49441815589043237` → `feeCurve()` = {minFee 0, maxFee 2.5%, minDuration 3 d, maxDuration 20 d, curvature k 0.75}.
  Claim fee `c(t) = maxFee − (maxFee − minFee) · tHat^k`, `tHat = (t − minDuration)/(maxDuration − minDuration)` (clamped; fee charged on escrowed assets, rounded up to the wei).
- apyUSD vault `0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A` → `unlockingFee()` = 0.1%, taken upfront: escrow = gross / (1 + u).
- Total cost vs gross apxUSD value: `cost(t) = 1 − (1 − c(t)) / (1 + u)` → 2.60% (day 3), 2.10% (5), 1.31% (10), 0.67% (15), 0.10% (20).

trade return r(t) = (1 − cost(t)) / (1 − discount) − 1; APY eq. = (1 + r)^(365/t) − 1. Optimizes annualized return, not total profit. Not financial advice.

Current discount (top panel, refreshed every 30 s): `1 − DEX price / (redeemRate · (1 + u))`, DEX price = apxUSD per apyUSD from a KyberSwap 10,000 apxUSD quote (fallback: deepest apyUSD/apxUSD pool `priceNative` on DexScreener). It pre-fills the curves' discount input/slider and follows live refreshes until the discount is edited manually ("Use live discount" re-links it).

`npm run build` copies `public/` to `dist/`.
