/**
 * Swap Executor — Executes arbitrage swaps via DEX contracts and LibUbiquityPool.
 *
 * Handles:
 * - ERC20 approvals
 * - Curve pool swaps (exchange)
 * - Uniswap V3 exact input swaps
 * - SushiSwap router swaps
 * - LibUbiquityPool mint/redeem operations
 */

import { ethers } from "ethers";
import {
  type BotConfig,
  type ArbOpportunity,
  type SwapResult,
  type Network,
  CURVE_POOL_ABI,
  ERC20_ABI,
  LIB_UBIQUITY_POOL_ABI,
  LIB_UBIQUITY_POOL,
  TOKENS,
} from "./types";

/** Uniswap V3 SwapRouter ABI */
const UNISWAP_V3_ROUTER_ABI = [
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external returns (uint256 amountOut)",
];

/** SushiSwap Router ABI */
const SUSHISWAP_ROUTER_ABI = [
  "function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, address[] calldata path, address to, uint256 deadline) external returns (uint256[] memory amounts)",
];

/** Uniswap V3 SwapRouter addresses */
const UNISWAP_V3_ROUTER: Record<Network, string> = {
  ethereum: "0xE592427A0AEce92De3Edee1F18E0157C05861564",
  gnosis: "0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E",
};

/** SushiSwap Router addresses */
const SUSHISWAP_ROUTER: Record<Network, string> = {
  ethereum: "0xd9e1cE17f2641f24aE83637ab66a2cca9C378B9F",
  gnosis: "0x1b02dA8cb0d097eB8D57A175b8817D5a43f2CADE",
};

export class SwapExecutor {
  private ethWallet: ethers.Wallet;
  private gnoWallet: ethers.Wallet;
  private config: BotConfig;

  constructor(config: BotConfig) {
    this.config = config;
    const ethProvider = new ethers.providers.JsonRpcProvider(config.ethereumRpc);
    const gnoProvider = new ethers.providers.JsonRpcProvider(config.gnosisRpc);
    this.ethWallet = new ethers.Wallet(config.privateKey, ethProvider);
    this.gnoWallet = new ethers.Wallet(config.privateKey, gnoProvider);
  }

  private getWallet(network: Network): ethers.Wallet {
    return network === "ethereum" ? this.ethWallet : this.gnoWallet;
  }

  /**
   * Execute an arbitrage opportunity.
   * Depending on direction:
   * - buy: Buy uUSD on DEX at discount, then redeem via LibUbiquityPool
   * - sell: Mint uUSD via LibUbiquityPool, then sell on DEX at premium
   */
  async execute(opp: ArbOpportunity): Promise<SwapResult> {
    const wallet = this.getWallet(opp.network);
    const startTime = Date.now();

    try {
      // Check gas price
      const gasPrice = await wallet.provider.getGasPrice();
      if (gasPrice.gt(this.config.maxGasPrice)) {
        return {
          success: false,
          amountIn: opp.amountIn,
          gasCost: "0",
          netPnl: "0",
          error: `Gas price ${ethers.utils.formatUnits(gasPrice, "gwei")} gwei exceeds max ${ethers.utils.formatUnits(this.config.maxGasPrice, "gwei")} gwei`,
          timestamp: startTime,
        };
      }

      let txHash: string;
      let gasUsed = 0;

      if (opp.direction === "buy") {
        // Buy uUSD on DEX, then redeem via pool
        const swapResult = await this.executeDexBuy(opp, wallet, gasPrice);
        if (!swapResult.success) return swapResult;
        txHash = swapResult.txHash!;
        gasUsed = swapResult.gasUsed ?? 0;

        // Redeem via LibUbiquityPool
        const redeemResult = await this.executePoolRedeem(opp, wallet, gasPrice);
        if (!redeemResult.success) {
          // DEX swap succeeded but pool redeem failed — log but still report
          console.error("[SwapExecutor] Pool redeem failed:", redeemResult.error);
        }
        if (redeemResult.gasUsed) gasUsed += redeemResult.gasUsed;
        if (redeemResult.txHash) txHash = `${txHash},${redeemResult.txHash}`;
      } else {
        // Mint via LibUbiquityPool, then sell on DEX
        const mintResult = await this.executePoolMint(opp, wallet, gasPrice);
        if (!mintResult.success) return mintResult;
        if (mintResult.gasUsed) gasUsed += mintResult.gasUsed;
        txHash = mintResult.txHash!;

        const swapResult = await this.executeDexSell(opp, wallet, gasPrice);
        if (!swapResult.success) {
          console.error("[SwapExecutor] DEX sell failed:", swapResult.error);
        }
        if (swapResult.gasUsed) gasUsed += swapResult.gasUsed;
        if (swapResult.txHash) txHash = `${txHash},${swapResult.txHash}`;
      }

      const totalGasCost = gasPrice.mul(gasUsed);

      return {
        success: true,
        txHash,
        amountIn: opp.amountIn,
        amountOut: opp.expectedAmountOut,
        gasUsed,
        gasCost: totalGasCost.toString(),
        netPnl: opp.netProfit,
        timestamp: startTime,
      };
    } catch (err) {
      return {
        success: false,
        amountIn: opp.amountIn,
        gasCost: "0",
        netPnl: "0",
        error: (err as Error).message,
        timestamp: startTime,
      };
    }
  }

