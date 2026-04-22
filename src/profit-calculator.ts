/**
 * Profit Calculator — Determines arbitrage profitability including gas, fees, and slippage.
 *
 * Supports two arbitrage strategies:
 * 1. DEX ↔ DEX: Buy low on one DEX, sell high on another
 * 2. DEX ↔ LibUbiquityPool: Buy/sell on DEX when price deviates, redeem/mint via pool at $1
 */

import { ethers } from "ethers";
import { type PriceData, type ArbOpportunity, type TradeDirection, type Network } from "./types";

export interface ProfitResult {
  expectedOut: string;
  grossProfit: string;
  gasCost: string;
  netProfit: string;
}

/** Estimated gas units per operation type */
const GAS_ESTIMATES = {
  curveSwap: 150000,
  uniswapV3Swap: 200000,
  sushiswapSwap: 160000,
  poolMint: 120000,
  poolRedeem: 120000,
  erc20Approve: 46000,
};

/** DEX fee in basis points */
const DEX_FEES_BPS: Record<string, number> = {
  curve: 4, // 0.04%
  "uniswap-v3": 30, // 0.3%
  sushiswap: 30, // 0.3%
};

export class ProfitCalculator {
  private ethGasPrice: ethers.BigNumber;
  private gnoGasPrice: ethers.BigNumber;
  private ethPriceUsd: number;

  constructor(ethGasPriceGwei = 20, gnoGasPriceGwei = 1, ethPriceUsd = 2000) {
    this.ethGasPrice = ethers.utils.parseUnits(ethGasPriceGwei.toString(), "gwei");
    this.gnoGasPrice = ethers.utils.parseUnits(gnoGasPriceGwei.toString(), "gwei");
    this.ethPriceUsd = ethPriceUsd;
  }

  /**
   * Update gas prices from the network.
   */
  updateGasPrices(ethGas: ethers.BigNumber, gnoGas: ethers.BigNumber): void {
    this.ethGasPrice = ethGas;
    this.gnoGasPrice = gnoGas;
  }

  /**
   * Calculate profit for buying uUSD below peg (price < $1).
   * Strategy: Buy uUSD on DEX at discount, redeem via LibUbiquityPool for $1 collateral.
   */
  calculateBuyProfit(
    price: PriceData,
    amountIn: ethers.BigNumberish,
    peg: number
  ): ProfitResult {
    const amount = ethers.BigNumber.from(amountIn);

    // How much USDC we spend to buy uUSD
    const costInStable = amount.mul(Math.floor(price.price * 1e6)).div(1e6);

    // How much we get back redeeming at $1 via pool
    const redemptionValue = amount.mul(Math.floor(peg * 1e6)).div(1e6);

    // Gross profit = redemption value - cost
    const grossProfit = redemptionValue.sub(costInStable);

    // Gas: DEX swap + pool redemption + 1 approval
    const gasCost = this.estimateTotalGas(
      price.network,
      price.protocol,
      "buy"
    );

    const netProfit = grossProfit.gt(gasCost) ? grossProfit.sub(gasCost) : ethers.BigNumber.from(0);

    return {
      expectedOut: redemptionValue.toString(),
      grossProfit: grossProfit.toString(),
      gasCost: gasCost.toString(),
      netProfit: netProfit.toString(),
    };
  }

  /**
   * Calculate profit for selling uUSD above peg (price > $1).
   * Strategy: Mint uUSD via LibUbiquityPool at $1, sell on DEX at premium.
   */
  calculateSellProfit(
    price: PriceData,
    amountIn: ethers.BigNumberish,
    peg: number
  ): ProfitResult {
    const amount = ethers.BigNumber.from(amountIn);

    // How much it costs to mint uUSD (at $1 peg)
    const mintCost = amount.mul(Math.floor(peg * 1e6)).div(1e6);

    // How much we get selling on DEX at premium
    const saleProceeds = amount.mul(Math.floor(price.price * 1e6)).div(1e6);

    // Gross profit = sale proceeds - mint cost
    const grossProfit = saleProceeds.sub(mintCost);

    // Gas: pool mint + DEX swap + 1 approval
    const gasCost = this.estimateTotalGas(
      price.network,
      price.protocol,
      "sell"
    );

    const netProfit = grossProfit.gt(gasCost) ? grossProfit.sub(gasCost) : ethers.BigNumber.from(0);

    return {
      expectedOut: saleProceeds.toString(),
      grossProfit: grossProfit.toString(),
      gasCost: gasCost.toString(),
      netProfit: netProfit.toString(),
    };
  }

