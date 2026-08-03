import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import {
  BadRequestError,
  type CaseJob,
  type CaseResult,
  type EvalCase,
  type HarnessSpec,
  UpstreamError,
} from "@everdict/contracts";
import { InMemoryRecordingStore, InMemoryRunStore, InMemoryTrajectoryStore, type RunRecord } from "@everdict/db";
import { inMemoryBudget } from "@everdict/domain";
import { describe, expect, it, vi } from "vitest";

const CASE: EvalCase = {
  id: "c1",
  env: { kind: "repo", source: { files: {} } },
  task: "t",
  graders: [],
  timeoutSec: 60,
  tags: [],
};

function resultFor(job: CaseJob, usd = 0): CaseResult {
  return {
    caseId: job.evalCase.id,
    harness: `${job.harness.id}@${job.harness.version}`,
    trace: usd ? [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd } }] : [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: [],
  };
}

const okDispatcher: Dispatcher = {
  async dispatch(job) {
    return resultFor(job);
  },
};
const failDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("boom");
  },
};

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
let n = 0;
const ids = () => `run-${n++}`;

describe("RunService", () => {
  it("submit → queued → succeeded + result stored on dispatch success", async () => {
    const store = new InMemoryRunStore();
    const svc = new RunService({ dispatcher: okDispatcher, store, newId: ids });
    const rec = await svc.submit({ tenant: "t", harness: { id: "scripted", version: "0" }, case: CASE });
    expect(rec.status).toBe("queued");
    await flush();
    const done = await svc.get(rec.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.result?.caseId).toBe("c1");
  });

  it("seals the replay recording and attaches its ref when frames were teed during the run", async () => {
    // Given a recording store with a frame teed under the run's derived runId (evd-run-<id>)
    const store = new InMemoryRunStore();
    const recordingStore = new InMemoryRecordingStore();
    await recordingStore.append("evd-run-rec1", { track: "frames", entry: { t: 1, ref: "memory://f" } });
    const svc = new RunService({ dispatcher: okDispatcher, store, newId: () => "rec1", recordingStore });

    // When the run finalizes
    const rec = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE });
    await flush();

    // Then the result carries the recordingRef and the sealed recording (envKind from the case) is retrievable
    const done = await svc.get(rec.id);
    expect(done?.result?.recordingRef?.ref).toBe("memory://recording/evd-run-rec1");
    expect((await recordingStore.get("evd-run-rec1"))?.envKind).toBe("repo");
  });

  it("attaches no recordingRef when nothing was recorded for the run", async () => {
    // Given a recording store with no entries for this run
    const store = new InMemoryRunStore();
    const svc = new RunService({
      dispatcher: okDispatcher,
      store,
      newId: () => "rec2",
      recordingStore: new InMemoryRecordingStore(),
    });

    // When the run finalizes with nothing teed
    const rec = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE });
    await flush();

    // Then no recordingRef is attached (an empty recording seals to undefined)
    expect((await svc.get(rec.id))?.result?.recordingRef).toBeUndefined();
  });

  it("recording() returns the sealed replay recording for a run, keyed by its derived runId", async () => {
    // Given a run whose recording was teed + sealed under its derived runId (evd-run-<id>)
    const store = new InMemoryRunStore();
    const recordingStore = new InMemoryRecordingStore();
    await recordingStore.append("evd-run-rec3", { track: "frames", entry: { t: 1, ref: "memory://f" } });
    const svc = new RunService({ dispatcher: okDispatcher, store, newId: () => "rec3", recordingStore });
    const rec = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE });
    await flush();

    // When the recording is fetched, it returns the sealed CaseRecording + the record (for authz)
    const out = await svc.recording(rec.id);
    expect(out?.recording?.runId).toBe("evd-run-rec3");
    expect(out?.recording?.tracks.frames).toHaveLength(1);
    expect(out?.record.status).toBe("succeeded");
  });

  it("recording() yields an undefined recording when nothing was recorded, and undefined for a missing run", async () => {
    // Given a run with nothing teed
    const store = new InMemoryRunStore();
    const svc = new RunService({
      dispatcher: okDispatcher,
      store,
      newId: () => "rec4",
      recordingStore: new InMemoryRecordingStore(),
    });
    const rec = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE });
    await flush();

    // Then the record is returned with no recording, and a missing run is undefined
    expect((await svc.recording(rec.id))?.recording).toBeUndefined();
    expect(await svc.recording("nope")).toBeUndefined();
  });

  it("when a runtime is given, injects it as the case's placement.target and dispatches (same symmetry as scorecard)", async () => {
    const store = new InMemoryRunStore();
    const jobs: CaseJob[] = [];
    const capture: Dispatcher = {
      async dispatch(job) {
        jobs.push(job);
        return resultFor(job);
      },
    };
    const svc = new RunService({ dispatcher: capture, store, newId: ids });
    await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE, runtime: "nomad-seoul" });
    await flush();
    expect(jobs[0]?.evalCase.placement?.target).toBe("nomad-seoul");

    // Contrast: with no runtime, placement is untouched (existing behavior preserved).
    await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(jobs[1]?.evalCase.placement).toBeUndefined();
  });

  it("requireRuntime policy: with no runtime/self target it's 400 (BadRequest) and no record is created (no local fallback)", async () => {
    const store = new InMemoryRunStore();
    const svc = new RunService({ dispatcher: okDispatcher, store, newId: ids, requireRuntime: true });
    // No target → submission rejected (the gate blocks before budget/record creation)
    await expect(svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE })).rejects.toBeInstanceOf(
      BadRequestError,
    );
    expect(await svc.list("t")).toHaveLength(0);
    // A registered runtime id or self:<runner> → passes the gate, normally queued
    const ok = await svc.submit({
      tenant: "t",
      harness: { id: "s", version: "0" },
      case: CASE,
      runtime: "self:laptop",
    });
    expect(ok.status).toBe("queued");
  });

  it("list(scorecardId) returns only that batch's children, default list only standalone (case drilldown)", async () => {
    const store = new InMemoryRunStore();
    const svc = new RunService({ dispatcher: okDispatcher, store, newId: ids });
    const base = {
      tenant: "t",
      harness: { id: "s", version: "0" },
      status: "succeeded" as const,
      createdAt: "t",
      updatedAt: "t",
    };
    await store.create({ ...base, id: "solo", caseId: "c" });
    await store.create({ ...base, id: "ch1", caseId: "c1", parentScorecardId: "sc1", trigger: "scorecard" });
    await store.create({ ...base, id: "ch2", caseId: "c2", parentScorecardId: "sc2", trigger: "scorecard" });
    expect((await svc.list("t")).map((r) => r.id)).toEqual(["solo"]); // default: children hidden
    expect((await svc.list("t", { scorecardId: "sc1" })).map((r) => r.id)).toEqual(["ch1"]); // batch drilldown
  });

  it("list({runnerId}) returns the runs a self-hosted runner executed (provenance), children included, newest first, capped", async () => {
    const store = new InMemoryRunStore();
    const svc = new RunService({ dispatcher: okDispatcher, store, newId: ids });
    const base = { tenant: "t", harness: { id: "s", version: "0" }, status: "succeeded" as const, updatedAt: "t" };
    const ranBy = (runner: string): CaseResult => ({
      caseId: "c",
      harness: "s@0",
      trace: [],
      snapshot: { kind: "prompt", output: "" },
      scores: [],
      provenance: { ranOn: "self-hosted", runner, by: "u" },
    });
    await store.create({ ...base, id: "a", caseId: "c", createdAt: "2026-07-01T00:00:00.000Z", result: ranBy("r1") });
    // a scorecard CHILD this runner ran → included (a runner mostly runs cases), and it's the newest
    await store.create({
      ...base,
      id: "b",
      caseId: "c",
      parentScorecardId: "sc1",
      createdAt: "2026-07-03T00:00:00.000Z",
      result: ranBy("r1"),
    });
    await store.create({ ...base, id: "c", caseId: "c", createdAt: "2026-07-02T00:00:00.000Z", result: ranBy("r2") }); // other runner
    await store.create({ ...base, id: "d", caseId: "c", createdAt: "2026-07-04T00:00:00.000Z" }); // no provenance (managed / in-flight)

    expect((await svc.list("t", { runnerId: "r1" })).map((r) => r.id)).toEqual(["b", "a"]); // newest first, r2/no-provenance excluded
    expect((await svc.list("t", { runnerId: "r1", limit: 1 })).map((r) => r.id)).toEqual(["b"]); // capped to the newest
    // offset pagination — page 2 (limit 1, offset 1) skips the newest and returns the next-newest
    expect((await svc.list("t", { runnerId: "r1", limit: 1, offset: 1 })).map((r) => r.id)).toEqual(["a"]);
    expect(await svc.list("t", { runnerId: "r1", limit: 1, offset: 2 })).toEqual([]); // past the end
    expect(await svc.list("t", { runnerId: "nobody" })).toEqual([]); // an unknown runner has no activity
  });

  it("records the trigger on the record (activity-view source axis) — unset if not given", async () => {
    const store = new InMemoryRunStore();
    const svc = new RunService({ dispatcher: okDispatcher, store, newId: ids });
    const rec = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE, trigger: "web" });
    expect(rec.trigger).toBe("web");
    const bare = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE });
    expect(bare.trigger).toBeUndefined();
  });

  it("an inline harnessSpec (service-internal synthetic harness, e.g. the code-judge dry-run wrapper) rides the job without consulting the registry", async () => {
    const jobs: CaseJob[] = [];
    const capture: Dispatcher = {
      async dispatch(job) {
        jobs.push(job);
        return resultFor(job);
      },
    };
    const inline: HarnessSpec = {
      kind: "command",
      id: "judge-x",
      version: "1.0.0",
      setup: [],
      command: "true",
      env: {},
      params: {},
      trace: { kind: "none" },
    };
    const resolveHarness = vi.fn(async () => undefined);
    const svc = new RunService({ dispatcher: capture, store: new InMemoryRunStore(), newId: ids, resolveHarness });
    await svc.submit({
      tenant: "t",
      harness: { id: "judge-x", version: "1.0.0" },
      case: CASE,
      harnessSpec: inline,
    });
    await flush();
    expect(jobs[0]?.harnessSpec).toEqual(inline);
    expect(resolveHarness).not.toHaveBeenCalled(); // the inline spec wins — no registry lookup for a synthetic id
  });

  it("self-hosted execution (provenance.ranOn=self-hosted) does not draw down the workspace usd/tokens budget", async () => {
    const store = new InMemoryRunStore();
    const selfHosted: Dispatcher = {
      async dispatch(job) {
        return { ...resultFor(job, 5), provenance: { ranOn: "self-hosted", runner: "laptop", by: "u" } };
      },
    };
    const budget = inMemoryBudget({ limitFor: () => ({}) });
    const settle = vi.spyOn(budget, "settle");
    const svc = new RunService({ dispatcher: selfHosted, store, budget, newId: ids });
    await svc.submit({ tenant: "acme", submittedBy: "u", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(settle).not.toHaveBeenCalled(); // the user's own login pays — workspace budget not charged

    // Contrast: a managed backend result (no provenance) is settled.
    await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(settle).not.toHaveBeenCalled(); // still not called — this is the selfHosted dispatcher

    const managed = new RunService({ dispatcher: okDispatcher, store, budget, newId: ids });
    await managed.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(settle).toHaveBeenCalledTimes(1); // managed is settled
  });

  it("failed + error envelope on dispatch failure", async () => {
    const store = new InMemoryRunStore();
    const svc = new RunService({ dispatcher: failDispatcher, store, newId: ids });
    const rec = await svc.submit({ tenant: "t", harness: { id: "scripted", version: "0" }, case: CASE });
    await flush();
    const done = await svc.get(rec.id);
    expect(done?.status).toBe("failed");
    expect(done?.error?.message).toBe("boom");
  });

  it("emits run.placement_blocked ONCE when the dispatch layer reports the run cannot start (M2)", async () => {
    // The wait loop may report the blocked verdict on every poll — the fact must stay one signal per run.
    const store = new InMemoryRunStore();
    const emitted: Array<{ kind: string; message: string }> = [];
    const blockedDispatcher: Dispatcher = {
      async dispatch(job, opts) {
        opts?.onWaiting?.("placement blocked — memory exhausted on 1 node(s)");
        opts?.onWaiting?.("placement blocked — memory exhausted on 1 node(s)");
        return resultFor(job);
      },
    };
    const svc = new RunService({
      dispatcher: blockedDispatcher,
      store,
      newId: ids,
      events: {
        async emit(input) {
          emitted.push({ kind: input.kind, message: input.message });
          return undefined;
        },
      },
    });
    await svc.submit({ tenant: "t", harness: { id: "scripted", version: "0" }, case: CASE });
    await flush();
    const blocked = emitted.filter((e) => e.kind === "run.placement_blocked");
    expect(blocked).toHaveLength(1);
    expect(blocked[0]?.message).toContain("memory exhausted");
  });

  it("a failed single run keeps the classified failure + backend evidence and seals it as its trajectory", async () => {
    // Regression (live-caught on Nomad): a failed SINGLE run kept only error {code,message} — the classified
    // CaseFailure with the throw-time evidence (placement identity + log tail) was a batch-only privilege, and
    // the run had no trajectory at all, so once the orchestrator job was GC'd the "why" was gone.
    const store = new InMemoryRunStore();
    const sealed: Array<{ runId: string; source: string; events: unknown[] }> = [];
    const evidenceFailDispatcher: Dispatcher = {
      async dispatch() {
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          {
            alloc: "a1",
            placement: { unit: "a1", node: "worker-2", events: ["Driver Failure: Failed to pull image"] },
            logTail: "panic: boom",
          },
          "alloc failed — Driver Failure: Failed to pull image",
        );
      },
    };
    const svc = new RunService({
      dispatcher: evidenceFailDispatcher,
      store,
      newId: ids,
      trajectories: {
        async seal(input) {
          sealed.push({ runId: input.runId, source: input.source, events: [...input.events] });
          return {
            runId: input.runId,
            tenant: input.tenant,
            source: input.source,
            eventCount: input.events.length,
            sealedAt: "2026-01-01T00:00:00Z",
            created: true,
          };
        },
        async get() {
          return undefined;
        },
        async list() {
          return { items: [] };
        },
        async ingestedSince() {
          return { trajectories: 0, events: 0 };
        },
        async deleteOlderThan() {
          return 0;
        },
      },
    });
    const rec = await svc.submit({ tenant: "t", harness: { id: "scripted", version: "0" }, case: CASE });
    await flush();
    const done = await svc.get(rec.id);
    expect(done?.status).toBe("failed");
    // The same synthesis the batch path uses: classified failure + evidence on the result.
    expect(done?.result?.failure).toMatchObject({
      stage: "dispatch",
      class: "infra",
      placement: { unit: "a1", node: "worker-2", events: ["Driver Failure: Failed to pull image"] },
      logTail: "panic: boom",
    });
    expect(done?.result?.trace).toEqual([
      // 인프라 플레인이 먼저 — the placement events as infra evidence, then the log tail, then the error.
      {
        t: 0,
        kind: "infra",
        scope: "placement",
        message: "Driver Failure: Failed to pull image",
        unit: "a1",
        node: "worker-2",
      },
      { t: 1, kind: "log", stream: "stderr", text: "panic: boom" },
      { t: 2, kind: "error", message: "alloc failed — Driver Failure: Failed to pull image" },
    ]);
    // Dual-write parity with the success path — the evidence trace sealed as the run's own trajectory.
    expect(sealed).toHaveLength(1);
    expect(sealed[0]).toMatchObject({ runId: rec.id, source: "run" });
    expect(sealed[0]?.events).toHaveLength(3);
  });

  it("submit throws when over budget (no run created, maps to 402)", async () => {
    const store = new InMemoryRunStore();
    const budget = inMemoryBudget({ limitFor: () => ({ runs: 1 }) });
    const svc = new RunService({ dispatcher: okDispatcher, store, budget, newId: ids });
    await svc.submit({ tenant: "free", harness: { id: "s", version: "0" }, case: CASE });
    await expect(svc.submit({ tenant: "free", harness: { id: "s", version: "0" }, case: CASE })).rejects.toMatchObject({
      code: "BUDGET_EXCEEDED",
      status: 402,
    });
  });

  it("metering: request override > workspace policy > off, carries the decided value as job.meterUsage", async () => {
    const seen: Array<boolean | undefined> = [];
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        seen.push(job.meterUsage);
        return resultFor(job);
      },
    };
    // Policy: only acme on. A request override beats the policy.
    const svc = new RunService({
      dispatcher,
      store: new InMemoryRunStore(),
      newId: ids,
      meterUsageFor: (t) => t === "acme",
    });
    await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE }); // policy on
    await svc.submit({ tenant: "beta", harness: { id: "s", version: "0" }, case: CASE }); // policy off
    await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE, meterUsage: false }); // override off
    await svc.submit({ tenant: "beta", harness: { id: "s", version: "0" }, case: CASE, meterUsage: true }); // override on
    await flush();
    expect(seen).toEqual([true, false, false, true]);
  });

  it("judge model: request override > workspace default > none, carries the decided value as job.judge", async () => {
    const seen: Array<CaseJob["judge"]> = [];
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        seen.push(job.judge);
        return resultFor(job);
      },
    };
    const svc = new RunService({
      dispatcher,
      store: new InMemoryRunStore(),
      newId: ids,
      // Workspace default: only acme has a judge model configured.
      judgeFor: async (t) => (t === "acme" ? { provider: "openai", model: "gpt-5.4-mini" } : undefined),
    });
    await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE }); // default applied
    await svc.submit({ tenant: "beta", harness: { id: "s", version: "0" }, case: CASE }); // no default
    await svc.submit({
      tenant: "beta",
      harness: { id: "s", version: "0" },
      case: CASE,
      judge: { model: "claude-opus-4-8", provider: "anthropic" },
    }); // override
    await flush();
    expect(seen[0]).toEqual({ provider: "openai", model: "gpt-5.4-mini" });
    expect(seen[1]).toBeUndefined(); // no default → job.judge unset → the agent skips the judge
    expect(seen[2]).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
  });

  it("the metering policy can be async (DB settings store) — awaited and carried on the job", async () => {
    let seen: boolean | undefined;
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        seen = job.meterUsage;
        return resultFor(job);
      },
    };
    // Returns Promise<boolean> like a DB lookup
    const svc = new RunService({
      dispatcher,
      store: new InMemoryRunStore(),
      newId: ids,
      meterUsageFor: async (t) => t === "acme",
    });
    await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(seen).toBe(true);
  });

  it("with no policy, default off (job.meterUsage=false)", async () => {
    let seen: boolean | undefined;
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        seen = job.meterUsage;
        return resultFor(job);
      },
    };
    const svc = new RunService({ dispatcher, store: new InMemoryRunStore(), newId: ids });
    await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(seen).toBe(false);
  });

  it("private repo: env.source.connectionId → resolved via repoTokenFor and carried as job.repoToken", async () => {
    const seen: Array<CaseJob["repoToken"]> = [];
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        seen.push(job.repoToken);
        return resultFor(job);
      },
    };
    // The connection is personally owned → repoTokenFor resolves by owner (submitter subject) ("clone with my connection").
    const calls: Array<{ owner: string; connectionId: string }> = [];
    const svc = new RunService({
      dispatcher,
      store: new InMemoryRunStore(),
      newId: ids,
      repoTokenFor: async (owner, connectionId) => {
        calls.push({ owner, connectionId });
        return connectionId === "conn-alice" ? "gho_resolved" : undefined;
      },
    });
    const gitCase = (connectionId?: string): EvalCase => ({
      ...CASE,
      env: {
        kind: "repo",
        source: { git: "https://github.com/acme/p.git", ref: "main", ...(connectionId ? { connectionId } : {}) },
      },
    });
    const submit = (c: EvalCase) =>
      svc.submit({ tenant: "acme", submittedBy: "u-alice", harness: { id: "s", version: "0" }, case: c });
    await submit(gitCase("conn-alice")); // resolved (my connection)
    await submit(gitCase("conn-missing")); // unresolved
    await submit(gitCase()); // no connectionId (public)
    await submit(CASE); // files seed (non-git)
    await flush();
    expect(seen).toEqual(["gho_resolved", undefined, undefined, undefined]);
    // Cases with no connectionId / non-repo cases never call repoTokenFor. owner is the submitter subject.
    expect(calls).toEqual([
      { owner: "u-alice", connectionId: "conn-alice" },
      { owner: "u-alice", connectionId: "conn-missing" },
    ]);
  });

  it("on completion, calls the onComplete callback with the latest record (notification hook)", async () => {
    const seen: Array<{ tenant: string; status: string; id: string }> = [];
    const store = new InMemoryRunStore();
    const svc = new RunService({
      dispatcher: okDispatcher,
      store,
      newId: ids,
      onComplete: async (tenant, rec) => {
        seen.push({ tenant, status: rec.status, id: rec.id });
      },
    });
    const rec = await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(seen).toEqual([{ tenant: "acme", status: "succeeded", id: rec.id }]);
  });

  it("even on dispatch failure, onComplete is called with the failed record", async () => {
    const seen: string[] = [];
    const svc = new RunService({
      dispatcher: failDispatcher,
      store: new InMemoryRunStore(),
      newId: ids,
      onComplete: async (_t, rec) => {
        seen.push(rec.status);
      },
    });
    await svc.submit({ tenant: "acme", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(seen).toEqual(["failed"]);
  });

  it("cost is settled on completion", async () => {
    const store = new InMemoryRunStore();
    const budget = inMemoryBudget({ limitFor: () => ({ usd: 1 }) });
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        return resultFor(job, 0.25);
      },
    };
    const svc = new RunService({ dispatcher, store, budget, newId: ids });
    const rec = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(budget.usage("t").usd).toBeCloseTo(0.25);
    expect((await svc.get(rec.id))?.status).toBe("succeeded");
  });

  it("fires the webhook on completion", async () => {
    const store = new InMemoryRunStore();
    const calls: Array<{ url: string; status: string }> = [];
    const fakeFetch = (async (url: string | URL, init?: { body?: string }) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url: String(url), status: body.status });
      return new Response("ok");
    }) as unknown as typeof fetch;
    const svc = new RunService({ dispatcher: okDispatcher, store, newId: ids, fetch: fakeFetch });
    await svc.submit({
      tenant: "t",
      harness: { id: "s", version: "0" },
      case: CASE,
      webhookUrl: "https://hook.example/cb",
    });
    await flush();
    await flush();
    expect(calls[0]?.url).toBe("https://hook.example/cb");
    expect(calls[0]?.status).toBe("succeeded");
  });
});

