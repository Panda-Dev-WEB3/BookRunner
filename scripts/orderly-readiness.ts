// Orderly readiness check for switching Orderly-venue books from the mock venue (services/mock-orderly +
// MockOrderlyVault) to REAL Orderly (docs/RUNBOOK.md "Switching testnet books to real Orderly"). READ-ONLY:
// eth_call / eth_getCode and public Orderly GETs only; never signs, never sends a transaction.
//
//   bun scripts/orderly-readiness.ts                    # testnet (46630, https://testnet-api.orderly.org)
//   bun scripts/orderly-readiness.ts --mainnet          # Robinhood Chain mainnet (4663, https://api.orderly.org)
//   options: --json  --stage venue|builder|books (comma list; exit code from those stages only)
//            --rpc <url>  --deployment <file>  --broker <id>  --admin <address>  --tickers NVDA,TSLA
//            --builder-key ed25519:<base58 public key>   (checks it is registered for the admin account)
//
// Stages (every row has one):
//   venue   — what Orderly must enable: Vault code, Vault.getAllowedToken(keccak256("USDG")) == USDG,
//             Vault.getAllowedBroker(keccak256(broker)), chain in /v1/public/chain_info with this vault and the
//             broker, USDG for the chain in /v1/public/token (6 decimals, same contract), USDG on-chain decimals.
//   builder — what the builder admin does (Orderly One): broker in /v1/public/broker/name, the admin wallet's
//             account (/v1/get_account), optional builder key, our builder symbols in /v1/public/info
//             (PERP_<T>_USDC_<broker>) and the equity symbols already listed.
//   books   — our contracts (deployment file via packages/shared deployments loader; skipped when absent):
//             config.usdc() / config.orderlyVault() / the factory's OrderlyAdapter implementation hashes, and per
//             Orderly book the adapter's vault, token, hashes, Orderly accounts (v3) and whether it is empty.
// Exit code: 0 = every gating row of the selected stages PASSes (FAIL gates; WARN / INFO / SKIP do not),
// 1 = not ready, 2 = usage / internal error. Cron-able: see the RUNBOOK section.
import { type Address, type Hex, erc20Abi, getAddress, isAddress, keccak256, stringToHex, zeroAddress } from "viem";
import { bookFactoryAbi, bookrunnerConfigAbi, orderlyAdapterAbi } from "../packages/shared/src/abi";
import { publicClientFor } from "../packages/shared/src/clients";
import { deploymentPath, tryLoadDeployment } from "../packages/shared/src/deployments";
import type { Deployment } from "../packages/shared/src/types";
import { baseAssetOf, venueSymbol } from "../packages/shared/src/venueSymbol";

// ============================================================================================ model

export type Status = "PASS" | "FAIL" | "WARN" | "INFO" | "SKIP";
export type Stage = "venue" | "builder" | "books";
export const STAGES: readonly Stage[] = ["venue", "builder", "books"];

export interface Row {
  stage: Stage;
  check: string;
  status: Status;
  detail: string;
}

export interface NetworkProfile {
  name: "testnet" | "mainnet";
  chainId: number;
  apiBase: string;
  rpcUrl: string;
  vault: Address;
  token: { symbol: string; address: Address; decimals: number };
  deploymentFile: string;
  /** Strictly-greater IF requirement per effective symbol (USD, VERIFY O10). */
  ifRequirementUsd: number;
}

/** VERIFY O2 / O3 / S1 (addresses re-read on-chain by this script). */
export const PROFILES: Record<"testnet" | "mainnet", NetworkProfile> = {
  testnet: {
    name: "testnet",
    chainId: 46630,
    apiBase: "https://testnet-api.orderly.org",
    rpcUrl: process.env.RHC_TESTNET_RPC_URL ?? "https://rpc.testnet.chain.robinhood.com",
    vault: "0x2A5b650A894409372DDeE241EDAC92d4152bE24d",
    token: { symbol: "USDG", address: "0x7E955252E15c84f5768B83c41a71F9eba181802F", decimals: 6 },
    deploymentFile: "contracts/deployments/46630.json",
    ifRequirementUsd: 100,
  },
  mainnet: {
    name: "mainnet",
    chainId: 4663,
    apiBase: "https://api.orderly.org",
    rpcUrl: process.env.RHC_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com",
    vault: "0x816f722424B49Cf1275cc86DA9840Fbd5a6167e9",
    token: { symbol: "USDG", address: "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168", decimals: 6 },
    deploymentFile: "contracts/deployments/4663.json",
    ifRequirementUsd: 25_000,
  },
};

