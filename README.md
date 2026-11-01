<!-- cspell:words uusd gnosis xdai wxdai lusd mainnet relayer calldata requotes get_dy -->

# Multi-chain UUSD arbitrage

The supported route returns liquidity to Ethereum Mainnet:

1. Bridge Mainnet DAI to Gnosis xDAI.
2. Wrap xDAI as WXDAI, leaving a separately funded native gas reserve.
3. Buy UUSD in [Gnosis factory-stable-ng-29](https://www.curve.finance/dex/xdai/pools/factory-stable-ng-29/swap/).
4. Bridge UUSD to Mainnet, including the destination claim.
5. Sell UUSD for LUSD in [Mainnet factory-stable-ng-164](https://www.curve.finance/dex/ethereum/pools/factory-stable-ng-164/swap/).

`build/index.ts` exports the route, `MultiChainArbitrage`, and dependency-free
`EvmQuotes` / `createRpcRequest` helpers. Amounts and prices use `bigint` with
18 decimals; the TypeScript target is ES2022 (Node 20+).

## Deployment adapters

This checkout does not contain a signer or a bridge proof/relayer service. Live
execution requires deployment-specific implementations of `QuoteProvider` and
`Executor`; **no transactions are sent by default**. Do not point signing RPCs at
unverified contracts. Resolve and verify contract/token addresses for the exact
pool IDs in `MARKETS` and both bridge deployments; pool IDs are not addresses.

A quote provider must:

- Quote each leg for the supplied input and slippage, returning its **minimum**
  delivered output after all token-denominated fees. Downstream legs use this
  minimum, not the spot price or a nominal 1:1 bridge amount.
- Include gas for every needed approval, bridge submission, wrapping, swap,
  relay and destination claim. Omit an approval only if allowance is sufficient.
  `EvmQuotes.estimateGas` estimates individual prepared transactions on the
  verified RPC chain. If a future transaction cannot yet be simulated (for
  example, a claim without its proof), obtain a conservative, enforceable gas
  cap from the bridge adapter; never substitute zero or ignore an estimation
  failure. Extra native fees belong in `nativeFee`, not transferred principal.
- Supply fresh DAI/LUSD, ETH/LUSD and xDAI/LUSD conversion rates and expirations.
  The engine does not assume that any stablecoin is worth one dollar.
- Use `EvmQuotes.quoteSwap` for on-chain Curve `get_dy` quotes and minimum-output
  calldata. Preserve adapter-owned prepared transactions/proofs in the quote
  through `executionData`. It checks RPC chain ID, both pool coins and their 18-decimal units,
  and reads all quote data at the same block. Its prepared exchange calldata
  still needs approval, gas estimation and signing by the deployment adapter.

An executor must enforce the quoted minimum output and buffered gas/fee caps,
check receipts, and await **destination delivery**, not just a source transaction
hash. In particular, the UUSD bridge leg includes its Mainnet claim. Persist
transaction hashes/nonces before advancing, and reconcile pending transfers
before retrying after a restart. Keep credentials outside the repository.

## Quoting and execution

With your adapters `quotes` and `walletExecutor`:

```typescript
import { MultiChainArbitrage, UNIT } from "./build/index";

const bot = new MultiChainArbitrage(quotes, {
  slippageBps: 50, // 0.5% maximum per swap, enforced by the quote adapter
  gasBufferBps: 2000, // 20% gas-limit safety margin
  minProfitLusd: 5n * UNIT,
  maxQuoteAgeMs: 30000,
});

const preview = await bot.run(1000n * UNIT); // dry-run; never signs
const result = await bot.run(1000n * UNIT, walletExecutor); // explicit live opt-in
```

The engine subtracts the original DAI's LUSD value, both chains' native gas costs
(including bridge claims), and native fees from the conservative final LUSD
output. It trades only for positive net profit meeting the configured threshold.
Mainnet ETH and Gnosis xDAI must be pre-funded for the entire route before the
first bridge; bridged principal must not be consumed as the wrapping gas reserve.

Every confirmed leg is followed by a fresh quote of the remaining route,
including updated prices and gas, while retaining the gas budget already spent.
Only the guaranteed output is forwarded; excess tokens remain in the wallet.
A closed spread returns `halted` with completed steps; an uncertain or failed
send throws `ArbitrageExecutionError` with completed/pending step information.
There is no automatic retry or claim that this non-atomic route guarantees
profit: bridging latency can strand intermediate inventory, which needs manual
reconciliation/recovery through the deployment's transaction journal.

## Focused tests

```shell
yarn test --runInBand tests/multi-chain-arbitrage.test.ts
# Also runnable offline with Bun, without repository dependencies:
bun test tests/multi-chain-arbitrage.test.ts
```

---

# `@ubiquity/ts-template`

This template repository includes support for the following:

- TypeScript
- Environment Variables
- Conventional Commits
- Automatic deployment to Cloudflare Pages

## Testing

### Cypress

To test with Cypress Studio UI, run

```shell
yarn cy:open
```

Otherwise, to simply run the tests through the console, run

```shell
yarn cy:run
```

### Jest

To start Jest tests, run

```shell
yarn test
```

## Sync any repository to latest `ts-template`

A bash function that can do this for you:

```bash
sync-branch-to-template() {
  local branch_name
  branch_name=$(git rev-parse --abbrev-ref HEAD)
  local original_remote
  original_remote=$(git remote show | head -n 1)

  # Add the template remote
  git remote add template https://github.com/ubiquity/ts-template

  # Fetch from the template remote
  git fetch template development

  if [ "$branch_name" != "HEAD" ]; then
    # Create a new branch and switch to it
    git checkout -b "chore/merge-${branch_name}-template"

    # Merge the changes from the template remote
    git merge template/development --allow-unrelated-histories

    # Switch back to the original branch
    git checkout "$branch_name"

    # Push the changes to the original remote
    git push "$original_remote" HEAD:"$branch_name"
  else
    echo "You are in a detached HEAD state. Please checkout a branch first."
  fi

  # Remove the template remote
  # git remote remove template
}
```
