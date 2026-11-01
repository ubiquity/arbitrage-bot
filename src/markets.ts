// cspell:words dai gnosis xdai wxdai uusd lusd mainnet relayer calldata requote requotes underdelivery
export type ChainId = 1 | 100;

export interface Asset {
  readonly chainId: ChainId;
  readonly symbol: string;
  // Every asset in this route uses 18 decimals. Native assets are explicitly marked.
  readonly isNative?: boolean;
}

export const ASSETS = {
  eth: { chainId: 1, symbol: "ETH", isNative: true },
  dai: { chainId: 1, symbol: "DAI" },
  xdai: { chainId: 100, symbol: "xDAI", isNative: true },
  wxdai: { chainId: 100, symbol: "WXDAI" },
  gnosisUusd: { chainId: 100, symbol: "UUSD" },
  mainnetUusd: { chainId: 1, symbol: "UUSD" },
  lusd: { chainId: 1, symbol: "LUSD" },
} as const satisfies Record<string, Asset>;

export interface Market {
  readonly chainId: ChainId;
  readonly poolId: string;
}

// Resolve contract addresses against these exact pool IDs; never guess a pool by symbol.
export const MARKETS = {
  mainnet: { chainId: 1, poolId: "factory-stable-ng-164" },
  gnosis: { chainId: 100, poolId: "factory-stable-ng-29" },
} as const satisfies Record<string, Market>;

export interface RouteLeg {
  readonly id: string;
  readonly kind: "bridge" | "wrap" | "swap";
  readonly from: Asset;
  readonly to: Asset;
  readonly market?: Market;
  // Includes destination claim gas for the UUSD return to Mainnet.
  readonly gasChains: readonly ChainId[];
}

export const ROUTE: readonly RouteLeg[] = [
  { id: "bridge-dai", kind: "bridge", from: ASSETS.dai, to: ASSETS.xdai, gasChains: [1] },
  { id: "wrap-xdai", kind: "wrap", from: ASSETS.xdai, to: ASSETS.wxdai, gasChains: [100] },
  { id: "buy-uusd", kind: "swap", from: ASSETS.wxdai, to: ASSETS.gnosisUusd, market: MARKETS.gnosis, gasChains: [100] },
  { id: "bridge-uusd", kind: "bridge", from: ASSETS.gnosisUusd, to: ASSETS.mainnetUusd, gasChains: [100, 1] },
  { id: "sell-uusd", kind: "swap", from: ASSETS.mainnetUusd, to: ASSETS.lusd, market: MARKETS.mainnet, gasChains: [1] },
];
