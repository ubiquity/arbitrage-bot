import * as dotenv from "dotenv";
import { PegArbitrageInput } from "./peg-arbitrage";

dotenv.config();

function readNumber(name: string, fallback?: number): number {
  const value = process.env[name];
  if (value === undefined || value === "") {
    if (fallback !== undefined) {
      return fallback;
    }
    throw new Error(`Missing required environment variable: ${name}`);
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be a finite number`);
  }
  return parsed;
}

export function loadPegArbitrageInputFromEnv(): PegArbitrageInput {
  return {
    pool: {
      uusdReserve: readNumber("POOL_UUSD_RESERVE"),
      lusdReserve: readNumber("POOL_LUSD_RESERVE"),
      feeBps: readNumber("POOL_FEE_BPS", 30),
    },
    wallet: {
      uusdBalance: readNumber("BOT_UUSD_BALANCE", 0),
      lusdBalance: readNumber("BOT_LUSD_BALANCE", 0),
    },
    targetPrice: readNumber("TARGET_PRICE", 1),
    pegToleranceBps: readNumber("PEG_TOLERANCE_BPS", 50),
    maxInputAmount: readNumber("MAX_INPUT_AMOUNT", Number.POSITIVE_INFINITY),
  };
}
