// scripts/dev.ts hands each child only the secrets it needs; testnet admin key policy; log-safe URLs.
import { describe, expect, test } from "bun:test";
import { english, generateMnemonic, privateKeyToAccount } from "viem/accounts";
import { childEnv, secretAllowed } from "../src/childenv";
import { ADMIN_KEY_OPT_IN, DEV_ROLE_INDEX, devAccount, roleAccount } from "../src/devkeys";
import { redactUrl } from "../src/redact";

const PARENT = {
  CHAIN_ID: "46630",
  RPC_URL: "https://rpc.testnet.chain.robinhood.com",
  DATABASE_URL: "postgres://bookrunner:pw@127.0.0.1:54400/bookrunner_testnet",
  REDIS_URL: "redis://:pw@127.0.0.1:63790/1",
  BKRN_TESTNET_MNEMONIC: "word ".repeat(11) + "word",
  DEV_MNEMONIC: "test test test test test test test test test test test junk",
  ANTHROPIC_API_KEY: "sk-ant-x",
  ORACLE_SEED: "s".repeat(32),
  API_ADMIN_TOKEN: "admin",
  MARK_SIGNER_PRIVATE_KEY: "0x01",
  DEPLOYER_PRIVATE_KEY: "0x02",
  BKRN_TESTNET_FUNDER_PK: "0x03",
  ORDERLY_TRADE_KEY_SECRET_7: "trade7",
  RISK_ORDERLY_SECRET: "risk",
  POSTGRES_PASSWORD: "pg",
  REDIS_PASSWORD: "rd",
  [ADMIN_KEY_OPT_IN]: "1",
  JURY_MAX_TOKENS: "16000",
  MARK_INTERVAL_SECONDS: "3600",
  ALERT_SMTP_USER: "alerts@bookrunner.tech",
  ALERT_SMTP_PASS: "smtp",
  ALERT_WEBHOOK_URL: "https://hooks.slack.com/services/T/B/x",
  ALERT_HEARTBEAT_URL: "https://hc-ping.com/uuid",
  ALERT_TELEGRAM_CHAT_ID: "-100",
  ALERT_EMAIL_TO: "ops@bookrunner.tech",
  ALERT_ROLE_ADDRESSES: "markSigner=0x00000000000000000000000000000000000000aa",
};

const SECRETS = ["BKRN_TESTNET_MNEMONIC", "DEV_MNEMONIC", "ANTHROPIC_API_KEY", "ORACLE_SEED", "API_ADMIN_TOKEN", "MARK_SIGNER_PRIVATE_KEY", "DEPLOYER_PRIVATE_KEY", "BKRN_TESTNET_FUNDER_PK", "ORDERLY_TRADE_KEY_SECRET_7", "RISK_ORDERLY_SECRET", "POSTGRES_PASSWORD", "REDIS_PASSWORD", ADMIN_KEY_OPT_IN, "ALERT_SMTP_USER", "ALERT_SMTP_PASS", "ALERT_WEBHOOK_URL", "ALERT_HEARTBEAT_URL", "ALERT_TELEGRAM_CHAT_ID"];
const secretsOf = (proc: string) => SECRETS.filter((k) => k in childEnv(proc, PARENT)).sort();