describe("RunService — single-run durability (P4, docs/architecture/batch-resilience.md)", () => {
  it("submit persists the placement-injected case as caseSpec (the boot-recovery re-dispatch basis)", async () => {
    const store = new InMemoryRunStore();
    const svc = new RunService({ dispatcher: okDispatcher, store, newId: ids });
    const rec = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE, runtime: "nomad-x" });
    const stored = await store.get(rec.id);
    expect(stored?.caseSpec?.id).toBe("c1");
    // The EFFECTIVE case is persisted — placement.target already baked in, so resume needs no re-injection.
    expect(stored?.caseSpec?.placement?.target).toBe("nomad-x");
  });

  it("resume with an adopted result settles the run directly — zero re-dispatch", async () => {
    const store = new InMemoryRunStore();
    const jobs: CaseJob[] = [];
    const capture: Dispatcher = {
      async dispatch(job) {
        jobs.push(job);
        return resultFor(job);
      },
    };
    const svc = new RunService({ dispatcher: capture, store, newId: ids });
    const rec = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE, runtime: "rt" });
    await flush();
    jobs.length = 0; // discard the original dispatch — resume is what's under test
    await store.update(rec.id, { status: "running" }); // simulate the interrupted state

    const adopted = resultFor({ evalCase: CASE, harness: { id: "s", version: "0" }, tenant: "t" });
    expect(await svc.resume((await store.get(rec.id)) as RunRecord, adopted)).toBe(true);
    expect(jobs).toHaveLength(0);
    const done = await store.get(rec.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.result?.caseId).toBe("c1");
  });

  it("resume without an adopted result re-dispatches from the persisted caseSpec to the same runtime", async () => {
    const store = new InMemoryRunStore();
    const jobs: CaseJob[] = [];
    const capture: Dispatcher = {
      async dispatch(job) {
        jobs.push(job);
        return resultFor(job);
      },
    };
    const svc = new RunService({ dispatcher: capture, store, newId: ids });
    const rec = await svc.submit({
      tenant: "t",
      submittedBy: "alice",
      harness: { id: "s", version: "0" },
      case: CASE,
      runtime: "nomad-x",
    });
    await flush();
    jobs.length = 0;
    await store.update(rec.id, { status: "queued" }); // interrupted before the first dispatch settled

    expect(await svc.resume((await store.get(rec.id)) as RunRecord)).toBe(true);
    await flush();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.evalCase.id).toBe("c1");
    expect(jobs[0]?.evalCase.placement?.target).toBe("nomad-x"); // routes to the recorded runtime, not a fresh default
    const done = await store.get(rec.id);
    expect(done?.status).toBe("succeeded");
  });

  it("resume returns false for a legacy record with no caseSpec — the caller keeps the tombstone path", async () => {
    const store = new InMemoryRunStore();
    const jobs: CaseJob[] = [];
    const capture: Dispatcher = {
      async dispatch(job) {
        jobs.push(job);
        return resultFor(job);
      },
    };
    const svc = new RunService({ dispatcher: capture, store, newId: ids });
    const legacy: RunRecord = {
      id: "legacy-1",
      tenant: "t",
      harness: { id: "s", version: "0" },
      caseId: "c1",
      status: "running",
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    };
    await store.create(legacy);
    expect(await svc.resume(legacy)).toBe(false);
    expect(jobs).toHaveLength(0);
    expect((await store.get("legacy-1"))?.status).toBe("running"); // untouched — recovery tombstones it
  });
});

