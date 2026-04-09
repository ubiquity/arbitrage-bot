/**
 * Arbitrage Bot
 *
 * Main bot class that orchestrates price monitoring and trade execution
 * to maintain the Dollar token USD peg via arbitrage opportunities.
 */

import { BotConfig, defaultConfig } from "./config";
import { PriceMonitor, ArbitrageOpportunity } from "./price-monitor";
import { Executor, TradeResult } from "./executor";

export class ArbitrageBot {
  private config: BotConfig;
  private running: boolean = false;
  private monitors: Map<number, PriceMonitor> = new Map();
  private executors: Map<number, Executor> = new Map();

  constructor(config: BotConfig = defaultConfig) {
    this.config = config;
  }

  /**
   * Initialize monitors and executors for all configured chains.
   */
  async init(): Promise<void> {
    for (const chain of this.config.chains) {
      this.monitors.set(chain.chainId, new PriceMonitor(chain));
      try {
        this.executors.set(chain.chainId, new Executor(chain, this.config));
      } catch (error) {
        console.warn(`Skipping executor for chain ${chain.name}: ${error instanceof Error ? error.message : error}`);
      }
    }
    console.log(`Initialized arbitrage bot with ${this.monitors.size} chain(s)`);
  }

  /**
   * Start the main monitoring loop.
   */
  async start(): Promise<void> {
    if (this.running) {
      console.warn("Bot is already running");
      return;
    }

    this.running = true;
    console.log("Starting arbitrage bot...");
    console.log(`Profit threshold: $${this.config.profitThresholdUsd}`);
    console.log(`Poll interval: ${this.config.pollIntervalMs}ms`);
    console.log(`Gas price limit: ${this.config.gasPriceLimitGwei} gwei`);

    while (this.running) {
      try {
        await this.runCycle();
      } catch (error) {
        console.error("Cycle error:", error instanceof Error ? error.message : error);
      }
      await this.sleep(this.config.pollIntervalMs);
    }
  }

  /** Stop the bot. */
  stop(): void {
    console.log("Stopping arbitrage bot...");
    this.running = false;
  }

  /**
   * Run a single monitoring cycle across all chains.
   */
  async runCycle(): Promise<ArbitrageOpportunity[]> {
    const allOpportunities: ArbitrageOpportunity[] = [];

    for (const chain of this.config.chains) {
      const monitor = this.monitors.get(chain.chainId);
      if (!monitor) continue;

      const opportunities = await monitor.findOpportunities(this.config.profitThresholdUsd);

      for (const opp of opportunities) {
        console.log(
          `[${chain.name}] ${opp.direction} opportunity on ${opp.market}: ` +
            `price=$${opp.dollarPrice.toFixed(4)} deviation=$${opp.deviation.toFixed(4)} ` +
            `estProfit=$${opp.estimatedProfitUsd.toFixed(2)}`
        );

        const executor = this.executors.get(chain.chainId);
        if (executor) {
          const result = await this.executeTrade(executor, opp);
          this.logResult(chain.name, opp, result);
        } else {
          console.warn(`  No executor for chain ${chain.name}, skipping trade`);
        }
      }

      allOpportunities.push(...opportunities);
    }

    return allOpportunities;
  }

  private async executeTrade(executor: Executor, opportunity: ArbitrageOpportunity): Promise<TradeResult> {
    switch (opportunity.direction) {
      case "mint-and-sell":
        return executor.executeMintAndSell(opportunity);
      case "buy-and-redeem":
        return executor.executeBuyAndRedeem(opportunity);
      default:
        return { success: false, error: `Unknown direction: ${opportunity.direction}` };
    }
  }

  private logResult(chainName: string, opp: ArbitrageOpportunity, result: TradeResult): void {
    if (result.success) {
      console.log(
        `  ✅ Trade executed on ${chainName}: tx=${result.txHash} profit=$${result.profitUsd?.toFixed(2)} gas=${result.gasUsed?.toString()}`
      );
    } else {
      console.warn(`  ❌ Trade failed on ${chainName}: ${result.error}`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
