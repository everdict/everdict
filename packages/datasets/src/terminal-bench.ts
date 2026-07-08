import { BadRequestError, type Dataset, DatasetSchema, type EvalCase } from "@everdict/core";
import { z } from "zod";

// Terminal-Bench (github.com/laude-institute/terminal-bench) on-ramp: a directory-based agent task → an Everdict
// EvalCase. Unlike the row-based CaseMapping (mapping.ts), a Terminal-Bench task is richer (per-task image, working
// dir, test command, difficulty), so it gets a dedicated pure mapper — one level up from importWebVoyager. Parsing the
// task.yaml/git files is a boundary concern kept OUT of this dependency-free package (done at the ingestion edge).
// docs/architecture/standard-task-formats.md

// A Terminal-Bench task reduced to what Everdict needs to run + grade it. The caller fills this from task.yaml
// (instruction/difficulty/tags/timeout), the task's prebuilt image, and its test-run convention.
export const TerminalBenchTaskSchema = z.object({
  id: z.string().min(1), // task id / directory name
  instruction: z.string().min(1), // task.yaml `instruction` — the agent's prompt
  image: z.string().optional(), // prebuilt task image (referenced, not built). Falls back to the dataset imageTemplate.
  testCommand: z.string().default("bash /tests/run-tests.sh"), // grades the task by exit code (tests-pass)
  workdir: z.string().default("/app"), // in-image working directory (repo env source.path — no clone)
  difficulty: z.enum(["easy", "medium", "hard"]).optional(),
  tags: z.array(z.string()).default([]),
  timeoutSec: z.number().int().positive().optional(), // task.yaml max_agent_timeout_sec
});
export type TerminalBenchTask = z.infer<typeof TerminalBenchTaskSchema>;

// Resolve a task's image: the per-task image wins, else the dataset-level imageTemplate with `{id}` interpolated.
// An unresolved image throws — Everdict references images, it never builds them (case.image is the portability contract).
function resolveImage(task: TerminalBenchTask, imageTemplate?: string): string {
  const image = task.image ?? (imageTemplate ? imageTemplate.replace(/\{id\}/g, task.id) : undefined);
  if (!image)
    throw new BadRequestError(
      "BAD_REQUEST",
      { task: task.id },
      "A Terminal-Bench task needs a prebuilt image (task.image or an imageTemplate) — Everdict references images, it does not build them.",
    );
  return image;
}

// One Terminal-Bench task → an Everdict EvalCase. Container-based coding task: the prebuilt image IS the environment
// (a repo env with an in-image workdir, no clone), the instruction is the prompt, the test command is a tests-pass grader.
export function terminalBenchTaskToCase(input: unknown, opts: { imageTemplate?: string } = {}): EvalCase {
  const task = TerminalBenchTaskSchema.parse(input);
  const image = resolveImage(task, opts.imageTemplate);
  const tags = [...(task.difficulty ? [task.difficulty] : []), ...task.tags];
  return {
    id: task.id,
    env: { kind: "repo", source: { path: task.workdir } },
    task: task.instruction,
    image,
    graders: [{ id: "tests-pass", config: { cmd: task.testCommand } }],
    timeoutSec: task.timeoutSec ?? 900,
    tags,
  };
}

export interface TerminalBenchMeta {
  id: string;
  version: string;
  description?: string;
  tags?: string[];
}

// Terminal-Bench provenance — lets the dataset detail show "where this came from" (lineage), like the recipe/catalog paths.
const TERMINAL_BENCH_PROVENANCE = {
  via: "spec",
  id: "terminal-bench",
  origin: {
    homepage: "https://www.tbench.ai/",
    code: "https://github.com/laude-institute/terminal-bench",
    taskType: "terminal/coding agent tasks",
  },
} as const;

// A set of Terminal-Bench tasks → a validated Everdict Dataset (DatasetSchema.parse applies EvalCase validation/defaults).
// Stamps producedBy so the dataset records it was ingested from Terminal-Bench (lineage, same as recipe/catalog imports).
export function terminalBenchToDataset(
  tasks: unknown[],
  meta: TerminalBenchMeta,
  opts: { imageTemplate?: string } = {},
): Dataset {
  return DatasetSchema.parse({
    id: meta.id,
    version: meta.version,
    ...(meta.description ? { description: meta.description } : {}),
    cases: tasks.map((t) => terminalBenchTaskToCase(t, opts)),
    tags: meta.tags ?? [],
    producedBy: TERMINAL_BENCH_PROVENANCE,
  });
}
