/**
 * Multi-chain Curve arbitrage bot.
 *
 * Monitors Curve factory-stable-ng pools on Ethereum Mainnet (164) and
 * Gnosis Chain (29), detects cross-chain price discrepancies, and
 * executes arbitrage when profitable.
 *
 * Usage:
 *   npx tsx src/multi-chain.ts
 *
 * Environment:
 *   MAINNET_RPC_URL  — Ethereum JSON-RPC endpoint
 *   GNOSIS_RPC_URL   — Gnosis JSON-RPC endpoint
 *   PRIVATE_KEY      — Signer private key (optional, sim-only without)
 */

import { DEFAULT_CONFIG, type ArbitrageConfig } from "./config";
import { fetchPoolState, getDy, buildExchangeTxForChain, type PoolState } from "./curve-integration";
import { createBridgeMonitor, detectOpportunity, type CrossChainOpportunity } from "./cross-chain";

/* ── Arbitrage execution engine ──────────────────────────────── */

export class ArbitrageEngine {
  private readonly config: ArbitrageConfig;
  private readonly monitor: ReturnType<typeof createBridgeMonitor>;
  private cycleCount = 0;

  constructor(config: ArbitrageConfig = DEFAULT_CONFIG) {
    this.config = config;
    this.monitor = createBridgeMonitor(config);
  }

  /**
   * Start the arbitrage bot.
   */
  start(): void {
    console.log("═══════════════════════════════════════════════");
    console.log("  Multi-Chain Curve Arbitrage Bot");
    console.log("  Mainnet: factory-stable-ng-164");
    console.log("  Gnosis:  factory-stable-ng-29");
    console.log("═══════════════════════════════════════════════");
    console.log(`  Min profit threshold: ${formatUnits(this.config.minProfitThreshold, 18)}`);
    console.log(`  Trade amount:         ${formatUnits(this.config.tradeAmount, 18)}`);
    console.log(`  Poll interval:        ${this.config.pollIntervalMs}ms`);
    console.log("═══════════════════════════════════════════════\n");

    this.monitor.onOpportunity((opp) => this.handleOpportunity(opp));
    this.monitor.start();
  }

  /**
   * Stop the bot gracefully.
   */
  stop(): void {
    console.log("\n[engine] Stopping...");
    this.monitor.stop();
    console.log("[engine] Stopped.");
  }

