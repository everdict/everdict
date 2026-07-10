import {
  type HarnessInstanceRegistry,
  type HarnessTemplateRegistry,
  type JudgeRegistry,
  type ModelRegistry,
  type RubricRegistry,
  loadHarnessTaxonomyDir,
  loadJudgeDir,
  loadModelDir,
  loadRubricDir,
} from "@everdict/registry";

// Seed the _shared harness taxonomy (template categories + instances) from the file SSOT. EVERDICT_HARNESS_TEMPLATES_DIR
// (else cwd/examples/harness-templates). *.template.json → template, *.instance.json → instance. Best-effort/idempotent.
export async function seedSharedHarnessTaxonomy(
  templates: HarnessTemplateRegistry,
  instances: HarnessInstanceRegistry,
): Promise<void> {
  const dir = process.env.EVERDICT_HARNESS_TEMPLATES_DIR ?? `${process.cwd()}/examples/harness-templates`;
  try {
    await loadHarnessTaxonomyDir(dir, { templates, instances });
    console.error(`▶ shared harness taxonomy seeded from ${dir}`);
  } catch {
    // A missing/empty directory is normal.
  }
}

// Seed _shared (first-party default judges) from the file SSOT — a new tenant can use the default judges immediately. Best-effort/idempotent.
export async function seedSharedJudges(registry: JudgeRegistry): Promise<void> {
  const dir = process.env.EVERDICT_JUDGES_DIR ?? `${process.cwd()}/examples/judges`;
  try {
    await loadJudgeDir(dir, { into: registry });
    console.error(`▶ shared judges seeded from ${dir}`);
  } catch {
    // A missing/empty directory is normal (boot with no seed).
  }
}

// Seed _shared (first-party default rubrics) from the file SSOT — a new tenant can reference the default rubrics from a judge immediately. Best-effort/idempotent.
export async function seedSharedRubrics(registry: RubricRegistry): Promise<void> {
  const dir = process.env.EVERDICT_RUBRICS_DIR ?? `${process.cwd()}/examples/rubrics`;
  try {
    await loadRubricDir(dir, { into: registry });
    console.error(`▶ shared rubrics seeded from ${dir}`);
  } catch {
    // A missing/empty directory is normal (boot with no seed).
  }
}

// Seed _shared (first-party default models) from the file SSOT — a new tenant can reference the registered models from a judge/harness immediately. Best-effort/idempotent.
export async function seedSharedModels(registry: ModelRegistry): Promise<void> {
  const dir = process.env.EVERDICT_MODELS_DIR ?? `${process.cwd()}/examples/models`;
  try {
    await loadModelDir(dir, { into: registry });
    console.error(`▶ shared models seeded from ${dir}`);
  } catch {
    // A missing/empty directory is normal (boot with no seed).
  }
}