export const DEFAULT_BROKER = "bookrunner";
/** Orderly builder admin wallet of broker `bookrunner` (testnet account 0xaa04…2e5c, 2026-10-18). */
export const DEFAULT_ADMIN: Address = "0x9c1B7179554304995dD58bA9ba203b0cbA8fe8b9";
export const DEFAULT_TICKERS = ["NVDA", "TSLA"];

/** Orderly's string hashes (VERIFY O7): keccak256(bytes(s)). */
export const orderlyHash = (s: string): Hex => keccak256(stringToHex(s));

/** Statuses that count against the IF requirement (VERIFY O10); DELISTED is terminal. */
export const EFFECTIVE_SYMBOL_STATUSES = new Set(["NEW", "PENDING", "POST_ONLY", "ACTIVE", "REDUCE_ONLY"]);

/** Builder (Perp Anything) symbols carry the broker id: PERP_<BASE>_USDC_<broker> (seen live 2026-10-18). */
export function builderSymbol(base: string, brokerId: string): string {
  try {
    return venueSymbol({ charterSymbol: base.toUpperCase(), mode: "live", brokerId }); // the services' mapping
  } catch {
    return `PERP_${base.toUpperCase()}_USDC_${brokerId}`; // not a valid base / broker id: shown as is (row stays FAIL)
  }
}

/** PERP_<BASE>_<QUOTE>[_<broker>] -> parts; null when not a perp symbol. */
export function parseSymbol(symbol: string): { base: string; quote: string; broker: string | null } | null {
  const m = /^PERP_([^_]+)_([^_]+)(?:_(.+))?$/.exec(symbol);
  return m ? { base: m[1]!, quote: m[2]!, broker: m[3] ?? null } : null;
}

/** Base asset of a charter symbol (PERP_NVDA_USDC or PERP_NVDA_USDC_<broker>). */
export function charterBase(symbol: string): string | null {
  return baseAssetOf(symbol);
}