  /**
   * Execute a DEX swap to buy uUSD.
   */
  private async executeDexBuy(
    opp: ArbOpportunity,
    wallet: ethers.Wallet,
    gasPrice: ethers.BigNumber
  ): Promise<SwapResult> {
    const tokenIn = new ethers.Contract(opp.tokenIn, ERC20_ABI, wallet);

    // Approve DEX to spend tokens
    const approveTx = await tokenIn.approve(opp.pool, opp.amountIn, { gasPrice, gasLimit: 100000 });
    await approveTx.wait();

    // Execute swap based on protocol
    switch (opp.protocol) {
      case "curve":
        return this.executeCurveSwap(opp, wallet, gasPrice, 0, 1);
      case "uniswap-v3":
        return this.executeUniswapV3Swap(opp, wallet, gasPrice, true);
      case "sushiswap":
        return this.executeSushiSwap(opp, wallet, gasPrice, true);
      default:
        return { success: false, amountIn: opp.amountIn, gasCost: "0", netPnl: "0", error: `Unknown protocol: ${opp.protocol}`, timestamp: Date.now() };
    }
  }

  /**
   * Execute a DEX swap to sell uUSD.
   */
  private async executeDexSell(
    opp: ArbOpportunity,
    wallet: ethers.Wallet,
    gasPrice: ethers.BigNumber
  ): Promise<SwapResult> {
    const uUsdToken = new ethers.Contract(opp.tokenIn, ERC20_ABI, wallet);

    // Approve DEX to spend uUSD
    const dexAddress = this.getDexAddress(opp.protocol, opp.network);
    const approveTx = await uUsdToken.approve(dexAddress, opp.amountIn, { gasPrice, gasLimit: 100000 });
    await approveTx.wait();

    switch (opp.protocol) {
      case "curve":
        return this.executeCurveSwap(opp, wallet, gasPrice, 0, 1);
      case "uniswap-v3":
        return this.executeUniswapV3Swap(opp, wallet, gasPrice, false);
      case "sushiswap":
        return this.executeSushiSwap(opp, wallet, gasPrice, false);
      default:
        return { success: false, amountIn: opp.amountIn, gasCost: "0", netPnl: "0", error: `Unknown protocol: ${opp.protocol}`, timestamp: Date.now() };
    }
  }

  /**
   * Execute a Curve pool swap.
   */
  private async executeCurveSwap(
    opp: ArbOpportunity,
    wallet: ethers.Wallet,
    gasPrice: ethers.BigNumber,
    i: number,
    j: number
  ): Promise<SwapResult> {
    const pool = new ethers.Contract(opp.pool, CURVE_POOL_ABI, wallet);
    const tx = await pool.exchange(i, j, opp.amountIn, 0, {
      gasPrice,
      gasLimit: 500000,
    });
    const receipt = await tx.wait();

    return {
      success: true,
      txHash: tx.hash,
      amountIn: opp.amountIn,
      gasUsed: receipt.gasUsed.toNumber(),
      gasCost: receipt.gasUsed.mul(gasPrice).toString(),
      netPnl: opp.netProfit,
      timestamp: Date.now(),
    };
  }

  /**
   * Execute a Uniswap V3 exact input swap.
   */
  private async executeUniswapV3Swap(
    opp: ArbOpportunity,
    wallet: ethers.Wallet,
    gasPrice: ethers.BigNumber,
    isBuy: boolean
  ): Promise<SwapResult> {
    const routerAddress = UNISWAP_V3_ROUTER[opp.network];
    const router = new ethers.Contract(routerAddress, UNISWAP_V3_ROUTER_ABI, wallet);

    const tokenIn = isBuy ? opp.tokenIn : opp.tokenOut;
    const tokenOut = isBuy ? opp.tokenOut : opp.tokenIn;

    const deadline = Math.floor(Date.now() / 1000) + 300; // 5 min
    const tx = await router.exactInputSingle(
      {
        tokenIn,
        tokenOut,
        fee: 3000, // 0.3%
        recipient: wallet.address,
        deadline,
        amountIn: opp.amountIn,
        amountOutMinimum: 0, // In production, set based on slippage tolerance
        sqrtPriceLimitX96: 0,
      },
      { gasPrice, gasLimit: 500000 }
    );
    const receipt = await tx.wait();

    return {
      success: true,
      txHash: tx.hash,
      amountIn: opp.amountIn,
      gasUsed: receipt.gasUsed.toNumber(),
      gasCost: receipt.gasUsed.mul(gasPrice).toString(),
      netPnl: opp.netProfit,
      timestamp: Date.now(),
    };
  }

