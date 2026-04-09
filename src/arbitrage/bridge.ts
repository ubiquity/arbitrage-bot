/**
 * Bridge integration for cross-chain arbitrage.
 *
 * Handles:
 *  - DAI → xDAI bridging (Mainnet → Gnosis via Omnibridge)
 *  - UUSD bridging back (Gnosis → Mainnet via Omnibridge)
 *  - Bridge transaction status tracking
 */
import { ethers } from "ethers";
import { CHAINS, BRIDGE_FEES } from "../config/chains";

/* ---------- ABIs (minimal) ---------- */

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function balanceOf(address account) view returns (uint256)",
];

// Omnibridge — relayTokens(address token, address receiver, uint256 amount)
const OMNIBRIDGE_ABI = [
  "function relayTokens(address token, address _receiver, uint256 _amount) payable",
  "function requiredMessageLength() view returns (uint256)",
];

/* ---------- Helpers ---------- */

function getProvider(chain: "mainnet" | "gnosis"): ethers.providers.JsonRpcProvider {
  return new ethers.providers.JsonRpcProvider(CHAINS[chain].rpcUrl, CHAINS[chain].chainId);
}

function getSigner(chain: "mainnet" | "gnosis", privateKey: string): ethers.Signer {
  return new ethers.Wallet(privateKey, getProvider(chain));
}

/**
 * Approve ERC-20 spending if current allowance is insufficient.
 */
export async function ensureApproval(
  chain: "mainnet" | "gnosis",
  tokenAddress: string,
  spenderAddress: string,
  amount: ethers.BigNumber,
  privateKey: string
): Promise<void> {
  const signer = getSigner(chain, privateKey);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
  const owner = await signer.getAddress();
  const allowance = await token.allowance(owner, spenderAddress);
  if (allowance.gte(amount)) return;
  console.log(`[bridge] Approving ${spenderAddress} for ${tokenAddress} on ${chain}…`);
  const tx = await token.approve(spenderAddress, amount);
  await tx.wait();
  console.log(`[bridge] Approval confirmed: ${tx.hash}`);
}

/**
 * Bridge DAI from Mainnet → Gnosis (becomes xDAI / WXDAI).
 *
 * Flow:
 *  1. Approve Omnibridge to spend DAI
 *  2. Call relayTokens(DAI, receiver, amount) on Mainnet Omnibridge
 *  3. Wait for confirmation
 *
 * @returns Mainnet tx hash for tracking
 */
export async function bridgeDaiToGnosis(
  amountDai: ethers.BigNumber,
  receiverOnGnosis: string,
  privateKey: string
): Promise<string> {
  const mainnet = CHAINS.mainnet;
  const signer = getSigner("mainnet", privateKey);

  await ensureApproval("mainnet", mainnet.tokens.DAI, mainnet.bridgeAddress, amountDai, privateKey);

  const bridge = new ethers.Contract(mainnet.bridgeAddress, OMNIBRIDGE_ABI, signer);
  console.log(`[bridge] Bridging ${ethers.utils.formatUnits(amountDai, 18)} DAI → Gnosis…`);

  const tx = await bridge.relayTokens(mainnet.tokens.DAI, receiverOnGnosis, amountDai, {
    gasLimit: mainnet.gasLimit.bridge,
  });
  console.log(`[bridge] Bridge tx submitted: ${tx.hash}`);
  await tx.wait();
  console.log(`[bridge] Bridge tx confirmed: ${tx.hash}`);
  return tx.hash;
}

/**
 * Bridge ERC-20 token (e.g. UUSD) from Gnosis → Mainnet via Omnibridge.
 *
 * @returns Gnosis tx hash for tracking
 */
export async function bridgeTokenToMainnet(
  tokenAddress: string,
  amount: ethers.BigNumber,
  receiverOnMainnet: string,
  privateKey: string
): Promise<string> {
  const gnosis = CHAINS.gnosis;
  const signer = getSigner("gnosis", privateKey);

  await ensureApproval("gnosis", tokenAddress, gnosis.bridgeAddress, amount, privateKey);

  const bridge = new ethers.Contract(gnosis.bridgeAddress, OMNIBRIDGE_ABI, signer);
  console.log(`[bridge] Bridging ${ethers.utils.formatUnits(amount, 18)} tokens → Mainnet…`);

  const tx = await bridge.relayTokens(tokenAddress, receiverOnMainnet, amount, {
    gasLimit: gnosis.gasLimit.bridge,
  });
  console.log(`[bridge] Bridge tx submitted: ${tx.hash}`);
  await tx.wait();
  console.log(`[bridge] Bridge tx confirmed: ${tx.hash}`);
  return tx.hash;
}

/**
 * Wait for a bridge relay to complete on the destination chain.
 *
 * Simplified polling: checks receiver token balance until it increases.
 */
export async function waitForBridgeDelivery(
  chain: "mainnet" | "gnosis",
  tokenAddress: string,
  receiver: string,
  expectedAmount: ethers.BigNumber,
  timeoutMs = 600_000, // 10 minutes default
  pollMs = 15_000
): Promise<boolean> {
  const provider = getProvider(chain);
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const startBalance = await token.balanceOf(receiver);
  const deadline = Date.now() + timeoutMs;

  console.log(`[bridge] Waiting for bridge delivery on ${chain}…`);
  while (Date.now() < deadline) {
    const bal = await token.balanceOf(receiver);
    if (bal.gte(startBalance.add(expectedAmount.mul(95).div(100)))) {
      // Accept 5% slippage on bridge amount
      console.log(`[bridge] Delivery confirmed. Balance: ${ethers.utils.formatUnits(bal, 18)}`);
      return true;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  console.error(`[bridge] Delivery timed out after ${timeoutMs / 1000}s`);
  return false;
}

/**
 * Estimate total bridge fees for a round trip (DAI → Gnosis, token → Mainnet).
 */
export function estimateRoundTripBridgeFees(): number {
  return BRIDGE_FEES.mainnetToGnosis + BRIDGE_FEES.gnosisToMainnet;
}
