import type { Dispatcher } from "@assay/backends";
import type { AgentJob, CaseResult } from "@assay/core";
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
