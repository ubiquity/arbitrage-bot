// cspell:words dai gnosis xdai wxdai uusd lusd mainnet relayer calldata requote requotes underdelivery
import { describe, expect, it } from "@jest/globals";
import { Asset, ASSETS, MARKETS, ROUTE } from "../src/markets";
import { ArbitrageExecutionError, Executor, MultiChainArbitrage, QuotedLeg, QuoteProvider, UNIT } from "../src/multi-chain-arbitrage";
import { createRpcRequest, EvmQuotes, RpcRequest } from "../src/evm-quotes";

const PRINCIPAL = 1000n * UNIT;
const BRIDGE_DAI = "bridge-dai";
const CHAIN_ID_METHOD = "eth_chainId";

function fixture() {
  const state = {
    now: 1000,
    daiPrice: UNIT,
    outputNumerator: 100n,
    outputDenominator: 97n,
    bridgeFee: 0n,
    quoted: [] as { id: string; amount: bigint; slippage: number }[],
    executed: [] as QuotedLeg[],
  };
  const quotes: QuoteProvider = {
    prices() {
      return Promise.resolve({ daiInLusd: state.daiPrice, nativeInLusd: { 1: 2000n * UNIT, 100: UNIT }, validUntil: state.now + 60000 });
    },
    quote(leg, amount, slippage) {
      state.quoted.push({ id: leg.id, amount, slippage });
      let output = leg.id === "buy-uusd" ? (amount * state.outputNumerator) / state.outputDenominator : amount;
      if (leg.id === "bridge-uusd") output -= state.bridgeFee;
      if (leg.kind === "swap") output = (output * BigInt(10000 - slippage)) / 10000n;
      return Promise.resolve({
        minAmountOut: output,
        gas: leg.gasChains.map((chainId) => ({ chainId, gasLimit: 100000n, maxFeePerGas: 10n ** 9n })),
        validUntil: state.now + 60000,
      });
    },
  };
  const executor: Executor = {
    balance() {
      return Promise.resolve(1000000n * UNIT);
    },
    execute(step) {
      state.executed.push(step);
      if (step.leg.kind === "bridge") state.now += 120000;
      return Promise.resolve(step.minAmountOut);
    },
  };
  function bot(policy = {}) {
    return new MultiChainArbitrage(quotes, { slippageBps: 0, gasBufferBps: 0, ...policy }, () => state.now);
  }
  return { state, quotes, executor, bot };
}

