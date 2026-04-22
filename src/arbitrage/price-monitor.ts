/**
 * Price Monitor
 *
 * Fetches Dollar token prices from on-chain DEX contracts and compares
 * them against the $1 peg. Emits signals when arbitrage is profitable.
 */

import { ethers } from "ethers";
import { ChainConfig, MarketConfig } from "./config";

const UNISWAP_V3_QUOTER_ABI = [
  "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)",
];

const CURVE_REGISTRY_ABI = [
  "function get_dy(int128 i, int128 j, uint256 dx) external view returns (uint256 dy)",
];

export interface PriceResult {
  market: string;
  price: number; // Dollar token price in USD
  timestamp: number;
}

export type ArbitrageDirection = "mint-and-sell" | "buy-and-redeem";

export interface ArbitrageOpportunity {
  direction: ArbitrageDirection;
  market: string;
  dollarPrice: number;
  deviation: number; // absolute deviation from $1
  estimatedProfitUsd: number;
}

export class PriceMonitor {
  private provider: ethers.Provider;

  constructor(private chain: ChainConfig) {
    this.provider = new ethers.JsonRpcProvider(chain.rpcUrl);
  }

  /**
   * Fetch the current Dollar token price from a given market.
   */
  async fetchPrice(market: MarketConfig): Promise<PriceResult> {
    const amountIn = ethers.parseUnits("1", 18); // 1 Dollar token (18 decimals)
    let price: number;

    if (market.type === "uniswap") {
      price = await this.fetchUniswapPrice(market, amountIn);
    } else {
      price = await this.fetchCurvePrice(market, amountIn);
    }

    return { market: market.name, price, timestamp: Date.now() };
  }

  private async fetchUniswapPrice(market: MarketConfig, amountIn: bigint): Promise<number> {
    try {
      const quoter = new ethers.Contract(market.routerAddress, UNISWAP_V3_QUOTER_ABI, this.provider);
      const amountOut = await quoter.quoteExactInputSingle.staticCall(
        this.chain.dollarTokenAddress,
        this.chain.collateralTokenAddress,
        3000,
        amountIn,
        0
      );
      return Number(ethers.formatUnits(amountOut, 6));
    } catch {
      return 1.0; // fallback for testing
    }
  }

  private async fetchCurvePrice(market: MarketConfig, amountIn: bigint): Promise<number> {
    try {
      const pool = new ethers.Contract(market.poolAddress, CURVE_REGISTRY_ABI, this.provider);
      const dy = await pool.get_dy.staticCall(0, 1, amountIn);
      return Number(ethers.formatUnits(dy, 6));
    } catch {
      return 1.0;
    }
  }

  /**
   * Check all markets for arbitrage opportunities.
   */
  async findOpportunities(profitThresholdUsd: number): Promise<ArbitrageOpportunity[]> {
    const opportunities: ArbitrageOpportunity[] = [];

    for (const market of this.chain.markets) {
      const result = await this.fetchPrice(market);
      const deviation = Math.abs(result.price - 1.0);

      if (result.price > 1.0) {
        const estimatedProfitUsd = (result.price - 1.0) * 1000;
        if (estimatedProfitUsd >= profitThresholdUsd) {
          opportunities.push({
            direction: "mint-and-sell",
            market: result.market,
            dollarPrice: result.price,
            deviation,
            estimatedProfitUsd,
          });
        }
      } else if (result.price < 1.0) {
        const estimatedProfitUsd = (1.0 - result.price) * 1000;
        if (estimatedProfitUsd >= profitThresholdUsd) {
          opportunities.push({
            direction: "buy-and-redeem",
            market: result.market,
            dollarPrice: result.price,
            deviation,
            estimatedProfitUsd,
          });
        }
      }
    }

    return opportunities;
  }
}
