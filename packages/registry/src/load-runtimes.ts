import { readFileSync, readdirSync } from "node:fs";
import { RuntimeSpecSchema } from "@everdict/core";
import { SHARED_TENANT } from "./registry.js";
import { InMemoryRuntimeRegistry, type RuntimeRegistry } from "./runtime-registry.js";

// Load a directory's *.json Runtime definitions into the registry. Version-controlled files = SSOT (GitOps).
// Default owner is SHARED_TENANT (first-party shared runtime — every tenant sees it as a fallback). Pass `into` to register there instead (e.g. Pg seed).
export async function loadRuntimeDir(
  dir: string,
  opts: { into?: RuntimeRegistry; tenant?: string } = {},
): Promise<RuntimeRegistry> {
  const registry = opts.into ?? new InMemoryRuntimeRegistry();
  const tenant = opts.tenant ?? SHARED_TENANT;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const raw = JSON.parse(readFileSync(`${dir.replace(/\/$/, "")}/${file}`, "utf8"));
    await registry.register(tenant, RuntimeSpecSchema.parse(raw));
  }
  return registry;
}
