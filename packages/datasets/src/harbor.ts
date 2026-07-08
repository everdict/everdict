import { BadRequestError, type Dataset, DatasetSchema, type EvalCase } from "@everdict/core";
import { z } from "zod";

// Harbor (Anthropic's agent-eval harness) on-ramp: a container task → an Everdict EvalCase. A Harbor task is a
// directory — instruction.md (the request), task.toml ([metadata]/[agent]/[environment]/[verifier]), an
// environment/Dockerfile, and a tests/ verifier. Same shape as Terminal-Bench (a second dedicated mapper); parsing
// instruction.md/task.toml is the ingestion edge's job (this package stays dependency-free).
// docs/architecture/standard-task-formats.md

// A Harbor task reduced to what Everdict needs to run + grade it. The caller fills this from instruction.md +
// task.toml (metadata difficulty/tags, [agent].timeout_sec) + the task's prebuilt image + the tests/ verifier command.
export const HarborTaskSchema = z.object({
  id: z.string().min(1), // task id / directory name
  instruction: z.string().min(1), // instruction.md — the agent's request
  image: z.string().optional(), // prebuilt image built from environment/Dockerfile (referenced, not built). Else imageTemplate.
  verifierCommand: z.string().default("bash /tests/verify.sh"), // the tests/ verifier → tests-pass grader (exit code)
  workdir: z.string().default("/app"), // in-image working directory (repo env source.path — no clone)
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  tags: z.array(z.string()).default([]),
  timeoutSec: z.number().int().positive().optional(), // task.toml [agent].timeout_sec
});
export type HarborTask = z.infer<typeof HarborTaskSchema>;

// Resolve a task's image: the per-task image wins, else the dataset imageTemplate with `{id}` interpolated. An
// unresolved image throws — Everdict references images, it never builds them (case.image is the portability contract).
function resolveImage(task: HarborTask, imageTemplate?: string): string {
  const image = task.image ?? (imageTemplate ? imageTemplate.replace(/\{id\}/g, task.id) : undefined);
  if (!image)
    throw new BadRequestError(
      "BAD_REQUEST",
      { task: task.id },
      "A Harbor task needs a prebuilt image (task.image or an imageTemplate) — Everdict references images, it does not build them.",
    );
  return image;
}

// One Harbor task → an Everdict EvalCase. Container task: the prebuilt image IS the environment (a repo env with an
// in-image workdir, no clone), instruction.md is the prompt, and the tests/ verifier is a tests-pass grader.
export function harborTaskToCase(input: unknown, opts: { imageTemplate?: string } = {}): EvalCase {
  const task = HarborTaskSchema.parse(input);
  const image = resolveImage(task, opts.imageTemplate);
  const tags = [...(task.difficulty ? [task.difficulty] : []), ...task.tags];
  return {
    id: task.id,
    env: { kind: "repo", source: { path: task.workdir } },
    task: task.instruction,
    image,
    graders: [{ id: "tests-pass", config: { cmd: task.verifierCommand } }],
    timeoutSec: task.timeoutSec ?? 900,
    tags,
  };
}

export interface HarborMeta {
  id: string;
  version: string;
  description?: string;
  tags?: string[];
}

// Harbor provenance — lets the dataset detail show "where this came from" (lineage), like the recipe/catalog paths.
const HARBOR_PROVENANCE = {
  via: "spec",
  id: "harbor",
  origin: {
    homepage: "https://harbor-framework-harbor.mintlify.app/introduction",
    taskType: "container agent-eval tasks (Anthropic Harbor)",
  },
} as const;

// A set of Harbor tasks → a validated Everdict Dataset (DatasetSchema.parse applies EvalCase validation/defaults).
export function harborToDataset(tasks: unknown[], meta: HarborMeta, opts: { imageTemplate?: string } = {}): Dataset {
  return DatasetSchema.parse({
    id: meta.id,
    version: meta.version,
    ...(meta.description ? { description: meta.description } : {}),
    cases: tasks.map((t) => harborTaskToCase(t, opts)),
    tags: meta.tags ?? [],
    producedBy: HARBOR_PROVENANCE,
  });
}
