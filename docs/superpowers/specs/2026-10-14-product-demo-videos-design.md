# BookRunner product demo videos — design

Date: 2026-10-14 · Status: approved in conversation

## Goal

Four short screen-recorded demos (1–2 min each, 16:9 1920×1080, text on screen, no voice) of the real product on
Robinhood Chain testnet, built on the existing `video/` Remotion project:

| # | Clip | Journey |
|---|---|---|
| 1 | Public site tour | bookrunner.tech home → live desk `/dashboard/` → `/status/` → rulebook `/documents/` (no wallet) |
| 2 | Allocator journey | connect wallet → mint 10,000 test USDC → books list → NVDA book (NAV, marks, fills & hedges, fee waterfall) → choose Senior/Junior → deposit (approve + deposit, real testnet txs) → Portfolio "waiting for a mark" → Withdraw tab explained |
| 3 | Sponsor & committee | `/charters/new` five-step form filled in → review step shows the prepared transactions (**not sent**) → `/charters/1` (terms, jury rationale, 2-of-3 votes) → `/committee` recent decisions → the NVDA book it created |
| 4 | Risk, agents & marks | `/risk` meters, breaches, kills → `/agents` keys per book → a book's signed marks, Merkle verify, fee waterfall per period |

## Constraints (from the investigation)

- Withdrawal cannot be demoed with a fresh wallet before the current top-up round settles (round end ≈ 2026-10-16
  21:17 UTC + next hourly mark). Clip 2 shows the deposit and the Withdraw tab; a withdrawal can be re-recorded from 2026-10-17.
- Charter filing needs a 100,000 BKRN bond (BKRN is not mintable): clip 3 stops at the review step; nothing is filed.
- Committee votes need seated committee keys that also run on the server (same keys must never be used from two
  places): the committee is shown read-only.
- Agents register/revoke need the sponsor's wallet: shown read-only.

## How it is recorded

- **App under test runs locally**: the operator app (`apps/web`) built for testnet with `VITE_API_URL=same-origin`
  and base `/app/`, served by a small local server inside the recording container at `http://localhost:<port>/app/`,
  which proxies `/trpc` and `/health` to `https://bookrunner.tech` (the live API only allows the bookrunner.tech
  origin, so the browser must see a same-origin API). Wallet RPC goes straight to the public testnet RPC (CORS `*`).
  Clip 1 records the public site directly (read-only).
- **Demo wallet**: a fresh key generated for the demos, stored in a gitignored file, never typed into any page.
  The page gets an EIP-6963-announced EIP-1193 provider (`addInitScript`); `eth_sendTransaction` is forwarded to Node
  (`page.exposeFunction`) where viem signs and broadcasts to the testnet RPC. Methods: `eth_requestAccounts`,
  `eth_accounts`, `eth_chainId`, `wallet_switchEthereumChain`, `wallet_addEthereumChain`, `wallet_revokePermissions`,
  `eth_sendTransaction`, plus read methods forwarded to the RPC; events `accountsChanged` / `chainChanged`.
  Funding: test ETH sent once from the testnet funder **on the server** (one-off, not from the PC); test USDC minted
  on camera with the app's own "Mint 10,000 test USDC" button.
- **Recorder**: Playwright (Docker image `mcr.microsoft.com/playwright:v1.64.1-noble`) drives each scenario with
  human-paced steps (visible synthetic cursor, smooth moves, typed input), records a 1920×1080 webm and writes a
  step log (timestamp + caption key) next to it. Fails loudly (HTTP status, landmarks, tx receipts).
- **Captions**: Remotion composition `Demo` (16:9) plays the recording, speeds up waits, and overlays a lower-third
  caption per step plus a short title card; all words in `video/src/demo-copy.ts` (copy-checked like `copy.ts`).
- Output: `video/out/bookrunner-demo-<1-site|2-allocator|3-sponsor|4-risk>.mp4` (+ poster PNG). Recordings and
  outputs gitignored.

## Verification

Each recording's step log shows every step reached; tx receipts succeeded (clip 2); stills per caption step reviewed
by the user before the final render; final MP4s checked (duration, 1920×1080, 30 fps, frames sampled).
