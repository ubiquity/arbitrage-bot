/**
 * Arbitrage Bot — Main orchestrator for Ubiquity Dollar peg arbitrage.
 *
 * Strategy:
 * 1. Monitor uUSD prices on Curve, Uniswap V3, and SushiSwap across Ethereum & Gnosis
 * 2. Detect price deviations from the $1 peg
 * 3. When uUSD < $1: Buy on DEX, redeem via LibUbiquityPool for $1 collateral
 * 4. When uUSD > $1: Mint via LibUbiquityPool at $1, sell on DEX at premium
 * 5. Only execute when net profit (after gas + fees) exceeds minimum threshold
 *
 * Also supports DEX-to-DEX arbitrage when price differs across pools.
 */

import { ethers } from "ethers";
import { PriceMonitor } from "./price-monitor";
import { SwapExecutor } from "./swap-executor";
import { ProfitCalculator } from "./profit-calculator";
import {
  type BotConfig,
  type ArbOpportunity,
  type BotStatus,
  type PriceData,
  TOKENS,
} from "./types";

export type { BotConfig, ArbOpportunity } from "./types";

export class ArbitrageBot {
  private monitor: PriceMonitor;
  private executor: SwapExecutor;
  private calculator: ProfitCalculator;
  private config: BotConfig;
  private running = false;
  private startTime = 0;

  // Stats
  private cyclesCompleted = 0;
  private totalTrades = 0;
  private totalProfitWei = ethers.BigNumber.from(0);
  private lastPrice: number | null = null;
  private lastOpportunity: ArbOpportunity | null = null;

  constructor(config: BotConfig) {
    this.config = config;
    this.monitor = new PriceMonitor(config.ethereumRpc, config.gnosisRpc);
    this.executor = new SwapExecutor(config);
    this.calculator = new ProfitCalculator();
  }

  /**
   * Start the arbitrage bot main loop.
   */
  async start(): Promise<void> {
    this.running = true;
    this.startTime = Date.now();

    console.log("═══════════════════════════════════════════");
    console.log("  🤖 Ubiquity Dollar Arbitrage Bot");
    console.log("═══════════════════════════════════════════");
    console.log(`  Peg target:    $${this.config.pegPrice}`);
    console.log(`  Deviation:     ${(this.config.deviationThreshold * 100).toFixed(1)}%`);
    console.log(`  Min profit:    ${ethers.utils.formatEther(this.config.minProfitWei)} ETH`);
    console.log(`  Max gas:       ${ethers.utils.formatUnits(this.config.maxGasPrice, "gwei")} gwei`);
    console.log(`  Interval:      ${this.config.checkIntervalMs}ms`);
    console.log(`  Networks:      Ethereum, Gnosis`);
    console.log("═══════════════════════════════════════════\n");

    while (this.running) {
      try {
        await this.runCycle();
      } catch (err) {
        console.error("[Bot] Cycle error:", (err as Error).message);
      }
      this.cyclesCompleted++;

      await this.sleep(this.config.checkIntervalMs);
    }
  }

  /**
   * Stop the bot gracefully.
   */
  stop(): void {
    this.running = false;
    console.log("\n🛑 Bot stopping after", this.cyclesCompleted, "cycles");
  }

