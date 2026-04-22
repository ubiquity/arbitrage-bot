/**
 * Price Monitor — Fetches Ubiquity Dollar prices from Curve, Uniswap V3,
 * and SushiSwap on Ethereum Mainnet and Gnosis.
 *
 * Uses raw JSON-RPC calls (no ethers dependency).
 */

import { ethers } from "ethers";
import {
  type BotConfig,
  type PriceData,
  type DexProtocol,
  type Network,
  TOKENS,
  POOLS,
  CURVE_POOL_ABI,
} from "./types";

export class PriceMonitor {
  private ethProvider: ethers.providers.Provider;
  private gnoProvider: ethers.providers.Provider;

  constructor(ethRpc: string, gnoRpc: string) {
    this.ethProvider = new ethers.providers.JsonRpcProvider(ethRpc);
    this.gnoProvider = new ethers.providers.JsonRpcProvider(gnoRpc);
  }

  private getProvider(network: Network): ethers.providers.Provider {
    return network === "ethereum" ? this.ethProvider : this.gnoProvider;
  }

  /**
   * Fetch Ubiquity Dollar prices from all configured pools.
   */
  async getAllPrices(): Promise<PriceData[]> {
    const prices: PriceData[] = [];

    for (const pool of POOLS) {
      try {
        const provider = this.getProvider(pool.network);
        const price = await this.fetchPoolPrice(pool, provider);
        if (price > 0) {
          prices.push({
            pool: pool.address,
            protocol: pool.protocol,
            network: pool.network,
            baseToken: pool.tokens[0].symbol,
            quoteToken: pool.tokens[1].symbol,
            price,
            liquidity: "0",
            timestamp: Date.now(),
          });
        }
      } catch (err) {
        console.error(
          `[PriceMonitor] Failed to fetch price for pool ${pool.address}:`,
          (err as Error).message
        );
      }
    }

    // Also try Uniswap V3 on mainnet
    try {
      const uniPrice = await this.fetchUniswapV3Price();
      if (uniPrice > 0) {
        prices.push({
          pool: "uniswap-v3",
          protocol: "uniswap-v3",
          network: "ethereum",
          baseToken: "uUSD",
          quoteToken: "USDC",
          price: uniPrice,
          liquidity: "0",
          timestamp: Date.now(),
        });
      }
    } catch {
      // Uniswap V3 may not be deployed for uUSD, skip silently
    }

    // Also try SushiSwap on Gnosis
    try {
      const sushiPrice = await this.fetchSushiSwapPrice();
      if (sushiPrice > 0) {
        prices.push({
          pool: "sushiswap",
          protocol: "sushiswap",
          network: "gnosis",
          baseToken: "uUSD",
          quoteToken: "wxDAI",
          price: sushiPrice,
          liquidity: "0",
          timestamp: Date.now(),
        });
      }
    } catch {
      // Skip silently
    }

    return prices;
  }

  /**
   * Fetch price from a Curve pool using get_dy.
   */
  private async fetchPoolPrice(
    pool: (typeof POOLS)[number],
    provider: ethers.providers.Provider
  ): Promise<number> {
    if (pool.protocol === "curve") {
      return this.fetchCurvePrice(pool.address, provider);
    }
    return 0;
  }

  /**
   * Fetch Curve pool price: swap 1 unit of uUSD to get the quote amount.
   */
  private async fetchCurvePrice(
    poolAddress: string,
    provider: ethers.providers.Provider
  ): Promise<number> {
    const contract = new ethers.Contract(poolAddress, CURVE_POOL_ABI, provider);

    // get_dy(0, 1, 1e18) — swap 1 uUSD (18 decimals) for USDC
    const amountOut = await contract.get_dy(0, 1, ethers.utils.parseUnits("1", 18));
    // USDC has 6 decimals
    return parseFloat(ethers.utils.formatUnits(amountOut, 6));
  }

  /**
   * Fetch Uniswap V3 price using the Quoter contract.
   * Quoter address on mainnet: 0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6
   */
  private async fetchUniswapV3Price(): Promise<number> {
    const quoterAddress = "0xb27308f9F90D607463bb33eA1BeBb41C27CE5AB6";
    const quoterAbi = [
      "function quoteExactInputSingle(address tokenIn, address tokenOut, uint24 fee, uint256 amountIn, uint160 sqrtPriceLimitX96) external returns (uint256 amountOut)",
    ];

    const contract = new ethers.Contract(quoterAddress, quoterAbi, this.ethProvider);
    // Quote swapping 1 uUSD for USDC via 0.3% fee tier
    const amountOut = await contract.callStatic.quoteExactInputSingle(
      TOKENS.uUSD_ETH.address,
      TOKENS.USDC_ETH.address,
      3000, // 0.3% fee tier
      ethers.utils.parseUnits("1", 18),
      0 // no price limit
    );

    return parseFloat(ethers.utils.formatUnits(amountOut, 6));
  }

  /**
   * Fetch SushiSwap price on Gnosis using the router.
   */
  private async fetchSushiSwapPrice(): Promise<number> {
    // SushiSwap on Gnosis uses the same UniswapV2-compatible interface
    const routerAddress = "0x1b02dA8cb0d097eB8D57A175b8817D5a43f2CADE";
    const routerAbi = [
      "function getAmountsOut(uint256 amountIn, address[] calldata path) external view returns (uint256[] memory amounts)",
    ];

    const contract = new ethers.Contract(routerAddress, routerAbi, this.gnoProvider);
    const amounts = await contract.getAmountsOut(ethers.utils.parseUnits("1", 18), [
      TOKENS.uUSD_GNO.address,
      TOKENS.WXDAI_GNO.address,
    ]);

    // wxDAI has 18 decimals, price is ~$1
    return parseFloat(ethers.utils.formatUnits(amounts[1], 18));
  }

  /**
   * Get current gas price for a network.
   */
  async getGasPrice(network: Network): Promise<ethers.BigNumber> {
    const provider = this.getProvider(network);
    return provider.getGasPrice();
  }
}
