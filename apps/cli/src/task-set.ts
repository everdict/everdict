import { readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { BadRequestError } from "@everdict/contracts";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";

// ── WALKING A TERMINAL-BENCH TASK SET (docs/architecture/standard-task-formats.md, slices 2+4) ────────
//
// This is the edge the pure package deliberately does not have: a filesystem, a YAML parser and a TOML
// parser. `@everdict/datasets` takes the PARSED result (`parseTerminalBenchTasks`), so the format-specific
// reading happens exactly once, here, where an operator runs it.
//
// What it reads, per task directory:
//   task.yaml    instruction · difficulty · tags · max_agent_timeout_sec        (the task)
//   task.toml    [verifier] timeout_sec/env · [environment] cpus/memory/gpus/network   (the WORLD)
//   tests/       every file, verbatim — the verifier's bytes travel WITH the case (verifier-private)
//   Dockerfile   only its presence matters here; `everdict tasks prebuild` is what builds it
//
// The `[environment]` block is read rather than dropped ON PURPOSE (rule `datasets`): an under-provisioned
// task reads as an agent that failed, and an offline task that ran online answered a different question. A
// set whose declarations this cannot read is REFUSED — importing it as a task with no world would be the
// silent version of the same corruption.

export interface TaskSetEntry {
  dir: string;
  task: Record<string, unknown>; // a TerminalBenchTask document, validated by @everdict/datasets on import
  hasDockerfile: boolean;
}

// A directory is a task when it holds a task.yaml. Anything else in the tree is ignored, so a repository
// root with README/scripts/LICENSE beside the tasks walks cleanly.
export async function walkTaskSet(root: string): Promise<TaskSetEntry[]> {
  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (err) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { root, detail: err instanceof Error ? err.message : String(err) },
      `cannot read the task set directory '${root}'`,
    );
  }
  const out: TaskSetEntry[] = [];
  for (const name of entries.sort()) {
    const dir = join(root, name);
    const yamlPath = join(dir, "task.yaml");
    if (!(await exists(yamlPath))) continue;
    out.push({
      dir,
      task: await readTask(dir, name),
      hasDockerfile: await exists(join(dir, "Dockerfile")),
    });
  }
  if (out.length === 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      { root },
      `no task.yaml under any subdirectory of '${root}' — this is not a Terminal-Bench task set`,
    );
  return out;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readTask(dir: string, id: string): Promise<Record<string, unknown>> {
  const yaml = await readDocument(join(dir, "task.yaml"), (text) => parseYaml(text) as unknown);
  const instruction = str(yaml.instruction);
  if (instruction === undefined)
    throw new BadRequestError("BAD_REQUEST", { dir }, `task '${id}' declares no instruction in task.yaml`);
  const tomlPath = join(dir, "task.toml");
  const toml = (await exists(tomlPath)) ? await readDocument(tomlPath, (text) => parseToml(text) as unknown) : {};
  const verifier = record(toml.verifier);
  const environment = record(toml.environment);
  const tests = await readTests(join(dir, "tests"));
  return {
    id,
    instruction,
    ...(str(yaml.difficulty) !== undefined ? { difficulty: str(yaml.difficulty) } : {}),
    ...(strList(yaml.tags).length > 0 ? { tags: strList(yaml.tags) } : {}),
    ...(num(yaml.max_agent_timeout_sec) !== undefined ? { timeoutSec: num(yaml.max_agent_timeout_sec) } : {}),
    ...(Object.keys(tests).length > 0 ? { tests } : {}),
    // [verifier] — how the reward is produced. Its `env` values are the SOURCE's; the importer resolves them.
    ...(num(verifier.timeout_sec) !== undefined ? { verifierTimeoutSec: num(verifier.timeout_sec) } : {}),
    ...(Object.keys(strMap(verifier.env)).length > 0 ? { verifierEnv: strMap(verifier.env) } : {}),
    // [environment] — the world, in the source's own units. Everdict's conversion happens in the mapper.
    ...(num(environment.cpus) !== undefined ? { cpus: num(environment.cpus) } : {}),
    ...(num(environment.memory_mb) !== undefined ? { memoryMb: num(environment.memory_mb) } : {}),
    ...(num(environment.gpus) !== undefined ? { gpus: num(environment.gpus) } : {}),
    ...(str(environment.network_mode) !== undefined ? { networkMode: str(environment.network_mode) } : {}),
    ...(strList(environment.allowed_hosts).length > 0 ? { allowedHosts: strList(environment.allowed_hosts) } : {}),
  };
}

// Every file under tests/, verbatim and keyed by its name — the bytes are what makes a case self-contained
// (a run that re-cloned the benchmark to find out how it is graded would depend on an unpinned repository).
async function readTests(dir: string): Promise<Record<string, string>> {
  if (!(await exists(dir))) return {};
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue; // a nested test tree is refused below rather than silently flattened
    out[entry.name] = await readFile(join(dir, entry.name), "utf8");
  }
  const nested = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory());
  if (nested.length > 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      { dir, subdirectories: nested.map((e) => e.name) },
      `tests/ in '${basename(dir)}' has subdirectories, and a case carries its verifier as a flat file map — flatten them or the verdict would run against files the case never carried`,
    );
  return out;
}

async function readDocument(path: string, parse: (text: string) => unknown): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = parse(await readFile(path, "utf8"));
  } catch (err) {
    throw new BadRequestError(
      "BAD_REQUEST",
      { path, detail: err instanceof Error ? err.message : String(err) },
      `cannot parse '${path}'`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    throw new BadRequestError("BAD_REQUEST", { path }, `'${path}' is not a mapping`);
  return parsed as Record<string, unknown>;
}

const record = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const strMap = (v: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(record(v)).filter(([, x]) => typeof x === "string")) as Record<string, string>;
