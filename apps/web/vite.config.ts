import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { type Plugin, defineConfig, loadEnv } from "vite";
import { filesWithDevKeys, isDevnetBuild } from "./scripts/bundle-check";

const port = Number(process.env.WEB_PORT ?? 5180);

/** Fails a non-devnet build whose output contains the devnet dev-wallet mnemonic (scripts/bundle-check.ts). */
function noDevKeysOutsideDevnet(chainId: string | undefined): Plugin {
  return {
    name: "bookrunner-no-dev-keys",
    apply: "build",
    generateBundle(_options, bundle) {
      if (isDevnetBuild(chainId)) return;
      const files = Object.values(bundle).map((o) => ({ file: o.fileName, text: o.type === "chunk" ? o.code : typeof o.source === "string" ? o.source : "" }));
      const hits = filesWithDevKeys(files);
      if (hits.length > 0) this.error(`the devnet dev-wallet mnemonic is in this chain ${chainId} build (${hits.join(", ")}): lib/devsigner must only load behind wallet/devGate.ts`);
    },
  };
}

// Server code is never bundled: the tRPC router is imported with `import type` only.
export default defineConfig(({ mode }) => ({
  plugins: [react(), tailwindcss(), noDevKeysOutsideDevnet(loadEnv(mode, fileURLToPath(new URL(".", import.meta.url)), "VITE_").VITE_CHAIN_ID)],
  server: { host: "127.0.0.1", port, strictPort: true },
  preview: { host: "127.0.0.1", port, strictPort: true },
  optimizeDeps: { include: ["@openzeppelin/merkle-tree"] },
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 1600,
  },
}));
