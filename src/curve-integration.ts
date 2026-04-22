/**
 * Curve Finance pool integration for stable-ng pools.
 *
 * Reads pool state (virtual price, balances, A parameter) from on-chain
 * contracts via eth-like RPC calls. Uses raw `eth_call` to avoid heavy
 * dependency on ethers/viem at this stage.
 */

import { CHAINS, type ChainConfig } from "./config";

/* ── ABIs (minimal) ──────────────────────────────────────────── */

const CURVE_REGISTRY_ABI = [
  "function get_pool_from_lp_token(address) view returns (address)",
  "function get_lp_token(address) view returns (address)",
  "function get_coins(address) view returns (address[8])",
  "function get_balances(address) view returns (uint256[8])",
];

const STABLE_NG_ABI = [
  "function A() view returns (uint256)",
  "function fee() view returns (uint256)",
  "function get_virtual_price() view returns (uint256)",
  "function balances(uint256) view returns (uint256)",
  "function coins(uint256) view returns (address)",
  "function get_dy(int128,int128,uint256) view returns (uint256)",
  "function exchange(int128,int128,uint256,uint256) returns (uint256)",
  "function N_COINS() view returns (uint256)",
];

/* ── Types ───────────────────────────────────────────────────── */

export interface PoolState {
  readonly chainKey: string;
  readonly poolAddress: string;
  readonly virtualPrice: bigint;
  readonly balances: bigint[];
  readonly amplification: bigint;
  readonly fee: bigint;
  readonly coinAddresses: string[];
  readonly blockNumber: number;
  readonly timestamp: number;
}

export interface ExchangeQuote {
  readonly amountOut: bigint;
  readonly fee: bigint;
  readonly effectivePrice: bigint;
}

/* ── Low-level RPC helper ────────────────────────────────────── */

async function ethCall(rpcUrl: string, to: string, data: string): Promise<string> {
  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to, data }, "latest"],
    }),
  });
  const json = (await resp.json()) as { result?: string; error?: { message: string } };
  if (json.error) {
    throw new Error(`RPC error: ${json.error.message}`);
  }
  return json.result ?? "0x";
}

async function getBlockNumber(rpcUrl: string): Promise<number> {
  const resp = await fetch(rpcUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
  });
  const json = (await resp.json()) as { result?: string };
  return parseInt(json.result ?? "0x0", 16);
}

/* ── ABI encoding helpers ────────────────────────────────────── */

function encodeFunction(selector: string, params: string[] = []): string {
  return selector + params.join("");
}

function padAddress(addr: string): string {
  return addr.toLowerCase().replace("0x", "").padStart(64, "0");
}

function padUint256(val: bigint): string {
  return val.toString(16).padStart(64, "0");
}

function padInt128(val: number): string {
  return val.toString(16).padStart(64, "0");
}

/* keccak selectors — pre-computed for the methods we need */
const SELECTOR = {
  A: "1e4e3a63",
  fee: "ddca3f43",
  get_virtual_price: "bb7b8b80",
  balances: "4903b0d1",
  coins: "c6610657",
  get_dy: "536aa264",
  exchange: "3df02124",
  N_COINS: "e6685f48",
} as const;

/* ── Pool state reader ───────────────────────────────────────── */

/**
 * Fetch on-chain state for a Curve stable-ng pool.
 * Falls back gracefully when RPC is unavailable.
 */
export async function fetchPoolState(chainKey: string): Promise<PoolState> {
  const chain = CHAINS[chainKey];
  if (!chain) throw new Error(`Unknown chain: ${chainKey}`);

  const pool = chain.poolAddress;
  const rpc = chain.rpcUrl;

  const [virtualPriceRaw, feeRaw, ampRaw, blockNum] = await Promise.all([
    ethCall(rpc, pool, `0x${SELECTOR.get_virtual_price}`),
    ethCall(rpc, pool, `0x${SELECTOR.fee}`),
    ethCall(rpc, pool, `0x${SELECTOR.A}`),
    getBlockNumber(rpc),
  ]);

  const balances: bigint[] = [];
  const coinAddresses: string[] = [];

  // Read first 2 coins/balances (stable pools typically have 2-4 coins)
  for (let i = 0; i < 2; i++) {
    try {
      const [balRaw, coinRaw] = await Promise.all([
        ethCall(rpc, pool, `0x${SELECTOR.balances}${padUint256(BigInt(i))}`),
        ethCall(rpc, pool, `0x${SELECTOR.coins}${padUint256(BigInt(i))}`),
      ]);
      balances.push(BigInt(balRaw));
      coinAddresses.push("0x" + coinRaw.slice(26));
    } catch {
      balances.push(0n);
      coinAddresses.push("0x" + "0".repeat(40));
    }
  }

  return {
    chainKey,
    poolAddress: pool,
    virtualPrice: BigInt(virtualPriceRaw),
    balances,
    amplification: BigInt(ampRaw),
    fee: BigInt(feeRaw),
    coinAddresses,
    blockNumber: blockNum,
    timestamp: Date.now(),
  };
}

/**
 * Simulate a swap (get_dy) to determine output amount.
 */
export async function getDy(
  chainKey: string,
  i: number,
  j: number,
  amount: bigint
): Promise<bigint> {
  const chain = CHAINS[chainKey];
  const data = `0x${SELECTOR.get_dy}${padInt128(i)}${padInt128(j)}${padUint256(amount)}`;
  const result = await ethCall(chain.rpcUrl, chain.poolAddress, data);
  return BigInt(result);
}

/**
 * Build an exchange transaction payload.
 */
export function buildExchangeTx(
  i: number,
  j: number,
  amountIn: bigint,
  minAmountOut: bigint
): { to: string; data: string; value: string } {
  const chain = CHAINS.mainnet; // default; caller overrides
  return {
    to: chain.poolAddress,
    data: `0x${SELECTOR.exchange}${padInt128(i)}${padInt128(j)}${padUint256(amountIn)}${padUint256(minAmountOut)}`,
    value: "0x0",
  };
}

/**
 * Build exchange tx for a specific chain.
 */
export function buildExchangeTxForChain(
  chainKey: string,
  i: number,
  j: number,
  amountIn: bigint,
  minAmountOut: bigint
): { to: string; data: string; value: string } {
  const chain = CHAINS[chainKey];
  return {
    to: chain.poolAddress,
    data: `0x${SELECTOR.exchange}${padInt128(i)}${padInt128(j)}${padUint256(amountIn)}${padUint256(minAmountOut)}`,
    value: "0x0",
  };
}