describe("Mainnet / Gnosis arbitrage", () => {
  it("targets the two requested markets and all five route legs", () => {
    expect(MARKETS.mainnet).toEqual({ chainId: 1, poolId: "factory-stable-ng-164" });
    expect(MARKETS.gnosis).toEqual({ chainId: 100, poolId: "factory-stable-ng-29" });
    expect(ROUTE.map((leg) => leg.to.symbol)).toEqual(["xDAI", "WXDAI", "UUSD", "UUSD", "LUSD"]);
    expect(ROUTE[4].to).toEqual(ASSETS.lusd);
  });

  it("uses exact amounts, net bridge output and both chains' gas, including the claim", async () => {
    const { state, bot } = fixture();
    state.bridgeFee = UNIT;
    const quote = await bot().quote(PRINCIPAL);
    expect(quote.minOutputLusd).toBe((PRINCIPAL * 100n) / 97n - UNIT);
    expect(quote.nativeCosts).toEqual({ 1: 300000000000000n, 100: 300000000000000n });
    expect(quote.gasCostLusd).toBe((6003n * UNIT) / 10000n);
    expect(quote.netProfitLusd).toBe(quote.minOutputLusd - PRINCIPAL - quote.gasCostLusd);
    expect(quote.isProfitable).toBe(true);
    expect(state.quoted[4].amount).toBe(quote.steps[3].minAmountOut);
  });

  it("counts approval gas, native relayer fees and a rounded-up gas safety buffer", async () => {
    const { quotes, bot } = fixture();
    const originalQuote = quotes.quote;
    quotes.quote = async function (leg, amount, slippage) {
      const quote = await originalQuote(leg, amount, slippage);
      const gas = [...quote.gas];
      if (leg.id === BRIDGE_DAI) gas.push({ chainId: 1, gasLimit: 1n, maxFeePerGas: 1n, nativeFee: UNIT / 1000n });
      return { ...quote, gas };
    };
    const quote = await bot({ gasBufferBps: 2000 }).quote(PRINCIPAL);
    expect(quote.steps[0].gas[1].gasLimit).toBe(2n);
    expect(quote.nativeCosts[1]).toBe(360000000000000n + 2n + UNIT / 1000n);
  });

  it("rejects a gross spread when gas or the minimum profit consumes it", async () => {
    const { state, bot, executor } = fixture();
    state.outputNumerator = 10001n;
    state.outputDenominator = 10000n;
    expect((await bot().run(PRINCIPAL, executor)).status).toBe("not-profitable");
    expect(state.executed).toHaveLength(0);
    expect((await bot({ minProfitLusd: 100n * UNIT }).quote(PRINCIPAL)).isProfitable).toBe(false);
  });

  it("prices DAI in LUSD rather than assuming a dollar peg", async () => {
    const { state, bot } = fixture();
    state.daiPrice = 2n * UNIT;
    const quote = await bot().quote(PRINCIPAL);
    expect(quote.inputValueLusd).toBe(2n * PRINCIPAL);
    expect(quote.isProfitable).toBe(false);
  });

  it("is dry-run by default and forwards the requested slippage", async () => {
    const { state, bot } = fixture();
    const result = await bot({ slippageBps: 50 }).run(PRINCIPAL);
    expect(result.status).toBe("dry-run");
    expect(state.executed).toHaveLength(0);
    expect(state.quoted.every((entry) => entry.slippage === 50)).toBe(true);
    expect(result.opportunity.steps[3].amountIn).toBe(result.opportunity.steps[2].minAmountOut);
  });

  it("waits for bridge completion, then requotes and completes in order", async () => {
    const { state, bot, executor } = fixture();
    const result = await bot().run(PRINCIPAL, executor);
    expect(result.status).toBe("completed");
    expect(state.executed.map((step) => step.leg.id)).toEqual(ROUTE.map((leg) => leg.id));
    expect(state.quoted).toHaveLength(15);
    expect(result.opportunity.gasCostLusd).toBe((6003n * UNIT) / 10000n);
    expect(result.opportunity.validUntil).toBeGreaterThan(240000);
  });

  it("halts with recoverable progress when the spread closes during a bridge", async () => {
    const { state, bot, executor } = fixture();
    const execute = executor.execute;
    executor.execute = async function (step) {
      const output = await execute(step);
      state.outputNumerator = 96n;
      return output;
    };
    const result = await bot().run(PRINCIPAL, executor);
    expect(result.status).toBe("halted");
    expect(result.completed.map((step) => step.leg.id)).toEqual([BRIDGE_DAI]);
    expect(state.executed).toHaveLength(1);
  });

  it("requires pre-funded gas on BOTH chains before sending DAI", async () => {
    const { state, bot, executor } = fixture();
    executor.balance = function (asset: Asset) {
      return Promise.resolve(asset === ASSETS.xdai ? 0n : 1000000n * UNIT);
    };
    await expect(bot().run(PRINCIPAL, executor)).rejects.toThrow("gas reserve on chain 100");
    expect(state.executed).toHaveLength(0);
  });

  it("does not wrap the native gas reserve along with bridged principal", async () => {
    const { state, bot, executor } = fixture();
    executor.balance = function (asset) {
      return Promise.resolve(asset === ASSETS.xdai && state.executed.length ? PRINCIPAL : 1000000n * UNIT);
    };
    await expect(bot().run(PRINCIPAL, executor)).rejects.toBeInstanceOf(ArbitrageExecutionError);
    expect(state.executed).toHaveLength(1);
  });

  it("does not submit a quote that expires while checking balances", async () => {
    const { state, bot, executor } = fixture();
    executor.balance = function () {
      state.now += 60000;
      return Promise.resolve(1000000n * UNIT);
    };
    await expect(bot().run(PRINCIPAL, executor)).rejects.toThrow("Expired");
    expect(state.executed).toHaveLength(0);
  });

  it("waits for delivery and prevents concurrent live runs on the same bot", async () => {
    const { state, bot, executor } = fixture();
    let release: () => void = function () {
      throw new Error("Delivery not ready");
    };
    let entered: () => void = function () {
      throw new Error("Execution not ready");
    };
    const delivery = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const execute = executor.execute;
    executor.execute = async function (step) {
      if (step.leg.id === BRIDGE_DAI) {
        entered();
        await delivery;
      }
      return execute(step);
    };
    const instance = bot();
    const running = instance.run(PRINCIPAL, executor);
    await started;
    const beforeDelivery = state.quoted.length;
    await expect(instance.run(PRINCIPAL, executor)).rejects.toThrow("already in progress");
    expect(state.executed).toHaveLength(0);
    expect(state.quoted).toHaveLength(beforeDelivery);
    release();
    expect((await running).status).toBe("completed");
  });

  it("reports the pending leg on underdelivery instead of starting another transaction", async () => {
    const { bot, executor } = fixture();
    executor.execute = function (step) {
      return Promise.resolve(step.minAmountOut - 1n);
    };
    try {
      await bot().run(PRINCIPAL, executor);
      throw new Error("Expected execution to stop");
    } catch (error) {
      expect(error).toBeInstanceOf(ArbitrageExecutionError);
      const failure = error as ArbitrageExecutionError;
      expect(failure.completed).toHaveLength(0);
      expect(failure.pendingStep?.leg.id).toBe(BRIDGE_DAI);
    }
  });

  it("fails closed for missing destination claim gas, expired quotes and invalid inputs", async () => {
    const { quotes, bot, state } = fixture();
    const originalQuote = quotes.quote;
    quotes.quote = async function (leg, amount, slippage) {
      const quote = await originalQuote(leg, amount, slippage);
      return { ...quote, gas: quote.gas.filter((gas) => leg.id !== "bridge-uusd" || gas.chainId !== 1) };
    };
    await expect(bot().quote(PRINCIPAL)).rejects.toThrow("Missing gas estimate for bridge-uusd");
    quotes.quote = async function (leg, amount, slippage) {
      return { ...(await originalQuote(leg, amount, slippage)), validUntil: state.now };
    };
    await expect(bot().quote(PRINCIPAL)).rejects.toThrow("Expired");
    await expect(bot().quote(0n)).rejects.toThrow("positive");
    expect(() => bot({ slippageBps: 10000 })).toThrow("Invalid arbitrage policy");
  });
});

