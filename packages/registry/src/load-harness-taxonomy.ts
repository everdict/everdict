import { readFileSync, readdirSync } from "node:fs";
import { HarnessInstanceSpecSchema, HarnessTemplateSpecSchema } from "@everdict/core";
import { type HarnessInstanceRegistry, InMemoryHarnessInstanceRegistry } from "./harness-instance-registry.js";
import { type HarnessTemplateRegistry, InMemoryHarnessTemplateRegistry } from "./harness-template-registry.js";
import { SHARED_TENANT } from "./registry.js";

// Load harness taxonomy files from a directory (file SSOT/GitOps). Distinguished by filename convention:
//   *.template.json  → HarnessTemplateSpec (category structure)
//   *.instance.json  → HarnessInstanceSpec (template reference + pins)
// Register all templates first, then instances (since instance registration validates the template via resolve).
// Default owner = SHARED_TENANT (first-party shared). Provide the target registries and it registers into them (e.g. Pg*) — Postgres seed.
export async function loadHarnessTaxonomyDir(
  dir: string,
  opts: { templates?: HarnessTemplateRegistry; instances?: HarnessInstanceRegistry; tenant?: string } = {},
): Promise<{ templates: HarnessTemplateRegistry; instances: HarnessInstanceRegistry }> {
  const templates = opts.templates ?? new InMemoryHarnessTemplateRegistry();
  const instances = opts.instances ?? new InMemoryHarnessInstanceRegistry(templates);
  const tenant = opts.tenant ?? SHARED_TENANT;
  const base = dir.replace(/\/$/, "");
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const read = (f: string) => JSON.parse(readFileSync(`${base}/${f}`, "utf8"));

  for (const file of files.filter((f) => f.endsWith(".template.json"))) {
    await templates.register(tenant, HarnessTemplateSpecSchema.parse(read(file)));
  }
  for (const file of files.filter((f) => f.endsWith(".instance.json"))) {
    await instances.register(tenant, HarnessInstanceSpecSchema.parse(read(file)));
  }
  return { templates, instances };
}
