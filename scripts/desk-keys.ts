// Desk session keys for EVERY book (devnet / testnet / testnet-live; Task 7b: an agent quotes new risk only with an
// active desk key on its mandate, so every quote risk judges is signed by one). For each book of the factory:
//   - the key its agent signs with (packages/shared/src/devkeys.ts derivedDeskAccount: the launch role for the three
//     launch books, else the book's own derived key at mnemonic index 1000 + bookId);
//   - active on the mandate (MMMandate.isActiveKey) and its expiry (getKey().validUntil);
//   - when it is not active (none, expired, revoked) and the book's sponsor is the stack's sponsor key: the operator
//     consents and the sponsor registers it (validUntil + DESK_KEY_VALID_DAYS, tier = the mandate's maxInventoryUsd).
//     A book of another sponsor is reported with the call that sponsor must make.
//   bun scripts/desk-keys.ts             # dry run: the plan
//   bun scripts/desk-keys.ts --send      # register / re-register the missing ones
//   CHAIN_ID=46630 RPC_URL=... DEPLOYMENT_FILE=contracts/deployments/46630.json bun --env-file=.env.testnet scripts/desk-keys.ts --send
// Mainnet: keys are per book (DESK_KEY_PRIVATE_KEY_<bookId>) and the sponsor registers them (RUNBOOK "Desk session
// keys"); this script refuses chain 4663.
import { type Abi, type Address, createPublicClient, createWalletClient, http } from "viem";
import type { LocalAccount } from "viem/accounts";
import { bookAbi, bookFactoryAbi, mMMandateAbi } from "../packages/shared/src/abi";
import { chainFor } from "../packages/shared/src/chains";
import { loadDeployment } from "../packages/shared/src/deployments";
import { MAINNET_CHAIN_ID, derivedDeskAccount, roleAccount } from "../packages/shared/src/devkeys";

export const DESK_KEY_VALID_DAYS = 365;
/** A key expiring within this many days is reported (re-register it before it lapses). */
export const DESK_KEY_RENEW_DAYS = 30;

export interface DeskKeyRow {
  bookId: number;
  /** BookState index (0 Subscription, 1 Cancelled, 2 Live, 3 Retiring, 4 Retired) */
  state: number;
  key: Address | null;
  active: boolean;
  /** unix s (0: never registered) */
  validUntil: number;
  sponsorIsOurs: boolean;
}

export type DeskKeyAction =
  | { bookId: number; action: "ok" }
  | { bookId: number; action: "renew_soon"; validUntil: number }
  | { bookId: number; action: "register"; key: Address }
  | { bookId: number; action: "ask_sponsor"; key: Address }
  | { bookId: number; action: "no_key" }
  | { bookId: number; action: "skip"; why: string };

/** Pure: what to do per book at chain time `nowSec`. Ended books (Cancelled, Retired) need no key. */
export function planDeskKeys(rows: readonly DeskKeyRow[], nowSec: number): DeskKeyAction[] {
  return rows.map((r): DeskKeyAction => {
    if (r.state === 1 || r.state === 4) return { bookId: r.bookId, action: "skip", why: r.state === 1 ? "Cancelled" : "Retired" };
    if (!r.key) return { bookId: r.bookId, action: "no_key" };
    if (r.active) return r.validUntil - nowSec < DESK_KEY_RENEW_DAYS * 86_400 ? { bookId: r.bookId, action: "renew_soon", validUntil: r.validUntil } : { bookId: r.bookId, action: "ok" };
    return r.sponsorIsOurs ? { bookId: r.bookId, action: "register", key: r.key } : { bookId: r.bookId, action: "ask_sponsor", key: r.key };
  });
}

/** Plans (and with `send` registers) the desk keys of every book of the deployment's factory. */
export async function ensureDeskKeys(o: { send: boolean; log?: (msg: string) => void }): Promise<DeskKeyAction[]> {
  const out = o.log ?? ((m: string) => console.log(`[desk-keys] ${m}`));
  const send = o.send;
  const chainId = Number(process.env.CHAIN_ID ?? 31337);
  if (chainId === MAINNET_CHAIN_ID) throw new Error("mainnet: desk keys are registered by each book's sponsor (RUNBOOK \"Desk session keys\")");
  const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8547";
  const chain = chainFor(chainId, RPC);
  const pub = createPublicClient({ chain, transport: http(RPC) });
  const dep = loadDeployment();
  const read = <T>(address: Address, abi: Abi, functionName: string, args: readonly unknown[] = []) => pub.readContract({ address, abi, functionName, args } as never) as Promise<T>;
  const sponsor = roleAccount("sponsor");
  const operator = roleAccount("agentOperator");
  const launchIds = dep.books.map((b) => b.bookId);

  const ids = (await read<bigint[]>(dep.contracts.factory, bookFactoryAbi as Abi, "bookIds")).map(Number);
  const rows: DeskKeyRow[] = [];
  const mandates = new Map<number, Address>();
  for (const id of ids) {
    const comps = await read<{ mandate: Address; book: Address }>(dep.contracts.factory, bookFactoryAbi as Abi, "componentsOf", [BigInt(id)]);
    mandates.set(id, comps.mandate);
    const state = Number(await read<number>(comps.book, bookAbi as Abi, "state"));
    let key: LocalAccount | null = null;
    try {
      key = derivedDeskAccount(launchIds, id);
    } catch {
      key = null;
    }
    const k = key ? await read<{ validUntil: bigint }>(comps.mandate, mMMandateAbi as Abi, "getKey", [key.address]) : { validUntil: 0n };
    const active = key ? await read<boolean>(comps.mandate, mMMandateAbi as Abi, "isActiveKey", [key.address]) : false;
    const bookSponsor = await read<Address>(comps.mandate, mMMandateAbi as Abi, "sponsor");
    rows.push({ bookId: id, state, key: key?.address ?? null, active, validUntil: Number(k.validUntil), sponsorIsOurs: bookSponsor.toLowerCase() === sponsor.address.toLowerCase() });
  }
  const nowSec = Number((await pub.getBlock({ blockTag: "latest" })).timestamp);
  const plan = planDeskKeys(rows, nowSec);
  for (const p of plan) out(`book ${p.bookId}: ${JSON.stringify(p)}`);
  if (!send) {
    if (plan.some((p) => p.action === "register")) out("dry run: add --send to register them");
    return plan;
  }
  const wallet = (who: LocalAccount) => createWalletClient({ chain, transport: http(RPC), account: who });
  const call = async (who: LocalAccount, address: Address, functionName: string, args: readonly unknown[]) => {
    const { request } = await pub.simulateContract({ address, abi: mMMandateAbi as Abi, functionName, args, account: who } as never);
    const hash = await wallet(who).writeContract(request as never);
    const r = await pub.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`${functionName} reverted (${hash})`);
  };
  for (const p of plan) {
    if (p.action !== "register") continue;
    const mandate = mandates.get(p.bookId) as Address;
    const terms = await read<{ maxInventoryUsd: bigint }>(mandate, mMMandateAbi as Abi, "getMandate");
    const validUntil = BigInt(nowSec + DESK_KEY_VALID_DAYS * 86_400);
    await call(operator, mandate, "consentKey", [p.key, true]);
    await call(sponsor, mandate, "registerKey", [p.key, operator.address, validUntil, terms.maxInventoryUsd]);
    out(`book ${p.bookId}: desk key ${p.key} registered until ${new Date(Number(validUntil) * 1000).toISOString()}`);
  }
  return plan;
}

if (import.meta.main) {
  ensureDeskKeys({ send: process.argv.includes("--send") }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
