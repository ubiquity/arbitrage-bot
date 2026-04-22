/**
 * Cross-chain bridge monitoring and coordination.
 *
 * Tracks bridged liquidity between Mainnet and Gnosis using the
 * Omni/Ethereum-Gnosis bridge. Detects when bridged funds arrive
 * and triggers arbitrage cycles.
 */

import { CHAINS, type ArbitrageConfig, DEFAULT_CONFIG } from "./config";
import { fetchPoolState, type PoolState } from "./curve-integration";

/* ── Types ───────────────────────────────────────────────────── */

export interface BridgeStatus {
  readonly sourceChain: string;
  readonly destinationChain: string;
  readonly amount: bigint;
  readonly txHash: string;
  readonly status: "pending" | "confirmed" | "finalized";
  readonly estimatedArrivalMs: number;
}

export interface CrossChainOpportunity {
  readonly buyChain: string;
  readonly sellChain: string;
  readonly coinIndex: number;
  readonly priceDiffBps: bigint;
  readonly estimatedProfit: bigint;
  readonly bridgeCost: bigint;
  readonly netProfit: bigint;
  readonly mainnetState: PoolState;
  readonly gnosisState: PoolState;
}

/* ── Bridge constants ────────────────────────────────────────── */

/** Approximate bridge fee (xDAI bridge is usually cheap) */
const BRIDGE_FEE_XDAI = parseUnits("0.5", 18);
const BRIDGE_TIME_MS = 60_000; // ~1 minute for xDAI bridge

/* ── Opportunity detection ───────────────────────────────────── */

/**
 * Compare pool states across chains and identify arbitrage opportunities.
 *
 * Strategy: If virtual price on Chain A is lower than Chain B,
 * buy on A and sell on B (after bridging).
 */
export function detectOpportunity(
  mainnetState: PoolState,
  gnosisState: PoolState,
  config: ArbitrageConfig = DEFAULT_CONFIG
): CrossChainOpportunity | null {
  const vpMainnet = mainnetState.virtualPrice;
  const vpGnosis = gnosisState.virtualPrice;

  if (vpMainnet === 0n || vpGnosis === 0n) return null;

  const tradeAmount = config.tradeAmount;

  // Price difference in basis points
  const priceDiffBps =
    vpMainnet > vpGnosis
      ? ((vpMainnet - vpGnosis) * 10_000n) / vpGnosis
      : ((vpGnosis - vpMainnet) * 10_000n) / vpMainnet;

  if (priceDiffBps < 1n) return null; // Less than 1 bps, not worth it

  // Determine direction
  const buyChain = vpMainnet > vpGnosis ? "gnosis" : "mainnet";
  const sellChain = buyChain === "gnosis" ? "mainnet" : "gnosis";

  // Estimate profit: priceDiff * tradeAmount
  const buyVp = buyChain === "gnosis" ? vpGnosis : vpMainnet;
  const sellVp = sellChain === "mainnet" ? vpMainnet : vpGnosis;

  const estimatedGross = (tradeAmount * sellVp) / buyVp - tradeAmount;

  // Subtract bridge fee
  const netProfit = estimatedGross - BRIDGE_FEE_XDAI;

  if (netProfit < config.minProfitThreshold) return null;

  return {
    buyChain,
    sellChain,
    coinIndex: 0,
    priceDiffBps,
    estimatedProfit: estimatedGross,
    bridgeCost: BRIDGE_FEE_XDAI,
    netProfit,
    mainnetState,
    gnosisState,
  };
}

/* ── Bridge monitoring ───────────────────────────────────────── */

export interface BridgeMonitor {
  start(): void;
  stop(): void;
  onOpportunity(callback: (opp: CrossChainOpportunity) => void): void;
}

/**
 * Create a cross-chain bridge monitor that periodically polls
 * both chains and detects opportunities.
 */
export function createBridgeMonitor(
  config: ArbitrageConfig = DEFAULT_CONFIG
): BridgeMonitor {
  let intervalId: ReturnType<typeof setInterval> | null = null;
  let running = false;
  const callbacks: Array<(opp: CrossChainOpportunity) => void> = [];

  async function poll(): Promise<void> {
    if (running) return;
    running = true;

    try {
      const [mainnetState, gnosisState] = await Promise.all([
        fetchPoolState("mainnet").catch((err) => {
          console.error(`[cross-chain] Mainnet fetch failed: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }),
        fetchPoolState("gnosis").catch((err) => {
          console.error(`[cross-chain] Gnosis fetch failed: ${err instanceof Error ? err.message : String(err)}`);
          return null;
        }),
      ]);

      if (!mainnetState || !gnosisState) return;

      const opp = detectOpportunity(mainnetState, gnosisState, config);
      if (opp) {
        console.log(
          `[cross-chain] Opportunity detected: buy=${opp.buyChain} sell=${opp.sellChain} profit=${formatUnits(opp.netProfit, 18)}`
        );
        for (const cb of callbacks) {
          cb(opp);
        }
      }
    } finally {
      running = false;
    }
  }

  return {
    start() {
      if (intervalId) return;
      console.log(`[cross-chain] Starting monitor (interval=${config.pollIntervalMs}ms)`);
      intervalId = setInterval(poll, config.pollIntervalMs);
      // Fire immediately
      poll().catch(() => {});
    },
    stop() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    },
    onOpportunity(callback) {
      callbacks.push(callback);
    },
  };
}

/* ── Bridge status tracking (simulated) ──────────────────────── */

/**
 * Track a bridge transaction across chains.
 * In production this would poll the bridge contract events.
 */
export function trackBridgeTx(txHash: string, source: string, destination: string, amount: bigint): BridgeStatus {
  return {
    sourceChain: source,
    destinationChain: destination,
    amount,
    txHash,
    status: "pending",
    estimatedArrivalMs: BRIDGE_TIME_MS,
  };
}

/* ── Helpers ─────────────────────────────────────────────────── */

function parseUnits(value: string, decimals: number): bigint {
  const [integer, fraction = ""] = value.split(".");
  const padded = fraction.padEnd(decimals, "0").slice(0, decimals);
  return BigInt(integer + padded);
}

function formatUnits(value: bigint, decimals: number): string {
  const str = value.toString().padStart(decimals + 1, "0");
  const integer = str.slice(0, -decimals) || "0";
  const fraction = str.slice(-decimals).replace(/0+$/, "");
  return fraction ? `${integer}.${fraction}` : integer;
}
