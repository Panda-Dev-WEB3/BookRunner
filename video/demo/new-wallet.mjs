// Creates the demo wallet key once: video/.secrets/demo-wallet.json ({ privateKey, address }, mode 600, gitignored).
// Prints only the address (also when the file already exists). Run: bash scripts/video.sh demo new-wallet
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const VIDEO = process.env.DEMO_VIDEO_DIR ?? fileURLToPath(new URL("..", import.meta.url));
const DIR = join(VIDEO, ".secrets");
const FILE = join(DIR, "demo-wallet.json");

if (existsSync(FILE)) {
  const { address } = JSON.parse(readFileSync(FILE, "utf8"));
  console.log(`demo wallet exists: ${address}`);
} else {
  mkdirSync(DIR, { recursive: true, mode: 0o700 });
  const privateKey = generatePrivateKey();
  const { address } = privateKeyToAccount(privateKey);
  // "wx": never overwrite a key that appeared meanwhile
  writeFileSync(FILE, `${JSON.stringify({ privateKey, address })}\n`, { flag: "wx", mode: 0o600 });
  chmodSync(FILE, 0o600);
  console.log(`demo wallet created: ${address}`);
}
