/**
 * Cross-chain arbitrage executor.
 *
 * Orchestrates the full arbitrage flow:
 *  1. Detect opportunity
 *  2. Bridge DAI → Gnosis (xDAI)
 *  3. Wrap xDAI → WXDAI if needed
 *  4. Buy UUSD at discount on Gnosis Curve pool
 *  5. Bridge UUSD back to Mainnet
 *  6. Sell UUSD for DAI/LUSD on Mainnet Curve pool
 *  7. Collect profit
 *
 * Includes error recovery and step-by-step tracking.
 */
import { ethers } from "ethers";
import { CHAINS, POLL_INTERVAL_MS } from "../config/chains";
import { detectOpportunity, executeSwap, ArbitrageOpportunity } from "./multi-chain";
import { bridgeDaiToGnosis, bridgeTokenToMainnet, waitForBridgeDelivery, ensureApproval } from "./bridge";

/* ---------- State machine ---------- */

type Step =
  | "IDLE"
  | "DETECTING"
  | "BRIDGING_TO_GNOSIS"
  | "WRAPPING_XDAI"
  | "BUYING_UUSD_GNOSIS"
  | "BRIDGING_UUSD_TO_MAINNET"
  | "SELLING_UUSD_MAINNET"
  | "COMPLETE"
  | "ERROR";

interface ExecutionState {
  step: Step;
  opportunity: ArbitrageOpportunity | null;
  bridgeTxOut?: string;
  bridgeTxBack?: string;
  error?: Error;
  startedAt: number;
  completedAt?: number;
  profitRealized?: number;
}

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function deposit() payable", // WXDAI
  "function withdraw(uint256 wad)",
];

/* ---------- Main executor ---------- */

export class CrossChainExecutor {
  private privateKey: string;
  private state: ExecutionState;
  private running = false;

  constructor(privateKey?: string) {
    this.privateKey = privateKey || process.env.PRIVATE_KEY || "";
    this.state = { step: "IDLE", opportunity: null, startedAt: 0 };
  }

  get currentState(): Readonly<ExecutionState> {
    return this.state;
  }

