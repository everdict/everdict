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

// 비공개 repo clone 인증 — 토큰을 argv 가 아니라 env(git 2.31+ GIT_CONFIG_*)로 http.extraheader 에 실어
// `ps`/로그/.git/config 노출을 피한다. 컨트롤플레인이 외부 계정 연결(Connected accounts)에서 resolve 한 토큰.
function gitAuthEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraheader",
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    GIT_TERMINAL_PROMPT: "0", // 자격증명 누락 시 프롬프트 대기 금지(즉시 실패)
  };
}

// repo/코딩 환경. seed=알려진 초기상태(원격 git 또는 인라인 파일), snapshot=HEAD 대비 diff.
// gitToken: 비공개 repo(env.source.connectionId)를 clone 하기 위한 transient 자격증명(컨트롤플레인이 잡에 주입).
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
      // 이미지-내 repo(예: SWE-bench /testbed): clone 하지 않고 작업 디렉터리(work)를 그 repo 로 심볼릭링크 →
      // 하니스/그레이더의 기본 cwd("work")가 그대로 그 repo 를 가리킨다(스레딩 불필요). 코딩 에이전트가 직접 작업.
      await compute.exec(`rm -rf ${WORK} && ln -sfn ${shq(src.path)} ${WORK}`);
    } else if ("files" in src) {
      // 빈 files({})여도 work 디렉터리는 있어야 한다(코딩 에이전트의 작업 디렉터리).
      await compute.exec(`mkdir -p ${WORK}`);
      for (const [path, content] of Object.entries(src.files)) {
        await compute.writeFile(`${WORK}/${path}`, content);
      }
      // 인라인 시드는 베이스라인 커밋이 필요하다(diff 기준점).
      await compute.exec(`git init -q && git add -A && ${GIT_ID} commit -q -m seed --allow-empty`, { cwd: WORK });
    } else {
      // 원격 git. 비공개면 gitToken(외부 계정 연결에서 resolve)으로 인증 — http.extraheader 는 clone/fetch 에만 필요.
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
