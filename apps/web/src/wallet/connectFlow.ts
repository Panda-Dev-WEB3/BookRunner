// Connecting and disconnecting a browser wallet, outside React so the decisions are unit-tested
// against wagmi itself (test/connect-flow.test.ts, with fake EIP-1193 wallets).
//
// Connect never passes `chainId` to wagmi: the injected connector then switches chains INSIDE
// connect() and rethrows a declined switch (4001) as a failed connect, while the wallet keeps the
// account permission (and its listeners). The app chain is asked for as a second, optional step
// whose decline only leaves the wrong-network state, which the banner and the setup checklist handle.
//
// One wallet at a time: wagmi keeps every connection and its disconnect() only drops the current
// one, then switches over to the next, so 'Change' then 'Disconnect' used to leave the first wallet
// connected (its address still shared, its balances still shown).
import type { Config, Connector } from "wagmi";
import { connect, disconnect, getConnection, getConnections, switchChain } from "wagmi/actions";

type AddChain = NonNullable<Parameters<typeof switchChain>[1]["addEthereumChainParameter"]>;

export interface ConnectResult {
  /** The asked-for connector is the connected one now. */
  ok: boolean;
  /** Why the connection failed (null when ok). */
  error: unknown;
  /** The wallet connected but did not switch to the app chain (declined or failed); null otherwise. */
  switchError: unknown;
}

/** Disconnects every connection except `keepUid` (all of them when null). Best effort. */
export async function disconnectOthers(config: Config, keepUid: string | null): Promise<void> {
  for (const c of getConnections(config)) {
    if (c.connector.uid === keepUid) continue;
    try {
      await disconnect(config, { connector: c.connector });
    } catch {
      // the wallet is gone already: nothing left to close
    }
  }
}

/**
 * Connects `connector`, keeps it as the only connection, then asks the wallet for the app chain.
 * Resolves ok only when the asked-for connector is the current one, so a decline in a second wallet
 * is never reported as success because another wallet is still connected.
 */
export async function connectWallet(config: Config, connector: Connector, target: { chainId: number; addChain?: AddChain }): Promise<ConnectResult> {
  let chainId: number | undefined;
  try {
    chainId = (await connect(config, { connector })).chainId;
  } catch (e) {
    // ConnectorAlreadyConnectedError: this connector is already the current one, which is a success.
    const cur = getConnection(config);
    if (cur.connector?.uid !== connector.uid) return { ok: false, error: e, switchError: null };
    chainId = cur.chainId;
  }
  await disconnectOthers(config, connector.uid);
  if (chainId === target.chainId) return { ok: true, error: null, switchError: null };
  try {
    await switchChain(config, { chainId: target.chainId, ...(target.addChain ? { addEthereumChainParameter: target.addChain } : {}) });
    return { ok: true, error: null, switchError: null };
  } catch (e) {
    return { ok: true, error: null, switchError: e };
  }
}

/** Disconnects every wallet connection, not just the current one. */
export function disconnectAll(config: Config): Promise<void> {
  return disconnectOthers(config, null);
}
