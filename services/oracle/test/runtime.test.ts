import { describe, expect, test } from "bun:test";
import { type Deployment, devAccount } from "@bookrunner/shared";
import { loadOracleConfig } from "../src/config";
import { Runtime } from "../src/runtime";
import { makeService, silentLog } from "./fakes";

describe("Runtime (deployment watcher)", () => {
  const cfg = loadOracleConfig({ ORACLE_DEPLOYMENT_RETRY_MS: "1234" });

  test("idles with a retry delay while the deployment file is missing", async () => {
    const { svc } = makeService({ sources: [] });
    const rt = new Runtime(cfg, silentLog, svc, devAccount("oracleSigner"), null, null, () => null);
    expect(await rt.refresh()).toBe(1234);
    expect(svc.status()).toBe("waiting-deployment");
    expect(svc.health().waitingReason).toContain("deployment file not found");
  });

  test("refuses a deployment for another chain id", async () => {
    const { svc } = makeService({ sources: [] });
    const dep = { chainId: 4663, startBlock: 0, contracts: {}, stockTokens: {}, books: [] } as unknown as Deployment;
    const rt = new Runtime(cfg, silentLog, svc, devAccount("oracleSigner"), null, null, () => dep);
    expect(await rt.refresh()).toBe(1234);
    expect(svc.health().waitingReason).toContain("chainId 4663");
  });
});
