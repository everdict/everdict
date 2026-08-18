import { BadRequestError, type Dataset, DatasetSchema, type EvalCase } from "@everdict/contracts";
import { z } from "zod";

// Harbor (harborframework.com — the framework from the Terminal-Bench authors at the Laude Institute, and the
// official harness for Terminal-Bench 2.0) on-ramp: a container task → an Everdict EvalCase. A Harbor task is a
// directory — instruction.md (the request), task.toml ([metadata]/[agent]/[environment]/[verifier]), an
// environment/Dockerfile or a prebuilt [environment].docker_image, and a tests/ verifier. Same shape as
// Terminal-Bench 2.0 (a second dedicated mapper); parsing instruction.md/task.toml is the ingestion edge's job
// (this package stays dependency-free). docs/architecture/harbor-interop.md

// A Harbor task reduced to what Everdict needs to run + grade it. The caller fills this from instruction.md +
// task.toml (metadata difficulty/tags, [agent].timeout_sec, [verifier].timeout_sec/env) + the task's prebuilt
// image + the bytes of its tests/ directory.
export const HarborTaskSchema = z.object({
  id: z.string().min(1), // task id / directory name
  instruction: z.string().min(1), // instruction.md — the agent's request
  image: z.string().optional(), // prebuilt image built from environment/Dockerfile (referenced, not built). Else imageTemplate.
  verifierCommand: z.string().default("bash /tests/test.sh"), // the tests/ verifier — its REWARD FILE is the verdict
  // The bytes of the task's tests/ directory, keyed by file name. Harbor copies this directory into the
  // container AFTER the agent finishes (the agent must never see it), so the dataset has to carry it: a run
  // that re-cloned the benchmark repo to find out how it is graded would make the case non-self-contained and
  // its verdict dependent on a repository state nobody pinned.
  tests: z.record(z.string()).default({}),
  verifierTimeoutSec: z.number().int().positive().optional(), // task.toml [verifier].timeout_sec
  // task.toml [verifier].env — the values are the CALLER's to resolve (28% of the real corpus asks for an
  // OPENAI_API_KEY here because the verifier itself calls an LLM judge). A dataset never carries a secret.
  verifierEnv: z.record(z.string()).default({}),
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

// One Harbor task → an Everdict EvalCase. Container task: the prebuilt image IS the environment (a repo env with
// an in-image workdir, no clone), instruction.md is the prompt, and the tests/ verifier is graded by the reward
// it PUBLISHES — never by its exit code.
//
// The exit code was this mapper's first reading and it was wrong in the way that matters: a Harbor verifier
// writes its reward to /logs/verifier/reward.{txt,json} and then exits 0 whether the agent was right or wrong, so
// `tests-pass` scored every case in the corpus as passing. See harbor-verifier.ts and
// docs/architecture/harbor-interop.md §2.
export function harborTaskToCase(input: unknown, opts: { imageTemplate?: string } = {}): EvalCase {
  const task = HarborTaskSchema.parse(input);
  const image = resolveImage(task, opts.imageTemplate);
  const tags = [...(task.difficulty ? [task.difficulty] : []), ...task.tags];
  return {
    id: task.id,
    env: { kind: "repo", source: { path: task.workdir } },
    task: task.instruction,
    image,
    graders: [
      {
        id: "harbor-verifier",
        config: {
          cmd: task.verifierCommand,
          cwd: task.workdir,
          ...(Object.keys(task.tests).length > 0 ? { files: task.tests } : {}),
          ...(task.verifierTimeoutSec ? { timeoutSec: task.verifierTimeoutSec } : {}),
          ...(Object.keys(task.verifierEnv).length > 0 ? { env: task.verifierEnv } : {}),
        },
      },
    ],
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
    homepage: "https://harborframework.com/docs",
    code: "https://github.com/laude-institute/harbor",
    taskType: "container agent-eval tasks (Harbor / Laude Institute)",
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