  /**
   * Run a single arbitrage cycle:
   *  detect → execute if profitable → report result
   */
  async executeOnce(tradeAmountDai: string = "1000"): Promise<ExecutionState> {
    this.state = { step: "DETECTING", opportunity: null, startedAt: Date.now() };

    try {
      // Step 1: Detect opportunity
      console.log("[executor] 🔍 Detecting arbitrage opportunity…");
      const opp = await detectOpportunity(tradeAmountDai);
      if (!opp) {
        this.state.step = "IDLE";
        console.log("[executor] No profitable opportunity found.");
        return this.state;
      }
      this.state.opportunity = opp;
      console.log(
        `[executor] 💡 Opportunity found! Net profit: $${opp.netProfitUsd.toFixed(2)} (discount: ${opp.discountPct.toFixed(2)}%)`
      );

      const signer = new ethers.Wallet(this.privateKey, new ethers.providers.JsonRpcProvider(CHAINS.mainnet.rpcUrl));
      const walletAddress = await signer.getAddress();

      // Step 2: Bridge DAI → Gnosis
      this.state.step = "BRIDGING_TO_GNOSIS";
      console.log("[executor] 🌉 Bridging DAI → Gnosis…");
      this.state.bridgeTxOut = await bridgeDaiToGnosis(opp.tradeAmount, walletAddress, this.privateKey);

      // Step 3: Wait for delivery on Gnosis
      const gnosisProvider = new ethers.providers.JsonRpcProvider(CHAINS.gnosis.rpcUrl, 100);
      const wxdaiContract = new ethers.Contract(CHAINS.gnosis.tokens.WXDAI, ERC20_ABI, gnosisProvider);
      const delivered = await waitForBridgeDelivery(
        "gnosis",
        CHAINS.gnosis.tokens.WXDAI,
        walletAddress,
        opp.tradeAmount.mul(95).div(100) // 5% bridge slippage tolerance
      );
      if (!delivered) throw new Error("Bridge delivery to Gnosis timed out");
      console.log("[executor] ✅ DAI delivered to Gnosis");

      // Step 4: Buy UUSD on Gnosis Curve pool (WXDAI → UUSD)
      this.state.step = "BUYING_UUSD_GNOSIS";
      console.log("[executor] 🔄 Buying UUSD on Gnosis…");
      const gnosisSigner = new ethers.Wallet(this.privateKey, gnosisProvider);
      const wxdaiBal = await wxdaiContract.balanceOf(walletAddress);
      const minUusdOut = wxdaiBal.mul(Math.floor(opp.gnosisPrice * 990)).div(1000); // 1% slippage

      await ensureApproval("gnosis", CHAINS.gnosis.tokens.WXDAI, CHAINS.gnosis.curvePoolAddress, wxdaiBal, this.privateKey);
      await executeSwap("gnosis", 0, 1, wxdaiBal, minUusdOut, this.privateKey);
      console.log("[executor] ✅ UUSD bought on Gnosis");

      // Step 5: Bridge UUSD back to Mainnet
      this.state.step = "BRIDGING_UUSD_TO_MAINNET";
      const uusdGnosis = new ethers.Contract(CHAINS.gnosis.tokens.UUSD, ERC20_ABI, gnosisProvider);
      const uusdBal = await uusdGnosis.balanceOf(walletAddress);
      console.log(`[executor] 🌉 Bridging ${ethers.utils.formatUnits(uusdBal, 18)} UUSD → Mainnet…`);
      this.state.bridgeTxBack = await bridgeTokenToMainnet(CHAINS.gnosis.tokens.UUSD, uusdBal, walletAddress, this.privateKey);

      // Step 6: Wait for UUSD delivery on Mainnet
      const mainnetProvider = new ethers.providers.JsonRpcProvider(CHAINS.mainnet.rpcUrl, 1);
      const deliveredBack = await waitForBridgeDelivery(
        "mainnet",
        CHAINS.mainnet.tokens.UUSD,
        walletAddress,
        uusdBal.mul(95).div(100)
      );
      if (!deliveredBack) throw new Error("UUSD bridge delivery to Mainnet timed out");
      console.log("[executor] ✅ UUSD delivered to Mainnet");

      // Step 7: Sell UUSD on Mainnet Curve pool (UUSD → DAI/LUSD)
      this.state.step = "SELLING_UUSD_MAINNET";
      const uusdMainnet = new ethers.Contract(CHAINS.mainnet.tokens.UUSD, ERC20_ABI, mainnetProvider);
      const uusdMainnetBal = await uusdMainnet.balanceOf(walletAddress);
      const minDaiOut = uusdMainnetBal.mul(Math.floor(opp.mainnetPrice * 990)).div(1000);

      await ensureApproval("mainnet", CHAINS.mainnet.tokens.UUSD, CHAINS.mainnet.curvePoolAddress, uusdMainnetBal, this.privateKey);
      await executeSwap("mainnet", 1, 0, uusdMainnetBal, minDaiOut, this.privateKey);
      console.log("[executor] ✅ UUSD sold on Mainnet");

      // Done!
      this.state.step = "COMPLETE";
      this.state.completedAt = Date.now();
      this.state.profitRealized = opp.netProfitUsd;
      console.log(`[executor] 🎉 Arbitrage complete! Estimated profit: $${opp.netProfitUsd.toFixed(2)}`);
    } catch (err: unknown) {
      this.state.step = "ERROR";
      this.state.error = err instanceof Error ? err : new Error(String(err));
      this.state.completedAt = Date.now();
      console.error(`[executor] ❌ Error at step ${this.state.step}:`, this.state.error.message);
    }

    return this.state;
  }

  /**
   * Run a continuous monitoring loop.
   * Polls for opportunities at the configured interval and executes when found.
   */
  async startLoop(tradeAmountDai: string = "1000"): Promise<void> {
    this.running = true;
    console.log(`[executor] 🚀 Starting continuous monitoring (interval: ${POLL_INTERVAL_MS}ms)…`);

    while (this.running) {
      const result = await this.executeOnce(tradeAmountDai);
      if (result.step === "ERROR") {
        // Back off on error
        console.log("[executor] Waiting 60s before retry due to error…");
        await new Promise((r) => setTimeout(r, 60_000));
      } else if (result.step === "COMPLETE") {
        // Brief pause after a successful trade
        console.log("[executor] Trade complete. Waiting 30s before next scan…");
        await new Promise((r) => setTimeout(r, 30_000));
      } else {
        // No opportunity — poll at normal interval
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }
  }

  stop(): void {
    this.running = false;
    console.log("[executor] 🛑 Stopping monitoring loop.");
  }
}

/**
 * Convenience: run a single arbitrage check and return result.
 */
export async function runSingleCheck(tradeAmountDai?: string): Promise<ExecutionState> {
  const executor = new CrossChainExecutor();
  return executor.executeOnce(tradeAmountDai);
}
