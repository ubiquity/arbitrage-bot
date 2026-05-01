# Ubiquity Dollar arbitrage bot

A small TypeScript bot foundation for keeping the UUSD/LUSD market close to peg during the early project stage.

This PR intentionally keeps the first implementation at a **dry-run planning boundary**: it computes the single largest swap needed to restore the pool to the configured target price, but it does not sign, broadcast, or submit transactions. Live swap execution should be wired in a follow-up/reviewed operator integration with explicit RPC, router, slippage, nonce, and key-management decisions.

## Why this shape

The bounty discussion clarified the desired behavior:

- Run as a simple Node.js app/cron job, not as a UbiquityOS plugin.
- The operator can fund the bot with UUSD and LUSD inventory.
- Use swaps only for now.
- On each run, do the max single swap required to balance the market.
- If the bot does not have enough inventory to balance the market on that turn, do nothing.

## Install

```shell
npm install --ignore-scripts
```

The upstream repo currently includes a Yarn lockfile. The command above was used only for local validation in this environment; it does not require credentials, wallets, or chain access.

## Configure

Copy the example environment and replace the dry-run values with read-only pool and inventory data:

```shell
cp .env.example .env
```

```dotenv
POOL_UUSD_RESERVE=1200
POOL_LUSD_RESERVE=800
POOL_FEE_BPS=30
BOT_UUSD_BALANCE=100
BOT_LUSD_BALANCE=260
TARGET_PRICE=1
PEG_TOLERANCE_BPS=50
MAX_INPUT_AMOUNT=250
```

## Run a dry-run plan

```shell
npm start
```

Example output when UUSD is below peg and the bot has enough LUSD inventory:

```json
{
  "action": "swap-lusd-for-uusd",
  "currentPrice": 0.6666666666666666,
  "targetPrice": 1,
  "postTradePrice": 1,
  "requiredInputAmount": 180.33690783678162,
  "trade": {
    "inputToken": "LUSD",
    "outputToken": "UUSD",
    "inputAmount": 180.33690783678162,
    "outputAmount": 220.20410288672872,
    "effectiveInputAmount": 179.79589711327128,
    "feeAmount": 0.5410107235103456
  }
}
```

If the pool is inside the peg band, the bot holds. If the required balancing input exceeds the configured wallet balance or max input cap, it also holds and returns the reason plus the required amount.

## Test

```shell
npx jest tests/peg-arbitrage.test.ts --runInBand
```

The focused tests cover:

- within-band hold behavior;
- UUSD-buy planning when UUSD is below peg;
- UUSD-sell planning when UUSD is above peg;
- hold behavior when inventory is insufficient for the full balancing swap;
- hold behavior when the required balancing input exceeds the operator cap.

## Safety boundary

This package does **not**:

- use private keys;
- spend gas;
- call live RPC endpoints;
- submit swaps;
- hold custody of funds;
- make routing/slippage/execution claims.

It returns deterministic JSON that a reviewed operator-side execution layer can consume after maintainers decide the exact router/pool/RPC/key-management path.
