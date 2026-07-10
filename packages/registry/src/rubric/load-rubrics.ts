import { readFileSync, readdirSync } from "node:fs";
import { RubricSpecSchema } from "@everdict/contracts";
import { SHARED_TENANT } from "../registry.js";
import { InMemoryRubricRegistry, type RubricRegistry } from "./rubric-registry.js";

// Load a directory's *.json rubrics into the registry. Version-controlled files = SSOT (GitOps).
// Default owner is SHARED_TENANT (first-party default rubric — every tenant sees it via fallback). Pass into to register there (e.g. Pg seed).
export async function loadRubricDir(
  dir: string,
  opts: { into?: RubricRegistry; tenant?: string } = {},
): Promise<RubricRegistry> {
  const registry = opts.into ?? new InMemoryRubricRegistry();
  const tenant = opts.tenant ?? SHARED_TENANT;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const raw = JSON.parse(readFileSync(`${dir.replace(/\/$/, "")}/${file}`, "utf8"));
    await registry.register(tenant, RubricSpecSchema.parse(raw));
  }
  return registry;
}
