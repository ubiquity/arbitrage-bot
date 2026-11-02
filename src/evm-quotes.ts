// cspell:words dai gnosis xdai wxdai uusd lusd mainnet relayer calldata requote requotes underdelivery
import { ChainId, Market, RouteLeg } from "./markets";
import { GasEstimate } from "./multi-chain-arbitrage";

export type RpcRequest = (method: string, params: readonly unknown[]) => Promise<unknown>;

export interface Transaction {
  readonly from: string;
  readonly to: string;
  readonly data?: string;
  readonly value?: string;
}

function hex(value: unknown): string {
  if (typeof value !== "string" || !/^0x[\da-f]+$/i.test(value)) throw new Error("Invalid RPC hex result");
  return value;
}

function address(value: string): string {
  if (!/^0x[\da-f]{40}$/i.test(value) || BigInt(value) === 0n) throw new Error("Invalid contract address");
  return value.toLowerCase();
}

function word(value: bigint): string {
  if (value < 0n || value >= 2n ** 256n) throw new Error("Invalid ABI integer");
  return value.toString(16).padStart(64, "0");
}

export function createRpcRequest(url: string, fetcher: typeof fetch = fetch): RpcRequest {
  let id = 0;
  return async function request(method, params) {
    const requestId = ++id;
    const response = await fetcher(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`RPC HTTP error ${response.status}`);
    const body: unknown = await response.json();
    if (!body || typeof body !== "object" || !("id" in body) || body.id !== requestId || "error" in body || !("result" in body)) {
      throw new Error(`RPC request failed: ${method}`);
    }
    return body.result;
  };
}

// Pool/token addresses must be supplied from verified deployment configuration.
// Verify the network, on-chain coin ordering and decimals rather than assuming
// the order shown by Curve's UI. No signing or unlocked RPC accounts are used.
export class EvmQuotes {
  constructor(
    readonly chainId: ChainId,
    private readonly _request: RpcRequest
  ) {}

  async estimateGas(transaction: Transaction, nativeFee = 0n): Promise<GasEstimate> {
    await this._checkChain();
    address(transaction.from);
    address(transaction.to);
    if (nativeFee < 0n) throw new Error("Invalid native fee");
    const gasLimit = BigInt(hex(await this._request("eth_estimateGas", [transaction])));
    const maxFeePerGas = BigInt(hex(await this._request("eth_gasPrice", [])));
    if (gasLimit <= 0n || maxFeePerGas <= 0n) throw new Error("Invalid gas estimate");
    return { chainId: this.chainId, gasLimit, maxFeePerGas, nativeFee };
  }

  async quoteSwap(
    leg: RouteLeg,
    pool: { market: Market; address: string; tokenIn: string; tokenOut: string },
    amountIn: bigint,
    slippageBps: number
  ): Promise<{ minAmountOut: bigint; data: string }> {
    if (
      leg.kind !== "swap" ||
      !leg.market ||
      leg.market.chainId !== this.chainId ||
      pool.market.chainId !== this.chainId ||
      pool.market.poolId !== leg.market.poolId ||
      amountIn <= 0n ||
      !Number.isInteger(slippageBps) ||
      slippageBps < 0 ||
      slippageBps >= 10000
    ) {
      throw new Error("Invalid Curve swap request");
    }
    await this._checkChain();
    const poolAddress = address(pool.address);
    const tokenIn = address(pool.tokenIn);
    const tokenOut = address(pool.tokenOut);
    const block = hex(await this._request("eth_blockNumber", []));
    const coins = await Promise.all([0n, 1n].map((index) => this._call(poolAddress, `0xc6610657${word(index)}`, block)));
    const coinAddresses = coins.map((coin) => address(`0x${word(BigInt(coin)).slice(24)}`));
    const inputIndex = coinAddresses.indexOf(tokenIn);
    const outputIndex = coinAddresses.indexOf(tokenOut);
    if (inputIndex < 0 || outputIndex < 0 || inputIndex === outputIndex) throw new Error("Unexpected Curve pool coins");
    for (const token of [tokenIn, tokenOut]) {
      if (BigInt(await this._call(token, "0x313ce567", block)) !== 18n) throw new Error("Unsupported token decimals");
    }
    const argumentsData = `${word(BigInt(inputIndex))}${word(BigInt(outputIndex))}${word(amountIn)}`;
    const output = BigInt(await this._call(poolAddress, `0x5e0d443f${argumentsData}`, block));
    const minAmountOut = (output * BigInt(10000 - slippageBps)) / 10000n;
    if (minAmountOut <= 0n) throw new Error("Curve swap has no output");
    // exchange(int128,int128,uint256,uint256), with an enforced minimum output.
    return { minAmountOut, data: `0x3df02124${argumentsData}${word(minAmountOut)}` };
  }

  private async _checkChain(): Promise<void> {
    if (BigInt(hex(await this._request("eth_chainId", []))) !== BigInt(this.chainId)) throw new Error("RPC chain mismatch");
  }

  private async _call(to: string, data: string, block: string): Promise<string> {
    const result = hex(await this._request("eth_call", [{ to, data }, block]));
    if (result.length !== 66) throw new Error("Invalid ABI result");
    return result;
  }
}
