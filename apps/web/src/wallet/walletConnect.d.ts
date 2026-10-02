// Narrow declaration for walletConnect.js (see there). Mirrors the options chains.ts passes to
// wagmi's walletConnect() connector (WalletConnectParameters in @wagmi/connectors).
import type { CreateConnectorFn } from "wagmi";

export interface WalletConnectOptions {
  /** WalletConnect Cloud project id. */
  projectId: string;
  /** Show the WalletConnect QR dialog (default true). */
  showQrModal?: boolean;
  metadata?: { name: string; description: string; url: string; icons: string[] };
}

export declare function walletConnect(parameters: WalletConnectOptions): CreateConnectorFn;