/** US equities / ETFs (heuristic list, used only to list existing equity markets). */
export const EQUITY_TICKERS = new Set([
  "NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "NFLX", "AMD", "AVGO", "INTC", "ORCL", "PLTR",
  "TSM", "MU", "COIN", "HOOD", "MSTR", "CRCL", "BABA", "DELL", "MRVL", "WDC", "SNDK", "AAOI", "ALLO", "CBRS", "GLW",
  "LITE", "NBIS", "QQQ", "SPY", "TQQQ", "SQQQ", "SOXL", "SOXS", "EWY", "SAMSUNG", "SKHYNIX", "SKHY", "IBM", "UBER",
]);

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 8)}…${a.slice(-4)}` : a);
const sameAddr = (a: string | null | undefined, b: string | null | undefined) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

// ============================================================================================ pure row logic

export interface VaultFacts {
  code: Hex | null | undefined;
  allowedToken: Address | null; // null = read failed
  allowedBroker: boolean | null;
  /** getAllowedToken(keccak256("USDC")), informational */
  allowedUsdc?: Address | null;
  tokenDecimals: number | null; // on-chain decimals() of the expected settlement token; null = read failed
  tokenCode: Hex | null | undefined;
  error?: string;
}

export function vaultRows(p: NetworkProfile, brokerId: string, f: VaultFacts): Row[] {
  const rows: Row[] = [];
  const v = `Vault ${short(p.vault)}`;
  const hasCode = !!f.code && f.code !== "0x";
  rows.push({ stage: "venue", check: "vault code", status: hasCode ? "PASS" : "FAIL", detail: hasCode ? `${v}: code present` : `${v}: no code on chain ${p.chainId}${f.error ? ` (${f.error})` : ""}` });
  const th = orderlyHash(p.token.symbol);
  if (f.allowedToken === null) {
    rows.push({ stage: "venue", check: `allowed token ${p.token.symbol}`, status: "FAIL", detail: `getAllowedToken(${short(th)}) read failed` });
  } else {
    const ok = sameAddr(f.allowedToken, p.token.address);
    rows.push({
      stage: "venue",
      check: `allowed token ${p.token.symbol}`,
      status: ok ? "PASS" : "FAIL",
      detail: ok
        ? `getAllowedToken(keccak256("${p.token.symbol}")) = ${p.token.address}`
        : f.allowedToken === zeroAddress
          ? `getAllowedToken(keccak256("${p.token.symbol}")) = 0x0: the vault allows no ${p.token.symbol} (expected ${p.token.address})`
          : `getAllowedToken(keccak256("${p.token.symbol}")) = ${f.allowedToken}, expected ${p.token.address}`,
    });
  }
  if (f.allowedUsdc !== undefined) {
    rows.push({ stage: "venue", check: "allowed token USDC", status: "INFO", detail: f.allowedUsdc === null ? "read failed" : `getAllowedToken(keccak256("USDC")) = ${f.allowedUsdc === zeroAddress ? "0x0" : f.allowedUsdc} (informational: the adapters use ${p.token.symbol})` });
  }
  rows.push({
    stage: "venue",
    check: `allowed broker ${brokerId}`,
    status: f.allowedBroker === true ? "PASS" : "FAIL",
    detail: f.allowedBroker === null ? `getAllowedBroker(keccak256("${brokerId}")) read failed` : `getAllowedBroker(keccak256("${brokerId}")) = ${f.allowedBroker}`,
  });
  const tokOk = !!f.tokenCode && f.tokenCode !== "0x" && f.tokenDecimals === p.token.decimals;
  rows.push({
    stage: "venue",
    check: `${p.token.symbol} on-chain`,
    status: tokOk ? "PASS" : "FAIL",
    detail: !f.tokenCode || f.tokenCode === "0x" ? `${p.token.address}: no code` : `${p.token.address}: decimals() = ${f.tokenDecimals ?? "read failed"} (expected ${p.token.decimals})`,
  });
  return rows;
}

export interface ChainInfoRow {
  chain_id: string | number;
  name?: string;
  vault_address?: string;
  broker_ids?: string[];
}

export function chainInfoRows(p: NetworkProfile, brokerId: string, rows: ChainInfoRow[] | Error): Row[] {
  if (rows instanceof Error) return [{ stage: "venue", check: "chain_info", status: "FAIL", detail: `GET /v1/public/chain_info failed: ${rows.message}` }];
  const r = rows.find((x) => String(x.chain_id) === String(p.chainId));
  if (!r) {
    const listed = rows.map((x) => String(x.chain_id)).join(", ");
    return [
      { stage: "venue", check: "chain_info", status: "FAIL", detail: `chain ${p.chainId} absent from /v1/public/chain_info (listed: ${listed || "none"})` },
      { stage: "venue", check: "chain broker", status: "FAIL", detail: `chain ${p.chainId} absent: no broker list` },
    ];
  }
  const vaultOk = sameAddr(r.vault_address, p.vault);
  const brokers = r.broker_ids ?? [];
  return [
    { stage: "venue", check: "chain_info", status: vaultOk ? "PASS" : "FAIL", detail: `chain ${p.chainId} (${r.name ?? "?"}) listed, vault ${r.vault_address ?? "?"}${vaultOk ? "" : ` != expected ${p.vault}`}` },
    { stage: "venue", check: "chain broker", status: brokers.includes(brokerId) ? "PASS" : "FAIL", detail: `${brokerId} ${brokers.includes(brokerId) ? "in" : "not in"} the chain's broker_ids (${brokers.length} brokers)` },
  ];
}

export interface TokenInfoRow {
  token: string;
  token_hash?: string;
  decimals?: number;
  chain_details?: Array<{ chain_id: string | number; contract_address?: string; decimals?: number; withdrawal_fee?: number }>;
}

export function tokenRows(p: NetworkProfile, rows: TokenInfoRow[] | Error): Row[] {
  const check = `token ${p.token.symbol}`;
  if (rows instanceof Error) return [{ stage: "venue", check, status: "FAIL", detail: `GET /v1/public/token failed: ${rows.message}` }];
  const t = rows.find((x) => x.token === p.token.symbol);
  if (!t) return [{ stage: "venue", check, status: "FAIL", detail: `${p.token.symbol} not in /v1/public/token (listed: ${rows.map((x) => x.token).join(", ")})` }];
  const hashOk = sameAddr(t.token_hash, orderlyHash(p.token.symbol));
  const c = (t.chain_details ?? []).find((x) => String(x.chain_id) === String(p.chainId));
  if (!c) return [{ stage: "venue", check, status: "FAIL", detail: `${p.token.symbol} listed, but not for chain ${p.chainId} (chains: ${(t.chain_details ?? []).map((x) => x.chain_id).join(", ") || "none"})` }];
  const ok = hashOk && sameAddr(c.contract_address, p.token.address) && c.decimals === p.token.decimals;
  return [
    {
      stage: "venue",
      check,
      status: ok ? "PASS" : "FAIL",
      detail: `chain ${p.chainId}: contract ${c.contract_address ?? "?"}, decimals ${c.decimals ?? "?"}, withdrawal fee ${c.withdrawal_fee ?? "?"}${hashOk ? "" : `, token_hash ${t.token_hash} != keccak256("${p.token.symbol}")`}${sameAddr(c.contract_address, p.token.address) ? "" : ` (expected ${p.token.address})`}`,
    },
  ];
}

