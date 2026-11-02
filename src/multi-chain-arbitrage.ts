// cspell:words dai gnosis xdai wxdai uusd lusd mainnet relayer calldata requote requotes underdelivery
import { Asset, ASSETS, ChainId, ROUTE, RouteLeg } from "./markets";

export const UNIT = 10n ** 18n;
const BASIS_POINTS = 10000n;
const CHAINS: readonly ChainId[] = [1, 100];

type NativeAmounts = Record<ChainId, bigint>;

export interface GasEstimate {
  readonly chainId: ChainId;
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  // Additional native relayer/bridge fees, excluding transferred principal.
  readonly nativeFee?: bigint;
}

export interface LegQuote {
  // Guaranteed minimum after slippage AND all token-denominated bridge fees.
  readonly minAmountOut: bigint;
  // Include approvals, source transactions, relaying and destination claims.
  readonly gas: readonly GasEstimate[];
  readonly validUntil: number;
  // Adapter-owned unsigned transactions/proofs needed to execute THIS quote.
  readonly executionData?: unknown;
}

export interface PriceQuote {
  // LUSD per DAI / native token, scaled by UNIT. Do not assume stable coins = $1.
  readonly daiInLusd: bigint;
  readonly nativeInLusd: Readonly<NativeAmounts>;
  readonly validUntil: number;
}

export interface QuoteProvider {
  quote(leg: RouteLeg, amountIn: bigint, slippageBps: number): Promise<LegQuote>;
  prices(): Promise<PriceQuote>;
}

export interface QuotedLeg extends LegQuote {
  readonly leg: RouteLeg;
  readonly amountIn: bigint;
}

export interface Executor {
  balance(asset: Asset): Promise<bigint>;
  // Enforce the quoted amounts and gas caps. Resolve only after confirmation AND
  // destination delivery (including a claim for bridges), never just submission.
  // The adapter must maintain a durable transaction journal for restart recovery.
  execute(step: QuotedLeg): Promise<bigint>;
}

export interface Opportunity {
  readonly steps: readonly QuotedLeg[];
  readonly minOutputLusd: bigint;
  readonly inputValueLusd: bigint;
  readonly nativeCosts: Readonly<NativeAmounts>;
  readonly gasCostLusd: bigint;
  readonly netProfitLusd: bigint;
  readonly isProfitable: boolean;
  readonly validUntil: number;
}

export interface Policy {
  slippageBps: number;
  gasBufferBps: number;
  minProfitLusd: bigint;
  maxQuoteAgeMs: number;
}

export interface RunResult {
  status: "dry-run" | "not-profitable" | "halted" | "completed";
  opportunity: Opportunity;
  completed: readonly QuotedLeg[];
}

// A failed/pending cross-chain send must NOT be retried as a fresh route.
export class ArbitrageExecutionError extends Error {
  constructor(
    readonly cause: unknown,
    readonly completed: readonly QuotedLeg[],
    readonly pendingStep?: QuotedLeg
  ) {
    super("Arbitrage stopped; reconcile completed/pending transactions before retrying", { cause });
    this.name = "ArbitrageExecutionError";
  }
}

function ceilDivide(value: bigint, divisor: bigint): bigint {
  return (value + divisor - 1n) / divisor;
}

function nativeCost(gas: GasEstimate): bigint {
  return gas.gasLimit * gas.maxFeePerGas + (gas.nativeFee ?? 0n);
}

export class MultiChainArbitrage {
  private _isRunning = false;
  private readonly _policy: Policy;

  constructor(
    private readonly _quotes: QuoteProvider,
    policy: Partial<Policy> = {},
    private readonly _now: () => number = Date.now
  ) {
    this._policy = { slippageBps: 50, gasBufferBps: 2000, minProfitLusd: 0n, maxQuoteAgeMs: 30000, ...policy };
    const { slippageBps, gasBufferBps, minProfitLusd, maxQuoteAgeMs } = this._policy;
    if (
      !Number.isInteger(slippageBps) ||
      slippageBps < 0 ||
      slippageBps >= 10000 ||
      !Number.isInteger(gasBufferBps) ||
      gasBufferBps < 0 ||
      gasBufferBps > 10000 ||
      minProfitLusd < 0n ||
      !Number.isSafeInteger(maxQuoteAgeMs) ||
      maxQuoteAgeMs <= 0
    ) {
      throw new Error("Invalid arbitrage policy");
    }
  }

  quote(amountIn: bigint): Promise<Opportunity> {
    return this._quoteRemaining(amountIn, amountIn, 0, { 1: 0n, 100: 0n });
  }

