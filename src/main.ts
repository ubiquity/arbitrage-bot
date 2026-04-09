import * as dotenv from "dotenv";
dotenv.config();

import { ArbitrageBot } from "./arbitrage/bot";

async function main(): Promise<void> {
  const bot = new ArbitrageBot();
  await bot.init();
  await bot.start();
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