export function brokerRows(brokerId: string, rows: Array<{ broker_id: string; broker_name?: string }> | Error): Row[] {
  if (rows instanceof Error) return [{ stage: "builder", check: "broker name", status: "FAIL", detail: `GET /v1/public/broker/name failed: ${rows.message}` }];
  const b = rows.find((x) => x.broker_id === brokerId);
  return [{ stage: "builder", check: "broker name", status: b ? "PASS" : "FAIL", detail: b ? `${brokerId} = "${b.broker_name ?? ""}"` : `${brokerId} not in /v1/public/broker/name (${rows.length} brokers)` }];
}

/** /v1/get_account envelope: {success, data:{account_id, user_id}} or {success:false, code, message}. */
export function accountRows(brokerId: string, admin: Address, env: { success?: boolean; data?: { account_id?: string; user_id?: number }; code?: number; message?: string } | Error): Row[] {
  const check = "admin account";
  if (env instanceof Error) return [{ stage: "builder", check, status: "FAIL", detail: `GET /v1/get_account failed: ${env.message}` }];
  const id = env.data?.account_id;
  if (env.success && id) return [{ stage: "builder", check, status: "PASS", detail: `${short(admin)} @ ${brokerId}: account ${id} (user ${env.data?.user_id ?? "?"})` }];
  return [{ stage: "builder", check, status: "FAIL", detail: `${short(admin)} @ ${brokerId}: ${env.code ?? "?"} ${env.message ?? "no account"}` }];
}

export function builderKeyRows(key: string | undefined, env: { success?: boolean; data?: { orderly_key?: string; scope?: string; expiration?: number }; message?: string } | Error | null, now = Date.now()): Row[] {
  const check = "builder key";
  if (!key) return [{ stage: "builder", check, status: "SKIP", detail: "no --builder-key given (ops-venue ORDERLY_BUILDER_KEY_SECRET's public key, registered by the admin wallet)" }];
  if (env === null || env instanceof Error) return [{ stage: "builder", check, status: "FAIL", detail: `GET /v1/get_orderly_key failed${env ? `: ${env.message}` : ""}` }];
  const d = env.data;
  if (!env.success || !d?.orderly_key) return [{ stage: "builder", check, status: "FAIL", detail: `${short(key)} not registered for the admin account (${env.message ?? "no key"})` }];
  const exp = Number(d.expiration ?? 0);
  const expired = exp > 0 && exp < now;
  return [{ stage: "builder", check, status: expired ? "FAIL" : "PASS", detail: `${short(key)} scope ${d.scope ?? "?"}, expires ${exp ? new Date(exp).toISOString() : "?"}${expired ? " (expired)" : ""}` }];
}

export interface SymbolInfoRow {
  symbol: string;
  status?: string;
  broker_id?: string;
}

/** Our builder symbols (one per target base) + the equity markets already listed on this Orderly network. */
export function symbolRows(brokerId: string, bases: string[], rows: SymbolInfoRow[] | Error): Row[] {
  if (rows instanceof Error) return [{ stage: "builder", check: "symbols", status: "FAIL", detail: `GET /v1/public/info failed: ${rows.message}` }];
  const out: Row[] = [];
  for (const base of bases) {
    const sym = builderSymbol(base, brokerId);
    const r = rows.find((x) => x.symbol === sym);
    const status = r?.status ?? null;
    out.push({
      stage: "builder",
      check: `symbol ${sym}`,
      status: !r ? "FAIL" : status === "ACTIVE" ? "PASS" : status && EFFECTIVE_SYMBOL_STATUSES.has(status) ? "WARN" : "FAIL",
      detail: !r ? "not listed (list it in Orderly One: Perp Anything)" : `listed, status ${status ?? "?"}${status === "ACTIVE" ? "" : status === "DELISTED" ? " (terminal)" : " (not ACTIVE yet: IF funding / review)"}`,
    });
  }
  const equities = rows
    .filter((x) => {
      const s = parseSymbol(x.symbol);
      return s !== null && EQUITY_TICKERS.has(s.base);
    })
    .map((x) => `${x.symbol}${x.status && x.status !== "ACTIVE" ? `:${x.status}` : ""}`);
  out.push({ stage: "builder", check: "equity symbols", status: "INFO", detail: equities.length ? `${equities.length} listed: ${equities.join(" ")}` : "none listed" });
  return out;
}

