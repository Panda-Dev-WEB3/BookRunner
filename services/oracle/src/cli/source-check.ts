// Operator CLI (read-only): reads every configured price source live and prints a pass/fail table.
//
//   bun run --cwd services/oracle source-check --chain 4663 --rpc https://<mainnet-rpc> \
//       [--config config/chains/4663.json] [--registry 0x<StockTokenRegistry>] [--no-service-config] [--json]
//
// Feeds/tokens come from the chain price config (default config/chains/<chain>.json) overlaid with
// ORACLE_CHAINLINK_FEEDS; the service-config rows (mainnet production rules) and the HTTP sources compared
// against Chainlink come from the current process environment (ORACLE_* variables), never from a .env file.
// Exit code 1 when any row FAILs. Sends no transaction and needs no key.
import { createLogger, isMainnet } from "@bookrunner/shared";
import { stockTokenRegistryAbi } from "@bookrunner/shared/abi";
import { type Address, BaseError, ContractFunctionRevertedError, type PublicClient, createPublicClient, getAddress, http } from "viem";
import { loadOracleConfig } from "../config";
import { productionProblems } from "../production";
import { type RegistryView, type SourceCheckReader, formatTable, runSourceCheck } from "../source-check";
import { buildSources } from "../sources";
import { aggregatorV3Abi, stockTokenAbi, viemAggregatorReader } from "../sources/chainlink";

interface Args {
  chain: number;
  rpc: string | undefined;
  config: string | undefined;
  registry: Address | null;
  serviceConfig: boolean;
  json: boolean;
}

export function parseArgs(argv: readonly string[], env: Record<string, string | undefined> = process.env): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const chain = Number(get("--chain") ?? env.CHAIN_ID ?? "4663");
  if (!Number.isInteger(chain) || chain <= 0) throw new Error("--chain must be a chain id");
  const reg = get("--registry");
  return {
    chain,
    rpc: get("--rpc") ?? env.ORACLE_CHAINLINK_RPC_URL ?? env.RHC_RPC_URL ?? env.RPC_URL,
    config: get("--config"),
    registry: reg ? getAddress(reg) : null,
    serviceConfig: !argv.includes("--no-service-config"),
    json: argv.includes("--json"),
  };
}

export function viemCheckReader(pub: PublicClient): SourceCheckReader {
  const base = viemAggregatorReader(pub);
  return {
    ...base,
    chainId: () => pub.getChainId(),
    hasCode: async (a) => {
      const code = await pub.getCode({ address: a });
      return !!code && code !== "0x";
    },
    description: (feed) => pub.readContract({ address: feed, abi: aggregatorV3Abi, functionName: "description" }),
    tokenDecimals: async (t) => Number(await pub.readContract({ address: t, abi: stockTokenAbi, functionName: "decimals" })),
  };
}

export function viemRegistryView(pub: PublicClient, registry: Address): RegistryView {
  return {
    async token(token) {
      try {
        const t = await pub.readContract({ address: registry, abi: stockTokenRegistryAbi, functionName: "getToken", args: [token] });
        return { registered: t.token !== "0x0000000000000000000000000000000000000000", multiplierWad: t.multiplierWad, decimals: t.decimals, active: t.active };
      } catch (e) {
        const revert = e instanceof BaseError ? e.walk((x) => x instanceof ContractFunctionRevertedError) : null;
        if (revert instanceof ContractFunctionRevertedError && revert.data?.errorName === "MultiplierOutOfBand") {
          const [, live, anchor] = revert.data.args as readonly [Address, bigint, bigint];
          return { error: `live uiMultiplier ${live} outside the band of anchor ${anchor}: re-anchor (setMultiplier) or pre-approve (setNextMultiplierAnchor)` };
        }
        return { error: `getToken reverted: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
      }
    },
    multiplierFromToken: (token) => pub.readContract({ address: registry, abi: stockTokenRegistryAbi, functionName: "multiplierFromToken", args: [token] }),
  };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.rpc) throw new Error("no RPC: pass --rpc <url> (or set RHC_RPC_URL)");
  const cfg = loadOracleConfig({ ...process.env, CHAIN_ID: String(args.chain), ...(args.config ? { ORACLE_CHAIN_CONFIG: args.config } : {}) });
  if (!cfg.chainConfig) throw new Error(`no chain price config for ${args.chain} (config/chains/${args.chain}.json or --config)`);
  const pub = createPublicClient({ transport: http(args.rpc, { batch: true }) }) as PublicClient;
  const log = createLogger("source-check", "silent");
  const built = args.serviceConfig ? buildSources(cfg, log) : null;
  const rows = await runSourceCheck({
    chainId: args.chain,
    config: cfg.chainConfig,
    feeds: cfg.chainlinkFeeds,
    reader: viemCheckReader(pub),
    sequencerFeed: cfg.sequencerUptimeFeed,
    sequencerGraceMs: cfg.ORACLE_SEQUENCER_GRACE_MS,
    registry: args.registry ? viemRegistryView(pub, args.registry) : null,
    otherSources: built ? built.sources.filter((s) => s.kind === "http") : [],
    outlierBps: cfg.ORACLE_OUTLIER_BPS,
    configProblems: built
      ? [...productionProblems(cfg, built.sources), ...(built.syntheticRefused && !isMainnet(args.chain) ? [built.syntheticRefused] : [])]
      : [],
  });
  console.log(args.json ? JSON.stringify(rows, null, 2) : formatTable(rows));
  return rows.some((r) => r.status === "FAIL") ? 1 : 0;
}

if (import.meta.main) {
  main().then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`source-check: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    },
  );
}
