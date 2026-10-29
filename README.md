# APYX apyUSD Arbitrage + Claim Timing

Static site based on arbitrageapyusd.netlify.app (live apxUSD→apyUSD quote via KyberSwap + on-chain redeem rate), plus profit curves and optimal claim-time curves for the apyUSD flexible unlock.

Model: fee(t) declines linearly from max fee (default 2.6%) at the first claim day (3) to the min fee (0.1%) at full cooldown (20 days);
trade return r(t) = (1 − fee(t)) / (1 − discount) − 1; APY eq. = (1 + r)^(365/t) − 1. Optimizes annualized return, not total profit. Not financial advice.

`npm run build` copies `public/` to `dist/`.
