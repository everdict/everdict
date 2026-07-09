import { readFileSync, readdirSync } from "node:fs";
import { DatasetSchema } from "@everdict/core";
import { SHARED_TENANT } from "../registry.js";
import { type DatasetRegistry, InMemoryDatasetRegistry } from "./dataset-registry.js";

// Load a directory's *.json datasets into the registry. Version-controlled files = SSOT (GitOps).
// Default owner is SHARED_TENANT (first-party benchmarks — every tenant sees them as a fallback). Pass `into` to register there instead (e.g. Pg seed).
export async function loadDatasetDir(
  dir: string,
  opts: { into?: DatasetRegistry; tenant?: string } = {},
): Promise<DatasetRegistry> {
  const registry = opts.into ?? new InMemoryDatasetRegistry();
  const tenant = opts.tenant ?? SHARED_TENANT;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const raw = JSON.parse(readFileSync(`${dir.replace(/\/$/, "")}/${file}`, "utf8"));
    await registry.register(tenant, DatasetSchema.parse(raw));
  }
  return registry;
}