describe("per-process secrets (scripts/dev.ts)", () => {
  test("the internet-facing API gets its admin token and nothing that signs", () => {
    expect(secretsOf("api")).toEqual(["API_ADMIN_TOKEN"]);
  });

  test("indexer, receipts, mock-orderly and web get no secrets at all", () => {
    for (const p of ["indexer", "receipts", "mock-orderly", "web"]) expect(secretsOf(p)).toEqual([]);
  });

  test("signing services get the mnemonic and their own key only", () => {
    expect(secretsOf("mark")).toEqual(["BKRN_TESTNET_MNEMONIC", "DEV_MNEMONIC", "MARK_SIGNER_PRIVATE_KEY"].sort());
    expect(secretsOf("oracle")).toEqual(["BKRN_TESTNET_MNEMONIC", "DEV_MNEMONIC", "ORACLE_SEED"].sort());
    expect(secretsOf("ops-venue")).toEqual(["BKRN_TESTNET_MNEMONIC", "DEV_MNEMONIC", "ORDERLY_TRADE_KEY_SECRET_7"].sort());
    expect(secretsOf("risk")).toEqual(["BKRN_TESTNET_MNEMONIC", "DEV_MNEMONIC", "RISK_ORDERLY_SECRET"].sort());
    expect(secretsOf("agent:NVDA")).toEqual(["BKRN_TESTNET_MNEMONIC", "DEV_MNEMONIC"].sort());
    expect(secretsOf("trader-sim")).toEqual(["BKRN_TESTNET_MNEMONIC", "DEV_MNEMONIC"].sort());
    expect(secretsOf("gas-keeper")).toEqual(["BKRN_TESTNET_FUNDER_PK", "BKRN_TESTNET_MNEMONIC", "DEV_MNEMONIC"].sort());
  });

  test("ANTHROPIC_API_KEY reaches the charter service only", () => {
    expect(secretsOf("charter")).toContain("ANTHROPIC_API_KEY");
    for (const p of ["api", "oracle", "mark", "risk", "ops-venue", "waterfall", "agent:RHX5", "trader-sim", "gas-keeper", "launch", "indexer"]) expect(secretsOf(p)).not.toContain("ANTHROPIC_API_KEY");
  });

  test("the admin opt-in and the deployer key reach the launch script only", () => {
    expect(secretsOf("launch")).toContain(ADMIN_KEY_OPT_IN);
    expect(secretsOf("launch")).toContain("DEPLOYER_PRIVATE_KEY");
    for (const p of ["api", "oracle", "mark", "risk", "ops-venue", "waterfall", "charter", "agent:NVDA", "trader-sim", "gas-keeper"]) {
      expect(secretsOf(p)).not.toContain(ADMIN_KEY_OPT_IN);
      expect(secretsOf(p)).not.toContain("DEPLOYER_PRIVATE_KEY");
    }
  });

  test("non-secret config passes through; infra URLs go to services but not to the web dev server", () => {
    const api = childEnv("api", PARENT, { FORCE_COLOR: "1" });
    expect(api.CHAIN_ID).toBe("46630");
    expect(api.JURY_MAX_TOKENS).toBe("16000");
    expect(api.DATABASE_URL).toBe(PARENT.DATABASE_URL);
    expect(api.FORCE_COLOR).toBe("1");
    expect(childEnv("web", PARENT).DATABASE_URL).toBeUndefined();
    expect(childEnv("web", PARENT).REDIS_URL).toBeUndefined();
  });

  test("alerts: its delivery credentials + the infra URLs, nothing that signs; nobody else gets them", () => {
    expect(secretsOf("alerts")).toEqual(["ALERT_HEARTBEAT_URL", "ALERT_SMTP_PASS", "ALERT_SMTP_USER", "ALERT_TELEGRAM_CHAT_ID", "ALERT_WEBHOOK_URL"]);
    const env = childEnv("alerts", PARENT);
    expect(env.DATABASE_URL).toBe(PARENT.DATABASE_URL);
    expect(env.ALERT_EMAIL_TO).toBe("ops@bookrunner.tech"); // not a secret: every child may see it
    expect(env.ALERT_ROLE_ADDRESSES).toBe(PARENT.ALERT_ROLE_ADDRESSES);
    for (const p of ["api", "oracle", "mark", "risk", "ops-venue", "waterfall", "charter", "indexer", "receipts", "agent:NVDA", "trader-sim", "gas-keeper", "launch", "web"]) {
      for (const k of ["ALERT_SMTP_PASS", "ALERT_SMTP_USER", "ALERT_WEBHOOK_URL", "ALERT_HEARTBEAT_URL"]) expect(secretsOf(p)).not.toContain(k);
    }
  });

  test("mainnet-style host: per-role KMS ids + AWS secrets, ALERT_* to alerts, desk keys and price API specs scoped", () => {
    const host = {
      CHAIN_ID: "4663",
      AWS_REGION: "eu-west-1",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      MARK_SIGNER_KMS_KEY_ID: "alias/bkrn-mark",
      RISK_KMS_KEY_ID: "alias/bkrn-risk",
      OPS_VENUE_KMS_KEY_ID: "alias/bkrn-ops",
      JURY_KMS_KEY_ID: "alias/bkrn-jury",
      KEEPER_KMS_KEY_ID: "alias/bkrn-keeper",
      ORACLE_SIGNER_KMS_KEY_ID: "alias/bkrn-oracle",
      DESK_KEY_PRIVATE_KEY_7: "0x07",
      ORACLE_HTTP_SOURCES: '[{"name":"v","url":"https://x/{ticker}","pricePath":"p","headers":{"X-Api-Key":"k"}}]',
      ALERT_SMTP_USER: "alerts@bookrunner.tech",
      ALERT_SMTP_PASS: "smtp",
      ALERT_ROLE_ADDRESSES: "markSigner=0x00000000000000000000000000000000000000aa",
    };
    const secrets = (proc: string) => Object.keys(childEnv(proc, host)).filter((k) => k !== "CHAIN_ID" && k !== "AWS_REGION" && k !== "ALERT_ROLE_ADDRESSES").sort();
    expect(secrets("mark")).toEqual(["AWS_SECRET_ACCESS_KEY", "MARK_SIGNER_KMS_KEY_ID"]);
    expect(secrets("risk")).toEqual(["AWS_SECRET_ACCESS_KEY", "RISK_KMS_KEY_ID"]);
    expect(secrets("ops-venue")).toEqual(["AWS_SECRET_ACCESS_KEY", "OPS_VENUE_KMS_KEY_ID"]);
    expect(secrets("charter")).toEqual(["AWS_SECRET_ACCESS_KEY", "JURY_KMS_KEY_ID"]);
    expect(secrets("waterfall")).toEqual(["AWS_SECRET_ACCESS_KEY", "KEEPER_KMS_KEY_ID"]);
    expect(secrets("oracle")).toEqual(["AWS_SECRET_ACCESS_KEY", "ORACLE_HTTP_SOURCES", "ORACLE_SIGNER_KMS_KEY_ID"]);
    expect(secrets("alerts")).toEqual(["ALERT_SMTP_PASS", "ALERT_SMTP_USER"]);
    for (const p of ["api", "indexer", "receipts"]) expect(secrets(p)).toEqual([]);
    // the per-book desk key is stripped from every child; dev.ts hands it to agent:<book> as DESK_KEY_PRIVATE_KEY
    expect(secrets("agent:NVDA")).toEqual([]);
    expect(childEnv("agent:NVDA", host, { DESK_KEY_PRIVATE_KEY: "0x07" }).DESK_KEY_PRIVATE_KEY).toBe("0x07");
    expect(childEnv("alerts", host).ALERT_ROLE_ADDRESSES).toBe(host.ALERT_ROLE_ADDRESSES);
  });

  test("unknown processes get no secrets", () => {
    expect(secretsOf("something-new")).toEqual([]);
    expect(secretAllowed("something-new", "BKRN_TESTNET_MNEMONIC")).toBe(false);
  });
});

