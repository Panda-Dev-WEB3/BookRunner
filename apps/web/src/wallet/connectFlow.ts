// Connecting a browser wallet, outside React so the decisions are unit-tested against wagmi itself
// (test/connect-flow.test.ts, with a fake EIP-1193 wallet).
//
// Connect never passes `chainId` to wagmi: the injected connector then switches chains INSIDE
// connect() and rethrows a declined switch (4001) as a failed connect, while the wallet keeps the
// account permission (and its listeners). The app chain is asked for as a second, optional step
// whose decline only leaves the wrong-network state, which the banner and the setup checklist handle.
import type { Config, Connector } from "wagmi";
import { connect, getConnection, switchChain } from "wagmi/actions";

type AddChain = NonNullable<Parameters<typeof switchChain>[1]["addEthereumChainParameter"]>;

export interface ConnectResult {
  /** The wallet is connected now. */
  ok: boolean;
  /** Why the connection failed (null when ok). */
  error: unknown;
  /** The wallet connected but did not switch to the app chain (declined or failed); null otherwise. */
  switchError: unknown;
}

/** Connects `connector`, then asks the wallet for the app chain as a separate step. */
export async function connectWallet(config: Config, connector: Connector, target: { chainId: number; addChain?: AddChain }): Promise<ConnectResult> {
  let chainId: number | undefined;
  try {
    chainId = (await connect(config, { connector })).chainId;
  } catch (e) {
    const cur = getConnection(config);
    if (!cur.isConnected) return { ok: false, error: e, switchError: null };
    chainId = cur.chainId;
  }
  if (chainId === target.chainId) return { ok: true, error: null, switchError: null };
  try {
    await switchChain(config, { chainId: target.chainId, ...(target.addChain ? { addEthereumChainParameter: target.addChain } : {}) });
    return { ok: true, error: null, switchError: null };
  } catch (e) {
    return { ok: true, error: null, switchError: e };
  }
}
