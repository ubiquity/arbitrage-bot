import { describe, expect, it } from "@jest/globals";
import { planPegArbitrage } from "../src/peg-arbitrage";

const balancedPool = {
  uusdReserve: 1_000,
  lusdReserve: 1_000,
  feeBps: 30,
};

describe("planPegArbitrage", () => {
  it("does nothing when the pool is already inside the configured peg band", () => {
    const plan = planPegArbitrage({
      pool: balancedPool,
      wallet: { uusdBalance: 500, lusdBalance: 500 },
      targetPrice: 1,
      pegToleranceBps: 50,
    });

    expect(plan.action).toBe("hold");
    expect(plan.reason).toBe("within-peg-band");
    expect(plan.trade).toBeUndefined();
  });

  it("plans the largest balancing UUSD buy when UUSD trades below peg and the wallet has enough LUSD", () => {
    const plan = planPegArbitrage({
      pool: {
        uusdReserve: 1_200,
        lusdReserve: 800,
        feeBps: 30,
      },
      wallet: { uusdBalance: 100, lusdBalance: 260 },
      targetPrice: 1,
      pegToleranceBps: 50,
    });

    expect(plan.action).toBe("swap-lusd-for-uusd");
    expect(plan.trade).toMatchObject({
      inputToken: "LUSD",
      outputToken: "UUSD",
    });
    expect(plan.trade?.inputAmount).toBeCloseTo(180.3, 1);
    expect(plan.trade?.outputAmount).toBeCloseTo(220.2, 1);
    expect(plan.postTradePrice).toBeCloseTo(1, 3);
  });

  it("plans the largest balancing UUSD sell when UUSD trades above peg and the wallet has enough UUSD", () => {
    const plan = planPegArbitrage({
      pool: {
        uusdReserve: 800,
        lusdReserve: 1_200,
        feeBps: 30,
      },
      wallet: { uusdBalance: 260, lusdBalance: 100 },
      targetPrice: 1,
      pegToleranceBps: 50,
    });

    expect(plan.action).toBe("swap-uusd-for-lusd");
    expect(plan.trade).toMatchObject({
      inputToken: "UUSD",
      outputToken: "LUSD",
    });
    expect(plan.trade?.inputAmount).toBeCloseTo(180.3, 1);
    expect(plan.trade?.outputAmount).toBeCloseTo(220.2, 1);
    expect(plan.postTradePrice).toBeCloseTo(1, 3);
  });

  it("does nothing when the bot lacks enough inventory to rebalance in a single swap", () => {
    const plan = planPegArbitrage({
      pool: {
        uusdReserve: 1_200,
        lusdReserve: 800,
        feeBps: 30,
      },
      wallet: { uusdBalance: 100, lusdBalance: 20 },
      targetPrice: 1,
      pegToleranceBps: 50,
    });

    expect(plan.action).toBe("hold");
    expect(plan.reason).toBe("insufficient-lusd-balance");
    expect(plan.requiredInputAmount).toBeCloseTo(180.3, 1);
  });

  it("respects an operator max input cap even when the wallet has more funds", () => {
    const plan = planPegArbitrage({
      pool: {
        uusdReserve: 1_200,
        lusdReserve: 800,
        feeBps: 30,
      },
      wallet: { uusdBalance: 100, lusdBalance: 260 },
      targetPrice: 1,
      pegToleranceBps: 50,
      maxInputAmount: 100,
    });

    expect(plan.action).toBe("hold");
    expect(plan.reason).toBe("above-max-input");
    expect(plan.requiredInputAmount).toBeCloseTo(180.3, 1);
  });
});