  /**
   * Run a single monitoring + execution cycle.
   */
  async runCycle(): Promise<ArbOpportunity | null> {
    // 1. Fetch prices from all DEXes
    const prices = await this.monitor.getAllPrices();

    if (prices.length === 0) {
      console.log("[Bot] No prices fetched");
      return null;
    }

    // Update last known price (average across sources)
    this.lastPrice = prices.reduce((sum, p) => sum + p.price, 0) / prices.length;
    console.log(
      `[Bot] Prices: ${prices.map((p) => `${p.protocol}/${p.network}: $${p.price.toFixed(4)}`).join(" | ")}`
    );

    // 2. Update gas prices in calculator
    try {
      const ethGas = await this.monitor.getGasPrice("ethereum");
      const gnoGas = await this.monitor.getGasPrice("gnosis");
      this.calculator.updateGasPrices(ethGas, gnoGas);
    } catch {
      // Use defaults
    }

    // 3. Find arbitrage opportunities
    const opportunities = this.findOpportunities(prices);

    if (opportunities.length === 0) {
      return null;
    }

    // 4. Sort by net profit (descending)
    opportunities.sort((a, b) => {
      const diff = ethers.BigNumber.from(b.netProfit).sub(ethers.BigNumber.from(a.netProfit));
      return diff.gt(0) ? 1 : diff.lt(0) ? -1 : 0;
    });

    const best = opportunities[0];
    this.lastOpportunity = best;

    console.log(
      `[Bot] 💡 Best opportunity: ${best.direction} on ${best.protocol}/${best.network} — ` +
        `profit: ${ethers.utils.formatEther(best.netProfit)} ETH`
    );

    // 5. Check profitability threshold
    if (ethers.BigNumber.from(best.netProfit).lt(this.config.minProfitWei)) {
      console.log("[Bot] ⏭️ Below min profit threshold, skipping");
      return null;
    }

    // 6. Execute the arbitrage
    console.log("[Bot] ✅ Executing arbitrage...");
    const result = await this.executor.execute(best);

    if (result.success) {
      this.totalTrades++;
      this.totalProfitWei = this.totalProfitWei.add(result.netPnl);
      console.log(`[Bot] 📝 Trade executed! TX: ${result.txHash}`);
      console.log(`[Bot] 💰 Gas: ${ethers.utils.formatEther(result.gasCost)} ETH | Net PnL: ${ethers.utils.formatEther(result.netPnl)} ETH`);
    } else {
      console.log(`[Bot] ❌ Trade failed: ${result.error}`);
    }

    return best;
  }

  /**
   * Scan prices for arbitrage opportunities:
   * - Peg deviation: uUSD priced ≠ $1 on any DEX
   * - Cross-DEX: price differs between DEXes
   */
  private findOpportunities(prices: PriceData[]): ArbOpportunity[] {
    const peg = this.config.pegPrice;
    const threshold = this.config.deviationThreshold;
    const maxSize = ethers.utils.parseEther(this.config.maxTradeSize);
    const opps: ArbOpportunity[] = [];

    // Strategy 1: Peg deviation arbitrage (DEX ↔ LibUbiquityPool)
    for (const price of prices) {
      const deviation = Math.abs(price.price - peg) / peg;

      if (deviation < threshold) continue;

      if (price.price < peg) {
        // uUSD below peg — buy on DEX, redeem via pool
        const amountIn = this.calculateTradeSize(price, maxSize, peg);
        const profit = this.calculator.calculateBuyProfit(price, amountIn, peg);

        if (ethers.BigNumber.from(profit.netProfit).gt(0)) {
          const tokenInfo = price.network === "ethereum" ? TOKENS.USDC_ETH : TOKENS.USDC_GNO;
          const uUsdInfo = price.network === "ethereum" ? TOKENS.uUSD_ETH : TOKENS.uUSD_GNO;

          opps.push({
            direction: "buy",
            pool: price.pool,
            protocol: price.protocol,
            network: price.network,
            tokenIn: tokenInfo.address,
            tokenOut: uUsdInfo.address,
            amountIn: amountIn.toString(),
            expectedAmountOut: profit.expectedOut,
            estimatedProfit: profit.grossProfit,
            gasCost: profit.gasCost,
            netProfit: profit.netProfit,
          });
        }
      } else {
        // uUSD above peg — mint via pool, sell on DEX
        const amountIn = this.calculateTradeSize(price, maxSize, peg);
        const profit = this.calculator.calculateSellProfit(price, amountIn, peg);

        if (ethers.BigNumber.from(profit.netProfit).gt(0)) {
          const tokenInfo = price.network === "ethereum" ? TOKENS.USDC_ETH : TOKENS.USDC_GNO;
          const uUsdInfo = price.network === "ethereum" ? TOKENS.uUSD_ETH : TOKENS.uUSD_GNO;

          opps.push({
            direction: "sell",
            pool: price.pool,
            protocol: price.protocol,
            network: price.network,
            tokenIn: uUsdInfo.address,
            tokenOut: tokenInfo.address,
            amountIn: amountIn.toString(),
            expectedAmountOut: profit.expectedOut,
            estimatedProfit: profit.grossProfit,
            gasCost: profit.gasCost,
            netProfit: profit.netProfit,
          });
        }
      }
    }

    // Strategy 2: Cross-DEX arbitrage
    if (prices.length >= 2) {
      // Find lowest and highest price
      const sorted = [...prices].sort((a, b) => a.price - b.price);
      const cheapest = sorted[0];
      const mostExpensive = sorted[sorted.length - 1];

      if (cheapest.price < mostExpensive.price) {
        const spread = (mostExpensive.price - cheapest.price) / cheapest.price;
        if (spread > threshold) {
          const amountIn = ethers.utils.parseEther("1000"); // Conservative cross-dex size
          const profit = this.calculator.calculateCrossDexProfit(cheapest, mostExpensive, amountIn);

          if (ethers.BigNumber.from(profit.netProfit).gt(0)) {
            opps.push({
              direction: "buy",
              pool: cheapest.pool,
              protocol: cheapest.protocol,
              network: cheapest.network,
              tokenIn: cheapest.quoteToken === "USDC" ? TOKENS.USDC_ETH.address : TOKENS.WXDAI_GNO.address,
              tokenOut: cheapest.baseToken === "uUSD"
                ? (cheapest.network === "ethereum" ? TOKENS.uUSD_ETH.address : TOKENS.uUSD_GNO.address)
                : TOKENS.USDC_ETH.address,
              amountIn: amountIn.toString(),
              expectedAmountOut: profit.expectedOut,
              estimatedProfit: profit.grossProfit,
              gasCost: profit.gasCost,
              netProfit: profit.netProfit,
            });
          }
        }
      }
    }

    return opps;
  }