describe("RunService — live trace correlation (observability ③)", () => {
  it("stamps the control-plane-minted job runId (evd-run-<record id>) so observers can correlate mid-run", async () => {
    const store = new InMemoryRunStore();
    const jobs: CaseJob[] = [];
    const capture: Dispatcher = {
      async dispatch(job) {
        jobs.push(job);
        return resultFor(job);
      },
    };
    const svc = new RunService({ dispatcher: capture, store, newId: ids });
    const rec = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: CASE });
    await flush();
    expect(jobs[0]?.runId).toBe(`evd-run-${rec.id}`);
  });

  it("get() derives liveTrace while the run is active AND the harness exports a platform trace", async () => {
    const store = new InMemoryRunStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const parking: Dispatcher = {
      async dispatch(job) {
        await gate;
        return resultFor(job);
      },
    };
    const svc = new RunService({
      dispatcher: parking,
      store,
      newId: ids,
      resolveHarness: async () => ({
        kind: "command",
        id: "traced",
        version: "1",
        setup: [],
        command: "run {{task}}",
        env: {},
        params: {},
        trace: { kind: "mlflow", endpoint: "http://mlflow:5000", collect: "control-plane", correlate: "id" },
      }),
    });
    const rec = await svc.submit({ tenant: "t", harness: { id: "traced", version: "1" }, case: CASE });
    const live = await svc.get(rec.id);
    expect(live?.liveTrace).toEqual({ kind: "mlflow", endpoint: "http://mlflow:5000", runId: `evd-run-${rec.id}` });

    release();
    await flush();
    const done = await svc.get(rec.id);
    expect(done?.status).toBe("succeeded");
    expect(done?.liveTrace).toBeUndefined(); // settled — the collected trace/traceRef is the evidence now
  });

  it("a trace:none harness never gets a liveTrace (nothing accumulates anywhere)", async () => {
    const store = new InMemoryRunStore();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const parking: Dispatcher = {
      async dispatch(job) {
        await gate;
        return resultFor(job);
      },
    };
    const svc = new RunService({
      dispatcher: parking,
      store,
      newId: ids,
      resolveHarness: async () => ({
        kind: "command",
        id: "dark",
        version: "1",
        setup: [],
        command: "run",
        env: {},
        params: {},
        trace: { kind: "none" },
      }),
    });
    const rec = await svc.submit({ tenant: "t", harness: { id: "dark", version: "1" }, case: CASE });
    expect((await svc.get(rec.id))?.liveTrace).toBeUndefined();
    release();
    await flush();
  });
});