export interface AdapterFacts {
  orderlyVault: Address;
  usdc: Address;
  tokenHash: Hex;
  brokerHash: Hex;
  /** null = pre-v3 implementation (no ifAccount() view) */
  ifAccount: Address | null;
  delegateSigner: Address;
  insuranceUsd: bigint;
  marginUsd: bigint;
  inTransitUsd: bigint;
  pendingIfUsd: bigint;
  pendingMmUsd: bigint;
}

export interface DeploymentFacts {
  configUsdc: Address | null;
  configVault: Address | null;
  implTokenHash: Hex | null;
  implBrokerHash: Hex | null;
  error?: string;
}

export function deploymentRows(p: NetworkProfile, brokerId: string, file: string, f: DeploymentFacts | null): Row[] {
  if (!f) return [{ stage: "books", check: "deployment", status: "SKIP", detail: `${file} not found: book checks skipped (pass --deployment <file>)` }];
  if (f.error) return [{ stage: "books", check: "deployment", status: "FAIL", detail: `${file}: ${f.error}` }];
  const th = orderlyHash(p.token.symbol);
  const bh = orderlyHash(brokerId);
  return [
    {
      stage: "books",
      check: "config.usdc()",
      status: sameAddr(f.configUsdc, p.token.address) ? "PASS" : "FAIL",
      detail: sameAddr(f.configUsdc, p.token.address)
        ? `${p.token.symbol} ${p.token.address}`
        : `${f.configUsdc ?? "read failed"}: the protocol settles in a token the real vault does not take (expected ${p.token.symbol} ${p.token.address}); every book component caches it at deploy`,
    },
    {
      stage: "books",
      check: "config.orderlyVault()",
      status: sameAddr(f.configVault, p.vault) ? "PASS" : "FAIL",
      detail: sameAddr(f.configVault, p.vault) ? `Orderly Vault ${p.vault}` : `${f.configVault ?? "read failed"} (mock venue; expected Orderly Vault ${p.vault})`,
    },
    {
      stage: "books",
      check: "adapter implementation",
      status: sameAddr(f.implTokenHash, th) && sameAddr(f.implBrokerHash, bh) ? "PASS" : "FAIL",
      detail: `factory ORDERLY_ADAPTER defaults: token ${f.implTokenHash ? short(f.implTokenHash) : "?"}${sameAddr(f.implTokenHash, th) ? ` = keccak256("${p.token.symbol}")` : ` != keccak256("${p.token.symbol}")`}, broker ${f.implBrokerHash ? short(f.implBrokerHash) : "?"}${sameAddr(f.implBrokerHash, bh) ? ` = keccak256("${brokerId}")` : ` != keccak256("${brokerId}")`}`,
    },
  ];
}

