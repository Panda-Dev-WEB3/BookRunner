import { KEYS } from "@bookrunner/shared/queues";
import { bytes32ToStr } from "@bookrunner/shared/bytes32";
import { type Address, getAddress, toBytes, zeroHash } from "viem";
import { z } from "zod";
import { usdInput } from "../domain/charter";
import { consentKeyTx, registerKeyTx, revokeKeyTx } from "../domain/txs";
import { bkrnStr, dbUsdStr, iso, parseUsd, unixSec, usdStr } from "../format";
import { fail, publicProcedure, requireChain, router, softChain } from "../trpc";
import { bookIdInput, componentsView, loadBook, loadCharterOf, timeInput, walletInput } from "./common";

const AGENT_ALIVE_MS = 30_000;

export interface AgentKeyView {
  key: Address;
  operator: Address | null;
  validUntil: string | null;
  inventoryTierUsd: string | null;
  status: string;
  activeOnChain: boolean | null;
  registeredTx: string | null;
  revokedTx: string | null;
  revokedReason: string | null;
  updatedAt: string;
}

export const agentRouter = router({
  /**
   * Prepared MMMandate.registerKey for the sponsor; checks tier >= maxInventory and the operator bond.
   * A third-party operator (operator != sponsor) must first consentKey(key, true) from its own wallet
   * (registerKey reverts OperatorConsentMissing otherwise): that tx is returned first, signer = operator.
   */
  register: publicProcedure
    .input(
      z.object({
        bookId: bookIdInput,
        key: walletInput,
        operator: walletInput,
        validUntil: timeInput,
        inventoryTierUsd: usdInput,
      }),
    )
    .mutation(async ({ ctx: { deps }, input }) => {
      const b = await loadBook(deps, input.bookId);
      const { charter } = await loadCharterOf(deps, b);
      const chain = requireChain(deps);
      const { mandate: mandateAddr } = componentsView(b);
      const tier = parseUsd(input.inventoryTierUsd);
      const validUntil = unixSec(input.validUntil);
      if (validUntil <= Math.floor(deps.now() / 1000)) fail("BAD_REQUEST", "validUntil must be in the future");

      const ms = await softChain(deps, "mandate.state", (g) => g.mandateState(mandateAddr), null);
      const maxInventory = ms?.mandate.maxInventoryUsd ?? charter?.mandate.maxInventoryUsd ?? null;
      if (maxInventory === null) fail("PRECONDITION_FAILED", "Mandate terms unavailable for this book");
      if (tier < maxInventory) {
        fail("BAD_REQUEST", `Inventory tier ${usdStr(tier)} USD must be at least the mandate's max inventory of ${usdStr(maxInventory)} USD`);
      }
      if (ms?.killed) fail("PRECONDITION_FAILED", "Mandate is killed; the committee must re-mandate before desk keys can be registered");
      if (ms?.activeKeys.some((k) => k.toLowerCase() === input.key.toLowerCase())) fail("CONFLICT", `Key ${input.key} is already active on this desk`);

      const [requiredBond, available] = await Promise.all([
        softChain(deps, "config.agentTierBond", (g) => g.agentTierBond(tier), null),
        softChain(deps, "staking.availableOf", (g) => g.stakeAvailable(input.operator), null),
      ]);
      if (requiredBond !== null && available !== null && available < requiredBond) {
        fail("PRECONDITION_FAILED", `Operator has ${bkrnStr(available)} BKRN available to lock; this tier requires ${bkrnStr(requiredBond)} BKRN of stake`);
      }
      const warnings: string[] = [];
      if (requiredBond === null || available === null) warnings.push("Operator bond could not be checked on-chain; registration reverts if the stake is short");
      const sponsor = charter?.sponsor ?? null;
      const selfOperated = sponsor !== null && sponsor.toLowerCase() === input.operator.toLowerCase();
      let consent: boolean | null = selfOperated;
      if (!selfOperated) consent = await softChain(deps, "mandate.operatorConsent", (g) => g.operatorConsent(mandateAddr, input.operator, input.key), null);
      const tx = registerKeyTx(chain.chainId, mandateAddr, input.key, input.operator, BigInt(validUntil), tier);
      const txs = [tx];
      if (consent !== true) {
        txs.unshift(consentKeyTx(chain.chainId, mandateAddr, input.key, input.operator));
        warnings.push(
          consent === null
            ? "Operator consent could not be checked on-chain; the operator signs consentKey first (harmless if already given), then the sponsor registers the key"
            : "The operator has not consented to this key yet: the operator wallet signs step 1 (consentKey), then the sponsor signs registerKey",
        );
      }
      return {
        tx,
        txs,
        signer: sponsor,
        signerRole: "sponsor" as const,
        consentRequired: consent !== true,
        bookId: b.id,
        key: input.key,
        operator: input.operator,
        validUntil: new Date(validUntil * 1000).toISOString(),
        inventoryTierUsd: usdStr(tier),
        requiredBondBkrn: requiredBond === null ? null : bkrnStr(requiredBond),
        operatorAvailableBkrn: available === null ? null : bkrnStr(available),
        warnings,
      };
    }),

  /** Prepared MMMandate.revokeKey (sponsor, RISK, committee, or the key itself). Same-block effect. */
  revoke: publicProcedure
    .input(z.object({ bookId: bookIdInput, key: walletInput, reason: z.string().min(1).max(32).default("REVOKED") }))
    .mutation(async ({ ctx: { deps }, input }) => {
      const b = await loadBook(deps, input.bookId);
      const chain = requireChain(deps);
      if (toBytes(input.reason).length > 32) fail("BAD_REQUEST", "reason must fit in 32 bytes");
      const { mandate } = componentsView(b);
      const ms = await softChain(deps, "mandate.state", (g) => g.mandateState(mandate), null);
      const warnings: string[] = [];
      if (ms && !ms.activeKeys.some((k) => k.toLowerCase() === input.key.toLowerCase())) {
        warnings.push(`Key ${input.key} is not active on-chain; the revocation has no effect`);
      }
      const tx = revokeKeyTx(chain.chainId, mandate, input.key, input.reason);
      return {
        tx,
        txs: [tx],
        signerRoles: ["sponsor", "risk", "committee", "key"] as const,
        bookId: b.id,
        key: input.key,
        reason: input.reason,
        warnings,
      };
    }),

  list: publicProcedure.input(z.object({ bookId: bookIdInput })).query(async ({ ctx: { deps }, input }) => {
    const b = await loadBook(deps, input.bookId);
    const [rows, hbRaw] = await Promise.all([deps.data.listAgentKeys(b.id), deps.kv.get(KEYS.agentHeartbeat(b.id))]);
    const ms = await softChain(deps, "mandate.state", (g) => g.mandateState(componentsView(b).mandate), null);
    const active = new Set((ms?.activeKeys ?? []).map((k) => k.toLowerCase()));
    const keys: AgentKeyView[] = rows.map((r) => ({
      key: getAddress(r.key),
      operator: getAddress(r.operator),
      validUntil: iso(r.validUntil),
      inventoryTierUsd: dbUsdStr(r.inventoryTierUsd),
      status: r.status,
      activeOnChain: ms ? active.has(r.key.toLowerCase()) : null,
      registeredTx: r.registeredTx,
      revokedTx: r.revokedTx,
      revokedReason: r.revokedReason,
      updatedAt: r.updatedAt.toISOString(),
    }));
    // Keys active on-chain that the indexer has not written yet.
    for (const k of ms?.activeKeys ?? []) {
      if (!rows.some((r) => r.key.toLowerCase() === k.toLowerCase())) {
        keys.push({
          key: getAddress(k),
          operator: null,
          validUntil: null,
          inventoryTierUsd: null,
          status: "active",
          activeOnChain: true,
          registeredTx: null,
          revokedTx: null,
          revokedReason: null,
          updatedAt: new Date(deps.now()).toISOString(),
        });
      }
    }
    const hb = hbRaw != null && /^\d+$/.test(hbRaw) ? Number(hbRaw) : null;
    return {
      bookId: b.id,
      keys,
      killed: ms?.killed ?? null,
      killReason: ms && ms.killReason !== zeroHash ? bytes32ToStr(ms.killReason) : null,
      agent: { heartbeatAt: hb ? new Date(hb).toISOString() : null, alive: hb !== null && deps.now() - hb < AGENT_ALIVE_MS },
    };
  }),
});
