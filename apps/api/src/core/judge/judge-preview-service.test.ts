import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { BadRequestError, type CaseJob, type CaseResult, type JudgeSpec, type TraceEvent } from "@everdict/contracts";
import { InMemoryRunStore } from "@everdict/db";
import { describe, expect, it, vi } from "vitest";
import { codeJudgeRunSubmitter } from "../../composition/run.js";
import { JudgePreviewService } from "./judge-preview-service.js";

const CODE_JUDGE: Extract<JudgeSpec, { kind: "code" }> = {
  kind: "code",
  id: "quality",
  version: "1.0.0",
  language: "python",
  code: "print('{}')",
  timeoutSec: 600,
  tags: [],
};

const SAMPLE_TRACE: TraceEvent[] = [{ t: 0, kind: "message", role: "assistant", text: "done" }];
const TRACE_EVIDENCE = { source: "trace" as const, trace: SAMPLE_TRACE };

describe("JudgePreviewService — code judge dry-run promotion", () => {
  it("try(code) submits a REAL standalone run and returns its runId (no inline scores)", async () => {
    const submitCodeJudgeRun = vi.fn(async () => ({ id: "run-7" }));
    const service = new JudgePreviewService({ submitCodeJudgeRun });
    const result = await service.try({
      tenant: "acme",
      spec: CODE_JUDGE,
      evidence: TRACE_EVIDENCE,
      createdBy: "user-1",
    });
    expect(result.runId).toBe("run-7");
    expect(result.scores).toBeUndefined(); // the verdict is read from the completed run, not inline
    expect(result.kind).toBe("code");
    expect(submitCodeJudgeRun).toHaveBeenCalledWith(
      expect.objectContaining({ tenant: "acme", spec: CODE_JUDGE, createdBy: "user-1" }),
    );
  });

  it("try(code) without a wired run submitter is a visible BadRequest (never a silent direct dispatch)", async () => {
    const service = new JudgePreviewService({});
    await expect(service.try({ tenant: "acme", spec: CODE_JUDGE, evidence: TRACE_EVIDENCE })).rejects.toBeInstanceOf(
      BadRequestError,
    );
  });
});

describe("codeJudgeRunSubmitter — the wrapper job as a first-class run", () => {
  function capture() {
    const jobs: CaseJob[] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job): Promise<CaseResult> {
        jobs.push(job);
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [{ graderId: "judge", metric: "judge", value: 1, pass: true }],
        };
      },
    };
    let n = 0;
    const store = new InMemoryRunStore();
    const service = new RunService({ dispatcher, store, newId: () => `run-${n++}` });
    return { jobs, service };
  }
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("submits with trigger judge-preview + the inline no-op wrapper spec; the script verdict lands on the record", async () => {
    const { jobs, service } = capture();
    const submit = codeJudgeRunSubmitter(service);
    const record = await submit({
      tenant: "acme",
      spec: CODE_JUDGE,
      ctx: {
        case: { id: "preview", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 1, tags: [] },
        trace: [],
        snapshot: { kind: "prompt", output: "" },
      },
      createdBy: "user-1",
    });
    expect(record.trigger).toBe("judge-preview");
    expect(record.harness).toEqual({ id: "judge-quality", version: "1.0.0" });
    await flush();
    expect(jobs[0]?.harnessSpec).toMatchObject({ kind: "command", command: "true" }); // no registry entry needed
    expect(jobs[0]?.submittedBy).toBe("user-1");
    const done = await service.get(record.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.result?.scores).toEqual([{ graderId: "judge", metric: "judge", value: 1, pass: true }]);
  });

  it("placement: spec.runtime wins; else the source case's placement is inherited (re-score co-locate)", async () => {
    const { jobs, service } = capture();
    const submit = codeJudgeRunSubmitter(service);
    const sourceCtx = {
      case: {
        id: "c1",
        env: { kind: "prompt" as const },
        task: "t",
        graders: [],
        timeoutSec: 1,
        tags: [],
        placement: { target: "nomad-seoul" },
      },
      trace: [],
      snapshot: { kind: "prompt" as const, output: "" },
    };
    await submit({ tenant: "acme", spec: CODE_JUDGE, ctx: sourceCtx });
    await submit({ tenant: "acme", spec: { ...CODE_JUDGE, runtime: "k8s-eu" }, ctx: sourceCtx });
    await flush();
    expect(jobs[0]?.evalCase.placement?.target).toBe("nomad-seoul"); // inherited
    expect(jobs[1]?.evalCase.placement?.target).toBe("k8s-eu"); // explicit wins
  });
});