describe("RunService.screen — browser (topology) live frame (observability ⑦)", () => {
  const browserCase: EvalCase = {
    id: "b1",
    env: { kind: "browser", startUrl: "https://example.com" },
    task: "browse",
    graders: [],
    timeoutSec: 60,
    tags: [],
  };

  it("captures the per-case browser via captureBrowserScreen, keyed by the record-derivable runId", async () => {
    const store = new InMemoryRunStore();
    const seen: string[] = [];
    const svc = new RunService({
      dispatcher: okDispatcher,
      store,
      newId: ids,
      captureBrowserScreen: async (_t, _r, runId) => {
        seen.push(runId);
        return "BROWSERB64";
      },
    });
    const rec = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: browserCase, runtime: "rt" });
    await store.update(rec.id, { status: "running" });
    const out = await svc.screen(rec.id);
    expect(out?.supported).toBe(true);
    expect(out?.dataUrl).toBe("data:image/png;base64,BROWSERB64");
    expect(seen).toEqual([`evd-run-${rec.id}`]); // the standalone-run correlation id
  });

  it("reports unsupported — not an empty frame — when the case declares a browser its lane cannot reach", async () => {
    const store = new InMemoryRunStore();
    const svc = new RunService({
      dispatcher: okDispatcher,
      store,
      newId: ids,
      captureBrowserScreen: async () => undefined, // e.g. a K8s topology, which has no per-case browser rediscovery
    });
    const rec = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: browserCase, runtime: "rt" });
    await store.update(rec.id, { status: "running" });
    const out = await svc.screen(rec.id);
    // The declared env kind used to be taken as proof a screen existed, so the viewer waited for a frame that could
    // never arrive. Support now follows the capture attempt.
    expect(out).toMatchObject({ supported: false, dataUrl: undefined });
  });

  it("captures a service harness's browser even though its case env is prompt (the browser belongs to the topology)", async () => {
    const store = new InMemoryRunStore();
    const svc = new RunService({
      dispatcher: okDispatcher,
      store,
      newId: ids,
      captureBrowserScreen: async () => "SESSIONB64",
    });
    const promptCase: EvalCase = {
      id: "p9",
      env: { kind: "prompt" },
      task: "t",
      graders: [],
      timeoutSec: 60,
      tags: [],
    };
    const rec = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: promptCase, runtime: "rt" });
    await store.update(rec.id, { status: "running" });
    expect(await svc.screen(rec.id)).toMatchObject({ supported: true, dataUrl: "data:image/png;base64,SESSIONB64" });
  });

  it("serves a frame PUSHED by a self-hosted runner for a run whose env has no single-container screen (browser-use)", async () => {
    const store = new InMemoryRunStore();
    const frames = new Map<string, string>();
    const svc = new RunService({
      dispatcher: okDispatcher,
      store,
      newId: ids,
      liveFrame: (runId) => frames.get(runId),
    });
    const promptCase: EvalCase = {
      id: "p1",
      env: { kind: "prompt" },
      task: "t",
      graders: [],
      timeoutSec: 60,
      tags: [],
    };
    const rec = await svc.submit({
      tenant: "t",
      harness: { id: "s", version: "0" },
      case: promptCase,
      runtime: "self:x",
    });
    await store.update(rec.id, { status: "running" });
    // env.kind "prompt" has no CDP/scrot capture path → not supported until the runner pushes a frame.
    expect((await svc.screen(rec.id))?.supported).toBe(false);
    frames.set(`evd-run-${rec.id}`, "PUSHEDB64"); // the runner captured + pushed a frame
    expect(await svc.screen(rec.id)).toMatchObject({ supported: true, dataUrl: "data:image/png;base64,PUSHEDB64" });
  });

  it("a pushed frame short-circuits the env-kind CDP pull (a self-hosted container is unreachable to pull from)", async () => {
    const store = new InMemoryRunStore();
    const frames = new Map<string, string>();
    let pulled = false;
    const svc = new RunService({
      dispatcher: okDispatcher,
      store,
      newId: ids,
      liveFrame: (runId) => frames.get(runId),
      captureBrowserScreen: async () => {
        pulled = true;
        return "PULLED";
      },
    });
    const rec = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: browserCase, runtime: "rt" });
    await store.update(rec.id, { status: "running" });
    frames.set(`evd-run-${rec.id}`, "PUSHEDB64");
    const out = await svc.screen(rec.id);
    expect(out?.dataUrl).toBe("data:image/png;base64,PUSHEDB64");
    expect(pulled).toBe(false); // the pushed frame wins — the CDP pull is never attempted
  });
});