  /**
   * Calculate DEX-to-DEX arbitrage profit.
   * Buy on the cheaper DEX, sell on the more expensive one.
   */
  calculateCrossDexProfit(
    buyPrice: PriceData,
    sellPrice: PriceData,
    amountIn: ethers.BigNumberish
  ): ProfitResult {
    const amount = ethers.BigNumber.from(amountIn);

    // Cost to buy
    const buyCost = amount.mul(Math.floor(buyPrice.price * 1e6)).div(1e6);

    // Proceeds from selling
    const saleProceeds = amount.mul(Math.floor(sellPrice.price * 1e6)).div(1e6);

    const grossProfit = saleProceeds.sub(buyCost);

    // Gas: two swaps
    const buyGas = this.getSwapGasCost(buyPrice.network, buyPrice.protocol);
    const sellGas = this.getSwapGasCost(sellPrice.network, sellPrice.protocol);
    const gasCost = buyGas.add(sellGas);

    const netProfit = grossProfit.gt(gasCost) ? grossProfit.sub(gasCost) : ethers.BigNumber.from(0);

    return {
      expectedOut: saleProceeds.toString(),
      grossProfit: grossProfit.toString(),
      gasCost: gasCost.toString(),
      netProfit: netProfit.toString(),
    };
  }

  /**
   * Estimate total gas cost for a full arbitrage cycle.
   */
  private estimateTotalGas(
    network: Network,
    protocol: string,
    direction: TradeDirection
  ): ethers.BigNumber {
    const gasPrice = network === "ethereum" ? this.ethGasPrice : this.gnoGasPrice;
    const swapGas = this.getGasUnitsForProtocol(protocol);
    const poolGas = direction === "buy" ? GAS_ESTIMATES.poolRedeem : GAS_ESTIMATES.poolMint;

    // Total gas units = swap + pool operation + approval
    const totalGasUnits = swapGas + poolGas + GAS_ESTIMATES.erc20Approve;

    return gasPrice.mul(totalGasUnits);
  }

  /**
   * Get gas cost for a single swap on a DEX.
   */
  private getSwapGasCost(network: Network, protocol: string): ethers.BigNumber {
    const gasPrice = network === "ethereum" ? this.ethGasPrice : this.gnoGasPrice;
    const gasUnits = this.getGasUnitsForProtocol(protocol);
    return gasPrice.mul(gasUnits);
  }

  /**
   * Get estimated gas units for a protocol swap.
   */
  private getGasUnitsForProtocol(protocol: string): number {
    switch (protocol) {
      case "curve":
        return GAS_ESTIMATES.curveSwap;
      case "uniswap-v3":
        return GAS_ESTIMATES.uniswapV3Swap;
      case "sushiswap":
        return GAS_ESTIMATES.sushiswapSwap;
      default:
        return 200000;
    }
  }

  /**
   * Get DEX fee in basis points.
   */
  getDexFeeBps(protocol: string): number {
    return DEX_FEES_BPS[protocol] ?? 30;
  }

  /**
   * Convert gas cost to USD equivalent.
   */
  gasCostToUsd(gasCostWei: ethers.BigNumberish, network: Network): number {
    const cost = ethers.BigNumber.from(gasCostWei);
    if (network === "ethereum") {
      const costEth = parseFloat(ethers.utils.formatEther(cost));
      return costEth * this.ethPriceUsd;
    } else {
      // XDAI ≈ $1
      return parseFloat(ethers.utils.formatEther(cost));
    }
  }
}
