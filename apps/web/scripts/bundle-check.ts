// Build guard (used by vite.config.ts): a testnet or mainnet bundle must not contain the devnet
// dev-wallet signer, i.e. the public anvil mnemonic and its key derivation. lib/devsigner.ts is
// only reachable through wallet/devGate.ts's compile-time gate, so for those builds it is dropped;
// this check fails the build if anything ever pulls it back in.

/** A fragment of the anvil mnemonic ("test test ... junk"), as it appears in a bundle. */
export const DEV_MNEMONIC_MARK = "test test test test";

/** Chain ids that are devnet builds (VITE_CHAIN_ID unset, empty or 31337). */
export const isDevnetBuild = (chainId: string | undefined): boolean => chainId === undefined || chainId.trim() === "" || chainId.trim() === "31337";

/** Output files (JS and source maps) that contain the dev mnemonic. */
export function filesWithDevKeys(files: ReadonlyArray<{ file: string; text: string }>): string[] {
  return files.filter((f) => f.text.includes(DEV_MNEMONIC_MARK)).map((f) => f.file);
}