describe("RunService.logs — pushed runner log wins over the backend tail (observability ②)", () => {
  const promptCase: EvalCase = { id: "p1", env: { kind: "prompt" }, task: "t", graders: [], timeoutSec: 60, tags: [] };

  it("serves the log a self-hosted runner PUSHED (report_case_log), keyed by the record-derivable runId", async () => {
    const store = new InMemoryRunStore();
    const pushed = new Map<string, string>();
    let backendTailed = false;
    const svc = new RunService({
      dispatcher: okDispatcher,
      store,
      newId: ids,
      pushLogs: (runId) => pushed.get(runId),
      readCaseLogs: async () => {
        backendTailed = true;
        return "from-backend";
      },
    });
    const rec = await svc.submit({
      tenant: "t",
      harness: { id: "s", version: "0" },
      case: promptCase,
      runtime: "self:x",
    });
    await store.update(rec.id, { status: "running" });
    pushed.set(`evd-run-${rec.id}`, "▶ Started\n✓ Completed");

    const out = await svc.logs(rec.id);
    expect(out?.text).toBe("▶ Started\n✓ Completed");
    expect(backendTailed).toBe(false); // the pushed log short-circuits the backend tail (self-hosted is unreachable)
  });

  it("falls through to the backend tail when nothing was pushed, and for the stderr toggle (a managed-backend concern)", async () => {
    const store = new InMemoryRunStore();
    const svc = new RunService({
      dispatcher: okDispatcher,
      store,
      newId: ids,
      pushLogs: () => undefined, // nothing pushed
      readCaseLogs: async (_t, _r, _c, stream) => `backend:${stream ?? "stdout"}`,
    });
    const rec = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: promptCase, runtime: "rt" });
    await store.update(rec.id, { status: "running" });

    expect((await svc.logs(rec.id))?.text).toBe("backend:stdout"); // no pushed log → backend
    expect((await svc.logs(rec.id, "stderr"))?.text).toBe("backend:stderr"); // a real second stream still wins
  });

  it("serves the pushed log on the stderr view too when the lane has no second stream to offer", async () => {
    const store = new InMemoryRunStore();
    const svc = new RunService({
      dispatcher: okDispatcher,
      store,
      newId: ids,
      pushLogs: () => "▶ Started",
      readCaseLogs: async () => undefined, // self-hosted: no orchestrator job to tail on either stream
    });
    const rec = await svc.submit({
      tenant: "t",
      harness: { id: "s", version: "0" },
      case: promptCase,
      runtime: "self:x",
    });
    await store.update(rec.id, { status: "running" });

    // Empty here would read as "this run wrote nothing to stderr" — a claim about the run, when the truth is that
    // this lane carries a single stream.
    expect((await svc.logs(rec.id, "stderr"))?.text).toBe("▶ Started");
  });
});

