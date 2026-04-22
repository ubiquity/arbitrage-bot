import { jest, describe, it, expect } from "@jest/globals";
import { PriceMonitor } from "../src/arbitrage/price-monitor";
import { defaultConfig } from "../src/arbitrage/config";
import { ArbitrageBot } from "../src/arbitrage/bot";

describe("ArbitrageBot", () => {
  it("should create a bot with default config", () => {
    const bot = new ArbitrageBot(defaultConfig);
    expect(bot).toBeDefined();
  });

  it("should have correct config values", () => {
    expect(defaultConfig.profitThresholdUsd).toBeGreaterThan(0);
    expect(defaultConfig.gasPriceLimitGwei).toBeGreaterThan(0);
    expect(defaultConfig.pollIntervalMs).toBeGreaterThan(0);
    expect(defaultConfig.chains.length).toBeGreaterThan(0);
  });

  it("should have valid chain config", () => {
    const chain = defaultConfig.chains[0];
    expect(chain.chainId).toBe(1);
    expect(chain.name).toBe("ethereum");
    expect(chain.dollarTokenAddress).toMatch(/^0x/);
    expect(chain.collateralTokenAddress).toMatch(/^0x/);
    expect(chain.markets.length).toBeGreaterThan(0);
  });

  it("should have valid market types", () => {
    for (const chain of defaultConfig.chains) {
      for (const market of chain.markets) {
        expect(["uniswap", "curve"]).toContain(market.type);
        expect(market.routerAddress).toMatch(/^0x/);
        expect(market.poolAddress).toMatch(/^0x/);
      }
    }
  });
});

describe("PriceMonitor", () => {
  it("should create a monitor instance", () => {
    const chain = defaultConfig.chains[0];
    const monitor = new PriceMonitor(chain);
    expect(monitor).toBeDefined();
  });
});
