# @bookrunner/web

Investor pages (Home `/`, Invest `/invest`, Portfolio `/portfolio`, Stake `/stake`, How it works
`/learn`) and the operator dashboards under the Protocol menu (ARCHITECTURE §5): Books `/books`, Book
detail, Charters (+ "File a charter"), Committee, Risk, Agents. Vite 8 + React 19 + TanStack Query +
tRPC client (types from `@bookrunner/api/router`, never bundled) + Tailwind 4 + viem / wagmi.

## Run

| Command | What |
|---|---|
| `bun run dev` | dev server on http://127.0.0.1:5180 against the local devnet (chain 31337) |
| `bun run dev:testnet` | same, built for Robinhood Chain testnet (chain 46630, `.env.testnet`) |
| `bun run build` / `bun run build:testnet` | production bundle in `dist/` |
| `bun run start` | build, then serve `dist/` on :5180 |
| `bun run test` | unit tests (formatters, chart transforms, waterfall / loss order, proofs, tx flow, onboarding, amounts, glossary, copy rules) |
| `bun run typecheck` | `tsc` for the browser app and the Bun-side tests / scripts |
| `bun run lint:copy` | copy rules over JSX text and string literals of `src/` and `index.html` |

The API must allow the page's origin (`WEB_ORIGIN`, default `http://127.0.0.1:5180`).

Builds are mounted at `/app/` (Vite `base`, `scripts/base.ts`; the public site `apps/site` owns the web
root, see `deploy/server/README.md`): `bun run start` / `preview` serve http://127.0.0.1:5180/app/. The dev
server stays at `/`. `WEB_BASE=/` builds for the root instead. The router's `basename` follows
`import.meta.env.BASE_URL` (`src/lib/basePath.ts`), so in-app links are written from `/`
(`<Link to="/books">`); links that leave the router (copy-a-link) go through `appUrl()`. The API is not
under the mount: `VITE_API_URL=same-origin` calls `{origin}/trpc` and `{origin}/health`.

## Configuration (`VITE_*`, see `.env.example`)

`VITE_CHAIN_ID` (default 31337), `VITE_RPC_URL`, `VITE_EXPLORER_URL`, `VITE_FAUCET_URL`, `VITE_API_URL`
(default `http://127.0.0.1:4400`), optional `VITE_CHAIN_NAME`, `VITE_CHAIN_KIND` (devnet / testnet / mainnet for a custom
chain id, which otherwise gets no test-network features), `VITE_USDC_ADDRESS`, and
`VITE_WALLETCONNECT_PROJECT_ID` (the WalletConnect option appears only when it is set; set it for any public
deployment, or phone visitors without a wallet app browser have no way to connect). Chain 46630
defaults to the public Robinhood Chain testnet RPC, explorer and faucet.

## Wallets

- Connect dialog (`useConnectModal().open()`): browser wallets discovered through EIP-6963 (name and
  icon), the generic injected wallet as a fallback, WalletConnect (QR code / mobile) only when
  `VITE_WALLETCONNECT_PROJECT_ID` is set, and a short "new to wallets" explainer. Connecting first
  connects, then asks the wallet to switch to the app chain (adding it when missing) as a separate
  step (`src/wallet/connectFlow.ts`): declining leaves the wallet connected on its own chain, and a
  site-wide banner offers the switch whenever the wallet sits on another chain.
- Account menu: address (copy, explorer), network, ETH / USDC / BKRN balances, the faucet when gas is
  low and, on test networks whose USDC is the open-mint mock, "Mint 10,000 test USDC".
- Devnet only (build for 31337 and an API on 31337): dev wallets sign with the anvil test accounts
  behind each role (`@bookrunner/shared/devkeys`), listed in the connect dialog. The signer
  (`src/lib/devsigner.ts`) loads only behind the compile-time gate in `src/wallet/devGate.ts`, so
  testnet and mainnet bundles never contain the anvil mnemonic; `vite.config.ts` fails such a build
  if it ever does.
- `src/wallet/walletConnect.js` re-exports wagmi's WalletConnect connector with a narrow
  `walletConnect.d.ts`: the package's own types would pull @walletconnect's type graph (and a second
  viem) into `tsc` and roughly double its memory.

Prepared transactions from the API (`{to, data, value, chainId, description}`) are sent in order,
each after the previous confirms, with pending / confirmed / failed states and retry from the failed
step (`TxRunner`).

## Design system

Tokens live in `src/styles.css` (light and dark, system default with a `data-theme` override). Fixed
series colours in every chart and diagram (`src/lib/palette.ts`): Senior blue, Junior amber, Backstop
/ BKRN violet, fee flow green, losses red. Primitives are in `src/components/ui.tsx` (Container,
Section, Card, Stat / StatGrid, Badge, TrancheBadge, Callout, Stepper, Tabs, Accordion, AmountInput,
Modal, ...); inline glossary terms use `<Term id="...">` with definitions in `src/lib/glossary.ts`.
`<SetupChecklist/>` walks a new wallet through connect, network, gas, test USDC and invest.
Investor routes are full-bleed (`handle.bleed` in `src/router.tsx`): build them from `<Section>`
blocks; every other route gets the page container from the layout.
