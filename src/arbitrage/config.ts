/**
 * Arbitrage Bot Configuration
 *
 * Holds all configurable parameters for the bot including
 * RPC endpoints, contract addresses, profit thresholds, and gas limits.
 */

export interface MarketConfig {
  name: string;
  type: "uniswap" | "curve";
  routerAddress: string;
  poolAddress: string;
}

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  dollarTokenAddress: string;
  collateralTokenAddress: string; // e.g. USDC
  poolDiamondAddress: string;
  markets: MarketConfig[];
}

export interface BotConfig {
  chains: ChainConfig[];
  profitThresholdUsd: number; // minimum profit in USD to execute a trade
  gasPriceLimitGwei: number; // maximum gas price to pay
  pollIntervalMs: number; // how often to check prices
  maxTradeAmount: number; // max Dollar tokens per trade
  privateKeyEnvVar: string; // env var name holding the wallet private key
}

/**
 * Default configuration targeting Ethereum mainnet.
 * Values should be overridden via environment variables or a .env file.
 */
export const defaultConfig: BotConfig = {
  chains: [
    {
      chainId: 1,
      name: "ethereum",
      rpcUrl: process.env.ETH_RPC_URL || "https://eth-mainnet.public.blastapi.io",
      dollarTokenAddress: process.env.DOLLAR_TOKEN_ADDRESS || "0x0F644658510c4CB68A40a4A6358b36c0837828F2",
      collateralTokenAddress: process.env.COLLATERAL_TOKEN_ADDRESS || "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
      poolDiamondAddress: process.env.POOL_DIAMOND_ADDRESS || "0x1111111111111111111111111111111111111111",
      markets: [
        {
          name: "UniswapV3 USD/USDC",
          type: "uniswap",
          routerAddress: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
          poolAddress: "0x1111111111111111111111111111111111111112",
        },
        {
          name: "Curve USD/USDC",
          type: "curve",
          routerAddress: "0x1111111111111111111111111111111111111113",
          poolAddress: "0x1111111111111111111111111111111111111114",
        },
      ],
    },
  ],
  profitThresholdUsd: Number(process.env.PROFIT_THRESHOLD_USD) || 5,
  gasPriceLimitGwei: Number(process.env.GAS_PRICE_LIMIT_GWEI) || 50,
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS) || 15_000,
  maxTradeAmount: Number(process.env.MAX_TRADE_AMOUNT) || 10_000,
  privateKeyEnvVar: "WALLET_PRIVATE_KEY",
};