describe("RunService — terminal writes are domain-guarded (first terminal write wins)", () => {
  it("a late tracker failure does not overwrite a run that was already settled by adoption", async () => {
    // Given a dispatch that hangs until we release it
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slowFailDispatcher: Dispatcher = {
      async dispatch() {
        await gate;
        throw new Error("late boom");
      },
    };
    const store = new InMemoryRunStore();
    const svc = new RunService({ dispatcher: slowFailDispatcher, store, newId: ids });
    const rec = await svc.submit({ tenant: "acme", harness: { id: "scripted", version: "0" }, case: CASE });

    // When boot-recovery adoption settles the run first…
    const adopted = resultFor({ evalCase: CASE, harness: rec.harness, tenant: "acme" } as CaseJob);
    await svc.resume((await store.get(rec.id)) as RunRecord, adopted);
    // …and the in-flight tracker later fails
    release?.();
    await flush();

    // Then the adopted success is preserved — the late failure is a no-op, not a blind overwrite
    const final = await store.get(rec.id);
    expect(final?.status).toBe("succeeded");
    expect(final?.result).toEqual(adopted);
    expect(final?.error).toBeUndefined();
  });

  it("adoption refuses to rewrite an already-terminal run (resume returns false)", async () => {
    const store = new InMemoryRunStore();
    const svc = new RunService({ dispatcher: okDispatcher, store, newId: ids });
    const rec = await svc.submit({ tenant: "acme", harness: { id: "scripted", version: "0" }, case: CASE });
    await flush(); // normal completion → succeeded

    const before = await store.get(rec.id);
    const late = resultFor({ evalCase: CASE, harness: { id: "scripted", version: "0" }, tenant: "acme" } as CaseJob, 9);
    const outcome = await svc.resume(before as RunRecord, late);
    expect(outcome).toBe(false);
    expect(await store.get(rec.id)).toEqual(before); // untouched
  });
});

