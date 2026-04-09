/**
 * Trade Executor
 *
 * Executes arbitrage trades by interacting with the LibUbiquityPool diamond
 * contract for minting/redeeming Dollar tokens and DEX routers for swaps.
 */

import { ethers } from "ethers";
import { ChainConfig, BotConfig } from "./config";
import { ArbitrageOpportunity } from "./price-monitor";

const POOL_ABI = [
  "function mintDollar(uint256 collateralAmount) external returns (uint256 dollarAmount)",
  "function redeemDollar(uint256 dollarAmount) external returns (uint256 collateralAmount)",
];

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) external returns (bool)",
  "function balanceOf(address owner) view returns (uint256)",
];

const UNISWAP_V3_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut)",
];

export interface TradeResult {
  success: boolean;
  txHash?: string;
  profitUsd?: number;
  gasUsed?: bigint;
  error?: string;
}

export class Executor {
  private provider: ethers.Provider;
  private wallet: ethers.Wallet;
  private poolContract: ethers.Contract;
  private dollarToken: ethers.Contract;
  private collateralToken: ethers.Contract;

  constructor(private chain: ChainConfig, private config: BotConfig) {
    this.provider = new ethers.JsonRpcProvider(chain.rpcUrl);

    const privateKey = process.env[config.privateKeyEnvVar];
    if (!privateKey) {
      throw new Error(`Private key not found in env var: ${config.privateKeyEnvVar}`);
    }
    this.wallet = new ethers.Wallet(privateKey, this.provider);

    this.poolContract = new ethers.Contract(chain.poolDiamondAddress, POOL_ABI, this.wallet);
    this.dollarToken = new ethers.Contract(chain.dollarTokenAddress, ERC20_ABI, this.wallet);
    this.collateralToken = new ethers.Contract(chain.collateralTokenAddress, ERC20_ABI, this.wallet);
  }

  /**
   * Estimate gas cost in USD for a transaction.
   */
  async estimateGasCostUsd(gasLimit: bigint): Promise<number> {
    const feeData = await this.provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? 0n;
    const gasCostWei = gasPrice * gasLimit;
    const gasCostEth = Number(ethers.formatEther(gasCostWei));
    const ethPriceUsd = Number(process.env.ETH_PRICE_USD) || 3000;
    return gasCostEth * ethPriceUsd;
  }

  /**
   * Execute a mint-and-sell arbitrage.
   * 1. Approve collateral to the pool
   * 2. Mint Dollar tokens from the pool at $1
   * 3. Sell Dollar tokens on the DEX for profit
   */
  async executeMintAndSell(opportunity: ArbitrageOpportunity): Promise<TradeResult> {
    try {
      const tradeAmount = ethers.parseUnits(
        Math.min(this.config.maxTradeAmount, opportunity.estimatedProfitUsd * 2).toString(),
        18
      );

      const gasEstimate = await this.poolContract.mintDollar.estimateGas(tradeAmount);
      const gasCostUsd = await this.estimateGasCostUsd(gasEstimate);
      const netProfit = opportunity.estimatedProfitUsd - gasCostUsd;

      if (netProfit < this.config.profitThresholdUsd) {
        return { success: false, error: `Not profitable after gas. Est profit: $${netProfit.toFixed(2)}` };
      }

      const feeData = await this.provider.getFeeData();
      const gasPriceGwei = Number(ethers.formatUnits(feeData.gasPrice ?? 0n, "gwei"));
      if (gasPriceGwei > this.config.gasPriceLimitGwei) {
        return { success: false, error: `Gas price too high: ${gasPriceGwei.toFixed(1)} gwei` };
      }

      // Approve collateral
      const collateralAmount = tradeAmount;
      const approveTx = await this.collateralToken.approve(this.chain.poolDiamondAddress, collateralAmount);
      await approveTx.wait();

      // Mint Dollar tokens
      const mintTx = await this.poolContract.mintDollar(collateralAmount);
      const mintReceipt = await mintTx.wait();

      // Sell on DEX (Uniswap)
      const sellAmount = await this.dollarToken.balanceOf(this.wallet.address);
      if (sellAmount > 0n) {
        await this.dollarToken.approve(this.chain.markets[0].routerAddress, sellAmount);
        const router = new ethers.Contract(this.chain.markets[0].routerAddress, UNISWAP_V3_ROUTER_ABI, this.wallet);
        const sellTx = await router.exactInputSingle({
          tokenIn: this.chain.dollarTokenAddress,
          tokenOut: this.chain.collateralTokenAddress,
          fee: 3000,
          recipient: this.wallet.address,
          deadline: Math.floor(Date.now() / 1000) + 600,
          amountIn: sellAmount,
          amountOutMinimum: 0n,
          sqrtPriceLimitX96: 0n,
        });
        await sellTx.wait();
      }

      return { success: true, txHash: mintReceipt?.hash, profitUsd: netProfit, gasUsed: mintReceipt?.gasUsed ?? 0n };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  /**
   * Execute a buy-and-redeem arbitrage.
   * 1. Buy cheap Dollar tokens on DEX
   * 2. Redeem Dollar tokens in pool for $1 collateral
   */
  async executeBuyAndRedeem(opportunity: ArbitrageOpportunity): Promise<TradeResult> {
    try {
      const tradeAmount = ethers.parseUnits(
        Math.min(this.config.maxTradeAmount, opportunity.estimatedProfitUsd * 2).toString(),
        18
      );

      const collateralAmount = ethers.parseUnits(
        (Number(ethers.formatUnits(tradeAmount, 18)) * opportunity.dollarPrice).toFixed(6),
        6
      );

      await this.collateralToken.approve(this.chain.markets[0].routerAddress, collateralAmount);
      const router = new ethers.Contract(this.chain.markets[0].routerAddress, UNISWAP_V3_ROUTER_ABI, this.wallet);
      const buyTx = await router.exactInputSingle({
        tokenIn: this.chain.collateralTokenAddress,
        tokenOut: this.chain.dollarTokenAddress,
        fee: 3000,
        recipient: this.wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 600,
        amountIn: collateralAmount,
        amountOutMinimum: tradeAmount,
        sqrtPriceLimitX96: 0n,
      });
      await buyTx.wait();

      const dollarBalance = await this.dollarToken.balanceOf(this.wallet.address);
      await this.dollarToken.approve(this.chain.poolDiamondAddress, dollarBalance);

      const gasEstimate = await this.poolContract.redeemDollar.estimateGas(dollarBalance);
      const gasCostUsd = await this.estimateGasCostUsd(gasEstimate);
      const netProfit = opportunity.estimatedProfitUsd - gasCostUsd;

      if (netProfit < this.config.profitThresholdUsd) {
        return { success: false, error: `Not profitable after gas. Est profit: $${netProfit.toFixed(2)}` };
      }

      const redeemTx = await this.poolContract.redeemDollar(dollarBalance);
      const redeemReceipt = await redeemTx.wait();

      return { success: true, txHash: redeemReceipt?.hash, profitUsd: netProfit, gasUsed: redeemReceipt?.gasUsed ?? 0n };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
