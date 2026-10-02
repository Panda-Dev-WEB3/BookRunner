# @bookrunner/web

Book dashboards (ARCHITECTURE §5): Books, Book detail, Charters (+ "File a charter"), Committee, Risk,
Agents. Vite 8 + React 19 + TanStack Query + tRPC client (types from `@bookrunner/api/router`, never
bundled) + Tailwind 4 + viem / wagmi.

## Run

| Command | What |
|---|---|
| `bun run dev` | dev server on http://127.0.0.1:5180 against the local devnet (chain 31337) |
| `bun run dev:testnet` | same, built for Robinhood Chain testnet (chain 46630, `.env.testnet`) |
| `bun run build` / `bun run build:testnet` | production bundle in `dist/` |
| `bun run start` | build, then serve `dist/` on :5180 |
| `bun run test` | unit tests (formatters, chart transforms, waterfall / loss order, proofs, tx flow, copy rules) |
| `bun run typecheck` | `tsc` for the browser app and the Bun-side tests / scripts |
| `bun run lint:copy` | copy rules over JSX text and string literals of `src/` and `index.html` |

The API must allow the page's origin (`WEB_ORIGIN`, default `http://127.0.0.1:5180`).

## Configuration (`VITE_*`, see `.env.example`)

`VITE_CHAIN_ID` (default 31337), `VITE_RPC_URL`, `VITE_EXPLORER_URL`, `VITE_FAUCET_URL`, `VITE_API_URL`
(default `http://127.0.0.1:4400`), optional `VITE_CHAIN_NAME`, `VITE_USDC_ADDRESS`. Chain 46630 defaults
to the public Robinhood Chain testnet RPC, explorer and faucet.

## Wallets

- Browser wallet (wagmi injected / EIP-6963). Connecting asks the wallet to switch to the app chain
  and adds it when missing; the wallet menu and every prepared-transaction list offer "switch" and
  "add network" when the wallet sits on another chain.
- Devnet only (build for 31337 and an API on 31337): the dev-wallet picker signs with the anvil test
  accounts behind each role (`@bookrunner/shared/devkeys`).
- Test networks: the wallet menu shows the gas balance (with the faucet when empty) and, when the
  deployment's USDC is the open-mint mock, a "Get 10,000 test USDC" mint the wallet signs itself.

Prepared transactions from the API (`{to, data, value, chainId, description}`) are sent in order,
each after the previous confirms, with pending / confirmed / failed states and retry from the failed
step.
