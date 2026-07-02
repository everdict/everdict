import { type Dispatcher, inMemoryBudget } from "@assay/backends";
import type { AgentJob, CaseResult } from "@assay/core";
import { describe, expect, it, vi } from "vitest";
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

function resultFor(job: AgentJob, opts: { usd?: number; selfHosted?: boolean } = {}): CaseResult {
  const usd = opts.usd ?? 0;
  return {
    caseId: job.evalCase.id,
    harness: "s@0",
    trace: usd ? [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd } }] : [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: [],
    ...(opts.selfHosted ? { provenance: { ranOn: "self-hosted", runner: "laptop", by: "u" } } : {}),
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

describe("executeCase (run/scorecard 공유 per-case 실행 수명)", () => {
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
      "acme",
      "alice",
      gitJob,
    );
    expect(cap.seen()?.repoToken).toBe("tok");
  });

  it("public/비-repo 케이스는 토큰을 붙이지 않는다(repoTokenFor 있어도)", async () => {
    const cap = capture();
    await executeCase({ dispatcher: cap.dispatcher, repoTokenFor: async () => "tok" }, "acme", "alice", JOB);
    expect(cap.seen()?.repoToken).toBeUndefined();
  });

  it("셀프호스티드 결과는 워크스페이스 버짓을 settle 하지 않고, 관리형 결과는 settle 한다", async () => {
    const budget = inMemoryBudget({ limitFor: () => ({}) });
    const settle = vi.spyOn(budget, "settle");
    const selfHosted: Dispatcher = {
      async dispatch(job) {
        return resultFor(job, { usd: 5, selfHosted: true });
      },
    };
    await executeCase({ dispatcher: selfHosted, budget }, "acme", "u", JOB);
    expect(settle).not.toHaveBeenCalled();

    const managed: Dispatcher = {
      async dispatch(job) {
        return resultFor(job, { usd: 5 });
      },
    };
    await executeCase({ dispatcher: managed, budget }, "acme", "u", JOB);
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it("admit 은 호출하지 않는다 — 호출부(run submit / scorecard 배치)의 책임", async () => {
    const budget = inMemoryBudget({ limitFor: () => ({}) });
    const admit = vi.spyOn(budget, "admit");
    await executeCase({ dispatcher: capture().dispatcher, budget }, "acme", "u", JOB);
    expect(admit).not.toHaveBeenCalled();
  });
});
