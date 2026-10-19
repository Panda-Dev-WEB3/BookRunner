// THE env-file rule shared by every reader of .env.testnet / .env.testnet-live / /etc/bookrunner/testnet-live.env
// (scripts/dev.ts, scripts/deploy-testnet.sh via `bun scripts/env-file.ts check`, and the root wrapper
// deploy/server/rehearsal-deploy.sh, whose awk mirror deploy/server/env-parse.sh is tested against this file):
//   - a line `KEY=VALUE` with KEY in [A-Z0-9_]+ (leading / trailing blanks around KEY and `=` allowed); `#` lines and
//     anything else are ignored;
//   - VALUE is the rest of the line, one leading and one trailing quote (" or ') stripped;
//   - a KEY defined MORE THAN ONCE refuses the whole file: readers that take the first line and readers that take the
//     last one (a shell `.`, systemd) must never see different values (a duplicated BKRN_TESTNET_LIVE_MNEMONIC let a
//     deploy check one mnemonic and broadcast with another).
//   bun scripts/env-file.ts check <file>     # exit 0 = parseable without duplicates, 1 = duplicates (named), 2 = unreadable
import { readFileSync } from "node:fs";

const LINE = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/;

export interface EnvFile {
  values: Record<string, string>;
  /** keys defined more than once (the file must be refused) */
  duplicates: string[];
}

export function parseEnvText(text: string): EnvFile {
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    if (line.trim().startsWith("#")) continue;
    const m = LINE.exec(line);
    if (!m) continue;
    const k = m[1] as string;
    if (seen.has(k)) dup.add(k);
    seen.add(k);
    values[k] = (m[2] as string).replace(/^["']|["']$/g, "");
  }
  return { values, duplicates: [...dup].sort() };
}

/** Parses a file and refuses duplicated keys (throws, naming them; never the values). */
export function readEnvFileStrict(path: string): Record<string, string> {
  const f = parseEnvText(readFileSync(path, "utf8"));
  if (f.duplicates.length) throw new Error(`${path} defines ${f.duplicates.join(", ")} more than once: keep exactly one line per key`);
  return f.values;
}

if (import.meta.main) {
  const [cmd, file] = process.argv.slice(2);
  if (cmd !== "check" || !file) {
    console.error("usage: bun scripts/env-file.ts check <file>");
    process.exit(2);
  }
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    console.error(`[env-file] ${file}: ${(err as Error).message}`);
    process.exit(2);
  }
  const f = parseEnvText(text);
  if (f.duplicates.length) {
    console.error(`[env-file] ${file} defines ${f.duplicates.join(", ")} more than once: keep exactly one line per key`);
    process.exit(1);
  }
}
