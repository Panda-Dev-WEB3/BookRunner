// Node side of the demo wallet: the page gets an EIP-6963 / EIP-1193 provider (wallet-inject.js) whose every request
// lands here through page.exposeBinding("__demoWalletRequest"), accepted only from the local app origin. Account
// methods are answered locally, read methods are forwarded to the testnet RPC, and eth_sendTransaction is signed by
// viem with the demo key and broadcast.
//
// Key rules (docs/superpowers/plans/2026-10-14-product-demo-videos.md, Global Constraints): the private key is read
// only from video/.secrets/demo-wallet.json, never logged, never sent to the page; only chain 46630 is accepted
// (the handler refuses to be built for any other chain, and re-checks the RPC's chain id before every send).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, getAddress, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";

/** Robinhood Chain testnet: the only chain the demo wallet signs for. */
export const DEMO_CHAIN_ID = 46630;
export const DEMO_RPC_URL = "https://rpc.testnet.chain.robinhood.com";
export const INJECT_SCRIPT = fileURLToPath(new URL("./wallet-inject.js", import.meta.url));

/** EIP-1193 / EIP-1474 error codes used here. */
export const ERR = { USER_REJECTED: 4001, UNAUTHORIZED: 4100, UNSUPPORTED: 4200, UNRECOGNIZED_CHAIN: 4902, INVALID_PARAMS: -32602, INTERNAL: -32603 };

export class RpcError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    if (data !== undefined) this.data = data;
  }
}

/** Non-negative integer (number | bigint | decimal or hex string, as BigInt() reads it) -> "0x…" quantity, no leading zeros. */
export function toHexQuantity(n) {
  const b = typeof n === "bigint" ? n : BigInt(n);
  if (b < 0n) throw new RangeError(`negative quantity ${b}`);
  return `0x${b.toString(16)}`;
}

/** "0x…" quantity (or number / bigint) -> bigint; undefined / null stay undefined; anything else is invalid params. */
export function parseQuantity(v, field) {
  if (v === undefined || v === null) return undefined;
  if (typeof v === "bigint" && v >= 0n) return v;
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return BigInt(v);
  if (typeof v === "string" && /^0x[0-9a-fA-F]+$/.test(v)) return BigInt(v);
  throw new RpcError(ERR.INVALID_PARAMS, `demo wallet: invalid ${field}`);
}

/** Throws unless `chainId` (number, bigint or hex) is the demo chain 46630. */
export function assertDemoChain(chainId) {
  let n;
  try {
    n = Number(typeof chainId === "string" && !chainId.startsWith("0x") ? BigInt(chainId) : parseQuantity(chainId, "chainId"));
  } catch {
    n = NaN;
  }
  if (n !== DEMO_CHAIN_ID) throw new RpcError(ERR.UNAUTHORIZED, `demo wallet: refusing chain ${String(chainId)} (only ${DEMO_CHAIN_ID} is allowed)`);
  return n;
}

const WALLET_METHODS = new Set([
  "eth_requestAccounts", "eth_accounts", "eth_chainId", "net_version",
  "wallet_switchEthereumChain", "wallet_addEthereumChain",
  "wallet_requestPermissions", "wallet_getPermissions", "wallet_revokePermissions",
]);
const READ_METHODS = new Set([
  "eth_call", "eth_estimateGas", "eth_blockNumber", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
  "eth_createAccessList", "web3_clientVersion",
]);

/** "wallet" (answered locally) | "send" (eth_sendTransaction) | "read" (forwarded to the RPC) | "unsupported". */
export function classifyMethod(method) {
  if (typeof method !== "string") return "unsupported";
  if (WALLET_METHODS.has(method)) return "wallet";
  if (method === "eth_sendTransaction") return "send";
  if (READ_METHODS.has(method) || /^eth_get[A-Z]/.test(method)) return "read";
  return "unsupported"; // eth_sign, personal_sign, eth_signTypedData*, eth_sendRawTransaction, …
}

/**
 * eth_sendTransaction params[0] -> viem sendTransaction parameters. Refuses a foreign `from`, a `chainId` other than
 * 46630, a missing / invalid `to` (the app never deploys contracts) and malformed quantities.
 */