const usd = (v: bigint) => `${(Number(v) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

/** Empty = nothing venue-side or in flight (UpgradeOrderlyAdapters `_migrate` / migrateToOrderlyAccounts rule). */
export function adapterEmpty(a: AdapterFacts): boolean {
  return a.insuranceUsd === 0n && a.marginUsd === 0n && a.inTransitUsd === 0n && a.pendingIfUsd === 0n && a.pendingMmUsd === 0n;
}

export function bookRows(p: NetworkProfile, brokerId: string, book: { bookId: number; name: string; symbol: string; adapter: Address }, a: AdapterFacts | Error): Row[] {
  const tag = `book ${book.bookId} ${book.name}`;
  if (a instanceof Error) return [{ stage: "books", check: tag, status: "FAIL", detail: `adapter ${book.adapter}: read failed (${a.message})` }];
  const real = sameAddr(a.orderlyVault, p.vault);
  const empty = adapterEmpty(a);
  const tokOk = sameAddr(a.usdc, p.token.address) && sameAddr(a.tokenHash, orderlyHash(p.token.symbol));
  const brokerOk = sameAddr(a.brokerHash, orderlyHash(brokerId));
  const v3 = a.ifAccount !== null && a.ifAccount !== zeroAddress;
  const sym = charterBase(book.symbol);
  return [
    {
      stage: "books",
      check: `${tag} venue`,
      status: real ? "PASS" : "FAIL",
      detail: real ? `adapter ${short(book.adapter)} on the Orderly Vault` : `adapter ${short(book.adapter)} on the MOCK vault ${a.orderlyVault} (stored at initialize; no upgrade path rebinds it)`,
    },
    {
      stage: "books",
      check: `${tag} token`,
      status: tokOk && brokerOk ? "PASS" : "FAIL",
      detail: `usdc ${short(a.usdc)}${sameAddr(a.usdc, p.token.address) ? ` (${p.token.symbol})` : ` (not ${p.token.symbol})`}, tokenHash ${sameAddr(a.tokenHash, orderlyHash(p.token.symbol)) ? `keccak256("${p.token.symbol}")` : short(a.tokenHash)}, brokerHash ${brokerOk ? `keccak256("${brokerId}")` : short(a.brokerHash)}`,
    },
    {
      stage: "books",
      check: `${tag} accounts`,
      status: v3 ? "PASS" : "FAIL",
      detail: v3
        ? `Orderly accounts (v3): IF account contract ${short(a.ifAccount ?? "")}, delegate signer ${a.delegateSigner === zeroAddress ? "unset" : short(a.delegateSigner)}`
        : a.ifAccount === null
          ? "pre-v3 implementation (no ifAccount()): UpgradeOrderlyAdapters, then migrateToOrderlyAccounts (only while empty)"
          : "devnet account ids (ifAccount() = 0): needs migrateToOrderlyAccounts (only while empty)",
    },
    {
      stage: "books",
      check: `${tag} empty`,
      status: empty ? "PASS" : "FAIL",
      detail: empty
        ? `nothing venue-side or in flight (migration precondition)${sym ? `; Orderly symbol ${builderSymbol(sym, brokerId)}` : ""}`
        : `IF ${usd(a.insuranceUsd)}, MM ${usd(a.marginUsd)}, in transit ${usd(a.inTransitUsd)}, pending IF ${usd(a.pendingIfUsd)} / MM ${usd(a.pendingMmUsd)}: recall to the vault first (retire / wind down)`,
    },
  ];
}

/** 0 = every FAIL-able row of the selected stages passed. */
export function exitCode(rows: Row[], stages: readonly Stage[] = STAGES): 0 | 1 {
  return rows.some((r) => stages.includes(r.stage) && r.status === "FAIL") ? 1 : 0;
}

export function formatTable(rows: Row[]): string {
  const w1 = Math.max(...rows.map((r) => r.check.length), 5);
  return rows.map((r) => `${r.status.padEnd(4)}  ${r.stage.padEnd(7)}  ${r.check.padEnd(w1)}  ${r.detail}`).join("\n");
}

export function parseStages(v: string | undefined): Stage[] {
  if (!v) return [...STAGES];
  const out = v.split(",").map((s) => s.trim());
  for (const s of out) if (!(STAGES as readonly string[]).includes(s)) throw new Error(`--stage: unknown stage "${s}" (${STAGES.join(" | ")})`);
  return out as Stage[];
}

// ============================================================================================ I/O

const vaultAbi = [
  { type: "function", name: "getAllowedToken", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [{ name: "", type: "address" }] },
  { type: "function", name: "getAllowedBroker", stateMutability: "view", inputs: [{ name: "", type: "bytes32" }], outputs: [{ name: "", type: "bool" }] },
] as const;

const errText = (e: unknown) => {
  const o = e as { shortMessage?: string; message?: string };
  return (o?.shortMessage ?? o?.message ?? String(e)).split("\n")[0]!.slice(0, 160);
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 120)}`);
  }
}

