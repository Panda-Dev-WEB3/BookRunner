import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Deployment } from "./types";

/** Repo root = two levels above packages/shared/src. */
export const REPO_ROOT = resolve(import.meta.dir, "../../..");

export function deploymentPath(file = process.env.DEPLOYMENT_FILE ?? "contracts/deployments/31337.json"): string {
  return isAbsolute(file) ? file : resolve(REPO_ROOT, file);
}

export function loadDeployment(file?: string): Deployment {
  const p = deploymentPath(file);
  if (!existsSync(p)) throw new Error(`deployment file not found: ${p} — run \`bun run deploy:local\` first`);
  return JSON.parse(readFileSync(p, "utf8")) as Deployment;
}

export function tryLoadDeployment(file?: string): Deployment | null {
  try {
    return loadDeployment(file);
  } catch {
    return null;
  }
}
