// scripts/desk-keys.ts: every book gets an active desk key (Task 7b), pure planning.
import { describe, expect, test } from "bun:test";
import { DESK_KEY_RENEW_DAYS, planDeskKeys } from "./desk-keys";

const K = "0x00000000000000000000000000000000000000d1" as const;
const T = 1_800_000_000;

describe("planDeskKeys", () => {
  test("register missing / expired / revoked keys of our books, ask other sponsors, skip ended books, flag renewals", () => {
    const plan = planDeskKeys(
      [
        { bookId: 1, state: 2, key: K, active: true, validUntil: T + 365 * 86_400, sponsorIsOurs: true },
        { bookId: 2, state: 2, key: K, active: true, validUntil: T + (DESK_KEY_RENEW_DAYS - 1) * 86_400, sponsorIsOurs: true },
        { bookId: 3, state: 0, key: K, active: false, validUntil: 0, sponsorIsOurs: true }, // never registered
        { bookId: 4, state: 2, key: K, active: false, validUntil: T - 1, sponsorIsOurs: true }, // expired
        { bookId: 5, state: 2, key: K, active: false, validUntil: 0, sponsorIsOurs: false },
        { bookId: 6, state: 4, key: K, active: false, validUntil: 0, sponsorIsOurs: true },
        { bookId: 7, state: 2, key: null, active: false, validUntil: 0, sponsorIsOurs: true },
      ],
      T,
    );
    expect(plan.map((p) => p.action)).toEqual(["ok", "renew_soon", "register", "register", "ask_sponsor", "skip", "no_key"]);
  });
});
