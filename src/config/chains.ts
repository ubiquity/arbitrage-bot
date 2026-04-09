/**
 * Chain configuration for multi-chain arbitrage between Mainnet and Gnosis.
 *
 * Target Curve pools:
 *   Mainnet: factory-stable-ng-164
 *   Gnosis:  factory-stable-ng-29
 */

export interface ChainConfig {
  chainId: number;
  name: string;
  rpcUrl: string;
  curvePoolAddress: string;
  curvePoolFactoryNgIndex: number;
  bridgeAddress: string;
  nativeTokenSymbol: string;
  gasLimit: {
    swap: number;
    bridge: number;
    approve: number;
  };
  tokens: Record<string, string>;
}

export const CHAINS: Record<string, ChainConfig> = {
  mainnet: {
    chainId: 1,
    name: "Ethereum Mainnet",
    rpcUrl: process.env.MAINNET_RPC_URL || "https://eth.llamarpc.com",
    curvePoolAddress: "0x0000000000000000000000000000000000000000", // factory-stable-ng-164 — replace with actual address
    curvePoolFactoryNgIndex: 164,
    bridgeAddress: "0x88ad09518695c6c3712AC10a214bE5109a613671", // Gnosis Bridge (xDAI Omnibridge)
    nativeTokenSymbol: "ETH",
    gasLimit: {
      swap: 300_000,
      bridge: 200_000,
      approve: 60_000,
    },
    tokens: {
      DAI: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      USDC: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      USDT: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
      LUSD: "0x5f98805A4E8be255a32880FDeC7F6728C6568bA0",
      UUSD: "0x0000000000000000000000000000000000000000", // replace with actual UUSD mainnet address
    },
  },
  gnosis: {
    chainId: 100,
    name: "Gnosis Chain",
    rpcUrl: process.env.GNOSIS_RPC_URL || "https://rpc.gnosischain.com",
    curvePoolAddress: "0x0000000000000000000000000000000000000000", // factory-stable-ng-29 — replace with actual address
    curvePoolFactoryNgIndex: 29,
    bridgeAddress: "0xf6A78083ca3e2a662D6dd1703c939c8aCE2e268d", // Omnibridge on Gnosis side
    nativeTokenSymbol: "xDAI",
    gasLimit: {
      swap: 500_000,
      bridge: 300_000,
      approve: 60_000,
    },
    tokens: {
      WXDAI: "0xe91D153E0b41518A2Ce8Dd3D7944Fa863463a97d",
      USDC: "0xDDAfbb505ad214D7b80b1f830fcCc89B60fb7A83",
      USDT: "0x4ECaBa5870353805a9F068101A40E0f32ed605C6",
      UUSD: "0x0000000000000000000000000000000000000000", // replace with actual UUSD gnosis address
    },
  },
};

/** Bridge relayer fee (in USD approximation) */
export const BRIDGE_FEES = {
  mainnetToGnosis: 0.5, // ~$0.50 gas on mainnet side
  gnosisToMainnet: 1.0, // slightly higher for L1 gas reimbursement
};

/** Minimum profit threshold in USD to execute a trade */
export const MIN_PROFIT_USD = parseFloat(process.env.MIN_PROFIT_USD || "5");

/** How often to poll prices (ms) */
export const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || "10000", 10);
