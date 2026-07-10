import {
  BadRequestError,
  type ComputeHandle,
  type EnvSpec,
  type Environment,
  type RepoSnapshot,
  shq,
} from "@everdict/contracts";

const WORK = "work";
const GIT_ID = "git -c user.email=everdict@local -c user.name=everdict";

// Private-repo clone auth — put the token into http.extraheader via env (git 2.31+ GIT_CONFIG_*), not argv, to
// avoid exposure in `ps`/logs/.git/config. A token the control plane resolved from Connected accounts.
function gitAuthEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    GIT_TERMINAL_PROMPT: "0", // don't wait at a prompt on missing credentials (fail immediately)
  };
}

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
}