  /**
   * Execute a SushiSwap swap via the router.
   */
  private async executeSushiSwap(
    opp: ArbOpportunity,
    wallet: ethers.Wallet,
    gasPrice: ethers.BigNumber,
    isBuy: boolean
  ): Promise<SwapResult> {
    const routerAddress = SUSHISWAP_ROUTER[opp.network];
    const router = new ethers.Contract(routerAddress, SUSHISWAP_ROUTER_ABI, wallet);

    const path = isBuy
      ? [opp.tokenIn, opp.tokenOut]
      : [opp.tokenIn, opp.tokenOut];

    const deadline = Math.floor(Date.now() / 1000) + 300;
    const tx = await router.swapExactTokensForTokens(
      opp.amountIn,
      0, // amountOutMin — in production, calculate from expected
      path,
      wallet.address,
      deadline,
      { gasPrice, gasLimit: 500000 }
    );
    const receipt = await tx.wait();

    return {
      success: true,
      txHash: tx.hash,
      amountIn: opp.amountIn,
      gasUsed: receipt.gasUsed.toNumber(),
      gasCost: receipt.gasUsed.mul(gasPrice).toString(),
      netPnl: opp.netProfit,
      timestamp: Date.now(),
    };
  }

  /**
   * Redeem uUSD via LibUbiquityPool for $1 of collateral.
   */
  private async executePoolRedeem(
    opp: ArbOpportunity,
    wallet: ethers.Wallet,
    gasPrice: ethers.BigNumber
  ): Promise<SwapResult> {
    const poolAddress = LIB_UBIQUITY_POOL[opp.network];
    const pool = new ethers.Contract(poolAddress, LIB_UBIQUITY_POOL_ABI, wallet);

    const uUsdToken = new ethers.Contract(opp.tokenOut, ERC20_ABI, wallet);

    // Approve pool to spend uUSD
    const approveTx = await uUsdToken.approve(poolAddress, opp.amountIn, { gasPrice, gasLimit: 100000 });
    await approveTx.wait();

    // Redeem
    const tx = await pool.redeemDollar(opp.amountIn, { gasPrice, gasLimit: 300000 });
    const receipt = await tx.wait();

    return {
      success: true,
      txHash: tx.hash,
      amountIn: opp.amountIn,
      gasUsed: receipt.gasUsed.toNumber(),
      gasCost: receipt.gasUsed.mul(gasPrice).toString(),
      netPnl: "0",
      timestamp: Date.now(),
    };
  }

  /**
   * Mint uUSD via LibUbiquityPool by depositing $1 of collateral.
   */
  private async executePoolMint(
    opp: ArbOpportunity,
    wallet: ethers.Wallet,
    gasPrice: ethers.BigNumber
  ): Promise<SwapResult> {
    const poolAddress = LIB_UBIQUITY_POOL[opp.network];
    const pool = new ethers.Contract(poolAddress, LIB_UBIQUITY_POOL_ABI, wallet);

    const collateralToken = new ethers.Contract(opp.tokenIn, ERC20_ABI, wallet);

    // Approve pool to spend collateral (amount proportional to uUSD amount)
    const approveTx = await collateralToken.approve(poolAddress, opp.amountIn, { gasPrice, gasLimit: 100000 });
    await approveTx.wait();

    // Mint
    const tx = await pool.mintDollar(opp.amountIn, { gasPrice, gasLimit: 300000 });
    const receipt = await tx.wait();

    return {
      success: true,
      txHash: tx.hash,
      amountIn: opp.amountIn,
      gasUsed: receipt.gasUsed.toNumber(),
      gasCost: receipt.gasUsed.mul(gasPrice).toString(),
      netPnl: "0",
      timestamp: Date.now(),
    };
  }

  /**
   * Get the DEX contract address for approvals.
   */
  private getDexAddress(protocol: string, network: Network): string {
    switch (protocol) {
      case "curve":
        return POOLS.find((p) => p.network === network && p.protocol === "curve")?.address ?? "";
      case "uniswap-v3":
        return UNISWAP_V3_ROUTER[network];
      case "sushiswap":
        return SUSHISWAP_ROUTER[network];
      default:
        return "";
    }
  }
}
