import { loadPegArbitrageInputFromEnv } from "./config";
import { planPegArbitrage } from "./peg-arbitrage";

export function main() {
  const plan = planPegArbitrage(loadPegArbitrageInputFromEnv());
  console.log(JSON.stringify(plan, null, 2));

  return plan;
}

if (require.main === module) {
  main();
}
