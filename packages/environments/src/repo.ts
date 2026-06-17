import {
  BadRequestError,
  type ComputeHandle,
  type EnvSpec,
  type Environment,
  type RepoSnapshot,
  shq,
} from "@assay/core";

const WORK = "work";
const GIT_ID = "git -c user.email=assay@local -c user.name=assay";

// repo/코딩 환경. seed=알려진 초기상태(원격 git 또는 인라인 파일), snapshot=HEAD 대비 diff.
export class RepoEnvironment implements Environment<RepoSnapshot> {
  readonly kind = "repo" as const;

  async seed(compute: ComputeHandle, spec: EnvSpec): Promise<void> {
    if (spec.kind !== "repo") throw new BadRequestError("BAD_REQUEST", { kind: spec.kind });
    const src = spec.source;
    if ("files" in src) {
      for (const [path, content] of Object.entries(src.files)) {
        await compute.writeFile(`${WORK}/${path}`, content);
      }
      // 인라인 시드는 베이스라인 커밋이 필요하다(diff 기준점).
      await compute.exec(`git init -q && git add -A && ${GIT_ID} commit -q -m seed --allow-empty`, { cwd: WORK });
    } else {
      await compute.exec(`git clone --depth 1 ${shq(src.git)} ${WORK}`);
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
