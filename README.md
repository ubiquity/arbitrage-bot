# Ubiquity Dollar Arbitrage Bot

A Node.js arbitrage bot that maintains the [Ubiquity Dollar token](https://github.com/ubiquity/ubiquity-dollar) USD peg by exploiting price deviations on secondary markets (Uniswap, Curve).

## How It Works

The bot monitors Dollar token prices on DEX markets and executes arbitrage when profitable:

1. **Price > $1 (Mint & Sell):** Mint Dollar tokens from the LibUbiquityPool at $1 of collateral, then sell on the DEX for a profit.
2. **Price < $1 (Buy & Redeem):** Buy cheap Dollar tokens on the DEX, then redeem them in the pool for $1 of collateral.

Both actions push the market price back toward the $1 peg.

## Prerequisites

- Node.js >= 20.10.0
- A funded Ethereum wallet (with collateral tokens, e.g. USDC)
- RPC endpoint for Ethereum mainnet

## Setup

```bash
# Install dependencies
yarn install

# Copy the example env file
cp .env.example .env

# Edit .env with your configuration
```

### Environment Variables

| Variable | Description | Default |
|---|---|---|
| `WALLET_PRIVATE_KEY` | Private key of the wallet to execute trades from | Required |
| `ETH_RPC_URL` | Ethereum mainnet RPC URL | `https://eth-mainnet.public.blastapi.io` |
| `DOLLAR_TOKEN_ADDRESS` | Dollar token contract address | Auto-configured |
| `COLLATERAL_TOKEN_ADDRESS` | Collateral token (USDC) address | Auto-configured |
| `POOL_DIAMOND_ADDRESS` | LibUbiquityPool diamond contract address | Auto-configured |
| `PROFIT_THRESHOLD_USD` | Minimum profit in USD to execute a trade | `5` |
| `GAS_PRICE_LIMIT_GWEI` | Maximum gas price to pay (in gwei) | `50` |
| `POLL_INTERVAL_MS` | How often to check prices (milliseconds) | `15000` |
| `MAX_TRADE_AMOUNT` | Maximum Dollar tokens per trade | `10000` |
| `ETH_PRICE_USD` | ETH price for gas cost estimation | `3000` |

## Usage

```bash
# Start the bot
yarn start

# Run tests
yarn test
```

## Architecture

```
src/
├── arbitrage/
│   ├── bot.ts          # Main bot orchestration
│   ├── config.ts       # Configuration and defaults
│   ├── price-monitor.ts # DEX price fetching & opportunity detection
│   └── executor.ts     # Trade execution (mint/redeem/swap)
├── index.ts            # Public API exports
└── main.ts             # Entry point
```

### Key Components

- **PriceMonitor** — Fetches Dollar token prices from Uniswap and Curve pools, detects deviations from the $1 peg.
- **Executor** — Executes trades via the LibUbiquityPool diamond contract (mint/redeem) and DEX routers (swap). Includes gas estimation and profitability checks.
- **ArbitrageBot** — Orchestrates monitoring and execution in a continuous loop.

## Gas Estimation & Profitability

Before executing any trade, the bot:
1. Estimates gas cost based on current network conditions
2. Deducts gas cost from expected profit
3. Only executes if net profit exceeds the configured threshold

## License

MIT
