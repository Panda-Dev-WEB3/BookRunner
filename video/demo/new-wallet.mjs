// Creates the demo wallet key once: video/.secrets/demo-wallet.json ({ privateKey, address }, mode 600, gitignored).
// Prints only the address (also when the file already exists). Run: bash scripts/video.sh demo new-wallet
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { loadDemoAccount } from "./wallet-node.mjs";

const VIDEO = process.env.DEMO_VIDEO_DIR ?? fileURLToPath(new URL("..", import.meta.url));
const DIR = join(VIDEO, ".secrets");
const FILE = join(DIR, "demo-wallet.json");

if (existsSync(FILE)) {
  // loadDemoAccount: generic error on an unreadable file (never the parse message, which could quote the key)
  console.log(`demo wallet exists: ${loadDemoAccount(FILE).address}`);
} else {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const privateKey = generatePrivateKey();
  const { address } = privateKeyToAccount(privateKey);
  // "wx": never overwrite a key that appeared meanwhile
  writeFileSync(FILE, `${JSON.stringify({ privateKey, address })}\n`, { flag: "wx", mode: 0o600 });
  chmodSync(FILE, 0o600);
  console.log(`demo wallet created: ${address}`);
}
