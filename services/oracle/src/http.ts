// HTTP surface (Hono): /health, /prices, /prices/:priceId, /attestation.
// Prices are served only once they have landed on-chain and never with their EIP-712 signature: a signed
// update the chain has not seen yet would let a trader trade at the stored price, relay the newer one and
// close in one transaction (AttestedOracle also restricts relaying to signers / KEEPER / timelock).
import { Hono } from "hono";
import type { OracleService } from "./service";

export type OracleView = Pick<OracleService, "health" | "publicPrices" | "publicPrice" | "signerInfo">;

export const ATTESTATION_NOTE =
  "VERIFY: devnet signs with a plain key. Production runs the aggregator inside a TEE; the quote is " +
  "hashed into AttestedOracle.setSigner(signer, active, attestation) by the timelock, and quote " +
  "verification (vendor collateral, measurement allow-list) is not implemented yet.";

export function createApp(svc: OracleView): Hono {
  const app = new Hono();

  app.get("/health", (c) => {
    const h = svc.health();
    return c.json({ ok: true, service: "oracle", ...h });
  });

  app.get("/prices", (c) => c.json({ prices: svc.publicPrices() }));

  app.get("/prices/:priceId", (c) => {
    const m = svc.publicPrice(c.req.param("priceId"));
    return m ? c.json(m) : c.json({ error: "unknown price id" }, 404);
  });

  app.get("/attestation", (c) => {
    const s = svc.signerInfo();
    return c.json({
      signer: s.address,
      chainId: s.chainId,
      oracle: s.oracle,
      registered: s.registered,
      attestation: { type: "devnet-plain-key", quote: null },
      note: ATTESTATION_NOTE,
    });
  });

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => c.json({ error: err.message }, 500));
  return app;
}

/** Bun.serve options: bound to ORACLE_HOST (default 127.0.0.1, not every interface). */
export function serveOptions(cfg: { ORACLE_HOST: string; ORACLE_PORT: number }, fetch: (req: Request) => Response | Promise<Response>) {
  return { hostname: cfg.ORACLE_HOST, port: cfg.ORACLE_PORT, fetch };
}

/**
 * Round-trip cost below which a move the chain has not seen yet cannot be arbitraged against an in-house
 * pool (RHX5: spread 10 bps + 2 x 6 bps taker fee = 22 bps). Pushes on a smaller deviation keep the stored
 * price within it; the service warns when ORACLE_PUSH_DEVIATION_BPS is above this.
 */
export const MAX_SAFE_PUSH_DEVIATION_BPS = 10;