const POOL = `0x${"1".repeat(40)}`;
const INPUT_TOKEN = `0x${"2".repeat(40)}`;
const OUTPUT_TOKEN = `0x${"3".repeat(40)}`;
const ACCOUNT = `0x${"4".repeat(40)}`;
const POOL_CONFIG = { market: MARKETS.gnosis, address: POOL, tokenIn: INPUT_TOKEN, tokenOut: OUTPUT_TOKEN };

function rpcFixture() {
  const calls: { method: string; params: readonly unknown[] }[] = [];
  const request: RpcRequest = function (method, params) {
    calls.push({ method, params });
    if (method === CHAIN_ID_METHOD) return Promise.resolve("0x64");
    if (method === "eth_blockNumber") return Promise.resolve("0x100");
    if (method === "eth_estimateGas") return Promise.resolve("0x5208");
    if (method === "eth_gasPrice") return Promise.resolve("0x2");
    if (method === "eth_call") {
      const { data } = params[0] as { data: string };
      let value = 18n;
      if (data.startsWith("0xc6610657")) value = BigInt(data.endsWith("0") ? OUTPUT_TOKEN : INPUT_TOKEN);
      if (data.startsWith("0x5e0d443f")) value = (PRINCIPAL * 100n) / 97n;
      return Promise.resolve(`0x${value.toString(16).padStart(64, "0")}`);
    }
    throw new Error(`Unexpected RPC call: ${method}`);
  };
  return { calls, request };
}