export function parseTxRequest(tx, { address }) {
  if (!tx || typeof tx !== "object") throw new RpcError(ERR.INVALID_PARAMS, "demo wallet: missing transaction");
  if (tx.from !== undefined && (typeof tx.from !== "string" || tx.from.toLowerCase() !== address.toLowerCase())) {
    throw new RpcError(ERR.UNAUTHORIZED, `demo wallet: from ${String(tx.from)} is not the demo account`);
  }
  if (tx.chainId !== undefined && tx.chainId !== null) assertDemoChain(tx.chainId);
  if (typeof tx.to !== "string" || !isAddress(tx.to, { strict: false })) throw new RpcError(ERR.INVALID_PARAMS, "demo wallet: transaction needs a valid `to`");
  if (tx.data !== undefined && tx.input !== undefined && tx.data !== tx.input) throw new RpcError(ERR.INVALID_PARAMS, "demo wallet: data and input differ");
  const data = tx.data ?? tx.input;
  if (data !== undefined && (typeof data !== "string" || !/^0x([0-9a-fA-F]{2})*$/.test(data))) throw new RpcError(ERR.INVALID_PARAMS, "demo wallet: invalid data");
  const out = {
    to: getAddress(tx.to),
    data,
    value: parseQuantity(tx.value, "value"),
    gas: parseQuantity(tx.gas, "gas"),
    nonce: tx.nonce === undefined || tx.nonce === null ? undefined : Number(parseQuantity(tx.nonce, "nonce")),
    maxFeePerGas: parseQuantity(tx.maxFeePerGas, "maxFeePerGas"),
    maxPriorityFeePerGas: parseQuantity(tx.maxPriorityFeePerGas, "maxPriorityFeePerGas"),
    gasPrice: parseQuantity(tx.gasPrice, "gasPrice"),
  };
  if (out.maxFeePerGas !== undefined || out.maxPriorityFeePerGas !== undefined) out.gasPrice = undefined;
  return Object.fromEntries(Object.entries(out).filter(([, v]) => v !== undefined));
}

const PERMISSIONS = [{ parentCapability: "eth_accounts", caveats: [] }];

/** Error -> plain { code, message, data? } (crosses the page boundary as JSON). */
export function toRpcErrorObject(e) {
  const code = typeof e?.code === "number" ? e.code : ERR.INTERNAL;
  const message = String(e?.shortMessage ?? e?.message ?? e ?? "demo wallet error");
  return e?.data !== undefined ? { code, message, data: e.data } : { code, message };
}

/**
 * The request router, without network: `rpc(method, params)` forwards reads, `send(txParams)` signs + broadcasts and
 * resolves the hash. `handle({ method, params })` resolves { result, events } or { error } — never rejects. `events`
 * are [name, payload] pairs the page emits on the provider (accountsChanged on connect / revoke).
 * With `allowSend: false` every eth_sendTransaction is refused (4100) before it is parsed, signed or sent: for
 * recordings that must never transact.
 */
export function createWalletHandler({ address, chainId, rpc, send, allowSend = true }) {
  assertDemoChain(chainId);
  if (!isAddress(address, { strict: false })) throw new Error("demo wallet: invalid address");
  const addr = getAddress(address);
  const state = { connected: false };

  async function dispatch(method, params, events) {
    switch (classifyMethod(method)) {
      case "wallet":
        switch (method) {
          case "eth_requestAccounts":
            if (!state.connected) events.push(["accountsChanged", [addr]]);
            state.connected = true;
            return [addr];
          case "wallet_requestPermissions":
            if (!state.connected) events.push(["accountsChanged", [addr]]);
            state.connected = true;
            return PERMISSIONS;
          case "wallet_getPermissions":
            return state.connected ? PERMISSIONS : [];
          case "eth_accounts":
            return state.connected ? [addr] : [];
          case "eth_chainId":
            return toHexQuantity(DEMO_CHAIN_ID);
          case "net_version":
            return String(DEMO_CHAIN_ID);
          case "wallet_switchEthereumChain": {
            const want = params?.[0]?.chainId;
            try {
              assertDemoChain(want);
            } catch {
              throw new RpcError(ERR.UNRECOGNIZED_CHAIN, `demo wallet: unrecognized chain ${String(want)} (only ${DEMO_CHAIN_ID})`);
            }
            return null;
          }
          case "wallet_addEthereumChain": {
            const want = params?.[0]?.chainId;
            try {
              assertDemoChain(want);
            } catch {
              throw new RpcError(ERR.USER_REJECTED, `demo wallet: will not add chain ${String(want)} (only ${DEMO_CHAIN_ID})`);
            }
            return null;
          }
          case "wallet_revokePermissions":
            if (state.connected) events.push(["accountsChanged", []]);
            state.connected = false;
            return null;
        }
        break;
      case "send": {
        if (allowSend !== true) throw new RpcError(ERR.UNAUTHORIZED, "demo wallet: sending is disabled for this recording");
        if (!state.connected) throw new RpcError(ERR.UNAUTHORIZED, "demo wallet: not connected");
        const tx = parseTxRequest(params?.[0], { address: addr });
        // the endpoint itself must be on 46630, not just the configured id
        assertDemoChain(await rpc("eth_chainId", []));
        return await send(tx);
      }
      case "read":
        return await rpc(method, params ?? []);
    }
    throw new RpcError(ERR.UNSUPPORTED, `demo wallet: unsupported method ${String(method)}`);
  }

  return {
    address: addr,
    state,
    async handle(req) {
      const events = [];
      try {
        const result = await dispatch(req?.method, Array.isArray(req?.params) ? req.params : [], events);
        return { result: result === undefined ? null : result, events };
      } catch (e) {
        return { error: toRpcErrorObject(e) };
      }
    },
  };
}