// A run whose evidence lives ONLY in the trajectory store (an agent turn: no CaseResult, per O10 — new runs
// write refs, not row embeds) still has to report what it cost. The store's derivation reads `result.trace`,
// which such a run never has, so the executions that actually spend money were reporting no cost at all while
// the invoice knew. The detail read falls back to the sealed evidence.
describe("RunService.get — usage for runs whose evidence is the sealed trajectory", () => {
  const agentRun = (id: string): RunRecord => ({
    id,
    tenant: "acme",
    harness: { id: "assistant", version: "latest" },
    caseId: "chat",
    status: "succeeded",
    kind: "agent",
    createdAt: "t0",
    updatedAt: "t1",
  });

  it("derives cost/tokens from the sealed trajectory when the record carries no result", async () => {
    const store = new InMemoryRunStore();
    const trajectories = new InMemoryTrajectoryStore();
    await store.create(agentRun("run-agent"));
    await trajectories.seal({
      runId: "run-agent",
      tenant: "acme",
      source: "run",
      events: [
        { t: 0, kind: "message", role: "assistant", text: "done" },
        { t: 1, kind: "llm_call", model: "m", cost: { inputTokens: 900, outputTokens: 120, usd: 0.31 } },
      ],
    });
    const svc = new RunService({ dispatcher: okDispatcher, store, trajectories, newId: ids });

    const run = await svc.get("run-agent");
    expect(run?.usage).toEqual({
      promptTokens: 900,
      completionTokens: 120,
      totalTokens: 1020,
      usd: 0.31,
      calls: 1,
    });
  });

  it("leaves usage unset when the sealed evidence has no model call (nothing to price)", async () => {
    const store = new InMemoryRunStore();
    const trajectories = new InMemoryTrajectoryStore();
    await store.create(agentRun("run-quiet"));
    await trajectories.seal({
      runId: "run-quiet",
      tenant: "acme",
      source: "run",
      events: [{ t: 0, kind: "message", role: "user", text: "hi" }],
    });
    const svc = new RunService({ dispatcher: okDispatcher, store, trajectories, newId: ids });

    expect((await svc.get("run-quiet"))?.usage).toBeUndefined();
  });

  it("never reaches for the trajectory when the record already carries a result (the store derived it)", async () => {
    const store = new InMemoryRunStore();
    const trajectories = new InMemoryTrajectoryStore();
    const svc = new RunService({ dispatcher: okDispatcher, store, trajectories, newId: ids });
    const rec = await svc.submit({ tenant: "acme", harness: { id: "scripted", version: "0" }, case: CASE });
    await flush();
    const spy = vi.spyOn(trajectories, "get");

    await svc.get(rec.id);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("RunService — display reads re-mint artifact refs", () => {
  // A store whose stored refs are in-network (what put() returns) and whose public refs are the browser's.
  const artifacts = {
    async put(key: string): Promise<string> {
      return `http://minio:9000/bucket/${key}`;
    },
    async get(): Promise<Uint8Array | undefined> {
      return undefined;
    },
    async publicUrlFor(ref: string): Promise<string | undefined> {
      return ref.startsWith("http://minio:9000/bucket/")
        ? `https://artifacts.example.com/bucket/${ref.slice("http://minio:9000/bucket/".length)}?fresh=1`
        : undefined;
    },
  };

  const shotRun = (id: string): RunRecord => ({
    id,
    tenant: "acme",
    status: "succeeded",
    harness: { id: "h", version: "1" },
    caseId: "c1",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    result: {
      caseId: "c1",
      harness: "h@1",
      trace: [],
      snapshot: { kind: "os-use", screenshot: "", screenshotRef: "http://minio:9000/bucket/runs/r1.png", windows: [] },
      scores: [],
    },
  });

  it("getForDisplay hands the browser a fresh public ref while get() keeps the in-cluster one", async () => {
    // Regression: the detail page rendered `screenshotRef` verbatim, so an outside browser got http://minio:9000 —
    // and an in-cluster consumer must NOT get the public host (the container may have no route to it).
    const store = new InMemoryRunStore();
    await store.create(shotRun("r1"));
    const svc = new RunService({ dispatcher: okDispatcher, store, artifacts, newId: ids });

    const displayed = await svc.getForDisplay("r1");
    const snapshot = displayed?.result?.snapshot;
    expect(snapshot?.kind === "os-use" && snapshot.screenshotRef).toBe(
      "https://artifacts.example.com/bucket/runs/r1.png?fresh=1",
    );
    const internal = (await svc.get("r1"))?.result?.snapshot;
    expect(internal?.kind === "os-use" && internal.screenshotRef).toBe("http://minio:9000/bucket/runs/r1.png");
  });

  it("recording frames are re-minted too (the player draws each frame from its ref), one mint per distinct ref", async () => {
    const store = new InMemoryRunStore();
    const recordings = new InMemoryRecordingStore();
    await store.create(shotRun("r2"));
    const frame = (t: number) => ({
      track: "frames" as const,
      entry: { t, ref: "http://minio:9000/bucket/recordings/a.png" },
    });
    await recordings.append("evd-run-r2", frame(1));
    await recordings.append("evd-run-r2", frame(2));
    await recordings.seal("evd-run-r2", { envKind: "browser" });
    const mint = vi.spyOn(artifacts, "publicUrlFor");
    const svc = new RunService({ dispatcher: okDispatcher, store, recordingStore: recordings, artifacts, newId: ids });

    const out = await svc.recording("r2");
    expect(out?.recording?.tracks.frames?.map((f) => f.ref)).toEqual([
      "https://artifacts.example.com/bucket/recordings/a.png?fresh=1",
      "https://artifacts.example.com/bucket/recordings/a.png?fresh=1",
    ]);
    expect(mint).toHaveBeenCalledTimes(1); // deduped by ref — a static screen is one object, not one per frame
    mint.mockRestore();
  });
});