  /**
   * Handle a detected arbitrage opportunity.
   */
  private async handleOpportunity(opp: CrossChainOpportunity): Promise<void> {
    this.cycleCount++;
    const cycleId = this.cycleCount;

    console.log(`\n[engine] ── Cycle #${cycleId} ──`);
    console.log(`[engine] Direction: buy on ${opp.buyChain} → sell on ${opp.sellChain}`);
    console.log(`[engine] Price diff: ${opp.priceDiffBps} bps`);
    console.log(`[engine] Est. gross profit: ${formatUnits(opp.estimatedProfit, 18)}`);
    console.log(`[engine] Bridge cost: ${formatUnits(opp.bridgeCost, 18)}`);
    console.log(`[engine] Net profit: ${formatUnits(opp.netProfit, 18)}`);

    try {
      // Simulate swap on buy chain
      const buyAmount = await this.simulateSwap(opp.buyChain, 0, 1, this.config.tradeAmount);
      console.log(`[engine] Buy chain (${opp.buyChain}) swap output: ${formatUnits(buyAmount, 18)}`);

      // Simulate swap on sell chain (reverse direction)
      const sellAmount = await this.simulateSwap(opp.sellChain, 1, 0, buyAmount);
      console.log(`[engine] Sell chain (${opp.sellChain}) swap output: ${formatUnits(sellAmount, 18)}`);

      const actualProfit = sellAmount - this.config.tradeAmount;
      console.log(`[engine] Actual profit (before bridge): ${formatUnits(actualProfit, 18)}`);

      if (actualProfit > this.config.minProfitThreshold) {
        await this.executeArbitrage(opp, buyAmount, sellAmount);
      } else {
        console.log(`[engine] Profit too low after simulation, skipping.`);
      }
    } catch (err) {
      console.error(`[engine] Cycle #${cycleId} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /**
   * Simulate a swap using get_dy.
   */
  private async simulateSwap(chainKey: string, i: number, j: number, amount: bigint): Promise<bigint> {
    return getDy(chainKey, i, j, amount);
  }

  /**
   * Execute the arbitrage: build and log transactions.
   *
   * In production this would sign and broadcast via a provider.
   */
  private async executeArbitrage(
    opp: CrossChainOpportunity,
    buyAmount: bigint,
    sellAmount: bigint
  ): Promise<void> {
    const slippageBps = BigInt(this.config.slippageBps);
    const minBuyOut = (buyAmount * (10_000n - slippageBps)) / 10_000n;
    const minSellOut = (sellAmount * (10_000n - slippageBps)) / 10_000n;

    // Build buy transaction
    const buyTx = buildExchangeTxForChain(opp.buyChain, 0, 1, this.config.tradeAmount, minBuyOut);
    console.log(`[engine] BUY tx → to=${buyTx.to} data=${buyTx.data.slice(0, 20)}...`);

    // Build sell transaction
    const sellTx = buildExchangeTxForChain(opp.sellChain, 1, 0, buyAmount, minSellOut);
    console.log(`[engine] SELL tx → to=${sellTx.to} data=${sellTx.data.slice(0, 20)}...`);

    console.log(`[engine] ✅ Arbitrage cycle ready for execution.`);
  }
}

/* ── One-shot scan ───────────────────────────────────────────── */

/**
 * Perform a single scan and print results without starting the loop.
 */
export async function scanOnce(config: ArbitrageConfig = DEFAULT_CONFIG): Promise<void> {
  console.log("[scan] Fetching pool states...\n");

  const [mainnetState, gnosisState] = await Promise.all([
    fetchPoolState("mainnet").catch((err) => {
      console.error(`[scan] Mainnet error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }),
    fetchPoolState("gnosis").catch((err) => {
      console.error(`[scan] Gnosis error: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }),
  ]);

  if (mainnetState) {
    printPoolState(mainnetState);
  }
  if (gnosisState) {
    printPoolState(gnosisState);
  }

  if (mainnetState && gnosisState) {
    const opp = detectOpportunity(mainnetState, gnosisState, config);
    if (opp) {
      console.log("\n[scan] 🎯 Opportunity found!");
      console.log(`  Buy on:   ${opp.buyChain}`);
      console.log(`  Sell on:  ${opp.sellChain}`);
      console.log(`  Net profit: ${formatUnits(opp.netProfit, 18)}`);
    } else {
      console.log("\n[scan] No profitable opportunity at this time.");
    }
  }
}

function printPoolState(state: PoolState): void {
  console.log(`── ${state.chainKey} (${state.poolId}) ──`);
  console.log(`  Pool:          ${state.poolAddress}`);
  console.log(`  Block:         ${state.blockNumber}`);
  console.log(`  Virtual Price:  ${state.virtualPrice.toString()}`);
  console.log(`  A (amp):       ${state.amplification.toString()}`);
  console.log(`  Fee:           ${state.fee.toString()}`);
  for (let i = 0; i < state.balances.length; i++) {
    console.log(`  Balance[${i}]:    ${formatUnits(state.balances[i], 18)}`);
  }
  console.log();
}

/* ── CLI entry point ─────────────────────────────────────────── */

function formatUnits(value: bigint, decimals: number): string {
  const str = value.toString().padStart(decimals + 1, "0");
  const integer = str.slice(0, -decimals) || "0";
  const fraction = str.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}

// Run when executed directly
if (typeof require !== "undefined" && require.main === module) {
  run();
}

async function run(): Promise<void> {
  const mode = process.argv[2] || "scan";

  if (mode === "monitor") {
    const engine = new ArbitrageEngine();
    process.on("SIGINT", () => engine.stop());
    process.on("SIGTERM", () => engine.stop());
    engine.start();
  } else {
    await scanOnce();
  }
}

export { run };