/** JSON-RPC over fetch; a JSON-RPC error keeps its code and data (revert data reaches the app unchanged). */
export function jsonRpc(rpcUrl) {
  let id = 0;
  return async (method, params) => {
    const res = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
    if (!res.ok) throw new RpcError(ERR.INTERNAL, `rpc ${method}: HTTP ${res.status}`);
    const body = await res.json();
    if (body.error) throw new RpcError(body.error.code ?? ERR.INTERNAL, body.error.message ?? "rpc error", body.error.data);
    return body.result;
  };
}

/**
 * Reads { privateKey, address } from the demo key file. Any read / parse failure becomes one generic error with no
 * cause attached: a JSON SyntaxError quotes the file's text, i.e. possibly the key.
 */
export function readDemoWalletFile(file) {
  let j;
  try {
    j = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    j = null;
  }
  if (!j || typeof j !== "object" || typeof j.privateKey !== "string") throw new Error(`${file}: demo wallet file unreadable`);
  return j;
}

/** Reads the demo key file and returns the viem account (checks it matches the stored address). Never prints the key. */
export function loadDemoAccount(file) {
  const j = readDemoWalletFile(file);
  let account;
  try {
    account = privateKeyToAccount(j.privateKey);
  } catch {
    throw new Error(`${file}: invalid privateKey`); // the library's message is not passed on: it may quote the value
  }
  if (j.address && account.address.toLowerCase() !== String(j.address).toLowerCase()) throw new Error(`${file}: address does not match the key`);
  return account;
}

export const demoChain = (rpcUrl = DEMO_RPC_URL) =>
  defineChain({ id: DEMO_CHAIN_ID, name: "Robinhood Chain Testnet", nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });

/** True when a calling frame's URL has exactly the app server's origin (scheme, host, port). */
export function originAllowed(frameUrl, appOrigin) {
  try {
    return new URL(frameUrl).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

/**
 * Installs the demo wallet in a Playwright page (before its first navigation). `appOrigin` is the local app server's
 * origin (startAppServer().origin): requests from any other frame origin (iframes, a followed explorer / faucet link)
 * are refused with 4100. Returns { address, txs, settled() }: `txs` gets
 * { hash, status: "pending" | "success" | "reverted" | "unknown" } per sent transaction. With
 * `allowSend: false` the wallet refuses every transaction (see createWalletHandler).
 */
export async function installDemoWallet(page, { account, appOrigin, rpcUrl = DEMO_RPC_URL, chainId = DEMO_CHAIN_ID, allowSend = true, log = console.log }) {
  assertDemoChain(chainId);
  if (!appOrigin || !originAllowed(appOrigin, appOrigin)) throw new Error("installDemoWallet: appOrigin (the local app server origin) is required");
  const chain = demoChain(rpcUrl);
  const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
  const walletClient = createWalletClient({ account, chain, transport: http(rpcUrl) });
  const txs = [];
  const waits = [];
  const handler = createWalletHandler({
    address: account.address,
    chainId,
    allowSend,
    rpc: jsonRpc(rpcUrl),
    async send(tx) {
      const hash = await walletClient.sendTransaction({ ...tx, account, chain });
      const rec = { hash, status: "pending" };
      txs.push(rec);
      log(`demo wallet: sent ${hash}`);
      waits.push(
        publicClient.waitForTransactionReceipt({ hash, timeout: 300_000 }).then(
          (r) => {
            rec.status = r.status;
            log(`demo wallet: ${hash} ${r.status} (block ${r.blockNumber})`);
          },
          (e) => {
            rec.status = "unknown";
            rec.error = String(e?.shortMessage ?? e?.message ?? e);
          },
        ),
      );
      return hash;
    },
  });
  await page.exposeBinding("__demoWalletRequest", (source, req) => {
    const from = source?.frame?.url?.() ?? "";
    if (!originAllowed(from, appOrigin)) {
      log(`demo wallet: refused a request from another origin (${from.split(/[?#]/)[0].slice(0, 80)})`);
      return { error: { code: ERR.UNAUTHORIZED, message: "demo wallet: this origin is not the demo app" } };
    }
    return handler.handle(req);
  });
  await page.addInitScript({ path: INJECT_SCRIPT });
  return { address: handler.address, txs, settled: () => Promise.all(waits).then(() => txs) };
}
