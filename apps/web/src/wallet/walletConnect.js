// Runtime re-export of wagmi's WalletConnect connector. Its types live in walletConnect.d.ts: the
// package's own declarations pull @walletconnect's whole type graph (and a second copy of viem's)
// into tsc, roughly doubling typecheck memory, for one function we call with three options.
export { walletConnect } from "wagmi/connectors";
