// Insurance-fund (IF) account mode, ORDERLY_IF_MODE (docs/VERIFY.md O10). Orderly assigns each market to exactly one
// IF account (in Orderly One); whether a smart-contract (delegate) account may be that account is unconfirmed, so both
// models are supported. Where each book's IF account id comes from:
//
//   contract (default)  adapter.accountId(IF) = keccak256(abi.encode(OrderlyIFAccount, brokerHash)): the per-book
//                       OrderlyIFAccount contract the adapter deploys at initialize (CREATE2, salt = bookId). A delegate
//                       account: ops-venue confirms its delegate signer (POST /v1/delegate_signer), registers the IF ops
//                       key (delegate_orderly_key) and executes IF withdrawals (Orderly pays the contract itself).
//   builder             adapter.accountId(IF) = keccak256(abi.encode(eoa, brokerHash)) once the timelock has called
//                       adapter.setIfAccountOwner(eoa): the Orderly account of an operator EOA. An EOA is ONE private key:
//                       the multisig / timelock controls only the binding, never the EOA or what it does on Orderly. A
//                       FALLBACK (if Orderly refuses a contract IF account), never for mainnet without the owner's
//                       explicit sign-off (ORDERLY_IF_MODE_BUILDER_ACK=1 on CHAIN_ID 4663, also the mainnet preflight).
//                       ORDERLY_IF_BUILDER_ACCOUNTS states the expected account id per book and must match the chain.
//                       ops-venue never holds that EOA's key, so the operator registers the account, ops-venue's IF ops
//                       key (read only: reports) and performs each IF withdrawal (Orderly pays the EOA) and returns the
//                       USDG to the adapter (one transfer of at least the amount, tracked as that Transfer log); ops-venue
//                       recognises the withdrawal, confirms it on-chain and sweeps. Safeguards: any withdrawal from the
//                       account no on-chain request asked for, and any IF equity drop below the adapter's insurance, page
//                       critical; a payout unreturned past OPS_IF_RETURN_WRITE_OFF_MS (24 h) is written off from NAV
//                       on-chain (adapter.writeOffOperatorPayout); an account holding equity before the book's deposit is
//                       never reported (prior_equity). The binding is re-read every OPS_IF_BINDING_RECHECK_MS; a switch
//                       re-provisions the book, removes the old IF key and asks the admin to re-assign the market's IF account.
//
// In both modes the IF capital reaches Orderly on-chain: adapter.depositToVenue(IF) -> Vault.depositTo(owner, accountId)
// at window close, recorded by the adapter's OrderlyDeposit(IF, accountId, amount, fee) event.
// A book whose binding does not match the mode gets no IF provisioning (no delegate / key registration for the IF
// account, no api-mode listing with that IF account) and is published for alerts; every other book is unaffected.
import { type Address, getAddress, type Hex, isAddress } from "viem";

export type IfMode = "contract" | "builder";
/** The adapter's on-chain IF binding: devnet = pre-v3 derivation, contract = OrderlyIFAccount, builder = EOA owner. */
export type IfBinding = "devnet" | "contract" | "builder";

const lc = (a: string) => a.toLowerCase();

/** On-chain binding from adapter.accountOwner(IF) and adapter.ifAccountOwner() (null: pre-v4 implementation or unset). */
export function ifBindingOf(p: { adapter: Address; ifOwner: Address; builderOwner: Address | null }): IfBinding {
  if (p.builderOwner && lc(p.builderOwner) === lc(p.ifOwner)) return "builder";
  return lc(p.ifOwner) === lc(p.adapter) ? "devnet" : "contract";
}

