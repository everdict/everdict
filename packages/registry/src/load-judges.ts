import { readFileSync, readdirSync } from "node:fs";
import { JudgeSpecSchema } from "@everdict/core";
import { InMemoryJudgeRegistry, type JudgeRegistry } from "./judge-registry.js";
import { SHARED_TENANT } from "./registry.js";

// Load a directory's *.json judges into the registry. Version-controlled files = SSOT (GitOps).
// Default owner is SHARED_TENANT (first-party default judge — every tenant sees it via fallback). Pass into to register there (e.g. Pg seed).
export async function loadJudgeDir(
  dir: string,
  opts: { into?: JudgeRegistry; tenant?: string } = {},
): Promise<JudgeRegistry> {
  const registry = opts.into ?? new InMemoryJudgeRegistry();
  const tenant = opts.tenant ?? SHARED_TENANT;
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const file of files) {
    const raw = JSON.parse(readFileSync(`${dir.replace(/\/$/, "")}/${file}`, "utf8"));
    await registry.register(tenant, JudgeSpecSchema.parse(raw));
  }
  return registry;
}