describe("testnet admin key policy (devkeys)", () => {
  const mnemonic = generateMnemonic(english);
  const env = { CHAIN_ID: "46630", BKRN_TESTNET_MNEMONIC: mnemonic };

  test("service roles still derive from the testnet mnemonic", () => {
    expect(roleAccount("markSigner", env).address).toBe(devAccount("markSigner", mnemonic).address);
  });

  test("the deployer needs the explicit opt-in (operator scripts) or its own private key", () => {
    expect(() => roleAccount("deployer", env)).toThrow(/protocol-admin/);
    expect(roleAccount("deployer", { ...env, [ADMIN_KEY_OPT_IN]: "1" }).address).toBe(devAccount("deployer", mnemonic).address);
    const pk = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    expect(roleAccount("deployer", { ...env, DEPLOYER_PRIVATE_KEY: pk }).address).toBe(privateKeyToAccount(pk).address);
  });

  test("the gas funder is its own key: index 23 or BKRN_TESTNET_FUNDER_PK", () => {
    expect(DEV_ROLE_INDEX.funder).toBe(23);
    expect(DEV_ROLE_INDEX.treasury).toBe(22); // distinct keys: the funder never holds protocol fees
    expect(roleAccount("funder", env).address).toBe(devAccount("funder", mnemonic).address);
    expect(roleAccount("funder", env).address).not.toBe(devAccount("deployer", mnemonic).address);
  });

  test("devnet is unchanged (anvil accounts, deployer included)", () => {
    expect(roleAccount("deployer", { CHAIN_ID: "31337" }).address).toBe("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
  });
});

describe("redactUrl", () => {
  test("keeps scheme + host, drops keys in path, query and credentials", () => {
    expect(redactUrl("https://rpc.testnet.chain.robinhood.com")).toBe("https://rpc.testnet.chain.robinhood.com");
    expect(redactUrl("https://eth.example.com/v2/AbCdEf0123456789")).toBe("https://eth.example.com/…");
    expect(redactUrl("https://rpc.example.com/?apikey=secret")).toBe("https://rpc.example.com/…");
    expect(redactUrl("postgres://bookrunner:pw@127.0.0.1:54400/db")).toBe("postgres://127.0.0.1:54400/…");
    expect(redactUrl("not a url")).toBe("<redacted url>");
  });
});
