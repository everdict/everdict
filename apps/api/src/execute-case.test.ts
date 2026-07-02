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
