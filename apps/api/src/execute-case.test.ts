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

describe("executeCase — pure execution (token resolve+attach → dispatch)", () => {
  it("for a private-repo (git+connectionId) case, resolves the owner's token, attaches it to the job, then dispatches", async () => {
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

  it("tries the workspace GitHub App token before the personal connection and attaches it to the job", async () => {
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
    expect(cap.seen()?.repoToken).toBe("app-tok"); // App first
  });

  it("falls back to the personal connection (connectionId) when there's no workspace App match", async () => {
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

  it("public/non-repo cases attach no token (even when repoTokenFor exists)", async () => {
    const cap = capture();
    await executeCase({ dispatcher: cap.dispatcher, repoTokenFor: async () => "tok" }, "alice", JOB);
    expect(cap.seen()?.repoToken).toBeUndefined();
  });

  it("returns the result as-is — no settlement/notification/offload (that's the orchestrator's job)", async () => {
    const cap = capture();
    const result = await executeCase({ dispatcher: cap.dispatcher }, "u", JOB);
    expect(result.caseId).toBe("c1");
    expect(cap.seen()?.evalCase.id).toBe("c1");
  });
});

describe("executeCase — attach workspace-registry pull credentials (job.registryAuth)", () => {
  const AUTH = { host: "ghcr.io", username: "bot", password: "pull-tok" };

  it("when the case image belongs to a workspace registry, attaches registryAuth", async () => {
    const cap = capture();
    const job: AgentJob = { ...JOB, evalCase: { ...JOB.evalCase, image: "ghcr.io/acme/sbench:v1" } };
    await executeCase(
      { dispatcher: cap.dispatcher, registryAuthsFor: async (ws) => (ws === "acme" ? [AUTH] : []) },
      "u",
      job,
    );
    expect(cap.seen()?.registryAuth).toEqual(AUTH);
  });

  it("when the job image isn't on that registry's host, no credentials are attached (avoids needless leakage)", async () => {
    const cap = capture();
    const job: AgentJob = { ...JOB, evalCase: { ...JOB.evalCase, image: "spreadsheetbench:v1" } };
    await executeCase({ dispatcher: cap.dispatcher, registryAuthsFor: async () => [AUTH] }, "u", job);
    expect(cap.seen()?.registryAuth).toBeUndefined();
  });

  it("a service harness is judged by its service images (+ per-dispatch pin override)", async () => {
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
    // the spec image is external, but the pin overrides to a workspace registry → attach.
    const job: AgentJob = { ...JOB, harnessSpec: serviceSpec, imagePins: { agent: "ghcr.io/acme/agent:pr-1" } };
    await executeCase({ dispatcher: cap.dispatcher, registryAuthsFor: async () => [AUTH] }, "u", job);
    expect(cap.seen()?.registryAuth).toEqual(AUTH);
  });
});

describe("executeCase — command-harness image promotion (evalCase.image ??= harnessSpec.image)", () => {
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

  it("when a case specifies no image, promotes the command harness's image (the CI re-pin target) as the execution container", async () => {
    const cap = capture();
    await executeCase({ dispatcher: cap.dispatcher }, "u", { ...JOB, harnessSpec: commandSpec("codex:v2") });
    expect(cap.seen()?.evalCase.image).toBe("codex:v2");
  });

  it("when a case specifies an image, it isn't overwritten by the harness image (case wins — datasets are harness-agnostic)", async () => {
    const cap = capture();
    const jobWithImage: AgentJob = {
      ...JOB,
      evalCase: { ...JOB.evalCase, image: "case:v9" },
      harnessSpec: commandSpec("codex:v2"),
    };
    await executeCase({ dispatcher: cap.dispatcher }, "u", jobWithImage);
    expect(cap.seen()?.evalCase.image).toBe("case:v9");
  });

  it("for a harness with no image, the case image stays as-is with no promotion (host-native preserved)", async () => {
    const cap = capture();
    await executeCase({ dispatcher: cap.dispatcher }, "u", { ...JOB, harnessSpec: commandSpec() });
    expect(cap.seen()?.evalCase.image).toBeUndefined();
  });
});

// ── Out-of-job trace collection (D4) — the completion step for traceRef results ──
// docs/architecture/streaming-case-pipeline.md

describe("executeCase — out-of-job trace collection (traceRef completion)", () => {
  const deferredResult = (job: AgentJob): CaseResult => ({
    caseId: job.evalCase.id,
    harness: "cmd@1",
    trace: [{ t: 0, kind: "error", message: "command exit 1: boom" }], // execution event left by the job
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }], // ground-truth from the job
    traceRef: { kind: "otel", endpoint: "http://collector", runId: "rid-9" },
  });
  const dispatcherOf = (result: (job: AgentJob) => CaseResult): Dispatcher => ({
    async dispatch(job) {
      return result(job);
    },
  });
  // Attach observation-grader specs to the case so steps/cost can be reconstructed and scored in the control plane.
  const jobWithGraders: AgentJob = {
    ...JOB,
    evalCase: { ...JOB.evalCase, graders: [{ id: "tests-pass", config: { cmd: "true" } }, { id: "steps" }] },
  };

  it("with a traceRef, pulls from the platform to complete the trace and scores only the deferred observation grader (steps)", async () => {
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
    expect(fetchedBy).toBe("otel:http://collector:rid-9"); // pull by traceRef coordinates + correlation key
    expect(result.trace).toHaveLength(3); // 1 job event + 2 from the platform
    // needsCompute (tests-pass) was already scored in the job — here only the deferred steps is appended (no double scoring).
    expect(result.scores.map((s) => s.graderId)).toEqual(["tests-pass", "steps"]);
    const steps = result.scores.find((s) => s.graderId === "steps");
    expect(steps?.value).toBe(1); // one tool_call — proof it was derived on the collected trace
    expect(result.traceRef?.runId).toBe("rid-9"); // kept as provenance
  });

  it("a pull failure classifies the case {collect, infra, retryable} while execution output (ground-truth scores) is preserved", async () => {
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
    expect(result.scores.some((s) => s.graderId === "tests-pass" && s.pass === true)).toBe(true); // preserved
    // The case is CLASSIFIED (stage-aware retry re-pulls it later) — not silently scored on an incomplete trace.
    expect(result.failure).toMatchObject({
      stage: "collect",
      class: "infra",
      code: "TRACE_COLLECT_FAILED",
      retryable: true,
    });
    expect(result.scores.some((s) => s.graderId === "steps")).toBe(false); // observation scoring stays deferred
  });

  it("a job-side collect failure RECOVERS on the control-plane pull: failure cleared, deferred observations scored", async () => {
    // The sandbox couldn't reach the platform, but the control plane can (the common network-asymmetry case).
    const failedInJob = (job: AgentJob): CaseResult => ({
      ...deferredResult(job),
      failure: {
        stage: "collect",
        class: "infra",
        code: "TRACE_COLLECT_FAILED",
        message: "trace collection failed: fetch failed",
        retryable: true,
      },
    });
    const result = await executeCase(
      {
        dispatcher: dispatcherOf(failedInJob),
        buildTraceSource: () => ({
          async fetch() {
            return [{ t: 1, kind: "tool_call", id: "x", name: "bash", args: {} }];
          },
        }),
      },
      "u",
      jobWithGraders,
    );
    expect(result.failure).toBeUndefined(); // recovered — the classification is shed
    expect(result.scores.map((s) => s.graderId)).toEqual(["tests-pass", "steps"]); // deferred scoring completed
  });

  it("a failed case does NOT recover on zero events — the {collect} classification is kept for a later stage-aware retry", async () => {
    const failedInJob = (job: AgentJob): CaseResult => ({
      ...deferredResult(job),
      failure: {
        stage: "collect",
        class: "infra",
        code: "TRACE_COLLECT_FAILED",
        message: "trace collection failed: fetch failed",
        retryable: true,
      },
    });
    const result = await executeCase(
      {
        dispatcher: dispatcherOf(failedInJob),
        sleep: async () => {},
        buildTraceSource: () => ({
          async fetch() {
            return []; // reachable but nothing correlated — the failed case is NOT healed by an empty pull
          },
        }),
      },
      "u",
      jobWithGraders,
    );
    expect(result.failure).toMatchObject({ stage: "collect", code: "TRACE_COLLECT_FAILED" });
    expect(result.scores.some((s) => s.graderId === "steps")).toBe(false);
  });

  it("authSecret is re-resolved from the tenant SecretStore into Authorization, and correlate/experiment flow into the source config", async () => {
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
    expect(seenCfg?.headers?.authorization).toBe("Basic abc"); // name → value re-resolution (verbatim Authorization)
    expect(seenCfg?.correlate).toBe("tag");
    expect(seenCfg?.project).toBe("7"); // experiment → the source's search scope
    expect(result.trace.some((e) => e.kind === "llm_call")).toBe(true);
  });

  it("on zero collected, retries (flush latency) and loads whatever arrives; if the secret is unregistered, surfaces a soft failure", async () => {
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

    // authSecret reference + unregistered secret → execution output preserved + an error event (reason it couldn't collect).
    const missing = await executeCase(
      {
        dispatcher: dispatcherOf((job) => ({
          ...deferredResult(job),
          traceRef: { kind: "otel", endpoint: "http://j", runId: "r", authSecret: "NOPE" },
        })),
        secretsFor: async () => ({}),
        buildTraceSource: () => ({
          async fetch() {
            throw new Error("must not be called — auth resolution fails first");
          },
        }),
      },
      "u",
      jobWithGraders,
    );
    expect(missing.trace.some((e) => e.kind === "error" && e.message.includes("NOPE"))).toBe(true);
    expect(missing.scores.some((s) => s.graderId === "tests-pass" && s.pass === true)).toBe(true);
    expect(missing.failure).toMatchObject({ stage: "collect", code: "TRACE_COLLECT_FAILED" }); // classified, not silent
  });

  it("a result with no traceRef (default job collection) passes through unchanged (no regression) + an unset buildTraceSource is surfaced", async () => {
    const plain = await executeCase({ dispatcher: dispatcherOf(resultFor) }, "u", jobWithGraders);
    expect(plain.trace).toEqual([]); // untouched
    const noSource = await executeCase({ dispatcher: dispatcherOf(deferredResult) }, "u", JOB);
    expect(noSource.trace.some((e) => e.kind === "error" && e.message.includes("buildTraceSource"))).toBe(true);
  });
});
