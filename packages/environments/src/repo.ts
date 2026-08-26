import {
  BadRequestError,
  type ComputeHandle,
  type EnvSpec,
  type Environment,
  GIT_MACHINE_IDENTITY,
  type RepoSnapshot,
  UpstreamError,
  gitAuthEnv,
  shq,
} from "@everdict/contracts";

const WORK = "work";
const GIT_ID = `git -c user.email=${GIT_MACHINE_IDENTITY.email} -c user.name=${GIT_MACHINE_IDENTITY.name}`;

// repo/coding environment. seed = a known initial state (remote git or inline files), snapshot = diff vs HEAD.
// gitToken: transient credential to clone a private repo (env.source.connectionId), injected into the job by the control plane.
export class RepoEnvironment implements Environment<RepoSnapshot> {
  readonly kind = "repo" as const;
  private readonly gitToken?: string;
  constructor(opts: { gitToken?: string } = {}) {
    if (opts.gitToken !== undefined) this.gitToken = opts.gitToken;
  }

  async seed(compute: ComputeHandle, spec: EnvSpec): Promise<void> {
    if (spec.kind !== "repo") throw new BadRequestError("BAD_REQUEST", { kind: spec.kind });
    const src = spec.source;
    if ("path" in src) {
      // in-image repo (e.g. SWE-bench /testbed): don't clone; symlink the working directory (work) to that repo →
      // the harness/grader's default cwd ("work") points at that repo directly (no threading needed). The coding agent works on it directly.
      await compute.exec(`rm -rf ${WORK} && ln -sfn ${shq(src.path)} ${WORK}`);
    } else if ("files" in src) {
      // even with empty files ({}), the work directory must exist (the coding agent's working directory).
      await compute.exec(`mkdir -p ${WORK}`);
      for (const [path, content] of Object.entries(src.files)) {
        await compute.writeFile(`${WORK}/${path}`, content);
      }
      // an inline seed needs a baseline commit (the diff reference point).
      await compute.exec(`git init -q && git add -A && ${GIT_ID} commit -q -m seed --allow-empty`, { cwd: WORK });
    } else {
      // remote git. If private, authenticate with gitToken (resolved from Connected accounts) — http.extraheader is only needed for clone/fetch.
      const auth = this.gitToken ? { env: gitAuthEnv(this.gitToken) } : {};
      await compute.exec(`git clone --depth 1 ${shq(src.git)} ${WORK}`, auth);
      await compute.exec(`git checkout ${shq(src.ref)}`, { cwd: WORK });
    }
    for (const cmd of spec.setup ?? []) await compute.exec(cmd, { cwd: WORK });
  }

  async snapshot(compute: ComputeHandle): Promise<RepoSnapshot> {
    await compute.exec("git add -A", { cwd: WORK });
    const diff = (await compute.exec("git diff --cached HEAD", { cwd: WORK })).stdout;
    const changed = (await compute.exec("git diff --cached --name-only HEAD", { cwd: WORK })).stdout.trim();
    const headSha = (await compute.exec("git rev-parse HEAD", { cwd: WORK })).stdout.trim();
    return { kind: "repo", diff, changedFiles: changed ? changed.split("\n") : [], headSha };
  }

  // In-run recorder sample (docs/architecture/replay.md, Principle 1) — the working-tree-vs-HEAD diff mid-run, WITHOUT
  // touching the agent's own index/staging: stage everything into a throwaway index under .git (GIT_INDEX_FILE, git
  // never scans .git so it self-excludes) and diff THAT vs HEAD, then delete it. Includes untracked files. run-case
  // polls this into CaseResult.envDeltas so a coding harness replays how the repo evolved. Empty diff → undefined.
  // `undefined` = sampled and nothing changed. A sample that could not be taken THROWS: the old swallow
  // (catch → undefined, and a shell line that sent git's own failures to /dev/null) made a broken sampler
  // indistinguishable from a calm world, so every delta the run "didn't have" read as evidence of nothing
  // happening (evolution-lineage Track C). The recorder owns best-effort — it counts the failure and the
  // channel reports `sampling_failed` instead of silently fewer deltas.
  async sampleDelta(compute: ComputeHandle): Promise<{ kind: "repo-diff"; text: string } | undefined> {
    const idx = ".git/everdict-rec.index";
    const cmd = `rm -f ${idx}; GIT_INDEX_FILE=${idx} git add -A >/dev/null 2>&1 && GIT_INDEX_FILE=${idx} git diff --cached HEAD; s=$?; rm -f ${idx}; exit $s`;
    const res = await compute.exec(cmd, { cwd: WORK });
    if (res.exitCode !== 0)
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { exitCode: res.exitCode },
        `environment sample failed: ${res.stderr.slice(0, 500) || "git diff exited non-zero"}`,
      );
    return res.stdout.trim() ? { kind: "repo-diff", text: res.stdout } : undefined;
  }
}
