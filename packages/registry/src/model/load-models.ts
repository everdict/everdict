import { readFileSync, readdirSync } from "node:fs";
import { ModelSpecSchema } from "@everdict/core";
import { SHARED_TENANT } from "../registry.js";
import { InMemoryModelRegistry, type ModelRegistry } from "./model-registry.js";

// Load a directory's *.json models into the registry. Version-controlled files = SSOT (GitOps).
// Default owner is SHARED_TENANT (first-party default model — every tenant sees it via fallback). Pass into to register there (e.g. Pg seed).
export async function loadModelDir(
  dir: string,
  opts: { into?: ModelRegistry; tenant?: string } = {},
): Promise<ModelRegistry> {
  const registry = opts.into ?? new InMemoryModelRegistry();
  const tenant = opts.tenant ?? SHARED_TENANT;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const raw = JSON.parse(readFileSync(`${dir.replace(/\/$/, "")}/${file}`, "utf8"));
    await registry.register(tenant, ModelSpecSchema.parse(raw));
  }
  return registry;
}
