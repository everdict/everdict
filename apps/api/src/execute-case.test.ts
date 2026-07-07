import type { Dispatcher } from "@everdict/backends";
import type { AgentJob, CaseResult } from "@everdict/core";
import { describe, expect, it } from "vitest";
import { executeCase } from "./execute-case.js";

const JOB: AgentJob = {
  evalCase: {
    id: "c1",
    env: { kind: "repo", source: { files: {} } },
    task: "t",
    graders: [],
    timeoutSec: 60,
    tags: [],
  },
  harness: { id: "s", version: "0" },
  tenant: "acme",
};

function resultFor(job: AgentJob): CaseResult {
  return {
    caseId: job.evalCase.id,
    harness: "s@0",
    trace: [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: [],
  };
}

const capture = (): { dispatcher: Dispatcher; seen: () => AgentJob | undefined } => {
  let seen: AgentJob | undefined;
  return {
    dispatcher: {
      async dispatch(job) {
        seen = job;
        return resultFor(job);
      },
    },
    seen: () => seen,
  };
};

describe("executeCase — 순수 실행(토큰 resolve+attach → dispatch)", () => {
  it("비공개 repo(git+connectionId) 케이스면 owner 의 토큰을 resolve 해 잡에 attach 한 뒤 dispatch 한다", async () => {
    const cap = capture();
    const gitJob: AgentJob = {
      ...JOB,
      evalCase: {
        ...JOB.evalCase,
        env: { kind: "repo", source: { git: "https://x/r.git", ref: "main", connectionId: "conn1" } },
      },
    };
    await executeCase(
      {
        dispatcher: cap.dispatcher,
        repoTokenFor: async (owner, cid) => (owner === "alice" && cid === "conn1" ? "tok" : undefined),
      },
      "alice",
      gitJob,
    );
    expect(cap.seen()?.repoToken).toBe("tok");
  });

  it("워크스페이스 GitHub App 토큰을 개인 연결보다 먼저 시도해 잡에 attach 한다", async () => {
    const cap = capture();
    const gitJob: AgentJob = {
      ...JOB,
      tenant: "acme",
      evalCase: {
        ...JOB.evalCase,
        env: { kind: "repo", source: { git: "https://github.com/acme/api", ref: "main", connectionId: "conn1" } },
      },
    };
    await executeCase(
      {
        dispatcher: cap.dispatcher,
        installationTokenFor: async (ws, git) => (ws === "acme" && git.includes("acme/api") ? "app-tok" : undefined),
        repoTokenFor: async () => "personal-tok",
      },
      "alice",
      gitJob,
    );
    expect(cap.seen()?.repoToken).toBe("app-tok"); // App 우선
  });

  it("워크스페이스 App 매칭이 없으면 개인 연결(connectionId)로 폴백한다", async () => {
    const cap = capture();
    const gitJob: AgentJob = {
      ...JOB,
      tenant: "acme",
      evalCase: {
        ...JOB.evalCase,
        env: { kind: "repo", source: { git: "https://x/r.git", ref: "main", connectionId: "conn1" } },
      },
    };
    await executeCase(
      {
        dispatcher: cap.dispatcher,
        installationTokenFor: async () => undefined,
        repoTokenFor: async (owner, cid) => (owner === "alice" && cid === "conn1" ? "personal-tok" : undefined),
      },
      "alice",
      gitJob,
    );
    expect(cap.seen()?.repoToken).toBe("personal-tok");
  });

  it("public/비-repo 케이스는 토큰을 붙이지 않는다(repoTokenFor 있어도)", async () => {
    const cap = capture();
    await executeCase({ dispatcher: cap.dispatcher, repoTokenFor: async () => "tok" }, "alice", JOB);
    expect(cap.seen()?.repoToken).toBeUndefined();
  });

  it("결과를 그대로 돌려준다 — 정산/알림/오프로드는 하지 않는다(오케의 몫)", async () => {
    const cap = capture();
    const result = await executeCase({ dispatcher: cap.dispatcher }, "u", JOB);
    expect(result.caseId).toBe("c1");
    expect(cap.seen()?.evalCase.id).toBe("c1");
  });
});

describe("executeCase — 워크스페이스 레지스트리 pull 자격증명 attach(job.registryAuth)", () => {
  const AUTH = { host: "ghcr.io", username: "bot", password: "pull-tok" };

  it("케이스 이미지가 워크스페이스 레지스트리 것이면 registryAuth 를 attach 한다", async () => {
    const cap = capture();
    const job: AgentJob = { ...JOB, evalCase: { ...JOB.evalCase, image: "ghcr.io/acme/sbench:v1" } };
    await executeCase(
      { dispatcher: cap.dispatcher, registryAuthsFor: async (ws) => (ws === "acme" ? [AUTH] : []) },
      "u",
      job,
    );
    expect(cap.seen()?.registryAuth).toEqual(AUTH);
  });

  it("잡 이미지가 그 레지스트리 호스트가 아니면 자격증명을 붙이지 않는다(불필요 유출 방지)", async () => {
    const cap = capture();
    const job: AgentJob = { ...JOB, evalCase: { ...JOB.evalCase, image: "spreadsheetbench:v1" } };
    await executeCase({ dispatcher: cap.dispatcher, registryAuthsFor: async () => [AUTH] }, "u", job);
    expect(cap.seen()?.registryAuth).toBeUndefined();
  });

  it("service 하니스는 서비스 이미지(+per-dispatch 핀 override)로 판정한다", async () => {
    const cap = capture();
    const serviceSpec: NonNullable<AgentJob["harnessSpec"]> = {
      kind: "service",
      id: "bu",
      version: "1",
      services: [
        { name: "agent", image: "mendhak/http-https-echo:latest", needs: [], perRun: [], replicas: 1, env: {} },
      ],
      dependencies: [],
      frontDoor: { service: "agent", submit: "POST /runs" },
      traceSource: { kind: "mlflow", endpoint: "http://m:5000" },
    };
    // spec 이미지는 외부지만 핀이 워크스페이스 레지스트리로 override → attach.
    const job: AgentJob = { ...JOB, harnessSpec: serviceSpec, imagePins: { agent: "ghcr.io/acme/agent:pr-1" } };
    await executeCase({ dispatcher: cap.dispatcher, registryAuthsFor: async () => [AUTH] }, "u", job);
    expect(cap.seen()?.registryAuth).toEqual(AUTH);
  });
});

describe("executeCase — command 하니스 이미지 승격(evalCase.image ??= harnessSpec.image)", () => {
  const commandSpec = (image?: string): NonNullable<AgentJob["harnessSpec"]> => ({
    kind: "command",
    id: "codex-sheets",
    version: "1",
    ...(image ? { image } : {}),
    command: "codex exec {{task}}",
    setup: [],
    env: {},
    params: {},
    trace: { kind: "none" },
  });

  it("케이스가 이미지를 지정하지 않으면 command 하니스의 image(CI 재핀 대상)를 실행 컨테이너로 승격한다", async () => {
    const cap = capture();
    await executeCase({ dispatcher: cap.dispatcher }, "u", { ...JOB, harnessSpec: commandSpec("codex:v2") });
    expect(cap.seen()?.evalCase.image).toBe("codex:v2");
  });

  it("케이스가 이미지를 명시하면 하니스 이미지로 덮어쓰지 않는다(케이스 우선 — 데이터셋은 하니스-무관)", async () => {
    const cap = capture();
    const jobWithImage: AgentJob = {
      ...JOB,
      evalCase: { ...JOB.evalCase, image: "case:v9" },
      harnessSpec: commandSpec("codex:v2"),
    };
    await executeCase({ dispatcher: cap.dispatcher }, "u", jobWithImage);
    expect(cap.seen()?.evalCase.image).toBe("case:v9");
  });

  it("이미지 없는 하니스면 케이스 이미지는 승격 없이 그대로다(호스트-네이티브 유지)", async () => {
    const cap = capture();
    await executeCase({ dispatcher: cap.dispatcher }, "u", { ...JOB, harnessSpec: commandSpec() });
    expect(cap.seen()?.evalCase.image).toBeUndefined();
  });
});

// ── 잡 밖 트레이스 수집(D4) — traceRef 결과의 완성 단계 ──
// docs/architecture/streaming-case-pipeline.md

describe("executeCase — 잡 밖 트레이스 수집(traceRef 완성)", () => {
  const deferredResult = (job: AgentJob): CaseResult => ({
    caseId: job.evalCase.id,
    harness: "cmd@1",
    trace: [{ t: 0, kind: "error", message: "command exit 1: boom" }], // 잡이 남긴 실행 이벤트
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }], // ground-truth 는 잡에서
    traceRef: { kind: "otel", endpoint: "http://collector", runId: "rid-9" },
  });
  const dispatcherOf = (result: (job: AgentJob) => CaseResult): Dispatcher => ({
    async dispatch(job) {
      return result(job);
    },
  });
  // steps/cost 를 컨트롤플레인에서 재구성해 채점할 수 있도록 케이스에 관측물 grader 스펙을 단다.
  const jobWithGraders: AgentJob = {
    ...JOB,
    evalCase: { ...JOB.evalCase, graders: [{ id: "tests-pass", config: { cmd: "true" } }, { id: "steps" }] },
  };

  it("traceRef 가 있으면 플랫폼에서 pull 해 트레이스를 완성하고, 미뤄진 관측물 grader(steps)만 채점한다", async () => {
    let fetchedBy = "";
    const result = await executeCase(
      {
        dispatcher: dispatcherOf(deferredResult),
        buildTraceSource: (cfg) => ({
          async fetch(runId) {
            fetchedBy = `${cfg.kind}:${cfg.endpoint}:${runId}`;
            return [
              { t: 1, kind: "tool_call", id: "x", name: "bash", args: {} },
              { t: 2, kind: "llm_call", model: "m" },
            ];
          },
        }),
      },
      "u",
      jobWithGraders,
    );
    expect(fetchedBy).toBe("otel:http://collector:rid-9"); // traceRef 좌표+상관 키로 pull
    expect(result.trace).toHaveLength(3); // 잡 이벤트 1 + 플랫폼 2
    // needsCompute(tests-pass)는 잡에서 이미 채점 — 여기선 미뤄진 steps 만 덧붙는다(이중 채점 없음).
    expect(result.scores.map((s) => s.graderId)).toEqual(["tests-pass", "steps"]);
    const steps = result.scores.find((s) => s.graderId === "steps");
    expect(steps?.value).toBe(1); // tool_call 1건 — 수집된 트레이스 위에서 도출됐다는 증거
    expect(result.traceRef?.runId).toBe("rid-9"); // provenance 로 유지
  });

  it("pull 실패는 soft — error 이벤트로 가시화하고 실행 산출물(ground-truth 점수)은 보존한다", async () => {
    const result = await executeCase(
      {
        dispatcher: dispatcherOf(deferredResult),
        buildTraceSource: () => ({
          async fetch() {
            throw new Error("collector down");
          },
        }),
      },
      "u",
      jobWithGraders,
    );
    expect(result.trace.some((e) => e.kind === "error" && e.message.includes("collector down"))).toBe(true);
    expect(result.scores.some((s) => s.graderId === "tests-pass" && s.pass === true)).toBe(true); // 보존
  });

  it("authSecret 은 테넌트 SecretStore 에서 재해석해 Authorization 으로, correlate/experiment 는 소스 설정으로 흐른다", async () => {
    const authedRef = (job: AgentJob): CaseResult => ({
      ...deferredResult(job),
      traceRef: {
        kind: "mlflow",
        endpoint: "http://m",
        runId: "everdict-r1",
        authSecret: "MLFLOW_AUTH",
        correlate: "tag",
        experiment: "7",
      },
    });
    let seenCfg: { headers?: Record<string, string>; correlate?: string; project?: string } | undefined;
    const result = await executeCase(
      {
        dispatcher: dispatcherOf(authedRef),
        secretsFor: async (tenant): Promise<Record<string, string>> =>
          tenant === "acme" ? { MLFLOW_AUTH: "Basic abc" } : {},
        buildTraceSource: (cfg) => {
          seenCfg = cfg;
          return {
            async fetch() {
              return [{ t: 1, kind: "llm_call", model: "m" }];
            },
          };
        },
      },
      "u",
      jobWithGraders,
    );
    expect(seenCfg?.headers?.authorization).toBe("Basic abc"); // 이름 → 값 재해석(verbatim Authorization)
    expect(seenCfg?.correlate).toBe("tag");
    expect(seenCfg?.project).toBe("7"); // experiment → 소스의 검색 범위
    expect(result.trace.some((e) => e.kind === "llm_call")).toBe(true);
  });

  it("수집 0건이면 재시도(플러시 지연) 후 도착분을 싣고, 시크릿 미등록이면 soft 실패로 가시화한다", async () => {
    let fetches = 0;
    const slept: number[] = [];
    const retried = await executeCase(
      {
        dispatcher: dispatcherOf(deferredResult),
        sleep: async (ms) => void slept.push(ms),
        buildTraceSource: () => ({
          async fetch() {
            fetches += 1;
            return fetches < 3 ? [] : [{ t: 1, kind: "llm_call", model: "m" }];
          },
        }),
      },
      "u",
      jobWithGraders,
    );
    expect(fetches).toBe(3);
    expect(slept).toEqual([2000, 2000]);
    expect(retried.trace.some((e) => e.kind === "llm_call")).toBe(true);

    // authSecret 참조 + 시크릿 미등록 → 실행 산출물 보존 + error 이벤트(수집 불가 사유).
    const missing = await executeCase(
      {
        dispatcher: dispatcherOf((job) => ({
          ...deferredResult(job),
          traceRef: { kind: "otel", endpoint: "http://j", runId: "r", authSecret: "NOPE" },
        })),
        secretsFor: async () => ({}),
        buildTraceSource: () => ({
          async fetch() {
            throw new Error("호출되면 안 됨 — 인증 해석 실패가 먼저");
          },
        }),
      },
      "u",
      jobWithGraders,
    );
    expect(missing.trace.some((e) => e.kind === "error" && e.message.includes("NOPE"))).toBe(true);
    expect(missing.scores.some((s) => s.graderId === "tests-pass" && s.pass === true)).toBe(true);
  });

  it("traceRef 없는 결과(기본 job 수집)는 그대로 통과한다(무회귀) + buildTraceSource 미설정은 가시화", async () => {
    const plain = await executeCase({ dispatcher: dispatcherOf(resultFor) }, "u", jobWithGraders);
    expect(plain.trace).toEqual([]); // 손대지 않음
    const noSource = await executeCase({ dispatcher: dispatcherOf(deferredResult) }, "u", JOB);
    expect(noSource.trace.some((e) => e.kind === "error" && e.message.includes("buildTraceSource"))).toBe(true);
  });
});