  // Supplying an executor explicitly opts into live execution. Without one this
  // is always a dry run, and no balances or transaction methods are called.
  async run(amountIn: bigint, executor?: Executor): Promise<RunResult> {
    if (this._isRunning) throw new Error("An arbitrage run is already in progress");
    this._isRunning = true;
    const completed: QuotedLeg[] = [];
    const spent: NativeAmounts = { 1: 0n, 100: 0n };
    let heldAmount = amountIn;
    let pendingStep: QuotedLeg | undefined;
    try {
      for (let index = 0; index < ROUTE.length; index++) {
        // Requote all remaining steps after EVERY confirmed transaction. Bridges
        // are asynchronous: never trade against the pre-bridge price/gas quote.
        const opportunity = await this._quoteRemaining(amountIn, heldAmount, index, spent);
        if (!opportunity.isProfitable) {
          return { status: completed.length ? "halted" : "not-profitable", opportunity, completed };
        }
        if (!executor) return { status: "dry-run", opportunity, completed };
        const step = opportunity.steps[0];
        await this._checkBalances(executor, step, opportunity.nativeCosts, spent);
        this._checkExpiry(opportunity.validUntil);
        pendingStep = step;
        await this._executeStep(executor, step, spent);
        completed.push(step);
        pendingStep = undefined;
        // Forward only the guaranteed amount; any excess stays in the wallet.
        heldAmount = step.minAmountOut;
        if (index === ROUTE.length - 1) return { status: "completed", opportunity, completed };
      }
      throw new Error("Empty arbitrage route");
    } catch (error) {
      if (completed.length || pendingStep) throw new ArbitrageExecutionError(error, completed, pendingStep);
      throw error;
    } finally {
      this._isRunning = false;
    }
  }

  private async _executeStep(executor: Executor, step: QuotedLeg, spent: NativeAmounts): Promise<void> {
    const received = await executor.execute(step);
    if (received < step.minAmountOut) throw new Error(`Insufficient destination delivery for ${step.leg.id}`);
    for (const gas of step.gas) spent[gas.chainId] += nativeCost(gas);
  }

  private _checkExpiry(validUntil: number): void {
    if (!Number.isSafeInteger(validUntil) || validUntil <= this._now()) throw new Error("Expired or invalid quote");
  }

  private async _quoteRemaining(originalAmount: bigint, heldAmount: bigint, index: number, spent: NativeAmounts): Promise<Opportunity> {
    if (originalAmount <= 0n || heldAmount <= 0n) throw new Error("Input amount must be positive");
    let validUntil = this._now() + this._policy.maxQuoteAgeMs;
    const prices = await this._quotes.prices();
    this._checkExpiry(prices.validUntil);
    if (prices.daiInLusd <= 0n || CHAINS.some((chain) => prices.nativeInLusd[chain] <= 0n)) throw new Error("Invalid LUSD prices");
    validUntil = Math.min(validUntil, prices.validUntil);
    const nativeCosts = { ...spent };
    const steps: QuotedLeg[] = [];
    for (const leg of ROUTE.slice(index)) {
      const quote = await this._quotes.quote(leg, heldAmount, this._policy.slippageBps);
      this._checkExpiry(quote.validUntil);
      if (quote.minAmountOut <= 0n) throw new Error(`Invalid output for ${leg.id}`);
      if (leg.gasChains.some((chain) => !quote.gas.some((gas) => gas.chainId === chain))) throw new Error(`Missing gas estimate for ${leg.id}`);
      const gas = quote.gas.map((estimate) => this._bufferGas(estimate, leg));
      for (const estimate of gas) nativeCosts[estimate.chainId] += nativeCost(estimate);
      steps.push({ ...quote, gas, leg, amountIn: heldAmount });
      heldAmount = quote.minAmountOut;
      validUntil = Math.min(validUntil, quote.validUntil);
    }
    this._checkExpiry(validUntil);
    const gasCostLusd = CHAINS.reduce((total, chain) => total + ceilDivide(nativeCosts[chain] * prices.nativeInLusd[chain], UNIT), 0n);
    const inputValueLusd = ceilDivide(originalAmount * prices.daiInLusd, UNIT);
    const netProfitLusd = heldAmount - inputValueLusd - gasCostLusd;
    return {
      steps,
      minOutputLusd: heldAmount,
      inputValueLusd,
      nativeCosts,
      gasCostLusd,
      netProfitLusd,
      isProfitable: netProfitLusd > 0n && netProfitLusd >= this._policy.minProfitLusd,
      validUntil,
    };
  }

  private _bufferGas(gas: GasEstimate, leg: RouteLeg): GasEstimate {
    if (
      (gas.chainId !== leg.from.chainId && gas.chainId !== leg.to.chainId) ||
      gas.gasLimit <= 0n ||
      gas.maxFeePerGas <= 0n ||
      (gas.nativeFee ?? 0n) < 0n
    ) {
      throw new Error(`Invalid gas estimate for ${leg.id}`);
    }
    return { ...gas, gasLimit: ceilDivide(gas.gasLimit * (BASIS_POINTS + BigInt(this._policy.gasBufferBps)), BASIS_POINTS) };
  }

  private async _checkBalances(executor: Executor, step: QuotedLeg, total: Readonly<NativeAmounts>, spent: NativeAmounts): Promise<void> {
    if ((await executor.balance(step.leg.from)) < step.amountIn) throw new Error(`Insufficient ${step.leg.from.symbol} balance`);
    for (const chain of CHAINS) {
      const nativeAsset = chain === 1 ? ASSETS.eth : ASSETS.xdai;
      const nativeInput = step.leg.from.isNative && step.leg.from.chainId === chain ? step.amountIn : 0n;
      if ((await executor.balance(nativeAsset)) < total[chain] - spent[chain] + nativeInput) {
        throw new Error(`Insufficient gas reserve on chain ${chain}`);
      }
    }
  }
}
