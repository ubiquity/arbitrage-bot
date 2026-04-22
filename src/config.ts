/**
 * Chain and pool configuration for multi-chain Curve arbitrage.
 *
 * Targets:
 *   - Mainnet: Curve factory-stable-ng-164
 *   - Gnosis:  Curve factory-stable-ng-29
 */

export interface ChainConfig {
  readonly chainId: number;
  readonly name: string;
  readonly rpcUrl: string;
  readonly poolAddress: string;
  readonly poolId: string;
  readonly nativeCurrency: {
    readonly name: string;
    readonly symbol: string;
    readonly decimals: number;
  };
  readonly blockTimeMs: number;
  readonly gasEstimate: bigint;
}

export interface ArbitrageConfig {
  readonly chains: Record<string, ChainConfig>;
  readonly pollIntervalMs: number;
  readonly minProfitThreshold: bigint;
  readonly tradeAmount: bigint;
  readonly maxGasPrice: bigint;
  readonly slippageBps: number;
}

export const CHAINS: Record<string, ChainConfig> = {
  mainnet: {
    chainId: 1,
    name: "Ethereum Mainnet",
    rpcUrl: process.env.MAINNET_RPC_URL || "https://eth.llamarpc.com",
    poolAddress: "0x6F0154E0136ECb549D3F9DEBc2bEF98Ee4BE5B04",
    poolId: "factory-stable-ng-164",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    blockTimeMs: 12_000,
    gasEstimate: 250_000n,
  },
  gnosis: {
    chainId: 100,
    name: "Gnosis Chain",
    rpcUrl: process.env.GNOSIS_RPC_URL || "https://rpc.gnosis.gateway.fm",
    poolAddress: "0x5B0d2830C4D5Cd19342F15eaa4D4b9Cd398F020e",
    poolId: "factory-stable-ng-29",
    nativeCurrency: { name: "xDai", symbol: "XDAI", decimals: 18 },
    blockTimeMs: 5_000,
    gasEstimate: 200_000n,
  },
};

export const DEFAULT_CONFIG: ArbitrageConfig = {
  chains: CHAINS,
  pollIntervalMs: 15_000,
  minProfitThreshold: parseUnits("0.01", 18),
  tradeAmount: parseUnits("1000", 18),
  maxGasPrice: parseUnits("50", 9),
  slippageBps: 50,
};

function parseUnits(value: string, decimals: number): bigint {
  const [integer, fraction = ""] = value.split(".");
  const padded = fraction.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(integer + padded);
}
