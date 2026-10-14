# Contributing

Thanks for your interest in Bookrunner. This is a short guide to the setup, the conventions and what a pull
request needs. For anything security-related, follow [SECURITY.md](SECURITY.md) instead of opening an issue.

## Setup

Requirements: Git, Docker, and Node.js (only to bootstrap Bun).

```bash
npx -y bun@1.4.2 install                      # Bun is a devDependency; this installs it + all workspaces
docker compose up -d                          # Postgres+Timescale :54400, Redis :63790, anvil :8547
./node_modules/.bin/bun run db:migrate
./node_modules/.bin/bun run deploy:local      # contracts on the local anvil (chain 31337) + ABIs
./node_modules/.bin/bun run dev               # every service, one agent per book, web on :5180
```

[`.env.example`](.env.example) documents the settings with their devnet values. Never commit `.env*` files
(other than `.env.example`), keys, mnemonics or deployment records (`contracts/deployments/*.json` are
gitignored).

## Tooling notes

- **Foundry runs in Docker.** Use `bash scripts/forge.sh <build|test|script ...>` (or `bun run forge ...`) instead
  of a native `forge`. It mounts the repo, so it works from any git worktree. `FOUNDRY_TOOL=cast bash
  scripts/forge.sh ...` runs `cast`. Inside the container the host anvil is `http://host.docker.internal:8547`.
  In Git Bash on Windows, prefix other `docker run` commands with `MSYS_NO_PATHCONV=1`.
- **Bun** comes from `node_modules`: `./node_modules/.bin/bun` (Windows: `bun.exe`). Workspaces use Bun's
  isolated linker.
- **ABIs** are generated: after changing a contract's interface run `bun run contracts:build` then `bun run abi`
  (writes `packages/shared/src/abi/`).
- **Waterfall parity:** the TypeScript waterfall in `packages/shared` is normative. After changing it run
  `bun scripts/gen-vectors.ts`; `WaterfallParityTest` must reproduce every row.
- **Specs first:** [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) is the build contract. Behaviour changes update it
  (and [docs/RUNBOOK.md](docs/RUNBOOK.md) / [docs/VERIFY.md](docs/VERIFY.md) where relevant) in the same change.

## Tests

```bash
./node_modules/.bin/bun run contracts:test     # Foundry suite (Docker)
./node_modules/.bin/bun test                   # TypeScript unit tests (no infra needed)
./node_modules/.bin/bun run typecheck          # tsc in every workspace
./node_modules/.bin/bun run lint:copy          # copy rules for README and user-facing app text
```

Integration tests that need running infrastructure are guarded by `BKRN_IT=1`.

## Commit style

One logical change per commit, subject line `<area>: <imperative summary>`, for example:

```
shared: one MAINNET_CHAIN_ID (stockTokens imports devkeys' constant)
apps: settlement token symbol from chain (ERC20 symbol() of config.usdc(); USDG on RHC)
RUNBOOK: how forge deploys the linked BookLogic on a broadcast
```

`<area>` is the contract, service, package, app or doc touched (`Book`, `ops-venue`, `shared`, `apps`,
`deploy`, `RUNBOOK`, ...). Use the body for the why when it is not obvious.

## Pull request checklist

- [ ] Tests added or updated, and `contracts:test` / `bun test` / `typecheck` pass locally.
- [ ] Contract changes: invariants in [docs/BOUNTY_SCOPE.md](docs/BOUNTY_SCOPE.md) still hold; ABIs regenerated.
- [ ] Docs updated (ARCHITECTURE, RUNBOOK, VERIFY, READMEs) where behaviour or operations changed.
- [ ] `bun run lint:copy` passes for user-facing text.
- [ ] No secrets, keys, mnemonics, `.env*` files or deployment records in the diff.