describe("EVM quote helpers", () => {
  it("reads Curve coin ordering and quotes at one block with an enforceable minimum", async () => {
    const { request, calls } = rpcFixture();
    const quote = await new EvmQuotes(100, request).quoteSwap(ROUTE[2], POOL_CONFIG, PRINCIPAL, 50);
    expect(quote.minAmountOut).toBe((((PRINCIPAL * 100n) / 97n) * 9950n) / 10000n);
    expect(quote.data.slice(0, 10)).toBe("0x3df02124");
    expect(BigInt(`0x${quote.data.slice(10, 74)}`)).toBe(1n);
    expect(BigInt(`0x${quote.data.slice(74, 138)}`)).toBe(0n);
    expect(BigInt(`0x${quote.data.slice(-64)}`)).toBe(quote.minAmountOut);
    expect(calls.filter((call) => call.method === "eth_call").every((call) => call.params[1] === "0x100")).toBe(true);
  });

  it("rejects the wrong chain, market and coin mapping", async () => {
    const { request } = rpcFixture();
    await expect(new EvmQuotes(1, request).estimateGas({ from: ACCOUNT, to: POOL })).rejects.toThrow("chain mismatch");
    const client = new EvmQuotes(100, request);
    await expect(client.quoteSwap(ROUTE[2], { ...POOL_CONFIG, market: MARKETS.mainnet }, PRINCIPAL, 0)).rejects.toThrow("Invalid Curve");
    await expect(client.quoteSwap(ROUTE[2], { ...POOL_CONFIG, tokenIn: ACCOUNT }, PRINCIPAL, 0)).rejects.toThrow("pool coins");
  });

  it("rejects unsupported token decimals and a malformed on-chain quote", async () => {
    const { request } = rpcFixture();
    const wrongDecimals: RpcRequest = function (method, params) {
      if (method === "eth_call" && (params[0] as { data: string }).data === "0x313ce567") {
        return Promise.resolve(`0x${"6".padStart(64, "0")}`);
      }
      return request(method, params);
    };
    await expect(new EvmQuotes(100, wrongDecimals).quoteSwap(ROUTE[2], POOL_CONFIG, PRINCIPAL, 0)).rejects.toThrow("decimals");
    const malformed: RpcRequest = function (method, params) {
      if (method === "eth_call") return Promise.resolve("0x01");
      return request(method, params);
    };
    await expect(new EvmQuotes(100, malformed).quoteSwap(ROUTE[2], POOL_CONFIG, PRINCIPAL, 0)).rejects.toThrow("Invalid ABI result");
  });

  it("estimates each transaction's native gas without mixing chains or principal", async () => {
    const { request } = rpcFixture();
    expect(await new EvmQuotes(100, request).estimateGas({ from: ACCOUNT, to: POOL }, 5n)).toEqual({
      chainId: 100,
      gasLimit: 21000n,
      maxFeePerGas: 2n,
      nativeFee: 5n,
    });
  });

  it("rejects HTTP and JSON-RPC errors without exposing endpoint credentials", async () => {
    const httpFailure = createRpcRequest("https://unused.invalid", function () {
      return Promise.resolve(new Response("unavailable", { status: 503 }));
    });
    await expect(httpFailure(CHAIN_ID_METHOD, [])).rejects.toThrow("RPC HTTP error 503");
    const rpcFailure = createRpcRequest("https://unused.invalid", function () {
      return Promise.resolve(Response.json({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "failure" } }));
    });
    await expect(rpcFailure(CHAIN_ID_METHOD, [])).rejects.toThrow("RPC request failed: eth_chainId");
  });
});
