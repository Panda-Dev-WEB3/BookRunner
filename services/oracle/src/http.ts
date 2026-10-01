// HTTP surface (Hono): /health, /prices, /prices/:priceId, /attestation.
import { Hono } from "hono";
import type { OracleService } from "./service";

export type OracleView = Pick<OracleService, "health" | "prices" | "price" | "signerInfo">;

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

  app.get("/prices", (c) => c.json({ prices: svc.prices() }));

  app.get("/prices/:priceId", (c) => {
    const m = svc.price(c.req.param("priceId"));
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