/** Why the book's IF account cannot be provisioned in this mode (null = consistent). */
export function ifAccountIssue(p: { mode: IfMode; binding: IfBinding; bookId: number; accountId: string; ifOwner: Address; expected?: ReadonlyMap<number, string> }): string | null {
  if (p.mode === "contract") {
    if (p.binding === "builder") return `ORDERLY_IF_MODE=contract but the adapter's IF account is builder-held (owner ${p.ifOwner}): set ORDERLY_IF_MODE=builder, or the timelock calls adapter.setIfAccountOwner(0x0) while the IF is empty`;
    return null;
  }
  if (p.binding !== "builder") return `ORDERLY_IF_MODE=builder but the adapter's IF account is ${p.binding === "contract" ? `the OrderlyIFAccount ${p.ifOwner}` : "the pre-v3 devnet derivation"}: the timelock calls adapter.setIfAccountOwner(<operator EOA>) while the IF is empty`;
  const want = p.expected?.get(p.bookId);
  if (!want) return `ORDERLY_IF_MODE=builder: no IF account configured for book ${p.bookId} in ORDERLY_IF_BUILDER_ACCOUNTS (on-chain ${p.accountId}, owner ${p.ifOwner})`;
  if (lc(want) !== lc(p.accountId)) return `ORDERLY_IF_BUILDER_ACCOUNTS says ${want} for book ${p.bookId} but the adapter's IF account is ${p.accountId} (owner ${p.ifOwner})`;
  return null;
}

const ACCOUNT_ID_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * ORDERLY_IF_BUILDER_ACCOUNTS: `<bookId>=<accountId>` pairs, comma separated (the builder IF account of each book,
 * keccak256(abi.encode(operatorEoa, brokerHash)), as Orderly shows it). One account per book: the adapter's insurance
 * figure is that account's equity, so two books on one account would each report the other's capital. Throws on
 * malformed input.
 */
export function parseIfBuilderAccounts(raw: string | undefined): Map<number, Hex> {
  const out = new Map<number, Hex>();
  if (!raw || raw.trim() === "") return out;
  const seen = new Map<string, number>();
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d+)\s*[=:]\s*(\S+)$/.exec(part);
    if (!m) throw new Error(`ORDERLY_IF_BUILDER_ACCOUNTS: "${part}" is not <bookId>=<accountId>`);
    const bookId = Number(m[1]);
    const id = (m[2] as string).toLowerCase();
    if (!ACCOUNT_ID_RE.test(id)) throw new Error(`ORDERLY_IF_BUILDER_ACCOUNTS: book ${bookId}: "${m[2]}" is not a 32-byte Orderly account id`);
    if (out.has(bookId)) throw new Error(`ORDERLY_IF_BUILDER_ACCOUNTS: book ${bookId} listed twice`);
    const other = seen.get(id);
    if (other !== undefined) throw new Error(`ORDERLY_IF_BUILDER_ACCOUNTS: books ${other} and ${bookId} share IF account ${id} (one builder IF account per book)`);
    seen.set(id, bookId);
    out.set(bookId, id as Hex);
  }
  return out;
}

/** Orderly's per-market IF requirement (USD 6dp; the IF must be STRICTLY above requirement x markets, VERIFY O10). */
export const ORDERLY_IF_REQUIREMENT_USD = { testnet: 100_000_000n, mainnet: 25_000_000_000n } as const;

/**
 * ORDERLY_IF_REQUIREMENT_USD (whole USD) if set, else from the Orderly API host: testnet-api.orderly.org -> 100,
 * api.orderly.org -> 25,000; anything else (mock-orderly) -> null (no venue requirement checked).
 */
export function resolveIfRequirementUsd(baseUrl: string, overrideWholeUsd?: number): bigint | null {
  if (overrideWholeUsd !== undefined) return BigInt(Math.round(overrideWholeUsd * 1e6));
  let host = "";
  try {
    host = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (host === "testnet-api.orderly.org" || host === "testnet-api-evm.orderly.org") return ORDERLY_IF_REQUIREMENT_USD.testnet;
  if (host === "api.orderly.org" || host === "api-evm.orderly.org") return ORDERLY_IF_REQUIREMENT_USD.mainnet;
  return null;
}

/** Orderly's rule: balance > requirement x markets on that IF account (one market per book's IF account here). */
export const ifAboveRequirement = (balanceUsd: bigint, requirementUsd: bigint, markets = 1): boolean => balanceUsd > requirementUsd * BigInt(markets);

/** Operator EOA as configured / read, checksummed (null for zero / invalid). */
export function eoaOrNull(a: string | null | undefined): Address | null {
  if (!a || !isAddress(a, { strict: false })) return null;
  const c = getAddress(a);
  return c === "0x0000000000000000000000000000000000000000" ? null : c;
}
