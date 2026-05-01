export type StableToken = "UUSD" | "LUSD";

export type PegPoolState = {
  uusdReserve: number;
  lusdReserve: number;
  feeBps?: number;
};

export type BotWalletState = {
  uusdBalance: number;
  lusdBalance: number;
};

export type PegArbitrageInput = {
  pool: PegPoolState;
  wallet: BotWalletState;
  targetPrice?: number;
  pegToleranceBps?: number;
  maxInputAmount?: number;
};

export type PegTrade = {
  inputToken: StableToken;
  outputToken: StableToken;
  inputAmount: number;
  outputAmount: number;
  effectiveInputAmount: number;
  feeAmount: number;
};

export type PegArbitragePlan = {
  action: "hold" | "swap-lusd-for-uusd" | "swap-uusd-for-lusd";
  reason?: "within-peg-band" | "insufficient-lusd-balance" | "insufficient-uusd-balance" | "above-max-input";
  currentPrice: number;
  targetPrice: number;
  postTradePrice: number;
  requiredInputAmount?: number;
  trade?: PegTrade;
};

const BASIS_POINTS = 10_000;

function assertPositiveFinite(value: number, field: string) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${field} must be a positive finite number`);
  }
}

function assertNonNegativeFinite(value: number, field: string) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a non-negative finite number`);
  }
}

function assertPositiveAmountOrInfinity(value: number, field: string) {
  if (value !== Number.POSITIVE_INFINITY && (!Number.isFinite(value) || value <= 0)) {
    throw new Error(`${field} must be a positive number or Infinity`);
  }
}

function getFeeMultiplier(feeBps = 0) {
  assertNonNegativeFinite(feeBps, "feeBps");
  if (feeBps >= BASIS_POINTS) {
    throw new Error("feeBps must be less than 10000");
  }
  return (BASIS_POINTS - feeBps) / BASIS_POINTS;
}

function getPrice(pool: PegPoolState) {
  return pool.lusdReserve / pool.uusdReserve;
}

function buildTradePlan({
  inputToken,
  pool,
  targetPrice,
  feeMultiplier,
}: {
  inputToken: StableToken;
  pool: PegPoolState;
  targetPrice: number;
  feeMultiplier: number;
}): { trade: PegTrade; postTradePrice: number } {
  const invariant = pool.uusdReserve * pool.lusdReserve;
  const targetUusdReserve = Math.sqrt(invariant / targetPrice);
  const targetLusdReserve = targetPrice * targetUusdReserve;

  if (inputToken === "LUSD") {
    const effectiveInputAmount = targetLusdReserve - pool.lusdReserve;
    const inputAmount = effectiveInputAmount / feeMultiplier;
    const outputAmount = pool.uusdReserve - targetUusdReserve;

    return {
      trade: {
        inputToken: "LUSD",
        outputToken: "UUSD",
        inputAmount,
        outputAmount,
        effectiveInputAmount,
        feeAmount: inputAmount - effectiveInputAmount,
      },
      postTradePrice: targetLusdReserve / targetUusdReserve,
    };
  }

  const effectiveInputAmount = targetUusdReserve - pool.uusdReserve;
  const inputAmount = effectiveInputAmount / feeMultiplier;
  const outputAmount = pool.lusdReserve - targetLusdReserve;

  return {
    trade: {
      inputToken: "UUSD",
      outputToken: "LUSD",
      inputAmount,
      outputAmount,
      effectiveInputAmount,
      feeAmount: inputAmount - effectiveInputAmount,
    },
    postTradePrice: targetLusdReserve / targetUusdReserve,
  };
}

/**
 * Builds a deterministic, side-effect-free peg stabilization plan for a UUSD/LUSD
 * constant-product pool. It deliberately returns a plan only: transaction signing,
 * routing, broadcasting, RPC calls, private keys, and live swaps must be wired by a
 * separately reviewed operator integration.
 */
export function planPegArbitrage({
  pool,
  wallet,
  targetPrice = 1,
  pegToleranceBps = 50,
  maxInputAmount = Number.POSITIVE_INFINITY,
}: PegArbitrageInput): PegArbitragePlan {
  assertPositiveFinite(pool.uusdReserve, "pool.uusdReserve");
  assertPositiveFinite(pool.lusdReserve, "pool.lusdReserve");
  assertPositiveFinite(targetPrice, "targetPrice");
  assertNonNegativeFinite(wallet.uusdBalance, "wallet.uusdBalance");
  assertNonNegativeFinite(wallet.lusdBalance, "wallet.lusdBalance");
  assertNonNegativeFinite(pegToleranceBps, "pegToleranceBps");
  assertPositiveAmountOrInfinity(maxInputAmount, "maxInputAmount");

  const feeMultiplier = getFeeMultiplier(pool.feeBps);
  const currentPrice = getPrice(pool);
  const tolerance = targetPrice * (pegToleranceBps / BASIS_POINTS);
  const lowerBound = targetPrice - tolerance;
  const upperBound = targetPrice + tolerance;

  if (currentPrice >= lowerBound && currentPrice <= upperBound) {
    return {
      action: "hold",
      reason: "within-peg-band",
      currentPrice,
      targetPrice,
      postTradePrice: currentPrice,
    };
  }

  const inputToken: StableToken = currentPrice < targetPrice ? "LUSD" : "UUSD";
  const { trade, postTradePrice } = buildTradePlan({ inputToken, pool, targetPrice, feeMultiplier });
  const balance = trade.inputToken === "LUSD" ? wallet.lusdBalance : wallet.uusdBalance;

  if (trade.inputAmount > maxInputAmount) {
    return {
      action: "hold",
      reason: "above-max-input",
      currentPrice,
      targetPrice,
      postTradePrice: currentPrice,
      requiredInputAmount: trade.inputAmount,
    };
  }

  if (trade.inputAmount > balance) {
    return {
      action: "hold",
      reason: trade.inputToken === "LUSD" ? "insufficient-lusd-balance" : "insufficient-uusd-balance",
      currentPrice,
      targetPrice,
      postTradePrice: currentPrice,
      requiredInputAmount: trade.inputAmount,
    };
  }

  return {
    action: trade.inputToken === "LUSD" ? "swap-lusd-for-uusd" : "swap-uusd-for-lusd",
    currentPrice,
    targetPrice,
    postTradePrice,
    requiredInputAmount: trade.inputAmount,
    trade,
  };
}
