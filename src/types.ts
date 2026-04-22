/**
 * Core types for the Ubiquity Dollar Arbitrage Bot
 */

export type Network = "ethereum" | "gnosis";
export type DexProtocol = "curve" | "uniswap-v3" | "sushiswap";
export type TradeDirection = "buy" | "sell";

// ─── Configuration ───────────────────────────────────────────────────────────

export interface BotConfig {
  ethereumRpc: string;
  gnosisRpc: string;
  privateKey: string;
  /** Minimum net profit in wei to execute a trade */
  minProfitWei: string;
  /** Maximum gas price in wei */
  maxGasPrice: string;
  /** Polling interval in milliseconds */
  checkIntervalMs: number;
  /** Peg target (default: 1.0) */
  pegPrice: number;
  /** Price deviation threshold to trigger arbitrage (default: 0.01 = 1%) */
  deviationThreshold: number;
  /** Maximum trade size in Ubiquity Dollar units (default: 10000) */
  maxTradeSize: string;
}

// ─── Token & Pool ────────────────────────────────────────────────────────────

export interface Token {
  address: string;
  symbol: string;
  decimals: number;
  network: Network;
}

export interface PoolConfig {
  address: string;
  network: Network;
  protocol: DexProtocol;
  tokens: [Token, Token];
  feeBps: number;
}

// ─── Price ───────────────────────────────────────────────────────────────────

export interface PriceData {
  pool: string;
  protocol: DexProtocol;
  network: Network;
  baseToken: string;
  quoteToken: string;
  price: number;
  liquidity: string;
  timestamp: number;
}

// ─── Arbitrage ───────────────────────────────────────────────────────────────

export interface ArbOpportunity {
  direction: TradeDirection;
  pool: string;
  protocol: DexProtocol;
  network: Network;
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  expectedAmountOut: string;
  estimatedProfit: string;
  gasCost: string;
  netProfit: string;
}

// ─── Swap Result ─────────────────────────────────────────────────────────────

export interface SwapResult {
  success: boolean;
  txHash?: string;
  amountIn: string;
  amountOut?: string;
  gasUsed?: number;
  gasCost: string;
  netPnl: string;
  error?: string;
  timestamp: number;
}

// ─── Bot Status ──────────────────────────────────────────────────────────────

export interface BotStatus {
  isRunning: boolean;
  cyclesCompleted: number;
  totalTrades: number;
  totalProfitWei: string;
  lastPrice: number | null;
  lastOpportunity: ArbOpportunity | null;
  lastSwap: SwapResult | null;
  uptimeSeconds: number;
}

// ─── Known Tokens ────────────────────────────────────────────────────────────

export const TOKENS: Record<string, Token> = {
  uUSD_ETH: { address: "0x0F644658510c95CB46955e55D7BA9DDa9E9fBEc6", symbol: "uUSD", decimals: 18, network: "ethereum" },
  USDC_ETH: { address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", symbol: "USDC", decimals: 6, network: "ethereum" },
  USDT_ETH: { address: "0xdAC17F958D2ee523a2206206994597C13D831ec7", symbol: "USDT", decimals: 6, network: "ethereum" },
  DAI_ETH: { address: "0x6B175474E89094C44Da98b954EedeAC495271d0F", symbol: "DAI", decimals: 18, network: "ethereum" },
  uUSD_GNO: { address: "0xD6d452c56618c3E9a46A53F7b2BA7e43D77b8b02", symbol: "uUSD", decimals: 18, network: "gnosis" },
  USDC_GNO: { address: "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83", symbol: "USDC", decimals: 6, network: "gnosis" },
  WXDAI_GNO: { address: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d", symbol: "wxDAI", decimals: 18, network: "gnosis" },
};

// ─── Known Pools ─────────────────────────────────────────────────────────────

export const POOLS: PoolConfig[] = [
  {
    address: "0x20955CB69Ae1515962177D164dfC9522feec56ff",
    network: "ethereum",
    protocol: "curve",
    tokens: [TOKENS.uUSD_ETH, TOKENS.USDC_ETH],
    feeBps: 4,
  },
  {
    address: "0xD6d452c56618c3E9a46A53F7b2BA7e43D77b8b02",
    network: "gnosis",
    protocol: "curve",
    tokens: [TOKENS.uUSD_GNO, TOKENS.USDC_GNO],
    feeBps: 4,
  },
];

// ─── LibUbiquityPool ─────────────────────────────────────────────────────────

/** LibUbiquityPool contract addresses for minting/redeeming Ubiquity Dollar */
export const LIB_UBIQUITY_POOL: Record<Network, string> = {
  ethereum: "0x7cC4B98d6b0436c4CaaAdBb5486951e4Fc4f2739",
  gnosis: "0x7cC4B98d6b0436c4CaaAdBb5486951e4Fc4f2739",
};

/**
 * LibUbiquityPool ABI — minimal set for:
 * - redeemDollar(amount): burn uUSD, get collateral back at $1
 * - mintDollar(amount): mint uUSD by depositing collateral at $1
 * - dollarBalances(): get pool dollar balance info
 */
export const LIB_UBIQUITY_POOL_ABI = [
  "function redeemDollar(uint256 amount) external",
  "function mintDollar(uint256 amount) external",
  "function dollarBalances() external view returns (uint256 debtBalance, uint256 collateralBalance)",
  "function collateralDollarBalance() external view returns (uint256)",
  "function getDollarPrice() external view returns (uint256)",
  "function owner() external view returns (address)",
];

/** Curve pool ABI for swaps */
export const CURVE_POOL_ABI = [
  "function exchange(int128 i, int128 j, uint256 dx, uint256 minDy) external returns (uint256)",
  "function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256)",
  "function get_virtual_price() external view returns (uint256)",
  "function balances(uint256) external view returns (uint256)",
];

/** ERC20 ABI */
export const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address) external view returns (uint256)",
  "function decimals() external view returns (uint8)",
  "function transfer(address to, uint256 amount) external returns (bool)",
  "function allowance(address owner, address spender) external view returns (uint256)",
];
