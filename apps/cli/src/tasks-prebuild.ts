import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { BadRequestError, UpstreamError } from "@everdict/contracts";
import { parseTerminalBenchTasks } from "@everdict/datasets";
import { type PushCredentials, fetchManagedPushGrant, fetchPushCredentials, pushImage } from "./image-push.js";
import { type TaskSetEntry, walkTaskSet } from "./task-set.js";

const pexecFile = promisify(execFile);

// ── everdict tasks prebuild (docs/architecture/standard-task-formats.md, slice 4) ─────────────────────
//
// A Terminal-Bench task set builds its images LOCALLY at run time; a managed run needs them prebuilt and
// pushed to a registry the runtime can pull. Everdict references images and never builds them — so this is
// an OPERATOR command at the edge, not a platform capability, and the platform still refuses a task whose
// image it cannot resolve.
//
// One pass over the set: build each task's Dockerfile, push it under one `{id}`-shaped template, and emit
// the task set as JSON for `POST /benchmarks/import` (source kind `terminal-bench`). The emitted document is
// the SAME shape the ingestion edge parses, so what was built and what will be imported cannot drift.

export interface TaskBuildIo {
  log: (message: string) => void;
  docker: (args: string[]) => Promise<void>;
}

const defaultDocker: TaskBuildIo["docker"] = async (args) => {
  try {
    await pexecFile("docker", args, { maxBuffer: 32 * 1024 * 1024 });
  } catch (err) {
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { args, detail: err instanceof Error ? err.message : String(err) },
      `docker ${args[0]} failed`,
    );
  }
};

// The local tag a task is built as, and the `{id}` template the import resolves each task's image from. Both
// come from one function so the pushed ref and the declared template cannot disagree — a template that names
// images nobody pushed is a task set that imports and then fails at dispatch, one case at a time.
export function localTagFor(prefix: string, id: string): string {
  return `${prefix}-${id}:latest`;
}
export function imageTemplateFrom(pushed: Map<string, string>, prefix: string): string | undefined {
  const refs = [...pushed.entries()];
  const first = refs[0];
  if (first === undefined) return undefined;
  const [id, ref] = first;
  // Substituting the BARE id would rewrite the first place those characters appear, which is usually the
  // registry account (`ghcr.io/acme/tb-a` → `ghcr.io/{id}cme/tb-a` for a task named "a"). The repository
  // segment this command builds is `${prefix}-${id}`, so that is what the template replaces — and only its
  // LAST occurrence, since the prefix may legitimately repeat in a namespace.
  const repository = `${prefix}-${id}`;
  const at = ref.lastIndexOf(repository);
  if (at < 0) return undefined;
  const template = `${ref.slice(0, at)}${prefix}-{id}${ref.slice(at + repository.length)}`;
  // …and it must hold for EVERY task, not just the one it was derived from. A registry that renames or
  // flattens repositories would make the template a claim about images that are not there.
  return refs.every(([taskId, taskRef]) => template.replace("{id}", taskId) === taskRef) ? template : undefined;
}

export async function buildTaskImages(
  entries: TaskSetEntry[],
  opts: { prefix: string; io?: TaskBuildIo },
): Promise<Map<string, string>> {
  const io = opts.io ?? { log: (m) => console.error(m), docker: defaultDocker };
  const built = new Map<string, string>();
  for (const entry of entries) {
    const id = String(entry.task.id);
    if (!entry.hasDockerfile)
      throw new BadRequestError(
        "BAD_REQUEST",
        { task: id, dir: entry.dir },
        `task '${id}' has no Dockerfile — there is nothing to prebuild, and a task set half of which has images is worse than one with none`,
      );
    const tag = localTagFor(opts.prefix, id);
    io.log(`▶ docker build ${entry.dir} → ${tag}`);
    await io.docker(["build", "-t", tag, entry.dir]);
    built.set(id, tag);
  }
  return built;
}

export async function tasksPrebuildCommand(dir: string | undefined, flags: Map<string, string>): Promise<void> {
  if (!dir)
    throw new BadRequestError(
      "BAD_REQUEST",
      undefined,
      "a task-set directory is required — everdict tasks prebuild <dir>",
    );
  const entries = await walkTaskSet(dir);
  console.error(`▶ ${entries.length} task(s) under ${dir}`);
  const prefix = flags.get("prefix") ?? "everdict-task";
  const built = await buildTaskImages(entries, { prefix });

  const out = flags.get("out");
  const pushed = new Map<string, string>();
  if (flags.has("push")) {
    const apiUrl = flags.get("api-url") ?? process.env.EVERDICT_API_URL ?? "http://localhost:8787";
    const apiKey = flags.get("api-key") ?? process.env.EVERDICT_API_KEY;
    if (!apiKey)
      throw new BadRequestError("BAD_REQUEST", undefined, "--api-key <ak_…> (or EVERDICT_API_KEY) is required to push");
    const registry = flags.get("registry");
    for (const [id, localRef] of built) {
      // One grant per repository, because that is the unit a registry scopes: the managed store mints a push
      // grant for the repository being written, and a BYO registry's credential covers its own prefix.
      const credentials: PushCredentials =
        (registry ? undefined : await fetchManagedPushGrant(apiUrl, apiKey, `${prefix}-${id}`)) ??
        (await fetchPushCredentials(apiUrl, apiKey, registry));
      pushed.set(id, await pushImage(credentials, localRef));
    }
  }

  // The task set, in the shape `POST /benchmarks/import` (source kind `terminal-bench`) parses. Each task
  // carries the ref that was actually pushed for it; when nothing was pushed the images stay unset and the
  // import resolves them from `--image-template`, which is the operator's claim rather than this command's.
  const tasks = entries.map((e) => {
    const id = String(e.task.id);
    const image = pushed.get(id);
    return image !== undefined ? { ...e.task, image } : e.task;
  });
  // Validated HERE, where it was produced, through the very parser the import door runs. An operator learns
  // their task set is malformed while they are standing in it, instead of at import time with a set of images
  // already pushed — and the two readings cannot drift, because there is only one.
  const document = JSON.stringify({ tasks }, null, 2);
  parseTerminalBenchTasks(document);
  if (out) {
    await writeFile(out, `${document}\n`, "utf8");
    console.error(`✓ ${tasks.length} task(s) written to ${out}`);
  } else console.log(document);

  if (pushed.size > 0) {
    const template = imageTemplateFrom(pushed, prefix);
    console.error(
      template
        ? `✓ pushed ${pushed.size} image(s) — imageTemplate: ${template}`
        : `✓ pushed ${pushed.size} image(s) — each task carries its own ref (no single {id} template describes them)`,
    );
  } else {
    console.error("↳ built locally only. Add --push (with --api-key) to publish them where a managed run can pull.");
  }
}
