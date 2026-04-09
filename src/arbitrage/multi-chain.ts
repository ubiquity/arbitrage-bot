/**
 * Multi-chain arbitrage logic.
 *
 * Monitors Curve pool prices on Mainnet (factory-stable-ng-164) and
 * Gnosis (factory-stable-ng-29) to detect cross-chain arbitrage
 * opportunities for UUSD.
 *
 * Flow:
 *  1. Compare UUSD price on Gnosis (discounted) vs Mainnet (peg)
 *  2. If discount > bridge_fees + gas + min_profit → signal opportunity
 *  3. Return structured opportunity for the executor to act on
 */
import { ethers } from "ethers";
import { CHAINS, MIN_PROFIT_USD } from "../config/chains";
import { estimateRoundTripBridgeFees } from "./bridge";

/* ---------- Minimal Curve stable-swap-ng ABI ---------- */

const CURVE_POOL_ABI = [
  // get_dy(i: uint256, j: uint256, dx: uint256) → uint256
  "function get_dy(uint256 i, uint256 j, uint256 dx) view returns (uint256)",
  // exchange(i: uint256, j: uint256, dx: uint256, min_dy: uint256) → uint256
  "function exchange(uint256 i, uint256 j, uint256 dx, uint256 min_dy) external returns (uint256)",
  // coins(uint256 i) → address
  "function coins(uint256 i) view returns (address)",
  "function N_COINS() view returns (uint256)",
];

/* ---------- Types ---------- */

export interface ArbitrageOpportunity {
  /** Buy token index on source pool */
  buyIndex: number;
  /** Sell token index on destination pool */
  sellIndex: number;
  /** Amount to trade (18-decimals) */
  tradeAmount: ethers.BigNumber;
  /** Expected gross profit in USD */
  grossProfitUsd: number;
  /** Estimated fees (bridge + gas) in USD */
  feesUsd: number;
  /** Net profit after fees in USD */
  netProfitUsd: number;
  /** Price of UUSD on Gnosis (relative to peg, e.g. 0.97 = 3% discount) */
  gnosisPrice: number;
  /** Price of UUSD on Mainnet */
  mainnetPrice: number;
  /** Discount percentage */
  discountPct: number;
}

/* ---------- Price helpers ---------- */

function getProvider(chain: "mainnet" | "gnosis"): ethers.providers.JsonRpcProvider {
  return new ethers.providers.JsonRpcProvider(CHAINS[chain].rpcUrl, CHAINS[chain].chainId);
}

/**
 * Get effective exchange rate from a Curve pool for dx=1 token.
 * Returns how many token-j you get for 1 token-i (as a float).
 */
async function getCurveRate(chain: "mainnet" | "gnosis", tokenI: number, tokenJ: number): Promise<number> {
  const cfg = CHAINS[chain];
  const provider = getProvider(chain);
  const pool = new ethers.Contract(cfg.curvePoolAddress, CURVE_POOL_ABI, provider);
  const oneUnit = ethers.utils.parseUnits("1", 18);
  const dy = await pool.get_dy(tokenI, tokenJ, oneUnit);
  return parseFloat(ethers.utils.formatUnits(dy, 18));
}

/**
 * Fetch current UUSD price on both chains.
 *
 * Assumes:
 *  - Gnosis pool: WXDAI (index 0) ↔ UUSD (index 1)
 *  - Mainnet pool: DAI/LUSD (index 0) ↔ UUSD (index 1)
 */
export async function fetchPrices(): Promise<{ gnosisUusdPrice: number; mainnetUusdPrice: number }> {
  const [gnosisUusdPrice, mainnetUusdPrice] = await Promise.all([
    getCurveRate("gnosis", 0, 1), // WXDAI → UUSD on Gnosis
    getCurveRate("mainnet", 0, 1), // DAI → UUSD on Mainnet (or LUSD pair)
  ]);
  return { gnosisUusdPrice, mainnetUusdPrice };
}

/**
 * Detect if a cross-chain arbitrage opportunity exists.
 *
 * @param tradeAmountDai  Amount in DAI to spend (18-decimals string, e.g. "1000")
 * @returns Opportunity if profitable, null otherwise
 */
export async function detectOpportunity(tradeAmountDai: string = "1000"): Promise<ArbitrageOpportunity | null> {
  const { gnosisUusdPrice, mainnetUusdPrice } = await fetchPrices();
  const discountPct = (1 - gnosisUusdPrice / mainnetUusdPrice) * 100;

  console.log(
    `[multi-chain] Gnosis UUSD: $${gnosisUusdPrice.toFixed(4)} | Mainnet UUSD: $${mainnetUusdPrice.toFixed(4)} | Discount: ${discountPct.toFixed(2)}%`
  );

  if (gnosisUusdPrice >= mainnetUusdPrice) {
    console.log("[multi-chain] No discount — UUSD not cheaper on Gnosis");
    return null;
  }

  const tradeAmount = ethers.utils.parseUnits(tradeAmountDai, 18);
  const grossProfitUsd = (mainnetUusdPrice - gnosisUusdPrice) * parseFloat(tradeAmountDai);
  const feesUsd = estimateRoundTripBridgeFees() + estimateGasFees();
  const netProfitUsd = grossProfitUsd - feesUsd;

  if (netProfitUsd < MIN_PROFIT_USD) {
    console.log(
      `[multi-chain] Profit $${netProfitUsd.toFixed(2)} below minimum $${MIN_PROFIT_USD}. Skipping.`
    );
    return null;
  }

  return {
    buyIndex: 0, // buy UUSD with WXDAI on Gnosis
    sellIndex: 0, // sell UUSD for DAI/LUSD on Mainnet
    tradeAmount,
    grossProfitUsd,
    feesUsd,
    netProfitUsd,
    gnosisPrice: gnosisUusdPrice,
    mainnetPrice: mainnetUusdPrice,
    discountPct,
  };
}

/**
 * Execute a swap on a Curve pool.
 */
export async function executeSwap(
  chain: "mainnet" | "gnosis",
  tokenI: number,
  tokenJ: number,
  dx: ethers.BigNumber,
  minDy: ethers.BigNumber,
  privateKey: string
): Promise<ethers.ContractTransaction> {
  const cfg = CHAINS[chain];
  const signer = new ethers.Wallet(privateKey, getProvider(chain));
  const pool = new ethers.Contract(cfg.curvePoolAddress, CURVE_POOL_ABI, signer);
  console.log(`[multi-chain] Swapping on ${chain}: token[${tokenI}]→token[${tokenJ}], dx=${ethers.utils.formatUnits(dx, 18)}`);
  const tx = await pool.exchange(tokenI, tokenJ, dx, minDy, {
    gasLimit: cfg.gasLimit.swap,
  });
  await tx.wait();
  console.log(`[multi-chain] Swap confirmed: ${tx.hash}`);
  return tx;
}

/**
 * Rough gas cost estimate (USD) for one round-trip execution.
 * Mainnet swap + gnosis swap + two bridge relays.
 */
function estimateGasFees(): number {
  // Conservative estimates
  const mainnetGasEth = 0.005; // ~$10-15 at 2000 gwei * 300k gas
  const gnosisGasXdai = 0.002; // negligible
  const ethPrice = 2000; // rough
  return mainnetGasEth * ethPrice * 0.005 + gnosisGasXdai * 1; // ~$10-15 for mainnet, ~$0 for gnosis
  // Simplified: just return a conservative number
}

// Re-estimate more cleanly
function estimateGasFees(): number {
  return 10; // $10 conservative estimate for round-trip gas on both chains
}
