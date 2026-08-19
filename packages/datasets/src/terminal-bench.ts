import {
  BadRequestError,
  type Dataset,
  DatasetSchema,
  type EvalCase,
  type NetworkPolicy,
  type ResourceRequest,
  isEmptyResourceRequest,
} from "@everdict/contracts";
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
  testCommand: z.string().default("bash /tests/test.sh"), // the tests/ verifier — its REWARD FILE is the verdict (v2)
  // The bytes of the task's tests/ directory, keyed by file name — copied into the container only AFTER the
  // agent finishes, so the dataset must carry them: a run that re-cloned the benchmark repo to find out how it
  // is graded would make the case non-self-contained and its verdict dependent on an unpinned repository state.
  tests: z.record(z.string()).default({}),
  verifierTimeoutSec: z.number().int().positive().optional(), // task.toml [verifier].timeout_sec
  verifierEnv: z.record(z.string()).default({}), // task.toml [verifier].env — values resolved by the caller
  // HOW THE VERDICT IS READ, stated rather than assumed. A v2 task's verifier PUBLISHES its reward to
  // /logs/verifier/reward.{txt,json} and then exits 0 either way, so reading such a run by its exit code marks
  // every case as passing (see reward-file.ts). A v1-era task set, whose `run-tests.sh` really did decide by
  // exit status, imports with `{ verdict: "exit-code", testCommand: "bash /tests/run-tests.sh" }`.
  verdict: z.enum(["reward-file", "exit-code"]).default("reward-file"),
  // ── THE WORLD task.toml [environment] DECLARES ──────────────────────────────────────────────────────
  // Carried into EvalCase.resources / EvalCase.network so the execution site can enforce it or refuse the
  // case (rule `drivers`). Dropping these is how an import silently changes what the benchmark measures —
  // an under-provisioned task reads as an agent that failed, and an offline task that ran online answered
  // a different question. Stated in the SOURCE's units (whole cores, and its own network vocabulary); the
  // conversion to Everdict's (millicores, `none`) happens once, here.
  cpus: z.number().int().positive().optional(), // [environment].cpus — whole cores
  memoryMb: z.number().int().positive().optional(), // [environment].memory_mb
  gpus: z.number().int().nonnegative().optional(), // [environment].gpus (0 = "no GPU", not a request)
  networkMode: z.enum(["public", "no-network", "allowlist"]).optional(), // [environment].network_mode
  allowedHosts: z.array(z.string().min(1)).default([]), // [environment].allowed_hosts (allowlist mode only)
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

// task.toml's world → Everdict's. `cpus` is whole cores and `EvalCase.resources.cpu` is millicores (the k8s
// convention the harness/topology specs already use), so the multiplication lives HERE rather than in every
// caller that fills a TerminalBenchTask. `gpus = 0` means "no GPU", not a request for zero of them.
function resourcesOf(task: { cpus?: number; memoryMb?: number; gpus?: number }): ResourceRequest | undefined {
  const resources: ResourceRequest = {
    ...(task.cpus !== undefined ? { cpu: task.cpus * 1000 } : {}),
    ...(task.memoryMb !== undefined ? { memoryMb: task.memoryMb } : {}),
    ...(task.gpus !== undefined && task.gpus > 0 ? { gpu: task.gpus } : {}),
  };
  return isEmptyResourceRequest(resources) ? undefined : resources;
}

// `public` is what every case got before this existed, so it is carried as ABSENT rather than as an explicit
// declaration — otherwise every imported task would look like it had made a deliberate network choice.
function networkOf(task: {
  networkMode?: "public" | "no-network" | "allowlist";
  allowedHosts: string[];
}): NetworkPolicy | undefined {
  if (task.networkMode === undefined || task.networkMode === "public") return undefined;
  return task.networkMode === "no-network"
    ? { mode: "none", allowedHosts: [] }
    : { mode: "allowlist", allowedHosts: task.allowedHosts };
}

// One Terminal-Bench task → an Everdict EvalCase. Container-based coding task: the prebuilt image IS the environment
// (a repo env with an in-image workdir, no clone), the instruction is the prompt, and the verifier is graded by the
// reward it publishes (`verdict`, above — v1-era task sets opt back into the exit-code reading).
export function terminalBenchTaskToCase(input: unknown, opts: { imageTemplate?: string } = {}): EvalCase {
  const task = TerminalBenchTaskSchema.parse(input);
  const image = resolveImage(task, opts.imageTemplate);
  const tags = [...(task.difficulty ? [task.difficulty] : []), ...task.tags];
  return {
    id: task.id,
    env: { kind: "repo", source: { path: task.workdir } },
    task: task.instruction,
    image,
    graders: [
      task.verdict === "exit-code"
        ? { id: "tests-pass", config: { cmd: task.testCommand } }
        : {
            id: "reward-file",
            config: {
              cmd: task.testCommand,
              cwd: task.workdir,
              ...(Object.keys(task.tests).length > 0 ? { files: task.tests } : {}),
              ...(task.verifierTimeoutSec ? { timeoutSec: task.verifierTimeoutSec } : {}),
              ...(Object.keys(task.verifierEnv).length > 0 ? { env: task.verifierEnv } : {}),
            },
          },
    ],
    timeoutSec: task.timeoutSec ?? 900,
    tags,
    ...(resourcesOf(task) ? { resources: resourcesOf(task) } : {}),
    ...(networkOf(task) ? { network: networkOf(task) } : {}),
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