  /**
   * Calculate optimal trade size based on price deviation and max size.
   * Higher deviation → larger trade (up to max).
   */
  private calculateTradeSize(
    price: PriceData,
    maxSize: ethers.BigNumber,
    peg: number
  ): ethers.BigNumber {
    const deviation = Math.abs(price.price - peg) / peg;
    // Scale: 0.5% deviation → 25% of max, 1% → 50%, 2%+ → 100%
    const scale = Math.min(deviation / 0.02, 1);
    const scaledSize = maxSize.mul(Math.floor(scale * 10000)).div(10000);

    // Minimum trade size: 100 uUSD
    const minSize = ethers.utils.parseEther("100");
    return scaledSize.gt(minSize) ? scaledSize : minSize;
  }

  /**
   * Get current bot status.
   */
  getStatus(): BotStatus {
    return {
      isRunning: this.running,
      cyclesCompleted: this.cyclesCompleted,
      totalTrades: this.totalTrades,
      totalProfitWei: this.totalProfitWei.toString(),
      lastPrice: this.lastPrice,
      lastOpportunity: this.lastOpportunity,
      lastSwap: null,
      uptimeSeconds: this.startTime > 0 ? Math.floor((Date.now() - this.startTime) / 1000) : 0,
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Allow the event loop to process stop() calls
      timer.unref();
    });
  }
}

/**
 * Main entry point — reads config from environment variables.
 */
export async function main(): Promise<void> {
  const config: BotConfig = {
    ethereumRpc: process.env.ETHEREUM_RPC ?? "https://eth.llamarpc.com",
    gnosisRpc: process.env.GNOSIS_RPC ?? "https://rpc.gnosischain.com",
    privateKey: process.env.PRIVATE_KEY ?? "",
    minProfitWei: process.env.MIN_PROFIT_WEI ?? ethers.utils.parseEther("0.001").toString(),
    maxGasPrice: process.env.MAX_GAS_PRICE ?? ethers.utils.parseUnits("50", "gwei").toString(),
    checkIntervalMs: parseInt(process.env.CHECK_INTERVAL_MS ?? "10000", 10),
    pegPrice: parseFloat(process.env.PEG_PRICE ?? "1.0"),
    deviationThreshold: parseFloat(process.env.DEVIATION_THRESHOLD ?? "0.005"),
    maxTradeSize: process.env.MAX_TRADE_SIZE ?? "10000",
  };

  if (!config.privateKey) {
    console.error("❌ PRIVATE_KEY environment variable is required");
    process.exit(1);
  }

  const bot = new ArbitrageBot(config);

  // Graceful shutdown
  process.on("SIGINT", () => bot.stop());
  process.on("SIGTERM", () => bot.stop());

  await bot.start();
}

// Run if executed directly
if (require.main === module) {
  main().catch(console.error);
}
