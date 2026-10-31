# APYX apyUSD Arbitrage + Claim Timing + Exit cost

Static site based on arbitrageapyusd.netlify.app (live apxUSD→apyUSD quote via KyberSwap + on-chain redeem rate), plus profit curves and optimal claim-time curves for the apyUSD flexible unlock.

Fee model, verified against the on-chain source (Sourcify/Etherscan) and read live via public RPC:
- UnlockReceipt `0x9bf51F33955EC70f87C4b5C49441815589043237` → `feeCurve()` = {minFee 0, maxFee 2.5%, minDuration 3 d, maxDuration 20 d, curvature k 0.75}.
  Claim fee `c(t) = maxFee − (maxFee − minFee) · tHat^k`, `tHat = (t − minDuration)/(maxDuration − minDuration)` (clamped; fee charged on escrowed assets, rounded up to the wei).
- apyUSD vault `0x38EEb52F0771140d10c4E9A9a72349A329Fe8a6A` → `unlockingFee()` = 0.1%, taken upfront: escrow = gross / (1 + u).
- Total cost vs gross apxUSD value: `cost(t) = 1 − (1 − c(t)) / (1 + u)` → 2.60% (day 3), 2.10% (5), 1.31% (10), 0.67% (15), 0.10% (20).

trade return r(t) = (1 − cost(t)) / (1 − discount) − 1; APY eq. = (1 + r)^(365/t) − 1. Optimizes annualized return, not total profit. Not financial advice.

Current discount (top panel, refreshed every 30 s): `1 − DEX price / (redeemRate · (1 + u))`, DEX price = apxUSD per apyUSD from a KyberSwap 10,000 apxUSD quote (fallback: deepest apyUSD/apxUSD pool `priceNative` on DexScreener). It pre-fills the curves' discount input/slider and follows live refreshes until the discount is edited manually ("Use live discount" re-links it).

## Sell apyUSD tab (reverse path: apyUSD → apxUSD)

Second tab (`#sell`, code in `public/sell.js`, pure formulas in `public/sell-math.js`): what it costs to exit `s` apyUSD into apxUSD, on a DEX now vs unlocking and claiming on day 3…20. All costs are relative to the **gross redemption value** `V = s · G`, with `G = convertToAssets(1e18)` (share price in apxUSD).

- **DEX**: KyberSwap route apyUSD→apxUSD at the entered size → `DEX cost = 1 − apxUSD out / V`. Spot price = KyberSwap quote for 100 apyUSD; price impact = `1 − price at size / spot`; spot discount = `1 − spot / G`. Fallback: deepest apyUSD/apxUSD pool `priceNative` on DexScreener (pool price, no price impact).
- **Unlock fees**: `fee(t) = 1 − (1 − c(t)) / (1 + u)` (same formula as the buy side).
- **Lost yield**: `(1 + APY)^(t/365) − 1`. The escrowed apxUSD earns nothing while unlocking. APY = annualized growth of the on-chain share price (`convertToAssets`) over the last 7 days (24 h as fallback, via archive RPC). It can be overridden.
- **Total unlock cost** `(t) = fee(t) + lost yield(t)`, in % and apxUSD (`· V`).
  - Optimal day = argmin over days 3…20.
  - Breakeven = first day on which the unlock cost ≤ DEX cost.
  - The recommendation card compares DEX against the optimal unlock day.
- **Overrides**: the DEX discount and APY inputs follow the live values until edited; "Use live …" re-links them.
- **Gas** is optional: swap gas from KyberSwap `gasUsd`. Unlock gas = 370k gas (request ≈ 250k + claim ≈ 115k, measured on-chain) at the same gas price.
- **Refresh**: every 30 s while the tab is visible, plus a 400 ms debounce on size changes.
- **Assumptions**: apxUSD ≈ 1 USD, no depeg during the wait, gas excluded by default.

Sell-direction mechanics, verified in the Sourcify sources (`ApyUSD._withdraw`, `UnlockReceipt.claim`, `FeeCurveLib`):
- `redeem(shares)` values the shares at `G` and burns them.
- The vault fee `u` is taken from that gross amount (`_feeOnTotal`: `gross · u / (1 + u)`, rounded up). It goes to the fee wallet, or stays in the vault and accrues to the remaining holders.
- The receipt escrows `gross / (1 + u)` (= `previewRedeem`).
- `claim` is allowed from `minDuration`. It pays `escrow − ceil(escrow · c(elapsed))`, with `c = maxFee` up to day 3.
- `cancel` re-mints shares, charges `minFee`, and does not refund `u`.

So the formula is the same as the README's buy-side cost. The only thing to note is the basis: the app's `redeemRate` (`previewWithdraw` / `previewRedeem`) is already **net** of `u`, and the gross share price is `redeemRate · (1 + u)`.

`npm test` runs the no-network unit tests of these formulas (`test/sell-math.test.mjs`, `node:test`).

`npm run build` copies `public/` to `dist/`.
