import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { type AgentJob, BadRequestError, type CaseResult, type EvalCase, type HarnessSpec } from "@everdict/contracts";
import { InMemoryRecordingStore, InMemoryRunStore, type RunRecord } from "@everdict/db";
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

function resultFor(job: AgentJob, usd = 0): CaseResult {
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
    const jobs: AgentJob[] = [];
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
    const jobs: AgentJob[] = [];
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
    const seen: Array<AgentJob["judge"]> = [];
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
    const seen: Array<AgentJob["repoToken"]> = [];
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
    const jobs: AgentJob[] = [];
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
    const jobs: AgentJob[] = [];
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
    const jobs: AgentJob[] = [];
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
    const jobs: AgentJob[] = [];
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

  it("supported:true but no frame when the browser isn't reachable (dataUrl undefined)", async () => {
    const store = new InMemoryRunStore();
    const svc = new RunService({
      dispatcher: okDispatcher,
      store,
      newId: ids,
      captureBrowserScreen: async () => undefined,
    });
    const rec = await svc.submit({ tenant: "t", harness: { id: "s", version: "0" }, case: browserCase, runtime: "rt" });
    await store.update(rec.id, { status: "running" });
    const out = await svc.screen(rec.id);
    expect(out).toMatchObject({ supported: true, dataUrl: undefined });
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
    expect((await svc.logs(rec.id, "stderr"))?.text).toBe("backend:stderr"); // stderr never uses the pushed (single-stream) log
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
    const adopted = resultFor({ evalCase: CASE, harness: rec.harness, tenant: "acme" } as AgentJob);
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
    const late = resultFor(
      { evalCase: CASE, harness: { id: "scripted", version: "0" }, tenant: "acme" } as AgentJob,
      9,
    );
    const outcome = await svc.resume(before as RunRecord, late);
    expect(outcome).toBe(false);
    expect(await store.get(rec.id)).toEqual(before); // untouched
  });
});