async function rowsOf<T>(url: string): Promise<T[] | Error> {
  try {
    const j = await getJson<{ success?: boolean; data?: { rows?: T[] }; message?: string }>(url);
    if (!j.success) return new Error(j.message ?? "success=false");
    return j.data?.rows ?? [];
  } catch (e) {
    return new Error(errText(e));
  }
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

export async function collect(argv: string[]): Promise<{ profile: NetworkProfile; rows: Row[]; stages: Stage[] }> {
  const profile: NetworkProfile = { ...PROFILES[argv.includes("--mainnet") ? "mainnet" : "testnet"] };
  const rpc = arg(argv, "rpc");
  if (rpc) profile.rpcUrl = rpc;
  const brokerId = arg(argv, "broker") ?? DEFAULT_BROKER;
  const adminArg = arg(argv, "admin") ?? DEFAULT_ADMIN;
  if (!isAddress(adminArg)) throw new Error(`--admin: not an address: ${adminArg}`);
  const admin = getAddress(adminArg);
  const stages = parseStages(arg(argv, "stage"));
  const builderKey = arg(argv, "builder-key");
  const pc = publicClientFor(profile.chainId, profile.rpcUrl);
  const api = profile.apiBase;
  const rows: Row[] = [];

  // ---- venue: on-chain vault + token
  const read = async <T>(f: () => Promise<T>): Promise<T | null> => {
    try {
      return await f();
    } catch {
      return null;
    }
  };
  let vaultErr: string | undefined;
  const code = await pc.getCode({ address: profile.vault }).catch((e) => {
    vaultErr = errText(e);
    return null;
  });
  const [allowedToken, allowedBroker, allowedUsdc, tokenCode, tokenDecimals] = await Promise.all([
    read(() => pc.readContract({ address: profile.vault, abi: vaultAbi, functionName: "getAllowedToken", args: [orderlyHash(profile.token.symbol)] })),
    read(() => pc.readContract({ address: profile.vault, abi: vaultAbi, functionName: "getAllowedBroker", args: [orderlyHash(brokerId)] })),
    read(() => pc.readContract({ address: profile.vault, abi: vaultAbi, functionName: "getAllowedToken", args: [orderlyHash("USDC")] })),
    read(() => pc.getCode({ address: profile.token.address })),
    read(() => pc.readContract({ address: profile.token.address, abi: erc20Abi, functionName: "decimals" })),
  ]);
  rows.push(...vaultRows(profile, brokerId, { code, allowedToken, allowedBroker, allowedUsdc, tokenCode, tokenDecimals: tokenDecimals === null ? null : Number(tokenDecimals), ...(vaultErr ? { error: vaultErr } : {}) }));

  // ---- venue + builder: public Orderly API
  const [chainInfo, tokens, brokers, info] = await Promise.all([
    rowsOf<ChainInfoRow>(`${api}/v1/public/chain_info`),
    rowsOf<TokenInfoRow>(`${api}/v1/public/token`),
    rowsOf<{ broker_id: string; broker_name?: string }>(`${api}/v1/public/broker/name`),
    rowsOf<SymbolInfoRow>(`${api}/v1/public/info`),
  ]);
  rows.push(...chainInfoRows(profile, brokerId, chainInfo), ...tokenRows(profile, tokens), ...brokerRows(brokerId, brokers));
  const acct = await getJson<Parameters<typeof accountRows>[2]>(`${api}/v1/get_account?address=${admin}&broker_id=${encodeURIComponent(brokerId)}&chain_type=EVM`).catch((e) => new Error(errText(e)));
  rows.push(...accountRows(brokerId, admin, acct));
  let keyEnv: Parameters<typeof builderKeyRows>[1] = null;
  const accountId = !(acct instanceof Error) ? acct.data?.account_id : undefined;
  if (builderKey && accountId) {
    keyEnv = await getJson<Exclude<Parameters<typeof builderKeyRows>[1], null | Error>>(`${api}/v1/get_orderly_key?account_id=${accountId}&orderly_key=${encodeURIComponent(builderKey)}`).catch((e) => new Error(errText(e)));
  }
  rows.push(...builderKeyRows(builderKey, keyEnv));

  // ---- books: our deployment
  const file = arg(argv, "deployment") ?? profile.deploymentFile;
  const dep: Deployment | null = tryLoadDeployment(file);
  const orderlyBooks = (dep?.books ?? []).filter((b) => b.venue === 0);
  const tickersArg = arg(argv, "tickers");
  const bases = tickersArg
    ? tickersArg.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean)
    : orderlyBooks.length
      ? [...new Set(orderlyBooks.map((b) => charterBase(b.symbol) ?? b.name))]
      : DEFAULT_TICKERS;
  rows.push(...symbolRows(brokerId, bases, info));

  const shownFile = deploymentPath(file);
  if (!dep) {
    rows.push(...deploymentRows(profile, brokerId, shownFile, null));
  } else if (dep.chainId !== profile.chainId) {
    rows.push(...deploymentRows(profile, brokerId, shownFile, { configUsdc: null, configVault: null, implTokenHash: null, implBrokerHash: null, error: `chainId ${dep.chainId} != ${profile.chainId}` }));
  } else {
    const c = dep.contracts;
    const [configUsdc, configVault, impl] = await Promise.all([
      read(() => pc.readContract({ address: c.config, abi: bookrunnerConfigAbi, functionName: "usdc" }) as Promise<Address>),
      read(() => pc.readContract({ address: c.config, abi: bookrunnerConfigAbi, functionName: "orderlyVault" }) as Promise<Address>),
      read(async () => {
        const kind = (await pc.readContract({ address: c.factory, abi: bookFactoryAbi, functionName: "ORDERLY_ADAPTER" })) as Hex;
        return (await pc.readContract({ address: c.factory, abi: bookFactoryAbi, functionName: "implementation", args: [kind] })) as Address;
      }),
    ]);
    const [implTokenHash, implBrokerHash] = impl
      ? await Promise.all([
          read(() => pc.readContract({ address: impl, abi: orderlyAdapterAbi, functionName: "DEFAULT_TOKEN_HASH" }) as Promise<Hex>),
          read(() => pc.readContract({ address: impl, abi: orderlyAdapterAbi, functionName: "DEFAULT_BROKER_HASH" }) as Promise<Hex>),
        ])
      : [null, null];
    rows.push(...deploymentRows(profile, brokerId, shownFile, { configUsdc, configVault, implTokenHash, implBrokerHash }));
    if (orderlyBooks.length === 0) rows.push({ stage: "books", check: "orderly books", status: "INFO", detail: "no Orderly-venue book in the deployment file" });
    for (const b of orderlyBooks) {
      const adapter = b.components.adapter;
      const r = <T>(functionName: string, args: readonly unknown[] = []) => pc.readContract({ address: adapter, abi: orderlyAdapterAbi, functionName, args } as never) as Promise<T>;
      const facts = await Promise.all([
        r<Address>("orderlyVault"),
        r<Address>("usdc"),
        r<Hex>("tokenHash"),
        r<Hex>("brokerHash"),
        r<Address>("ifAccount").catch(() => null), // pre-v3 implementation: no ifAccount()
        r<Address>("delegateSigner"),
        r<bigint>("insuranceEquityUsd"),
        r<bigint>("marginEquityUsd"),
        r<bigint>("inTransitUsd"),
        r<bigint>("pendingWithdrawUsd", [0]),
        r<bigint>("pendingWithdrawUsd", [1]),
      ])
        .then(
          ([orderlyVault, usdc, tokenHash, brokerHash, ifAccount, delegateSigner, insuranceUsd, marginUsd, inTransitUsd, pendingIfUsd, pendingMmUsd]): AdapterFacts => ({
            orderlyVault,
            usdc,
            tokenHash,
            brokerHash,
            ifAccount,
            delegateSigner,
            insuranceUsd,
            marginUsd,
            inTransitUsd,
            pendingIfUsd,
            pendingMmUsd,
          }),
        )
        .catch((e) => new Error(errText(e)));
      rows.push(...bookRows(profile, brokerId, { bookId: b.bookId, name: b.name, symbol: b.symbol, adapter }, facts));
    }
  }
  return { profile, rows, stages };
}

async function main() {
  const argv = process.argv.slice(2);
  const { profile, rows, stages } = await collect(argv);
  const code = exitCode(rows, stages);
  if (argv.includes("--json")) {
    console.log(JSON.stringify({ network: profile.name, chainId: profile.chainId, api: profile.apiBase, checkedAt: new Date().toISOString(), stages, ready: code === 0, rows }, null, 2));
  } else {
    console.log(`[orderly-readiness] ${profile.name} (chain ${profile.chainId}, ${profile.apiBase}), stages ${stages.join(",")}`);
    console.log(formatTable(rows));
    const fails = rows.filter((r) => stages.includes(r.stage) && r.status === "FAIL").length;
    console.log(code === 0 ? "[orderly-readiness] READY: every precondition passes" : `[orderly-readiness] NOT READY: ${fails} FAIL row(s)`);
  }
  process.exit(code);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error(`[orderly-readiness] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  });
}
