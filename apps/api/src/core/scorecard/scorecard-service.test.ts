import type { Dispatcher } from "@everdict/backends";
import {
  BadRequestError,
  CURRENT_EVIDENCE_VERSION,
  type CaseJob,
  type CaseResult,
  ConflictError,
  type Dataset,
  ForbiddenError,
  type HarnessSpec,
  type HarnessTemplateSpec,
  type JudgeSpec,
  NotFoundError,
  type RunRecord,
  type Scorecard,
  TRACE_EVAL_REF,
  type TraceEvent,
  UpstreamError,
} from "@everdict/contracts";
import { measuredScores } from "@everdict/contracts";
import {
  InMemoryEnvelopeStore,
  InMemoryPlatformEventStore,
  InMemoryRecordingStore,
  InMemoryRunStore,
  InMemoryScorecardStore,
  InMemoryTrajectoryStore,
  type ScorecardRecord,
} from "@everdict/db";
import {
  CircuitBreaker,
  DEFAULT_VERDICT_POLICY,
  DEFAULT_VERDICT_POLICY_V1,
  type Principal,
  Run,
  composeVerdictPolicy,
  evidenceStatus,
  inMemoryUsageMeter,
  verdictPolicyRef,
} from "@everdict/domain";
import { costGrader, latencyGrader, stepsGrader } from "@everdict/graders";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
  InMemoryJudgeRegistry,
  InMemoryRubricRegistry,
} from "@everdict/registry";
import { InMemoryArtifactStore } from "@everdict/storage";
import type { TraceSource, TraceSourceConfig } from "@everdict/trace";
import { afterEach, describe, expect, it, vi } from "vitest";

// Trace-only grader factory injected into the ingest path (re-architecture P2 S4) — the application layer never
// imports @everdict/graders, so the composition side supplies the steps/cost/latency graders the ingest re-derives.
const defaultTraceGraders = () => [stepsGrader, costGrader, latencyGrader];
import type { CaseExportStream, JudgeRunner } from "@everdict/application-control";
import { ScorecardService } from "@everdict/application-control";

const dispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("unused in diff tests");
  },
};

// One tests-pass score per case. Flip pass to create a regression/improvement.
const caseResult = (pass: boolean): CaseResult => ({
  caseId: "c1",
  harness: "h@1",
  trace: [],
  snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
  scores: [{ graderId: "tests-pass", metric: "tests-pass", value: pass ? 1 : 0, pass }],
});

const record = (id: string, over: Partial<ScorecardRecord> = {}): ScorecardRecord => ({
  id,
  tenant: "acme",
  dataset: { id: "d", version: "1.0.0" },
  harness: { id: "h", version: "1" },
  status: "succeeded",
  createdAt: "2026-06-19T00:00:00.000Z",
  updatedAt: "2026-06-19T00:00:00.000Z",
  ...over,
});

const scorecard = (pass: boolean): Scorecard => ({ suiteId: "d", harness: "h@1", results: [caseResult(pass)] });

function svc(store: InMemoryScorecardStore): ScorecardService {
  return new ScorecardService({ dispatcher, store, datasets: new InMemoryDatasetRegistry() });
}

describe("ScorecardService.submit — requireRuntime policy (no local fallback)", () => {
  const input = (over: Record<string, unknown> = {}) => ({
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    ...over,
  });
  const build = (requireRuntime: boolean) =>
    new ScorecardService({
      dispatcher,
      store: new InMemoryScorecardStore(),
      datasets: new InMemoryDatasetRegistry(),
      requireRuntime,
    });

  it("policy ON + no runtime → 400 (BadRequest) — fail-fast before resolving the dataset", async () => {
    await expect(build(true).submit(input())).rejects.toBeInstanceOf(BadRequestError);
  });

  it("policy ON + a runtime (registered runtime/self) passes the gate — proceeds to the next step (NotFound because the dataset is missing)", async () => {
    // NotFound rather than BadRequest = proof it passed the runtime gate (the gate only checks that a target exists).
    await expect(build(true).submit(input({ runtime: "self:laptop" }))).rejects.toBeInstanceOf(NotFoundError);
  });

  it("policy OFF (dev) passes the gate without a runtime (existing behavior unchanged)", async () => {
    await expect(build(false).submit(input())).rejects.toBeInstanceOf(NotFoundError);
  });
});

// A harnesses port whose get() rejects — models a REGISTERED harness whose stored spec fails to resolve (a malformed
// target/delivery, a bad pin). Such a spec can't be created through the real registry (it validates on register), so
// the fake throws directly. Extends the in-memory impl to satisfy the whole port with a one-method override.
class ThrowingHarnessRegistry extends InMemoryHarnessInstanceRegistry {
  constructor(private readonly err: Error) {
    super(new InMemoryHarnessTemplateRegistry());
  }
  override get() {
    return Promise.reject(this.err);
  }
}

describe("ScorecardService.submit — registered harness spec resolution (regression)", () => {
  const okDispatch: Dispatcher = {
    async dispatch(job) {
      return {
        caseId: job.evalCase.id,
        harness: `${job.harness.id}@${job.harness.version}`,
        trace: [],
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
        scores: [],
      };
    },
  };

  it("a registered harness whose spec fails to resolve → 400 (BadRequest), not a silent spec-less dispatch", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      harnesses: new ThrowingHarnessRegistry(
        new BadRequestError("BAD_REQUEST", {}, "Invalid discriminator value at target.delivery.mode."),
      ),
      newId: () => "sc-badspec",
    });
    // Pre-fix: the resolve error was swallowed (treated as built-in), the batch ran with NO spec embedded, no error.
    await expect(
      service.submit({ tenant: "acme", dataset: { id: "d", version: "1.0.0" }, harness: { id: "svc", version: "1" } }),
    ).rejects.toBeInstanceOf(BadRequestError);
    expect(await store.get("sc-badspec")).toBeUndefined(); // failed fast — before a queued record was even persisted
  });

  it("a raw (non-AppError) resolve failure is remapped into our error model (never propagated bare)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const service = new ScorecardService({
      dispatcher,
      store: new InMemoryScorecardStore(),
      datasets,
      harnesses: new ThrowingHarnessRegistry(
        new Error("Invalid discriminator value. Expected 'reference' | 'sentinel' | 'egress'"),
      ),
      newId: () => "sc-raw",
    });
    await expect(
      service.submit({ tenant: "acme", dataset: { id: "d", version: "1.0.0" }, harness: { id: "svc", version: "1" } }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("an unregistered/built-in harness (NotFound) still dispatches as-given, no spec embedded", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      datasets,
      harnesses: new ThrowingHarnessRegistry(new NotFoundError("NOT_FOUND", {}, "harness 'scripted' not found.")),
      newId: () => "sc-builtin",
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    const rec = await waitTerminal(store, "sc-builtin");
    expect(rec.status).toBe("succeeded"); // NotFound stays swallowed — the built-in fall-through is preserved
  });
});

describe("ScorecardService.submit — judge version pinning (reproducibility)", () => {
  const okDispatch: Dispatcher = {
    async dispatch(job) {
      return {
        caseId: job.evalCase.id,
        harness: `${job.harness.id}@${job.harness.version}`,
        trace: [],
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
        scores: [],
      };
    },
  };
  const modelJudge = (version: string): JudgeSpec => ({
    kind: "model",
    id: "quality",
    version,
    provider: "anthropic",
    model: "claude-opus-4-8",
    rubric: "good?",
    inputs: ["trace"],
    tags: [],
  });

  it("resolves a selected judge's 'latest' to the concrete version and records it — a re-run scores with the SAME judge", async () => {
    // Regression: orchestration.judges used to store the ref as-given, so a later re-run/schedule resolved "latest"
    // again → possibly a different judge version → a different verdict. Harness/dataset were pinned; judges were not.
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", modelJudge("1.0.0"));
    await judges.register("acme", modelJudge("2.0.0")); // latest
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({ dispatcher: okDispatch, store, datasets, judges, newId: () => "sc-pin" });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      judges: [{ id: "quality", version: "latest" }],
    });
    const rec = await waitTerminal(store, "sc-pin");
    expect(rec.orchestration?.judges).toEqual([{ id: "quality", version: "2.0.0" }]); // concrete, never "latest"
    // The manifest seals the CLOSURE: a raw-string model binding is already concrete and rides verbatim.
    expect(rec.manifest?.judges?.[0]).toMatchObject({ id: "quality", version: "2.0.0", model: "claude-opus-4-8" });
  });

  it("seals a judge's REF binding to its resolved concrete version — same spec digest, no moving target", async () => {
    // A spec pinning {ref} with no version is a byte-identical document over a moving target: the manifest
    // must seal what the ref RESOLVED TO at submit, or two batches under one spec digest can be judged by
    // different models while identity reads held. The runtime judge config is sealed the same way.
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", {
      kind: "model",
      id: "quality",
      version: "1.0.0",
      provider: "anthropic",
      model: { ref: "judge-default" },
      rubric: "good?",
      inputs: ["trace"],
      tags: [],
    });
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      datasets,
      judges,
      resolveModelBinding: async (_tenant, binding) => `${binding.ref}@5.0.0`,
      newId: () => "sc-closure",
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      judges: [{ id: "quality", version: "1.0.0" }],
      judge: { provider: "anthropic", model: { ref: "judge-default" } },
    });
    const rec = await waitTerminal(store, "sc-closure");
    expect(rec.manifest?.judges?.[0]?.model).toBe("judge-default@5.0.0");
    expect(rec.manifest?.judgeRun).toEqual({ provider: "anthropic", model: "judge-default@5.0.0" });
  });

  it("an unresolvable binding seals the honest sentinel — never a silent sameness claim", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", {
      kind: "model",
      id: "quality",
      version: "1.0.0",
      provider: "anthropic",
      model: { ref: "judge-default" },
      rubric: "good?",
      inputs: ["trace"],
      tags: [],
    });
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      datasets,
      judges, // no resolveModelBinding wired
      newId: () => "sc-unresolved",
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      judges: [{ id: "quality", version: "1.0.0" }],
    });
    const rec = await waitTerminal(store, "sc-unresolved");
    expect(rec.manifest?.judges?.[0]?.model).toBe("unresolved");
  });

  it("keeps an unknown judge id as-given (the scoring path skips a missing judge, unchanged)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      datasets,
      judges: new InMemoryJudgeRegistry(),
      newId: () => "sc-unknown",
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      judges: [{ id: "ghost", version: "latest" }],
    });
    const rec = await waitTerminal(store, "sc-unknown");
    expect(rec.orchestration?.judges).toEqual([{ id: "ghost", version: "latest" }]); // kept as-given
  });
});

describe("ScorecardService.moveToTeam — evidence is re-filed, and both teams are checked", () => {
  const member = (teams: string[]): Principal => ({
    subject: "alice",
    workspace: "acme",
    roles: ["member"],
    via: "oidc",
    teams,
  });

  it("re-files the batch and reports the team it came from", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("sc1", { teamId: "team_eng" }));

    const moved = await svc(store).moveToTeam({
      principal: member(["team_eng", "team_platform"]),
      id: "sc1",
      teamId: "team_platform",
    });

    expect(moved.teamId).toBe("team_platform");
    expect((await store.get("sc1"))?.teamId).toBe("team_platform");
  });

  it("refuses a source team the caller is not on — a batch cannot be taken out of someone else's team", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("sc1", { teamId: "team_eng" }));

    await expect(
      svc(store).moveToTeam({ principal: member(["team_platform"]), id: "sc1", teamId: "team_platform" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect((await store.get("sc1"))?.teamId).toBe("team_eng"); // nothing moved
  });

  it("refuses a destination team the caller is not on", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("sc1", { teamId: "team_eng" }));

    await expect(
      svc(store).moveToTeam({ principal: member(["team_eng"]), id: "sc1", teamId: "team_secret" }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("another workspace's / a missing batch is 404, and a move that changes nothing is 409", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("sc1", { teamId: "team_eng" }));
    await store.create(record("theirs", { tenant: "beta", teamId: "team_eng" }));
    const service = svc(store);
    const alice = member(["team_eng"]);

    await expect(service.moveToTeam({ principal: alice, id: "nope", teamId: "team_eng" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(service.moveToTeam({ principal: alice, id: "theirs", teamId: "team_eng" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(service.moveToTeam({ principal: alice, id: "sc1", teamId: "team_eng" })).rejects.toBeInstanceOf(
      ConflictError,
    );
  });

  it("records the transfer as a fact on the same write as the ownership change (E0 outbox)", async () => {
    const log = new InMemoryPlatformEventStore();
    const store = new InMemoryScorecardStore(log);
    await store.create(record("sc1", { teamId: "team_eng" }));

    await new ScorecardService({ dispatcher, store, datasets: new InMemoryDatasetRegistry() }).moveToTeam({
      principal: member(["team_eng", "team_platform"]),
      id: "sc1",
      teamId: "team_platform",
    });

    const moved = (await log.list("acme")).find((e) => e.kind === "scorecard.moved");
    expect(moved).toMatchObject({
      kind: "scorecard.moved",
      subject: { type: "scorecard", id: "sc1" },
      payload: { id: "sc1", from: "team_eng", to: "team_platform" },
    });
  });
});

describe("ScorecardService — constitution seed (verdict-authority declarations)", () => {
  it("a member declaring ground_truth authority for a run-time grader is refused; an admin passes and the composed policy is sealed", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({ dispatcher, store, datasets });
    const base = {
      tenant: "acme",
      dataset: { id: datasetWithCase().id, version: datasetWithCase().version },
      harness: { id: "scripted", version: "0" },
      graders: [{ id: "custom_state", authority: "ground_truth" as const }],
    };
    // member: refused — whoever can name new ground truth decides what passing MEANS
    await expect(service.submit({ ...base, submitterRoles: ["member"] })).rejects.toThrow(/admin/);
    // admin: accepted, and the COMPOSED policy document is sealed into the manifest (re-derivable forever)
    const record = await service.submit({ ...base, submitterRoles: ["admin"] });
    expect(record.manifest?.verdictPolicy?.id).toBe("composed");
    expect(
      record.manifest?.verdictPolicy?.metrics.some(
        (d) => "metric" in d.match && d.match.metric === "custom_state" && d.authority === "ground_truth",
      ),
    ).toBe(true);
  });
});

describe("ScorecardService.diff", () => {
  it("REFUSES while a scoring pass is live or abandoned on either side — the plane between revisions is not comparable (I3)", async () => {
    // Pre-fix, a re-score's strip-first window (and a FAILED Temporal pass, which nothing settles) left a
    // persisted plane belonging to NO completed revision — and diff/gate read it as if it were one.
    const store = new InMemoryScorecardStore();
    const pass = {
      targetRevision: 2,
      baseRevision: 1,
      judges: [{ id: "quality", version: "2.0.0" }],
      startedAt: "2026-08-09T00:00:00.000Z",
      status: "running" as const,
    };
    await store.create(record("base", { scorecard: scorecard(true) }));
    await store.create(record("cand", { scorecard: scorecard(false), scoringPass: pass }));
    await expect(svc(store).diff("acme", "base", "cand")).rejects.toThrow(/between revisions/);
    // The abandoned shape refuses with its own honest message — broken evidence, not a readable revision.
    await store.create(
      record("cand2", {
        scorecard: scorecard(false),
        scoringPass: { ...pass, status: "failed" as const, failure: "worker died" },
      }),
    );
    await expect(svc(store).diff("acme", "base", "cand2")).rejects.toThrow(/ABANDONED scoring pass/);
  });

  it("reports pass transitions as regression/improvement", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("base", { scorecard: scorecard(true) }));
    await store.create(record("cand", { scorecard: scorecard(false) }));
    const diff = await svc(store).diff("acme", "base", "cand");
    expect(diff.regressions).toEqual([
      { caseId: "c1", metric: "tests-pass", baseline: 1, candidate: 0, delta: -1, passChange: "broke" },
    ]);
    expect(diff.improvements).toEqual([]);
    expect(diff.metrics).toContainEqual({
      metric: "tests-pass",
      baselineMean: 1,
      candidateMean: 0,
      delta: -1,
      reading: "unknown", // "tests-pass" (grader-id spelling) has no declared direction — sign is not a verdict
    });
    expect(diff.comparability).toBe("full");
  });

  it("refuses to compare batches judged under different verdict-policy digests (injection: policy changed between runs)", async () => {
    // Both stamps RESOLVE (each batch carries its composed document) — they simply resolve to different
    // documents, which is the mismatch this test is about. An unrestorable stamp is the other refusal below.
    const basePolicy = composeVerdictPolicy([{ id: "schema_valid", authority: "objective" }]);
    const candPolicy = composeVerdictPolicy([{ id: "schema_valid", authority: "ground_truth" }]);
    const manifestFor = (p: typeof basePolicy) => ({
      dataset: { id: "d", version: "1.0.0", digest: "dd" },
      harness: { id: "h", version: "1" },
      verdictPolicy: p,
    });
    const store = new InMemoryScorecardStore();
    await store.create(
      record("base", {
        scorecard: scorecard(true),
        verdictPolicy: verdictPolicyRef(basePolicy),
        manifest: manifestFor(basePolicy),
      }),
    );
    await store.create(
      record("cand", {
        scorecard: scorecard(false),
        verdictPolicy: verdictPolicyRef(candPolicy),
        manifest: manifestFor(candPolicy),
      }),
    );
    const diff = await svc(store).diff("acme", "base", "cand");
    // Verdicts produced by different rules are not one experiment — "no differences" is not the claim here.
    expect(diff.comparability).toBe("none");
    expect(diff.policyMismatch).toEqual({
      baseline: verdictPolicyRef(basePolicy),
      candidate: verdictPolicyRef(candPolicy),
    });
    expect(diff.policyUnresolvable).toBeUndefined();
  });

  // A case scoring one custom metric — the axis a run-time grader DECLARES authority/direction for.
  const declaredCase = (metric: string, value: number, pass?: boolean): CaseResult => ({
    caseId: "c1",
    harness: "h@1",
    trace: [],
    snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
    scores: [{ graderId: metric, metric, value, ...(pass !== undefined ? { pass } : {}) }],
  });
  const declaredManifest = (policy: ReturnType<typeof composeVerdictPolicy>) => ({
    dataset: { id: "d", version: "1.0.0", digest: "dd" },
    harness: { id: "h", version: "1" },
    verdictPolicy: policy,
  });

  it("reads a metric's delta through the DIRECTION the batch's own grader declared", async () => {
    // Given both batches judged under a composed policy where tokens_used is declared lower_is_better.
    const policy = composeVerdictPolicy([
      { id: "tokens_used", authority: "observational", direction: "lower_is_better" },
    ]);
    const stamp = verdictPolicyRef(policy);
    const store = new InMemoryScorecardStore();
    for (const [id, value] of [
      ["base", 100],
      ["cand", 50],
    ] as const) {
      await store.create(
        record(id, {
          scorecard: { suiteId: "d", harness: "h@1", results: [declaredCase("tokens_used", value)] },
          verdictPolicy: stamp,
          manifest: declaredManifest(policy),
        }),
      );
    }
    // When the two are compared, the halved token count reads as an IMPROVEMENT, not an unknown sign.
    // Pre-fix the service called diffScorecards with no policy at all, so the declared direction was dropped
    // and every custom metric's delta read "unknown" — a declaration the batch paid to record and never used.
    const diff = await svc(store).diff("acme", "base", "cand");
    expect(diff.metrics.find((m) => m.metric === "tokens_used")).toMatchObject({
      delta: -50,
      direction: "lower_is_better",
      reading: "improved",
    });
  });

  it("FNV-era and sha256-era stamps of the SAME policy document are ONE policy — never a mismatch", async () => {
    // Regression: the mismatch was decided on raw digest strings, so a batch settled in the FNV window and a
    // batch settled after the sha256 switch — both judged under the identical v1 ladder — read as "different
    // policies" and the comparison refused as not holding. The resolver dual-reads both eras; the mismatch
    // must compare the RESOLVED documents' canonical identity.
    const legacyFnvOf = (document: unknown): string => {
      const canonicalize = (value: unknown): string => {
        if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
        if (value !== null && typeof value === "object")
          return `{${Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v !== undefined)
            .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
            .join(",")}}`;
        return JSON.stringify(value);
      };
      const text = canonicalize(document);
      let hash = 0xcbf29ce484222325n;
      for (let i = 0; i < text.length; i++) {
        hash ^= BigInt(text.charCodeAt(i));
        hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
      }
      return hash.toString(16).padStart(16, "0");
    };
    const store = new InMemoryScorecardStore();
    await store.create(
      record("base", {
        scorecard: scorecard(true),
        verdictPolicy: {
          id: DEFAULT_VERDICT_POLICY_V1.id,
          version: DEFAULT_VERDICT_POLICY_V1.version,
          digest: legacyFnvOf(DEFAULT_VERDICT_POLICY_V1), // sealed in the FNV window
        },
      }),
    );
    await store.create(
      record("cand", { scorecard: scorecard(false), verdictPolicy: verdictPolicyRef(DEFAULT_VERDICT_POLICY_V1) }),
    );
    const diff = await svc(store).diff("acme", "base", "cand");
    expect(diff.policyMismatch).toBeUndefined();
    expect(diff.policyUnresolvable).toBeUndefined();
    expect(diff.comparability).toBe("full"); // the real regression below is readable, not refused
    expect(diff.caseTransitions.find((t) => t.caseId === "c1")?.change).toBe("broke");
  });

  it("a stamped policy that cannot be restored makes the comparison NOT hold — never a default re-judgement", async () => {
    // Given a batch stamped with a COMPOSED policy but no manifest to restore it from (the list-path shape).
    const policy = composeVerdictPolicy([{ id: "schema_valid", authority: "objective" }]);
    const stamp = verdictPolicyRef(policy);
    const store = new InMemoryScorecardStore();
    await store.create(record("base", { scorecard: scorecard(true) }));
    await store.create(record("cand", { scorecard: scorecard(false), verdictPolicy: stamp }));
    const diff = await svc(store).diff("acme", "base", "cand");
    expect(diff.comparability).toBe("none");
    expect(diff.policyUnresolvable).toEqual({ candidate: stamp });
  });

  it("missing / other-workspace scorecard → NotFoundError (404)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("base", { scorecard: scorecard(true) }));
    await store.create(record("other", { tenant: "beta", scorecard: scorecard(true) }));
    await expect(svc(store).diff("acme", "base", "nope")).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc(store).diff("acme", "base", "other")).rejects.toBeInstanceOf(NotFoundError); // other workspace
  });

  it("not completed (no scorecard) → BadRequestError (400)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("base", { scorecard: scorecard(true) }));
    await store.create(record("queued", { status: "queued" }));
    await expect(svc(store).diff("acme", "base", "queued")).rejects.toBeInstanceOf(BadRequestError);
  });

  // N trials of case c1, the first `passes` passing.
  const trialCard = (harness: string, passes: number, n: number): Scorecard => ({
    suiteId: "d",
    harness,
    results: Array.from(
      { length: n },
      (_, i): CaseResult => ({
        caseId: "c1",
        harness,
        trial: i,
        trace: [],
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
        scores: [{ graderId: "tests-pass", metric: "tests_pass", value: i < passes ? 1 : 0, pass: i < passes }],
      }),
    ),
  });

  it("attaches a statistically-gated trial diff — a significant pass-rate collapse (5/5 → 0/5) is a regression", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("base", { scorecard: trialCard("h@1", 5, 5) }));
    await store.create(record("cand", { scorecard: trialCard("h@2", 0, 5) }));
    const diff = await svc(store).diff("acme", "base", "cand");
    expect(diff.trials?.regressions.map((r) => r.caseId)).toEqual(["c1"]);
    expect(diff.trials?.cases[0]?.significant).toBe(true);
  });

  it("a within-noise trial drop (3/5 → 2/5) is NOT flagged as a trial regression", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("base", { scorecard: trialCard("h@1", 3, 5) }));
    await store.create(record("cand", { scorecard: trialCard("h@2", 2, 5) }));
    const diff = await svc(store).diff("acme", "base", "cand");
    expect(diff.trials?.regressions).toEqual([]);
    expect(diff.trials?.cases[0]?.significant).toBe(false);
  });

  it("a single-run diff carries no trials field (backward compatible)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("base", { scorecard: scorecard(true) }));
    await store.create(record("cand", { scorecard: scorecard(false) }));
    const diff = await svc(store).diff("acme", "base", "cand");
    expect(diff.trials).toBeUndefined();
  });
});

describe("ScorecardService.leaderboard", () => {
  // A completed scorecard with a judge passRate + primary model.
  const scored = (id: string, harnessVersion: string, model: string, passRate: number): Partial<ScorecardRecord> => ({
    harness: { id: "h", version: harnessVersion },
    summary: [{ metric: "judge", count: 10, mean: passRate, passRate }],
    models: { observed: [model], primary: model },
  });

  it("ranks a dataset's (harness × model) descending by metric and scopes to the workspace", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("a", scored("a", "1", "gpt-5", 0.6)));
    await store.create(record("b", scored("b", "2", "claude-opus-4-8", 0.9)));
    await store.create(record("other", { ...scored("other", "2", "x", 1.0), tenant: "beta" })); // other workspace
    const lb = await svc(store).leaderboard("acme", { datasetId: "d", metric: "judge" });
    expect(lb.rows.map((r) => [r.rank, r.harness.version, r.model, r.score])).toEqual([
      [1, "2", "claude-opus-4-8", 0.9],
      [2, "1", "gpt-5", 0.6],
    ]);
    expect(lb.rows.some((r) => r.model === "x")).toBe(false); // beta workspace excluded
  });
});

describe("ScorecardService.analysis — flexible pivot", () => {
  const scored = (id: string, harnessId: string, passRate: number): Partial<ScorecardRecord> => ({
    harness: { id: harnessId, version: "1" },
    summary: [{ metric: "judge", count: 10, mean: passRate, passRate }],
  });

  const config = {
    filters: {},
    groupBy: ["harness" as const],
    measure: "passRate" as const,
    sort: { by: "measure" as const, dir: "desc" as const },
    viz: "table" as const,
  };

  it("groups the workspace's scorecards by dimension and scopes out other workspaces", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("a", scored("a", "h1", 0.4)));
    await store.create(record("b", scored("b", "h2", 0.9)));
    await store.create(record("other", { ...scored("other", "h3", 1.0), tenant: "beta" }));
    const result = await svc(store).analysis("acme", config);
    if (result.kind !== "grid") throw new Error("expected grid");
    expect(result.rows.map((r) => [r.labels[0], r.value])).toEqual([
      ["h2", 0.9],
      ["h1", 0.4],
    ]);
    expect(result.total).toBe(2); // beta workspace excluded
  });

  it("a line viz buckets by the time dimension", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("a", { ...scored("a", "h1", 0.5), createdAt: "2026-06-01T00:00:00.000Z" }));
    await store.create(record("b", { ...scored("b", "h1", 0.7), createdAt: "2026-06-02T00:00:00.000Z" }));
    const result = await svc(store).analysis("acme", { ...config, groupBy: ["day"], viz: "line" });
    if (result.kind !== "line") throw new Error("expected line");
    expect(result.buckets).toEqual(["2026-06-01", "2026-06-02"]);
    expect(result.series[0]?.points).toEqual([0.5, 0.7]);
  });
});

describe("ScorecardService.getForDisplay — case snapshots the browser can open", () => {
  const artifacts = {
    async put(key: string): Promise<string> {
      return `http://minio:9000/bucket/${key}`;
    },
    async get(): Promise<Uint8Array | undefined> {
      return undefined;
    },
    async publicUrlFor(ref: string): Promise<string | undefined> {
      return ref.startsWith("http://minio:9000/")
        ? `${ref.replace("http://minio:9000", "https://cdn.example")}&fresh`
        : undefined;
    },
  };
  const withShot = (id: string): ScorecardRecord =>
    record(id, {
      status: "succeeded",
      scorecard: {
        suiteId: "d",
        harness: "h@1",
        results: [
          {
            caseId: "c1",
            harness: "h@1",
            trace: [],
            snapshot: {
              kind: "os-use",
              screenshot: "",
              screenshotRef: "http://minio:9000/bucket/scorecards/sc/c1.png?sig=old",
              windows: [],
            },
            scores: [],
          },
        ],
      },
    });

  it("re-mints each case's screenshotRef for the viewer, while get() keeps the in-cluster ref", async () => {
    // Regression: the detail page rendered the stored ref, which is signed for http://minio:9000 and expired.
    const store = new InMemoryScorecardStore();
    await store.create(withShot("sc"));
    const service = new ScorecardService({ dispatcher, store, datasets: new InMemoryDatasetRegistry(), artifacts });

    const shown = (await service.getForDisplay("sc"))?.scorecard?.results[0]?.snapshot;
    expect(shown?.kind === "os-use" && shown.screenshotRef).toBe(
      "https://cdn.example/bucket/scorecards/sc/c1.png?sig=old&fresh",
    );
    const internal = (await service.get("sc"))?.scorecard?.results[0]?.snapshot;
    expect(internal?.kind === "os-use" && internal.screenshotRef).toBe(
      "http://minio:9000/bucket/scorecards/sc/c1.png?sig=old",
    );
  });
});

describe("ScorecardService.analysisBundle — offloaded analysis fetch", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("returns 404-shaped NotFound when the record has no fetchable (http) analysisRef", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("none"));
    await store.create(record("mem", { analysisRef: "memory://analyses/mem.json" }));
    await expect(svc(store).analysisBundle("acme", "none")).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc(store).analysisBundle("acme", "mem")).rejects.toBeInstanceOf(NotFoundError);
    await expect(svc(store).analysisBundle("acme", "missing")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("another workspace's record reads NotFound (no existence leak) even with a ref", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("theirs", { tenant: "beta", analysisRef: "https://s3/analyses/theirs.json" }));
    await expect(svc(store).analysisBundle("acme", "theirs")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("reads the artifact by KEY from the store — never by replaying the stored (presigned, internal) ref", async () => {
    // Regression: the ref `put` returned is a presigned URL on the SERVER-internal endpoint. An hour later it answers
    // 403, so a scorecard from yesterday used to have an undownloadable analysis (and the browser could never resolve
    // `minio:9000` anyway). The read side derives the key from the id instead.
    const bundle = { scorecardId: "sc", dataset: "d@1", harness: "h@1", summary: [], cases: [] };
    const artifacts = new InMemoryArtifactStore();
    await artifacts.put("analyses/sc.json", Buffer.from(JSON.stringify(bundle)), "application/json");
    const expired = vi.fn(async () => new Response("expired", { status: 403 }));
    vi.stubGlobal("fetch", expired);
    const store = new InMemoryScorecardStore();
    await store.create(
      record("sc", { analysisRef: "http://minio:9000/everdict-artifacts/analyses/sc.json?X-Amz-Signature=stale" }),
    );
    const service = new ScorecardService({ dispatcher, store, datasets: new InMemoryDatasetRegistry(), artifacts });
    await expect(service.analysisBundle("acme", "sc")).resolves.toEqual(bundle);
    expect(expired).not.toHaveBeenCalled();
  });

  it("falls back to the ref when this deployment's store doesn't hold the artifact", async () => {
    const bundle = { scorecardId: "sc", dataset: "d@1", harness: "h@1", summary: [], cases: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(bundle), { status: 200 })),
    );
    const store = new InMemoryScorecardStore();
    await store.create(record("sc", { analysisRef: "https://elsewhere.example/analyses/sc.json" }));
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets: new InMemoryDatasetRegistry(),
      artifacts: new InMemoryArtifactStore(), // wired, but empty
    });
    await expect(service.analysisBundle("acme", "sc")).resolves.toEqual(bundle);
  });

  it("fetches an http ref server-side and returns the parsed bundle", async () => {
    const bundle = { scorecardId: "sc", dataset: "d@1", harness: "h@1", summary: [], cases: [] };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(bundle), { status: 200 })),
    );
    const store = new InMemoryScorecardStore();
    await store.create(record("sc", { analysisRef: "https://s3.example/analyses/sc.json" }));
    await expect(svc(store).analysisBundle("acme", "sc")).resolves.toEqual(bundle);
  });

  it("a non-ok upstream response is remapped to UpstreamError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("expired", { status: 403 })),
    );
    const store = new InMemoryScorecardStore();
    await store.create(record("sc", { analysisRef: "https://s3.example/analyses/sc.json" }));
    await expect(svc(store).analysisBundle("acme", "sc")).rejects.toBeInstanceOf(UpstreamError);
  });
});

describe("ScorecardService.backfillModels", () => {
  // A completed scorecard with an observed model in the trace (no models field, like an old record).
  const scWithModel = (model: string): Scorecard => ({
    suiteId: "d",
    harness: "h@1",
    results: [
      {
        caseId: "c1",
        harness: "h@1",
        trace: [{ t: 0, kind: "llm_call", model }],
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
        scores: [],
      },
    ],
  });

  it("fills succeeded records lacking models from stored-trace observations (idempotent; skips incomplete / existing models)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("old", { scorecard: scWithModel("gpt-4o") })); // no models
    await store.create(record("queued", { status: "queued" })); // no output → skip
    await store.create(
      record("already", { scorecard: scWithModel("o3"), models: { observed: ["o3"], primary: "o3" } }),
    );

    const res = await svc(store).backfillModels("acme");
    expect(res.updated).toBe(1); // old only
    expect((await store.get("old"))?.models?.primary).toBe("gpt-4o");

    // idempotent: the second run has nothing to fill.
    expect((await svc(store).backfillModels("acme")).updated).toBe(0);
  });
});

// A dataset with a single case (c1). The target for pull-ingest ordering.
const datasetWithCase = (): Dataset => ({
  id: "d",
  version: "1.0.0",
  cases: [
    {
      id: "c1",
      env: { kind: "repo", source: { files: { "a.txt": "x" } } },
      task: "do",
      graders: [],
      timeoutSec: 1800,
      tags: [],
    },
  ],
  tags: [],
});

// Poll until the background trackPull finishes (terminal status).
async function waitTerminal(store: InMemoryScorecardStore, id: string): Promise<ScorecardRecord> {
  for (let i = 0; i < 50; i++) {
    const rec = await store.get(id);
    if (rec && (rec.status === "succeeded" || rec.status === "failed")) return rec;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("pull ingest did not finish");
}

describe("ScorecardService.rerun — full re-run of a finished batch (전체 재실행)", () => {
  // Dispatch returns a scored result so the background track settles cleanly (the assertions read the
  // synchronously-created new record either way).
  const okDispatch: Dispatcher = {
    async dispatch(job) {
      return {
        caseId: job.evalCase.id,
        harness: `${job.harness.id}@${job.harness.version}`,
        trace: [],
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
        scores: [{ graderId: "tests-pass", metric: "tests-pass", value: 1, pass: true }],
      };
    },
  };

  // A finished source batch whose config the re-run must reproduce — a CI-triggered PR run (repo/prNumber origin),
  // a subset, a selected judge, and a grading plan.
  const seedSrc = async (store: InMemoryScorecardStore, over: Partial<ScorecardRecord> = {}) => {
    const src = record("src-1", {
      status: "succeeded",
      runtime: "self:laptop",
      origin: { source: "github-actions", repo: "acme/app", prNumber: 7 },
      subset: { total: 3, selected: 1, ids: ["c1"] },
      orchestration: {
        judges: [{ id: "j", version: "1" }],
        concurrency: 2,
        retries: 1,
        graders: [{ id: "tests-pass" }],
      },
      ...over,
    });
    await store.create(src);
    return src;
  };

  const build = (store: InMemoryScorecardStore) => {
    const datasets = new InMemoryDatasetRegistry();
    let n = 0;
    const service = new ScorecardService({ dispatcher: okDispatch, store, datasets, newId: () => `new-${n++}` });
    return { datasets, service };
  };

  it("clones the record's config into a NEW scorecard (retryOf lineage) and does NOT inherit the PR — so a manual re-run never supersedes the PR's in-flight batches", async () => {
    const store = new InMemoryScorecardStore();
    await seedSrc(store);
    const { datasets, service } = build(store);
    await datasets.register("acme", datasetWithCase());

    const created = await service.rerun({ tenant: "acme", id: "src-1", submittedBy: "alice" });

    expect(created.id).toBe("new-0"); // a fresh record, not a mutation of the source
    expect(created.origin?.retryOf).toBe("src-1"); // lineage kept
    expect(created.origin?.repo).toBeUndefined(); // PR provenance deliberately dropped …
    expect(created.origin?.prNumber).toBeUndefined(); // … so submit's PR-supersede never fires for a manual re-run
    // Config reproduced faithfully.
    expect(created.dataset).toEqual({ id: "d", version: "1.0.0" });
    expect(created.runtime).toBe("self:laptop");
    expect(created.subset?.ids).toEqual(["c1"]);
    expect(created.orchestration?.judges).toEqual([{ id: "j", version: "1" }]);
    expect(created.orchestration?.concurrency).toBe(2);
    expect(created.orchestration?.graders).toEqual([{ id: "tests-pass" }]); // original grading plan inherited
    expect(created.createdBy).toBe("alice");
    // The source record is never mutated.
    expect((await store.get("src-1"))?.status).toBe("succeeded");
  });

  it("applies run-config overrides (selected judges / runtime) to the new batch while reproducing the original scoring", async () => {
    const store = new InMemoryScorecardStore();
    await seedSrc(store);
    const { datasets, service } = build(store);
    await datasets.register("acme", datasetWithCase());

    const created = await service.rerun({
      tenant: "acme",
      id: "src-1",
      judges: [{ id: "k", version: "latest" }],
      runtime: "rt-cloud",
    });

    expect(created.orchestration?.judges).toEqual([{ id: "k", version: "latest" }]); // override replaces the original selection
    expect(created.runtime).toBe("rt-cloud"); // runtime override applied
    expect(created.orchestration?.graders).toEqual([{ id: "tests-pass" }]); // scoring reproduced verbatim (not overridable)
  });

  // Regression (gap: rerun could not adjust dispatch knobs) — a re-run may override concurrency/retries/subset; unset
  // fields still inherit the source. Pre-fix these three inputs did not exist, so a re-run always inherited them.
  it("applies dispatch-knob overrides (concurrency / retries / subset) while inheriting the unset ones", async () => {
    const twoCaseDataset: Dataset = {
      id: "d",
      version: "1.0.0",
      tags: [],
      cases: [
        { id: "c1", env: { kind: "repo", source: { files: {} } }, task: "do", graders: [], timeoutSec: 1800, tags: [] },
        { id: "c2", env: { kind: "repo", source: { files: {} } }, task: "do", graders: [], timeoutSec: 1800, tags: [] },
      ],
    };
    const store = new InMemoryScorecardStore();
    await seedSrc(store); // source: concurrency 2, retries 1, subset ids ["c1"], judges [{j,1}]
    const { datasets, service } = build(store);
    await datasets.register("acme", twoCaseDataset);

    const created = await service.rerun({
      tenant: "acme",
      id: "src-1",
      concurrency: 8,
      retries: 3,
      cases: { ids: ["c2"] },
    });

    expect(created.orchestration?.concurrency).toBe(8); // override (source was 2)
    expect(created.orchestration?.retries).toBe(3); // override (source was 1)
    expect(created.subset?.ids).toEqual(["c2"]); // subset override (source was ["c1"])
    expect(created.orchestration?.judges).toEqual([{ id: "j", version: "1" }]); // judges inherited (unset)
  });

  it("an explicit empty judges list re-runs with no judges (score with the dataset's graders only)", async () => {
    const store = new InMemoryScorecardStore();
    await seedSrc(store);
    const { datasets, service } = build(store);
    await datasets.register("acme", datasetWithCase());

    const created = await service.rerun({ tenant: "acme", id: "src-1", judges: [] });

    expect(created.orchestration?.judges).toEqual([]); // [] is an override to "no judges", not "inherit"
    expect(created.runtime).toBe("self:laptop"); // runtime still inherited (unset)
  });

  it("rejects re-running a batch that has not finished (400) and hides another workspace's / a missing scorecard (404)", async () => {
    const store = new InMemoryScorecardStore();
    await seedSrc(store, { status: "running" });
    const { datasets, service } = build(store);
    await datasets.register("acme", datasetWithCase());

    await expect(service.rerun({ tenant: "acme", id: "src-1" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(service.rerun({ tenant: "acme", id: "missing" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.rerun({ tenant: "other", id: "src-1" })).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("ScorecardService — placement waiting diagnostic (Phase 1: immediate offline-runner feedback)", () => {
  // A dataset with two cases so the batch fans out twice — the diagnostic must appear ONCE (deduped per batch), not per case.
  const twoCaseDataset = (): Dataset => ({
    id: "d",
    version: "1.0.0",
    cases: ["c1", "c2"].map((id) => ({
      id,
      env: { kind: "repo" as const, source: { files: { "a.txt": "x" } } },
      task: "do",
      graders: [],
      timeoutSec: 1800,
      tags: [],
    })),
    tags: [],
  });

  // The dispatcher stands in for the RuntimeDispatcher's self-hosted gate: it fires onWaiting (the offline runner
  // reason) at dispatch, then still parks-and-runs (returns a result) — exactly the non-terminal contract.
  const offlineThenRuns = (reason: string): Dispatcher => ({
    async dispatch(job, opts) {
      opts?.onWaiting?.(reason);
      return {
        caseId: job.evalCase.id,
        harness: `${job.harness.id}@${job.harness.version}`,
        trace: [],
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
        scores: [{ graderId: "tests-pass", metric: "tests-pass", value: 1, pass: true }],
      };
    },
  });

  it("surfaces the dispatcher's onWaiting reason as ONE 'dispatch/info' step (deduped across a 2-case batch)", async () => {
    const reason = 'Runner "laptop" is offline (no lease in the last ~90s) — start or reconnect it.';
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", twoCaseDataset());
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: offlineThenRuns(reason),
      store,
      datasets,
      newId: () => "sc-wait",
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    const rec = await waitTerminal(store, "sc-wait");

    const waitingSteps = (rec.steps ?? []).filter((s) => s.phase === "dispatch" && s.status === "info");
    expect(waitingSteps).toHaveLength(1); // deduped — two cases hit the same offline pool, but the user sees one line
    expect(waitingSteps[0]?.message).toBe(reason);
    // Non-terminal: the runner "reconnected" (the fake still returned a result) so the batch still succeeds.
    expect(rec.status).toBe("succeeded");
  });

  it("does NOT add a waiting step when the dispatcher never signals onWaiting (healthy dispatch)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", twoCaseDataset());
    const store = new InMemoryScorecardStore();
    const healthy: Dispatcher = {
      async dispatch(job) {
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [{ graderId: "tests-pass", metric: "tests-pass", value: 1, pass: true }],
        };
      },
    };
    const service = new ScorecardService({ dispatcher: healthy, store, datasets, newId: () => "sc-ok" });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    const rec = await waitTerminal(store, "sc-ok");

    expect((rec.steps ?? []).filter((s) => s.phase === "dispatch" && s.status === "info")).toHaveLength(0);
    expect(rec.status).toBe("succeeded");
  });
});

describe("materialize-on-import — imported traces seal as OUR copy and are judged from it (W4)", () => {
  const pulled: TraceEvent[] = [
    { t: 0, kind: "llm_call", model: "external-model" },
    { t: 1, kind: "tool_call", id: "t1", name: "bash", args: {} },
  ];

  const build = (trajectories: InMemoryTrajectoryStore, source: TraceSource) => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      defaultTraceGraders,
      trajectories,
      buildTraceSource: () => source,
      newId: () => "sc-mat",
    });
    return { store, datasets, service };
  };

  it("a pull-ingested trace seals in the owned store (source: import) — delete it on the source platform, the evidence still opens", async () => {
    const trajectories = new InMemoryTrajectoryStore();
    let deleted = false;
    const source: TraceSource = {
      fetch: async () => {
        if (deleted) throw new UpstreamError("UPSTREAM_ERROR", {}, "trace was deleted on the source platform");
        return pulled;
      },
    };
    const { store, datasets, service } = build(trajectories, source);
    await datasets.register("acme", datasetWithCase());

    const created = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      source: { kind: "otel", endpoint: "http://jaeger:16686" },
      runs: [{ caseId: "c1", runId: "external-trace-9" }],
      judges: [],
    });
    const done = await waitTerminal(store, created.id);
    expect(done.status).toBe("succeeded");

    // The source platform loses the trace AFTER the pull — our sealed copy is unaffected.
    deleted = true;
    const sealed = await trajectories.get("acme", `ingest:${created.id}:c1`);
    expect(sealed?.meta).toMatchObject({ source: "import", eventCount: 2 });
    expect(sealed?.events).toEqual(pulled);
    // The record embed and the sealed copy agree (one evidence, two carriers until refs-not-embeds).
    expect(done.scorecard?.results[0]?.trace).toEqual(pulled);
  });

  it("judging reads the SEALED copy, never a fresher fetch — a pre-existing seal under the same key wins", async () => {
    const trajectories = new InMemoryTrajectoryStore();
    const sealedFirst: TraceEvent[] = [{ t: 0, kind: "tool_call", id: "t1", name: "bash", args: {} }];
    // The key is deterministic (ingest:<scorecardId>:<caseId>), so the original evidence can be sealed ahead.
    await trajectories.seal({ runId: "ingest:sc-mat:c1", tenant: "acme", source: "import", events: sealedFirst });
    const { store, datasets, service } = build(trajectories, { fetch: async () => pulled });
    await datasets.register("acme", datasetWithCase());

    const created = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      source: { kind: "otel", endpoint: "http://jaeger:16686" },
      runs: [{ caseId: "c1", runId: "external-trace-9" }],
      judges: [],
    });
    const done = await waitTerminal(store, created.id);

    // First write won: the embed AND the derived metrics come from the sealed copy, not the fresh pull.
    expect(done.scorecard?.results[0]?.trace).toEqual(sealedFirst);
    expect(measuredScores(done.scorecard?.results[0]?.scores ?? []).find((s) => s.metric === "tool_calls")?.value).toBe(
      1,
    );
  });

  it("the reserved source 'everdict' evaluates OWN trajectories — read from the store, judged, and NEVER duplicated", async () => {
    const trajectories = new InMemoryTrajectoryStore();
    await trajectories.seal({ runId: "run-prod-1", tenant: "acme", source: "otlp", events: pulled });
    const { store, datasets, service } = build(trajectories, {
      fetch: async () => {
        throw new Error("the owned store never builds an external TraceSource");
      },
    });
    await datasets.register("acme", datasetWithCase());

    const created = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      source: { name: "everdict" }, // N2 continuous evaluation — the pull machinery pointed at OUR store
      runs: [{ caseId: "c1", runId: "run-prod-1" }],
      judges: [],
    });
    const done = await waitTerminal(store, created.id);
    expect(done.status).toBe("succeeded");
    expect(done.scorecard?.results[0]?.trace).toEqual(pulled); // judged from the sealed store copy
    expect(done.scorecard?.results[0]?.scores.some((s) => s.metric === "tool_calls")).toBe(true);
    // No ingest:* duplicate — the evidence already lives in the owned store under its own runId.
    expect(await trajectories.get("acme", `ingest:${created.id}:c1`)).toBeUndefined();

    // A runId with no sealed trajectory fails the batch loudly, never judges emptiness.
    const missing = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      source: { name: "everdict" },
      runs: [{ caseId: "c1", runId: "ghost" }],
      judges: [],
    });
    const failed = await waitTerminal(store, missing.id);
    expect(failed.status).toBe("failed");
    expect(failed.error?.message).toContain("ghost");
  });

  it("refuses to pull ANOTHER member's owned trajectory into a scorecard — the audience rule's third door", async () => {
    // The browse surfaces keep a member's agent-turn transcript private; this path names run ids directly, so
    // without the same check the evidence would simply walk out through a scorecard's results.
    const trajectories = new InMemoryTrajectoryStore();
    await trajectories.seal({ runId: "turn-alice", tenant: "acme", source: "run", owner: "alice", events: pulled });
    const { store, datasets, service } = build(trajectories, {
      fetch: async () => {
        throw new Error("the owned store never builds an external TraceSource");
      },
    });
    await datasets.register("acme", datasetWithCase());

    const asBob = await service.ingestPull({
      tenant: "acme",
      submittedBy: "bob",
      dataset: { id: "d", version: "latest" },
      source: { name: "everdict" },
      runs: [{ caseId: "c1", runId: "turn-alice" }],
      judges: [],
    });
    const refused = await waitTerminal(store, asBob.id);
    expect(refused.status).toBe("failed");
    // Same wording as an id that does not exist — a refusal must not confirm that it does.
    expect(refused.error?.message).toContain("turn-alice");

    // The owner evaluates her own turn exactly as before.
    const asAlice = await service.ingestPull({
      tenant: "acme",
      submittedBy: "alice",
      dataset: { id: "d", version: "latest" },
      source: { name: "everdict" },
      runs: [{ caseId: "c1", runId: "turn-alice" }],
      judges: [],
    });
    expect((await waitTerminal(store, asAlice.id)).status).toBe("succeeded");
  });

  it("push ingest materializes through the same door (both ingest paths converge on finishIngest)", async () => {
    const trajectories = new InMemoryTrajectoryStore();
    const { store, datasets, service } = build(trajectories, {
      fetch: async () => {
        throw new Error("push ingest never pulls");
      },
    });
    await datasets.register("acme", datasetWithCase());

    const created = await service.ingest({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      traces: [{ caseId: "c1", trace: pulled }],
      judges: [],
    });
    const done = await waitTerminal(store, created.id);
    expect(done.status).toBe("succeeded");
    expect((await trajectories.get("acme", `ingest:${created.id}:c1`))?.meta).toMatchObject({
      source: "import",
      eventCount: 2,
    });
  });

  it("an ingested case stamps the evidence era WITHOUT a seal, so its evidence reads partial", async () => {
    // Regression: pre-fix, an absent seal was indistinguishable from a pre-seal-era row, so every ingested
    // case claimed COMPLETE trace evidence. Ingest scores a trace someone else collected — nobody here
    // watched that collection, and the honest reading is partial. The era is what makes the absence a claim.
    const { store, datasets, service } = build(new InMemoryTrajectoryStore(), {
      fetch: async () => {
        throw new Error("push ingest never pulls");
      },
    });
    await datasets.register("acme", datasetWithCase());
    const created = await service.ingest({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      traces: [{ caseId: "c1", trace: pulled }],
      judges: [],
    });
    const done = await waitTerminal(store, created.id);
    const result = done.scorecard?.results[0];
    if (result === undefined) throw new Error("the ingested batch produced no result");
    expect(result.evidenceVersion).toBe(CURRENT_EVIDENCE_VERSION);
    expect(result.traceSealed).toBeUndefined();
    expect(evidenceStatus(result).trace).toBe("partial");
  });
});

describe("ScorecardService.ingestPull", () => {
  it("pulls traces from a trace source, derives metrics, and stores as succeeded", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());

    const trace: TraceEvent[] = [
      { t: 0, kind: "llm_call", model: "m" },
      { t: 1, kind: "tool_call", id: "t1", name: "bash", args: {} },
    ];
    let captured: TraceSourceConfig | undefined;
    const buildTraceSource = (cfg: TraceSourceConfig): TraceSource => {
      captured = cfg;
      return { fetch: async () => trace };
    };

    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      defaultTraceGraders,
      buildTraceSource,
      secretsFor: async () => ({ OTEL_TOKEN: "Bearer secret-xyz" }),
    });
    const created = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      harness: { id: "h", version: "1.0.0" },
      source: { kind: "otel", endpoint: "http://jaeger:16686", authSecret: "OTEL_TOKEN" },
      runs: [{ caseId: "c1", runId: "trace-1" }],
      judges: [],
    });
    expect(created.status).toBe("queued");

    const done = await waitTerminal(store, created.id);
    expect(done.status).toBe("succeeded");
    expect(done.scorecard?.results.map((r) => r.caseId)).toEqual(["c1"]);
    expect(done.scorecard?.results[0]?.scores.some((s) => s.metric === "tool_calls")).toBe(true);
    // authSecret → SecretStore value → injected into the trace source as an Authorization: Bearer header
    expect(captured?.headers?.authorization).toBe("Bearer secret-xyz");
  });

  it("an INLINE source carries its correlation axes (correlate/correlateTag/service/artifactBaseUrl) into the built source", async () => {
    // Pre-fix the inline variant silently STRIPPED these fields (schema without them + no passthrough), so a
    // correlate:"tag" inline pull degraded to an id-fetch and every trace came back empty with no hint why.
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    let captured: TraceSourceConfig | undefined;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      defaultTraceGraders,
      buildTraceSource: (cfg): TraceSource => {
        captured = cfg;
        return { fetch: async () => [{ t: 0, kind: "llm_call", model: "m" }] };
      },
    });
    const created = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      harness: { id: "h", version: "1.0.0" },
      source: {
        kind: "otel",
        endpoint: "http://jaeger:16686",
        correlate: "tag",
        correlateTag: "mlflow.trace.session",
        service: "agent",
        artifactBaseUrl: "https://artifacts.internal",
      },
      runs: [{ caseId: "c1", runId: "run-9" }],
      judges: [],
    });
    await waitTerminal(store, created.id);
    expect(captured).toMatchObject({
      correlate: "tag",
      correlateTag: "mlflow.trace.session",
      service: "agent",
      artifactBaseUrl: "https://artifacts.internal",
    });
  });

  it("resolves a REGISTERED source referenced by name (register once, pull by name) — the credential comes from the pool, not the request", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const trace: TraceEvent[] = [{ t: 0, kind: "tool_call", id: "t1", name: "bash", args: {} }];
    let captured: TraceSourceConfig | undefined;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      defaultTraceGraders,
      buildTraceSource: (cfg): TraceSource => {
        captured = cfg;
        return { fetch: async () => trace };
      },
      // the workspace pool resolver — a name → the whole config (as TraceSourceService.resolveByName does).
      resolveTraceSourceByName: async (_t, name) => {
        if (name !== "prod-mlflow") throw new BadRequestError("BAD_REQUEST", {}, "Unregistered trace source");
        return {
          kind: "mlflow",
          endpoint: "https://mlflow.prod",
          headers: { authorization: "Basic xyz" },
          project: "7",
          correlate: "tag",
        };
      },
    });
    const created = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      harness: { id: "h", version: "1.0.0" },
      source: { name: "prod-mlflow" }, // just a name — no kind/endpoint/credential restated
      runs: [{ caseId: "c1", runId: "trace-1" }],
      judges: [],
    });
    const done = await waitTerminal(store, created.id);
    expect(done.status).toBe("succeeded");
    expect(captured).toMatchObject({ kind: "mlflow", endpoint: "https://mlflow.prod", project: "7" });
    expect(captured?.headers?.authorization).toBe("Basic xyz"); // resolved from the registered pool
  });

  it("a named-source pull can override correlation to 'id' (evaluate-traces holds the platform's real trace ids)", async () => {
    // The registered source is normally used with "tag" correlation (find-by-everdict-run_id). The evaluate-traces flow
    // already has the platform's real trace ids from listTraces, so it must fetch by id — the per-pull override wins.
    const store = new InMemoryScorecardStore();
    let captured: TraceSourceConfig | undefined;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets: new InMemoryDatasetRegistry(),
      defaultTraceGraders,
      buildTraceSource: (cfg): TraceSource => {
        captured = cfg;
        return { fetch: async () => [{ t: 0, kind: "llm_call", model: "m" }] };
      },
      resolveTraceSourceByName: async () => ({
        kind: "mlflow",
        endpoint: "https://mlflow.prod",
        headers: { authorization: "Basic z" },
        project: "7",
        correlate: "tag", // the pooled setting …
      }),
    });
    const created = await service.ingestPull({
      tenant: "acme",
      // no dataset/harness (evaluate traces) + override the pooled "tag" correlation to "id"
      source: { name: "prod-mlflow", correlate: "id" },
      runs: [{ caseId: "trace-1", runId: "trace-1" }],
      judges: [],
    });
    await waitTerminal(store, created.id);
    expect(captured?.correlate).toBe("id"); // … the per-pull override wins
  });

  it("applies the per-harness conversion overlay (spanMappingFor) to the pull-eval trace source", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());

    let captured: TraceSourceConfig | undefined;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      defaultTraceGraders,
      buildTraceSource: (cfg): TraceSource => {
        captured = cfg;
        return { fetch: async (): Promise<TraceEvent[]> => [{ t: 0, kind: "llm_call", model: "m" }] };
      },
      // The judge-wizard-authored overlay, keyed by the producing harness id — the periodic-eval consumer.
      spanMappingFor: async (_tenant, harnessId) => (harnessId === "h" ? { model: ["my.llm.model"] } : undefined),
    });
    const created = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      harness: { id: "h", version: "1.0.0" },
      source: { kind: "otel", endpoint: "http://jaeger:16686" },
      runs: [{ caseId: "c1", runId: "trace-1" }],
      judges: [],
    });
    await waitTerminal(store, created.id);
    // The overlay flows through to the trace source so production traces normalize the harness/judge's way.
    expect(captured?.mapping).toEqual({ model: ["my.llm.model"] });
  });

  it("fetchDetailed evidence (dom/screenshot) synthesizes a browser snapshot the judges read", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());

    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      // The source extracts evidence slots (mapping-authored) alongside the events — the pull-path substitute
      // for the EnvSnapshot a live run produces.
      buildTraceSource: (): TraceSource => ({
        fetch: async () => [],
        fetchDetailed: async () => ({
          events: [{ t: 0, kind: "message", role: "assistant", text: "done" }],
          evidence: {
            finalAnswer: "done",
            dom: "<html>goal</html>",
            screenshot: "QUJD",
            screenshotMediaType: "image/png",
            custom: { confirmation_id: "R-42" },
          },
        }),
      }),
    });
    const created = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      harness: { id: "h", version: "1.0.0" },
      source: { kind: "mlflow", endpoint: "http://mlflow" },
      runs: [{ caseId: "c1", runId: "trace-1" }],
      judges: [],
    });
    const done = await waitTerminal(store, created.id);
    expect(done.status).toBe("succeeded");
    const snapshot = done.scorecard?.results[0]?.snapshot;
    expect(snapshot?.kind).toBe("browser");
    if (snapshot?.kind === "browser") {
      expect(snapshot.dom).toBe("<html>goal</html>");
      expect(snapshot.screenshot).toBe("QUJD");
    }
    // the evidence itself rides the CaseResult — the carrier that brings CUSTOM slots to the judges
    expect(done.scorecard?.results[0]?.evidence?.custom).toEqual({ confirmation_id: "R-42" });
  });

  it("fetchDetailed without browser evidence keeps the synthetic ingest snapshot (no empty browser shell)", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      buildTraceSource: (): TraceSource => ({
        fetch: async () => [],
        fetchDetailed: async () => ({ events: [{ t: 0, kind: "message", role: "assistant", text: "done" }] }),
      }),
    });
    const created = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      harness: { id: "h", version: "1.0.0" },
      source: { kind: "mlflow", endpoint: "http://mlflow" },
      runs: [{ caseId: "c1", runId: "trace-1" }],
      judges: [],
    });
    const done = await waitTerminal(store, created.id);
    expect(done.scorecard?.results[0]?.snapshot.kind).toBe("repo");
  });

  it("missing dataset → NotFoundError (404)", async () => {
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets: new InMemoryDatasetRegistry(),
      buildTraceSource: () => ({ fetch: async () => [] }),
    });
    await expect(
      service.ingestPull({
        tenant: "acme",
        dataset: { id: "missing", version: "latest" },
        harness: { id: "h", version: "1.0.0" },
        source: { kind: "otel", endpoint: "http://j" },
        runs: [{ caseId: "c1", runId: "r1" }],
        judges: [],
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it("no dataset/harness → each pulled trace becomes its own case and judges score it directly (TRACE_EVAL_REF sentinel)", async () => {
    // The "evaluate existing traces" path: pick traces from a trace source + run judges, with NO dataset and NO harness
    // run. Pre-fix, dataset was required — omitting it 404'd, and even a synthetic scorecard would have judged nothing
    // (createJudgeStream skips caseIds absent from the dataset). Post-fix, every pulled trace becomes a synthetic case
    // so the judges align to it.
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry(); // empty — no dataset registered, and none is referenced
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", {
      kind: "model",
      id: "quality",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
      rubric: "good?",
      inputs: ["trace"],
      tags: [],
    });
    // A fake judge runner that scores each case — proves the judges see the synthesized cases (alignment).
    const judgeRunner: JudgeRunner = {
      run: async (spec, _tenant, ctx) => [
        { graderId: `judge:${spec.id}`, metric: `judge:${spec.id}`, value: 1, pass: true, detail: ctx.case.id },
      ],
    };
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      defaultTraceGraders,
      judges,
      judgeRunner,
      buildTraceSource: (): TraceSource => ({
        fetch: async () => [{ t: 0, kind: "tool_call", id: "t1", name: "bash", args: {} }],
      }),
    });
    const created = await service.ingestPull({
      tenant: "acme",
      // dataset + harness deliberately OMITTED — evaluate the pulled traces directly
      source: { kind: "otel", endpoint: "http://jaeger:16686" },
      runs: [
        { caseId: "trace-1", runId: "trace-1" },
        { caseId: "trace-2", runId: "trace-2" },
      ],
      judges: [{ id: "quality", version: "latest" }],
    });
    // The record carries the reserved sentinel for both NOT-NULL refs (a trace-evaluation, detectable by consumers).
    expect(created.dataset).toEqual({ id: TRACE_EVAL_REF, version: "external" });
    expect(created.harness).toEqual({ id: TRACE_EVAL_REF, version: "external" });

    const done = await waitTerminal(store, created.id);
    expect(done.status).toBe("succeeded");
    // Every pulled trace became a case — nothing was skipped for want of a dataset.
    expect(done.scorecard?.results.map((r) => r.caseId).sort()).toEqual(["trace-1", "trace-2"]);
    // The selected judge scored each synthetic case (the createJudgeStream alignment works via the synthesized dataset).
    for (const r of done.scorecard?.results ?? []) {
      expect(measuredScores(r.scores).some((s) => s.metric === "judge:quality" && s.pass === true)).toBe(true);
    }
  });

  it("push ingest with no dataset/harness → uploaded traces become cases under the TRACE_EVAL_REF sentinel", async () => {
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets: new InMemoryDatasetRegistry(),
      defaultTraceGraders,
    });
    const created = await service.ingest({
      tenant: "acme",
      // dataset + harness omitted
      traces: [
        { caseId: "a", trace: [{ t: 0, kind: "tool_call", id: "t1", name: "bash", args: {} }] },
        { caseId: "b", trace: [{ t: 0, kind: "llm_call", model: "m" }] },
      ],
      judges: [],
    });
    expect(created.dataset).toEqual({ id: TRACE_EVAL_REF, version: "external" });
    const done = await waitTerminal(store, created.id);
    expect(done.status).toBe("succeeded");
    expect(done.scorecard?.results.map((r) => r.caseId).sort()).toEqual(["a", "b"]);
  });

  it("buildTraceSource unset → the run ends failed (BAD_REQUEST)", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const service = new ScorecardService({ dispatcher, store, datasets });
    const created = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      harness: { id: "h", version: "1.0.0" },
      source: { kind: "otel", endpoint: "http://j" },
      runs: [{ caseId: "c1", runId: "r1" }],
      judges: [],
    });
    const done = await waitTerminal(store, created.id);
    expect(done.status).toBe("failed");
    expect(done.error?.code).toBe("BAD_REQUEST");
  });
});

describe("ScorecardService.submit — private-repo repoToken injection (per case)", () => {
  it("case env.source.connectionId → repoTokenFor resolve → per-case job.repoToken; public/non-git are not injected", async () => {
    const seen: Array<{ caseId: string; repoToken?: string }> = [];
    const cap: Dispatcher = {
      async dispatch(job) {
        seen.push({ caseId: job.evalCase.id, ...(job.repoToken !== undefined ? { repoToken: job.repoToken } : {}) });
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [],
        };
      },
    };
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", {
      id: "priv",
      version: "1.0.0",
      tags: [],
      cases: [
        {
          id: "git-priv",
          env: { kind: "repo", source: { git: "https://github.com/acme/p.git", ref: "main", connectionId: "conn-1" } },
          task: "t",
          graders: [],
          timeoutSec: 60,
          tags: [],
        },
        {
          id: "files-pub",
          env: { kind: "repo", source: { files: {} } },
          task: "t",
          graders: [],
          timeoutSec: 60,
          tags: [],
        },
      ],
    });
    const store = new InMemoryScorecardStore();
    // Connections are personally owned → repoTokenFor resolves by owner (submitter subject).
    const calls: Array<{ owner: string; connectionId: string }> = [];
    const service = new ScorecardService({
      dispatcher: cap,
      store,
      datasets,
      newId: () => "sc-priv",
      repoTokenFor: async (owner, connectionId) => {
        calls.push({ owner, connectionId });
        return connectionId === "conn-1" ? "gho_sc" : undefined;
      },
    });
    await service.submit({
      tenant: "acme",
      submittedBy: "u-alice",
      dataset: { id: "priv", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    await waitTerminal(store, "sc-priv");
    const byCase = Object.fromEntries(seen.map((s) => [s.caseId, s.repoToken]));
    expect(byCase["git-priv"]).toBe("gho_sc");
    expect(byCase["files-pub"]).toBeUndefined();
    expect(calls).toEqual([{ owner: "u-alice", connectionId: "conn-1" }]); // the files case does not call the resolver
  });

  it("failure after dispatch (judges phase) → status=failed + error.phase=judges + partial results preserved (visibility)", async () => {
    const okDispatch: Dispatcher = {
      async dispatch(job) {
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
        };
      },
    };
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", {
      kind: "model",
      id: "j1",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
      rubric: "ok?",
      inputs: ["trace"],
      tags: [],
    });
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      datasets,
      judges,
      judgeRunner: {
        async run() {
          throw new Error("judge boom");
        },
      },
      newId: () => "sc-phase",
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      judges: [{ id: "j1", version: "1.0.0" }],
    });
    const rec = await waitTerminal(store, "sc-phase");
    expect(rec.status).toBe("failed");
    expect(rec.error?.phase).toBe("judges"); // "which phase" — judges-phase failure
    expect(rec.error?.message).toContain("judge boom"); // "how" — the reason
    // Partial results preserved: cases gathered up to dispatch remain in the failed record for visibility.
    expect(rec.scorecard?.results.map((r) => r.caseId)).toEqual(["c1"]);
    // Progress (step) timeline — case completion + judges-phase failure are recorded in order.
    expect(rec.steps?.some((s) => s.phase === "case" && s.caseId === "c1")).toBe(true);
    expect(rec.steps?.some((s) => s.phase === "judges" && s.status === "failed")).toBe(true);
  });

  it("judge is streaming — applied the moment a case completes rather than waiting for the whole batch (a barrier would hang this test)", async () => {
    // rendezvous: c2 dispatch blocks until c1's judge starts — if the judge were a post-batch barrier, they'd never meet.
    let judgeStarted: () => void = () => {};
    const c1Judged = new Promise<void>((resolve) => {
      judgeStarted = resolve;
    });
    const okDispatch: Dispatcher = {
      async dispatch(job) {
        if (job.evalCase.id === "c2") await c1Judged; // a slow case that doesn't complete until c1's judge starts
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
        };
      },
    };
    const datasets = new InMemoryDatasetRegistry();
    const twoCase = datasetWithCase();
    const c1 = twoCase.cases[0];
    if (!c1) throw new Error("datasetWithCase guarantees one case");
    await datasets.register("acme", { ...twoCase, cases: [c1, { ...c1, id: "c2" }] });
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", {
      kind: "model",
      id: "j1",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
      rubric: "ok?",
      inputs: ["trace"],
      tags: [],
    });
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      datasets,
      judges,
      judgeRunner: {
        async run(spec) {
          judgeStarted(); // reached right after c1 completes (streaming) → c2 is released
          return [{ graderId: spec.id, metric: `judge:${spec.id}`, value: 1, pass: true }];
        },
      },
      newId: () => "sc-stream",
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      judges: [{ id: "j1", version: "1.0.0" }],
    });
    const rec = await waitTerminal(store, "sc-stream");
    expect(rec.status).toBe("succeeded");
    // Both cases get a judge score attached.
    for (const r of rec.scorecard?.results ?? []) {
      expect(r.scores.some((s) => s.metric === "judge:j1")).toBe(true);
    }
  }, 5000);

  it("on completion, calls the onComplete callback with the latest record (notification hook)", async () => {
    const okDispatch: Dispatcher = {
      async dispatch(job) {
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [],
        };
      },
    };
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const seen: Array<{ tenant: string; status: string; id: string }> = [];
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      datasets,
      newId: () => "sc-done",
      onComplete: async (tenant, rec) => {
        seen.push({ tenant, status: rec.status, id: rec.id });
      },
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    await waitTerminal(store, "sc-done");
    expect(seen).toEqual([{ tenant: "acme", status: "succeeded", id: "sc-done" }]);
  });
});

describe("ScorecardService — trace sink export", () => {
  const okDispatch: Dispatcher = {
    async dispatch(job) {
      return {
        caseId: job.evalCase.id,
        harness: `${job.harness.id}@${job.harness.version}`,
        trace: [],
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
        scores: [{ graderId: "tests-pass", metric: "tests-pass", value: 1, pass: true }],
      };
    },
  };

  it("sink export is case-streaming (D5) — fires the moment a case completes (a post-batch bulk export would hang this test)", async () => {
    // rendezvous: c2 dispatch waits for c1's export push — if export were post-batch bulk, they'd never meet.
    let c1Exported: () => void = () => {};
    const exportedC1 = new Promise<void>((resolve) => {
      c1Exported = resolve;
    });
    const gatedDispatch: Dispatcher = {
      async dispatch(job) {
        if (job.evalCase.id === "c2") await exportedC1;
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [{ graderId: "tests-pass", metric: "tests-pass", value: 1, pass: true }],
        };
      },
    };
    const datasets = new InMemoryDatasetRegistry();
    const one = datasetWithCase();
    const c1 = one.cases[0];
    if (!c1) throw new Error("datasetWithCase guarantees one case");
    await datasets.register("acme", { ...one, cases: [c1, { ...c1, id: "c2" }] });
    const store = new InMemoryScorecardStore();
    const pushed: string[] = [];
    const exportStreamFor = async (): Promise<CaseExportStream> => ({
      push: (r) => {
        pushed.push(r.caseId);
        if (r.caseId === "c1") c1Exported(); // the instant c1 goes out, c2 is released (proves streaming)
      },
      settle: async () => ({
        sink: "mlflow",
        name: "mlf",
        status: "succeeded",
        exportedAt: "2026-07-07T00:00:00.000Z",
        cases: pushed.map((caseId) => ({ caseId, externalId: `ext-${caseId}` })),
      }),
    });
    const service = new ScorecardService({
      dispatcher: gatedDispatch,
      store,
      datasets,
      exportStreamFor,
      newId: () => "sc-export-stream",
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
    });
    const rec = await waitTerminal(store, "sc-export-stream");
    expect(rec.status).toBe("succeeded");
    expect(pushed).toEqual(["c1", "c2"]); // fired per case in completion order
    expect(rec.export?.cases?.map((c) => c.caseId)).toEqual(["c1", "c2"]); // settle aggregation lands in record.export
    expect(rec.steps?.some((s) => s.phase === "export" && s.status === "ok")).toBe(true);
  }, 5000);

  it("live batch: after scoring, the exportResults outcome is recorded in record.export and steps(export)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const calls: Array<{ ctx: { scorecardId: string; dataset: string; harness: string }; caseIds: string[] }> = [];
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      datasets,
      newId: () => "sc-export",
      exportResults: async (_tenant, ctx, results) => {
        calls.push({ ctx, caseIds: results.map((r) => r.caseId) });
        return {
          sink: "mlflow",
          status: "succeeded",
          url: "http://mlflow/#/experiments/7",
          exportedAt: "2026-07-06T00:00:00.000Z",
          cases: [{ caseId: "c1", externalId: "tr-1", url: "http://mlflow/#/experiments/7?tr=tr-1" }],
        };
      },
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
    });
    const done = await waitTerminal(store, "sc-export");
    // Then: the scored results go to export and the outcome remains in the record.
    expect(calls[0]?.ctx).toEqual({ scorecardId: "sc-export", dataset: "d@1.0.0", harness: "h@1" });
    expect(calls[0]?.caseIds).toEqual(["c1"]);
    expect(done.status).toBe("succeeded");
    expect(done.export?.status).toBe("succeeded");
    expect(done.export?.cases?.[0]?.externalId).toBe("tr-1");
    expect(done.steps?.some((s) => s.phase === "export" && s.status === "ok")).toBe(true);
  });

  it("even on export failure (outcome=failed·throw), the scorecard is succeeded — isolation principle", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    // the case recorded as outcome=failed.
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      datasets,
      newId: () => "sc-exf",
      exportResults: async () => ({
        sink: "langfuse",
        status: "failed",
        message: "upstream 401",
        exportedAt: "2026-07-06T00:00:00.000Z",
      }),
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
    });
    const done = await waitTerminal(store, "sc-exf");
    expect(done.status).toBe("succeeded"); // export failure does not affect the result
    expect(done.error).toBeUndefined(); // error.phase unused
    expect(done.export?.status).toBe("failed");
    expect(done.steps?.some((s) => s.phase === "export" && s.status === "failed")).toBe(true);

    // Even if the hook itself throws (contract violation), the scorecard succeeds and only export is left unrecorded.
    const store2 = new InMemoryScorecardStore();
    const service2 = new ScorecardService({
      dispatcher: okDispatch,
      store: store2,
      datasets,
      newId: () => "sc-exth",
      exportResults: async () => {
        throw new Error("contract-violation throw");
      },
    });
    await service2.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
    });
    const done2 = await waitTerminal(store2, "sc-exth");
    expect(done2.status).toBe("succeeded");
    expect(done2.export).toBeUndefined();
  });

  it("pull ingest: the (source.kind, caseId→runId) attach hint is passed to export and the outcome is recorded", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    let attachSeen: { sourceKind: string; externalIdByCase: Record<string, string> } | undefined;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      buildTraceSource: () => ({ fetch: async () => [{ t: 0, kind: "llm_call", model: "m" }] }),
      exportResults: async (_tenant, _ctx, _results, attach) => {
        attachSeen = attach;
        return {
          sink: "mlflow",
          status: "succeeded",
          exportedAt: "2026-07-06T00:00:00.000Z",
          cases: [{ caseId: "c1", externalId: "tr-orig-1" }],
        };
      },
    });
    const created = await service.ingestPull({
      tenant: "acme",
      dataset: { id: "d", version: "latest" },
      harness: { id: "h", version: "1.0.0" },
      source: { kind: "mlflow", endpoint: "http://mlflow:5000" },
      runs: [{ caseId: "c1", runId: "tr-orig-1" }],
      judges: [],
    });
    const done = await waitTerminal(store, created.id);
    // Then: the original trace coordinates flow through attach so scores can be attached to the existing trace (flow ②).
    expect(attachSeen).toEqual({ sourceKind: "mlflow", externalIdByCase: { c1: "tr-orig-1" } });
    expect(done.export?.cases?.[0]?.externalId).toBe("tr-orig-1");
  });
});

describe("ScorecardService.submit — leaderboard model-axis capture", () => {
  // A dispatcher that emits an llm_call(model) per case — the source of the observed model.
  const llmDispatch = (model: string): Dispatcher => ({
    async dispatch(job) {
      return {
        caseId: job.evalCase.id,
        harness: `${job.harness.id}@${job.harness.version}`,
        trace: [{ t: 0, kind: "llm_call", model }],
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
        scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
      };
    },
  });

  it("stores the trace-observed model as the succeeded record's models (observation first)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: llmDispatch("claude-opus-4-8"),
      store,
      datasets,
      newId: () => "sc-model",
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    const rec = await waitTerminal(store, "sc-model");
    expect(rec.status).toBe("succeeded");
    expect(rec.models?.observed).toEqual(["claude-opus-4-8"]);
    expect(rec.models?.primary).toBe("claude-opus-4-8");
  });

  it("stores the inline judge-config model as the succeeded record's judgeModels (judge axis)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: llmDispatch("gpt-4o"),
      store,
      datasets,
      newId: () => "sc-judge",
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      judge: { provider: "openai", model: "gpt-5.4-mini" }, // grader
    });
    const rec = await waitTerminal(store, "sc-judge");
    expect(rec.status).toBe("succeeded");
    expect(rec.models?.primary).toBe("gpt-4o"); // the LLM the harness used
    expect(rec.judgeModels).toEqual(["gpt-5.4-mini"]); // grader — a separate axis
  });
});

describe("ScorecardService.submit — child-run fan-out (runStore)", () => {
  const okDispatch: Dispatcher = {
    async dispatch(job) {
      return {
        caseId: job.evalCase.id,
        harness: `${job.harness.id}@${job.harness.version}`,
        trace: [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd: 0.01 } }],
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
        scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
      };
    },
  };

  it("with runStore set, creates a child run per case, hides them from the activity list, and references them via scorecard.runIds", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    let n = 0;
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      runStore,
      datasets,
      newId: () => `sc-${n++}`, // sc-0 = scorecard, sc-1 = submitted-fact event id (E0), sc-2 = child run of case c1
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    const rec = await waitTerminal(store, "sc-0");
    expect(rec.status).toBe("succeeded");
    expect(rec.runIds).toEqual(["sc-2"]); // reference to the fanned-out child run
    expect(rec.scorecard).toBeUndefined(); // storage dedup — the heavy embed is not stored (runIds only)

    const child = await runStore.get("sc-2");
    expect(child?.status).toBe("succeeded");
    expect(child?.parentScorecardId).toBe("sc-0");
    expect(child?.trigger).toBe("scorecard");
    expect(child?.caseId).toBe("c1");

    // get hydrates the scorecard from child runs — the response shape is identical to the embed era (web/diff unchanged).
    const hydrated = await service.get("sc-0");
    expect(hydrated?.scorecard?.results).toHaveLength(1);
    expect(hydrated?.scorecard?.results[0]?.caseId).toBe("c1");
    // Write-back preserves case scores (grader/judge/metric) on the child → they come back intact on hydrate.
    expect(hydrated?.scorecard?.results[0]?.scores[0]?.metric).toBe("tests_pass");

    // The activity list (default) hides children, but by scorecardId those batch children are visible.
    expect(await runStore.list("acme")).toEqual([]);
    expect((await runStore.list("acme", { scorecardId: "sc-0" })).map((r) => r.id)).toEqual(["sc-2"]);
  });

  it("an agent-caused batch (origin.causedByRunId) hands its children the cause:'run' edge (P3 demand graph)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    // The causer must exist — the P4 gate rejects a forged causedByRunId (an envelope-less causer admits unbounded).
    await runStore.create(
      Run.newAgentRun({
        id: "run-agent-1",
        tenant: "acme",
        agentId: "sentinel",
        sessionId: "sess-0",
        eventKind: "scorecard.completed",
        now: "2026-07-30T00:00:00.000Z",
      }),
    );
    const service = new ScorecardService({ dispatcher: okDispatch, store, runStore, datasets });
    const rec = await service.submit({
      tenant: "acme",
      submittedBy: "alice",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      origin: { source: "mcp", causedByRunId: "run-agent-1" },
    });
    await waitTerminal(store, rec.id);
    const children = await runStore.list("acme", { scorecardId: rec.id });
    expect(children).toHaveLength(1);
    expect(children[0]?.origin).toEqual({ cause: "run", causedByRunId: "run-agent-1", actor: "alice" });
  });

  it("seals the replay recording teed under each child's runId and attaches the ref on write-back", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    const recordingStore = new InMemoryRecordingStore();
    // A frame teed under the child's derived runId (evd-<scorecardId>-<caseId>) while the case ran.
    await recordingStore.append("evd-sc-0-c1", { track: "frames", entry: { t: 1, ref: "memory://f" } });
    let n = 0;
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      runStore,
      recordingStore,
      datasets,
      newId: () => `sc-${n++}`, // sc-0 = scorecard, sc-1 = submitted-fact event id (E0), sc-2 = child run of case c1
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    await waitTerminal(store, "sc-0");

    // The child run's final result carries the sealed recording ref; the recording is retrievable.
    const child = await runStore.get("sc-2");
    expect(child?.result?.recordingRef?.ref).toBe("memory://recording/evd-sc-0-c1");
    expect((await recordingStore.get("evd-sc-0-c1"))?.tracks.frames).toHaveLength(1);
  });

  it("diff hydrates dedup (runIds) scorecards too and computes regression/improvement", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    // A dispatcher that flips pass — base passes, candidate fails (regression).
    const dispatchPass = (pass: boolean): Dispatcher => ({
      async dispatch(job) {
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [{ graderId: "tests-pass", metric: "tests-pass", value: pass ? 1 : 0, pass }],
        };
      },
    });
    // Per-service independent counters — base scorecard=b-0 (+child b-1), candidate scorecard=c-0 (+child c-1).
    let bn = 0;
    let cn = 0;
    const base = new ScorecardService({
      dispatcher: dispatchPass(true),
      store,
      runStore,
      datasets,
      newId: () => `b-${bn++}`,
    });
    await base.submit({ tenant: "acme", dataset: { id: "d", version: "1.0.0" }, harness: { id: "s", version: "0" } });
    await waitTerminal(store, "b-0");
    const cand = new ScorecardService({
      dispatcher: dispatchPass(false),
      store,
      runStore,
      datasets,
      newId: () => `c-${cn++}`,
    });
    await cand.submit({ tenant: "acme", dataset: { id: "d", version: "1.0.0" }, harness: { id: "s", version: "0" } });
    await waitTerminal(store, "c-0");

    // Both scorecards stored only runIds without embed, yet diff hydrates and catches the pass→fail regression.
    const diff = await base.diff("acme", "b-0", "c-0");
    expect(diff.regressions).toContainEqual({
      caseId: "c1",
      metric: "tests-pass",
      baseline: 1,
      candidate: 0,
      delta: -1,
      passChange: "broke",
    });
  });

  it("without runStore, embed the scorecard with no child runs (unchanged)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({ dispatcher: okDispatch, store, datasets, newId: () => "sc-x" });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    const rec = await waitTerminal(store, "sc-x");
    expect(rec.status).toBe("succeeded");
    expect(rec.runIds).toBeUndefined();
    expect(rec.scorecard?.results).toHaveLength(1); // embedded results are intact
  });
});

describe("ScorecardService.submit — request concurrency flows into runSuite parallelism", () => {
  // A dispatcher that measures concurrent in-flight dispatches — each dispatch must delay briefly for parallelism to build up.
  function probe(): { dispatcher: Dispatcher; peak: () => number } {
    let inFlight = 0;
    let max = 0;
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        inFlight++;
        max = Math.max(max, inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [],
        };
      },
    };
    return { dispatcher, peak: () => max };
  }

  // A dataset of N cases (for parallelism testing — meaningful only when cases outnumber the concurrency).
  async function datasetN(datasets: InMemoryDatasetRegistry, n: number): Promise<void> {
    await datasets.register("acme", {
      id: "many",
      version: "1.0.0",
      tags: [],
      cases: Array.from({ length: n }, (_, i) => ({
        id: `c${i}`,
        env: { kind: "repo", source: { files: {} } } as const,
        task: "t",
        graders: [],
        timeoutSec: 60,
        tags: [],
      })),
    });
  }

  it("request concurrency=3 → dispatches up to 3 at once (overrides the service default)", async () => {
    const { dispatcher, peak } = probe();
    const datasets = new InMemoryDatasetRegistry();
    await datasetN(datasets, 6);
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({ dispatcher, store, datasets, concurrency: 1, newId: () => "sc-conc" });
    await service.submit({
      tenant: "acme",
      dataset: { id: "many", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      concurrency: 3,
    });
    const done = await waitTerminal(store, "sc-conc");
    expect(done.status).toBe("succeeded");
    expect(peak()).toBe(3); // the request value (3) applied, not the service default (1)
  });

  it("request concurrency unset → serial dispatch at the service default concurrency (=1)", async () => {
    const { dispatcher, peak } = probe();
    const datasets = new InMemoryDatasetRegistry();
    await datasetN(datasets, 4);
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({ dispatcher, store, datasets, concurrency: 1, newId: () => "sc-def" });
    await service.submit({
      tenant: "acme",
      dataset: { id: "many", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    await waitTerminal(store, "sc-def");
    expect(peak()).toBe(1);
  });
});

describe("ScorecardService.submit — submit-time ephemeral pins + origin provenance", () => {
  const topoTemplate: HarnessTemplateSpec = {
    kind: "service",
    category: "topology",
    id: "bu",
    version: "1",
    services: [
      { name: "planner", needs: [], perRun: [], replicas: 1, env: {} },
      { name: "browser", needs: [], perRun: [], replicas: 1, env: {} },
    ],
    dependencies: [],
    frontDoor: { service: "planner", submit: "POST /runs" },
    traceSource: { kind: "otel", endpoint: "http://otel:4318" },
  };
  const pinDataset: Dataset = {
    id: "pd",
    version: "1.0.0",
    cases: [
      { id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    ],
    tags: [],
  };

  async function fixtures() {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", pinDataset);
    const templates = new InMemoryHarnessTemplateRegistry();
    const instances = new InMemoryHarnessInstanceRegistry(templates);
    await templates.register("acme", topoTemplate);
    await instances.register("acme", {
      template: { id: "bu", version: "1" },
      id: "bu",
      version: "1.0.0",
      pins: { planner: "p:1", browser: "b:1" },
    });
    return { datasets, instances };
  }

  it("pins swap only the matching slot image in the dispatched harnessSpec and are recorded via origin.pinOverrides (registry unchanged)", async () => {
    const { datasets, instances } = await fixtures();
    const store = new InMemoryScorecardStore();
    const jobs: CaseJob[] = [];
    const capture: Dispatcher = {
      async dispatch(job) {
        jobs.push(job);
        return caseResult(true);
      },
    };
    const service = new ScorecardService({
      dispatcher: capture,
      store,
      datasets,
      harnesses: instances,
      newId: () => "sc-pins",
    });
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "pd", version: "latest" },
      harness: { id: "bu", version: "latest", pins: { planner: "p:pr-7" } },
      origin: { source: "github-actions", repo: "acme/app", prNumber: 7 },
    });
    expect(rec.harness).toEqual({ id: "bu", version: "1.0.0" }); // ephemeral pins don't create a version (the base version is recorded)
    expect(rec.origin).toMatchObject({
      source: "github-actions",
      repo: "acme/app",
      prNumber: 7,
      pinOverrides: { planner: "p:pr-7" }, // reproducibility record of what was evaluated
    });
    await waitTerminal(store, "sc-pins");
    const spec = jobs[0]?.harnessSpec;
    if (spec?.kind !== "service") throw new Error("expected service harnessSpec");
    expect(spec.services.map((s) => s.image)).toEqual(["p:pr-7", "b:1"]); // only planner swapped
    expect(await instances.versions("acme", "bu")).toEqual(["1.0.0"]); // registry unchanged
  });

  it("unknown slot pin → BadRequest (prevents silently passing while ignoring the pin — no fallback)", async () => {
    const { datasets, instances } = await fixtures();
    const service = new ScorecardService({
      dispatcher,
      store: new InMemoryScorecardStore(),
      datasets,
      harnesses: instances,
    });
    await expect(
      service.submit({
        tenant: "acme",
        dataset: { id: "pd", version: "latest" },
        harness: { id: "bu", version: "latest", pins: { nope: "x" } },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("no registry + pins → BadRequest (can't pin a built-in harness)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", pinDataset);
    const service = new ScorecardService({ dispatcher, store: new InMemoryScorecardStore(), datasets });
    await expect(
      service.submit({
        tenant: "acme",
        dataset: { id: "pd", version: "latest" },
        harness: { id: "scripted", version: "0", pins: { image: "x" } },
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("origin is recorded as-is even without pins (common provenance for schedule/web/api)", async () => {
    const { datasets, instances } = await fixtures();
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      harnesses: instances,
      newId: () => "sc-origin",
    });
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "pd", version: "latest" },
      harness: { id: "bu", version: "latest" },
      origin: { source: "schedule" },
    });
    expect(rec.origin).toEqual({ source: "schedule" });
  });

  it("submittedBy (submitter) is stamped as the record's createdBy — the actor (who) paired with origin (where)", async () => {
    const { datasets, instances } = await fixtures();
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      harnesses: instances,
      newId: () => "sc-by",
    });
    const rec = await service.submit({
      tenant: "acme",
      submittedBy: "user-alice",
      dataset: { id: "pd", version: "latest" },
      harness: { id: "bu", version: "latest" },
    });
    expect(rec.createdBy).toBe("user-alice");
    expect((await store.get("sc-by"))?.createdBy).toBe("user-alice");
  });

  it("ingest (trace upload) also stamps submittedBy as createdBy", async () => {
    const { datasets } = await fixtures();
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({ dispatcher, store, datasets, newId: () => "sc-ingest-by" });
    const rec = await service.ingest({
      tenant: "acme",
      submittedBy: "user-bob",
      dataset: { id: "pd", version: "latest" },
      harness: { id: "bu", version: "1.0.0" },
      traces: [{ caseId: "c1", trace: [] }],
      judges: [],
    });
    expect(rec.createdBy).toBe("user-bob");
  });
});

describe("ScorecardService.submit — server-side supersede (re-firing the same PR reclaims the in-flight batch)", () => {
  const twoCaseDataset: Dataset = {
    id: "sd",
    version: "1.0.0",
    cases: [
      { id: "c1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
      { id: "c2", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    ],
    tags: [],
  };
  // A gating dispatcher — records the moment of firing and holds the result until release() (to keep the batch "running").
  function gatedDispatcher() {
    const dispatched: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        dispatched.push(job.evalCase.id);
        await gate;
        return { ...caseResult(true), caseId: job.evalCase.id };
      },
    };
    return { dispatcher, dispatched, release: () => release() };
  }
  const until = async (cond: () => boolean | Promise<boolean>): Promise<void> => {
    for (let i = 0; i < 100; i++) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("condition not met");
  };

  it("re-firing the same (repo,PR,harness,dataset) → the previous batch is superseded (remaining cases unfired · partial results preserved · notification skipped)", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", twoCaseDataset);
    const gate = gatedDispatcher();
    const completions: string[] = [];
    let n = 0;
    const service = new ScorecardService({
      dispatcher: gate.dispatcher,
      store,
      datasets,
      concurrency: 1, // serial — while c1 is stuck at the gate, c2 stays unfired
      newId: () => `sup-${n++}`,
      onComplete: async (_tenant, rec) => {
        completions.push(rec.id);
      },
    });
    const base = {
      tenant: "acme",
      dataset: { id: "sd", version: "latest" },
      harness: { id: "scripted", version: "0" },
    };
    const origin = { source: "github-actions", repo: "acme/app", prNumber: 7 };

    const first = await service.submit({ ...base, origin: { ...origin, sha: "old" } });
    await until(() => gate.dispatched.length === 1); // c1 fired (blocked at the gate)

    const second = await service.submit({ ...base, origin: { ...origin, sha: "new" } });
    // The previous batch is reclaimed immediately at submit time (before the 202 response — supersede is awaited inside submit).
    const supersededNow = await store.get(first.id);
    expect(supersededNow?.status).toBe("superseded");
    expect(supersededNow?.error?.code).toBe("SUPERSEDED");

    gate.release();
    await until(async () => (await store.get(second.id))?.status === "succeeded");
    await until(async () => (await store.get(first.id))?.scorecard !== undefined); // wait for the first batch to settle

    const finalFirst = await store.get(first.id);
    expect(finalFirst?.status).toBe("superseded"); // track settlement does not revive it to succeeded
    expect(finalFirst?.scorecard?.results.map((r) => r.caseId)).toEqual(["c1"]); // partial results (only what fired) preserved
    // The remaining case (c2) never fired in the first batch — total firings = first-batch c1 + second-batch c1,c2.
    expect(gate.dispatched).toHaveLength(3);
    expect(completions).toEqual([second.id]); // the superseded batch skips its completion notification
  });

  it("firings with no prNumber (merge/dev) or a different PR number do not supersede", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", twoCaseDataset);
    const gate = gatedDispatcher();
    let n = 0;
    const service = new ScorecardService({
      dispatcher: gate.dispatcher,
      store,
      datasets,
      concurrency: 2,
      newId: () => `keep-${n++}`,
    });
    const base = {
      tenant: "acme",
      dataset: { id: "sd", version: "latest" },
      harness: { id: "scripted", version: "0" },
    };
    const pr7 = await service.submit({ ...base, origin: { source: "github-actions", repo: "acme/app", prNumber: 7 } });
    await until(() => gate.dispatched.length >= 1);
    await service.submit({ ...base, origin: { source: "github-actions", repo: "acme/app" } }); // merge — no prNumber
    await service.submit({ ...base, origin: { source: "github-actions", repo: "acme/app", prNumber: 8 } }); // a different PR
    expect((await store.get(pr7.id))?.status).toBe("running"); // not reclaimed
    gate.release();
    await until(async () => (await store.get(pr7.id))?.status === "succeeded"); // completes normally
  });
});

describe("ScorecardService.submit — partial run (subset)", () => {
  const threeCaseDataset = (): Dataset => ({
    id: "big",
    version: "1.0.0",
    cases: (["a", "b", "c"] as const).map((id, i) => ({
      id,
      env: { kind: "prompt" },
      task: `q-${id}`,
      graders: [],
      timeoutSec: 60,
      tags: i < 2 ? ["easy"] : ["hard"],
    })),
    tags: [],
  });
  const capture = () => {
    const dispatched: string[] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        dispatched.push(job.evalCase.id);
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "prompt", output: "" },
          scores: [],
        };
      },
    };
    return { dispatched, dispatcher };
  };
  const build = async (id: string) => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", threeCaseDataset());
    const store = new InMemoryScorecardStore();
    const { dispatched, dispatcher } = capture();
    const service = new ScorecardService({ dispatcher, store, datasets, newId: () => id });
    return { datasets, store, dispatched, service };
  };
  const submitBase = {
    tenant: "acme",
    dataset: { id: "big", version: "1.0.0" },
    harness: { id: "scripted", version: "0" },
  };

  it("with limit, only the first N run and record.subset is stamped", async () => {
    const { store, dispatched, service } = await build("sc-lim");
    const rec = await service.submit({ ...submitBase, cases: { limit: 2 } });
    expect(rec.subset).toEqual({ total: 3, selected: 2, limit: 2 });
    await waitTerminal(store, "sc-lim");
    expect([...dispatched].sort()).toEqual(["a", "b"]);
    expect((await store.get("sc-lim"))?.scorecard?.results).toHaveLength(2);
  });

  it("tags is an any-match filter (combined with limit)", async () => {
    const { store, dispatched, service } = await build("sc-tag");
    const rec = await service.submit({ ...submitBase, cases: { tags: ["easy"], limit: 1 } });
    expect(rec.subset).toEqual({ total: 3, selected: 1, tags: ["easy"], limit: 1 });
    await waitTerminal(store, "sc-tag");
    expect(dispatched).toEqual(["a"]);
  });

  it("ids is explicit selection — an unknown id is rejected immediately with 400 (no silent partial run)", async () => {
    const { store, dispatched, service } = await build("sc-ids");
    const rec = await service.submit({ ...submitBase, cases: { ids: ["c", "a"] } });
    expect(rec.subset).toEqual({ total: 3, selected: 2, ids: ["c", "a"] });
    await waitTerminal(store, "sc-ids");
    expect([...dispatched].sort()).toEqual(["a", "c"]);
    await expect(service.submit({ ...submitBase, cases: { ids: ["a", "nope"] } })).rejects.toThrow(/nope/);
  });

  it("zero selected → 400 (tag mismatch)", async () => {
    const { service } = await build("sc-empty");
    await expect(service.submit({ ...submitBase, cases: { tags: ["no-such-tag"] } })).rejects.toThrow(
      /No cases match the selection/,
    );
  });

  it("unset cases runs everything + no subset stamp (unchanged)", async () => {
    const { store, dispatched, service } = await build("sc-all");
    const rec = await service.submit({ ...submitBase });
    expect(rec.subset).toBeUndefined();
    await waitTerminal(store, "sc-all");
    expect(dispatched).toHaveLength(3);
  });
});

// Batch resilience — restart resume + retry-failed + persisted orchestration (docs/architecture/batch-resilience.md).
describe("ScorecardService — batch-on-Temporal internals (plan → case → finalize)", () => {
  const threeCases: Dataset = {
    id: "td",
    version: "1.0.0",
    cases: (["c1", "c2", "c3"] as const).map((id) => ({
      id,
      env: { kind: "prompt" as const },
      task: "t",
      graders: [],
      timeoutSec: 60,
      tags: [],
    })),
    tags: [],
  };
  const ok = (caseId: string): CaseResult => ({
    caseId,
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "" },
    scores: [{ graderId: "tests-pass", metric: "tests-pass", value: 1, pass: true }],
  });
  function wire(dispatcher: Dispatcher) {
    const store = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    const datasets = new InMemoryDatasetRegistry();
    let n = 0;
    const service = new ScorecardService({ dispatcher, store, datasets, runStore: runs, newId: () => `t-${n++}` });
    return { store, runs, datasets, service };
  }
  const record = () => ({
    id: "sc-t",
    tenant: "acme",
    dataset: { id: "td", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    status: "queued" as const,
    runtime: "rt-a,rt-b",
    orchestration: { judges: [], concurrency: 2, retries: 0, workflowId: "everdict-batch-sc-t" },
    createdAt: "2026-07-08T00:00:00.000Z",
    updatedAt: "2026-07-08T00:00:00.000Z",
  });

  it("the full workflow loop — plan lists remaining cases (sharded targets), each case settles once, finalize aggregates", async () => {
    const seen: Array<{ id: string; target?: string }> = [];
    const dispatcher: Dispatcher = {
      async dispatch(job: CaseJob) {
        seen.push({
          id: job.evalCase.id,
          ...(job.evalCase.placement?.target ? { target: job.evalCase.placement.target } : {}),
        });
        return ok(job.evalCase.id);
      },
    };
    const { store, service, datasets } = wire(dispatcher);
    await datasets.register("acme", threeCases);
    await store.create(record());

    const plan = await service.planBatch("sc-t");
    expect(plan).toEqual({ caseIds: ["c1", "c2", "c3"], concurrency: 2 });

    for (const cid of plan.caseIds) {
      expect(await service.runBatchCase("sc-t", cid)).toEqual({ settled: true });
    }
    // Idempotency — a retried activity for an already-settled case never re-dispatches.
    expect(await service.runBatchCase("sc-t", "c1")).toEqual({ settled: true, skipped: true });
    expect(seen.map((x) => x.id)).toEqual(["c1", "c2", "c3"]);
    // Sharding parity with the in-process loop: selected-index round-robin over the comma list.
    expect(seen.map((x) => x.target)).toEqual(["rt-a", "rt-b", "rt-a"]);

    await service.finalizeBatch("sc-t");
    const rec = await store.get("sc-t");
    expect(rec?.status).toBe("succeeded");
    expect(rec?.summary?.[0]).toMatchObject({ metric: "tests-pass", count: 3, passRate: 1 });
    const hydrated = await service.get("sc-t");
    expect(hydrated?.scorecard?.results.map((r) => r.caseId)).toEqual(["c1", "c2", "c3"]);
    expect(rec?.steps?.some((s) => s.phase === "dispatch" && s.message.includes("Temporal"))).toBe(true);
  });

  // Regression (gap 12): a Temporal retry can re-invoke the SAME case's activity on the same worker while the original
  // is still in-flight (before doneIds is set). Pre-fix both executed the harness (wasted compute); the synchronous
  // in-flight claim makes the retry skip.
  it("a concurrent same-worker retry of an in-flight case does not double-dispatch", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen: string[] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job: CaseJob) {
        seen.push(job.evalCase.id);
        await gate; // hold the first dispatch in-flight so the concurrent retry arrives while it is running
        return ok(job.evalCase.id);
      },
    };
    const { store, service, datasets } = wire(dispatcher);
    await datasets.register("acme", threeCases);
    await store.create(record());
    await service.planBatch("sc-t");

    const a = service.runBatchCase("sc-t", "c1"); // executes, held at the gate (in-flight)
    while (seen.length === 0) await new Promise((r) => setTimeout(r, 0)); // wait until `a` is dispatching
    const b = await service.runBatchCase("sc-t", "c1"); // the retry — sees the in-flight claim and skips
    expect(b).toEqual({ settled: true, skipped: true });
    release();
    expect(await a).toEqual({ settled: true }); // the original completed normally

    expect(seen).toEqual(["c1"]); // dispatched ONCE (pre-fix: ["c1","c1"] — the retry double-dispatched)
  });

  it("a re-plan after a restart returns only unfinished cases (done children excluded)", async () => {
    const dispatcher: Dispatcher = {
      async dispatch(job: CaseJob) {
        return ok(job.evalCase.id);
      },
    };
    const { store, runs, service, datasets } = wire(dispatcher);
    await datasets.register("acme", threeCases);
    await store.create(record());
    await runs.create({
      id: "done-c2",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c2",
      status: "succeeded",
      result: ok("c2"),
      parentScorecardId: "sc-t",
      createdAt: "2026-07-08T00:00:01.000Z",
      updatedAt: "2026-07-08T00:00:02.000Z",
    });
    const plan = await service.planBatch("sc-t");
    expect(plan.caseIds).toEqual(["c1", "c3"]);
  });

  it("submit with a temporal driver stamps workflowId and starts the workflow; a failed start degrades to in-process", async () => {
    const started: string[] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job: CaseJob) {
        return ok(job.evalCase.id);
      },
    };
    const { store, service, datasets } = wire(dispatcher);
    await datasets.register("acme", threeCases);
    const svc = new ScorecardService({
      dispatcher,
      store,
      datasets,
      newId: () => "sc-wf",
      temporalBatches: {
        workflowIdFor: (id) => `everdict-batch-${id}`,
        start: async (id) => {
          started.push(id);
        },
      },
    });
    const rec = await svc.submit({
      tenant: "acme",
      dataset: { id: "td", version: "1.0.0" },
      harness: { id: "h", version: "1" },
    });
    expect(started).toEqual(["sc-wf"]);
    expect(rec.orchestration?.workflowId).toBe("everdict-batch-sc-wf");
    expect((await store.get("sc-wf"))?.status).toBe("queued"); // the workflow drives it — no in-process track

    // Failed start → fall back to the in-process loop (workflowId stripped, batch completes).
    let m = 0;
    const store2 = new InMemoryScorecardStore();
    const svc2 = new ScorecardService({
      dispatcher,
      store: store2,
      datasets,
      newId: () => `sc-fb-${m++}`,
      temporalBatches: {
        workflowIdFor: (id) => `everdict-batch-${id}`,
        start: async () => {
          throw new Error("temporal down");
        },
      },
    });
    const rec2 = await svc2.submit({
      tenant: "acme",
      dataset: { id: "td", version: "1.0.0" },
      harness: { id: "h", version: "1" },
    });
    const final = await waitTerminal(store2, rec2.id);
    expect(final.status).toBe("succeeded");
    expect(final.orchestration?.workflowId).toBeUndefined();
  });

  it("boot resume leaves a Temporal-owned batch alone (returns handled without re-driving)", async () => {
    const dispatcher: Dispatcher = {
      async dispatch(job: CaseJob) {
        return ok(job.evalCase.id);
      },
    };
    const { store, service, datasets } = wire(dispatcher);
    await datasets.register("acme", threeCases);
    await store.create({ ...record(), status: "running" });
    expect(await service.resume("sc-t")).toBe(true);
    expect((await store.get("sc-t"))?.status).toBe("running"); // untouched — the workflow owns it
  });
});

describe("ScorecardService — batch resilience (resume · retry-failed)", () => {
  const threeCaseDataset: Dataset = {
    id: "rd",
    version: "1.0.0",
    cases: (["c1", "c2", "c3"] as const).map((id) => ({
      id,
      env: { kind: "prompt" as const },
      task: "t",
      graders: [],
      timeoutSec: 60,
      tags: [],
    })),
    tags: [],
  };
  const passResult = (caseId: string, pass = true): CaseResult => ({
    caseId,
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "" },
    scores: [{ graderId: "tests-pass", metric: "tests-pass", value: pass ? 1 : 0, pass }],
  });
  function capturingDispatcher() {
    const dispatched: string[] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job: CaseJob) {
        dispatched.push(job.evalCase.id);
        return passResult(job.evalCase.id);
      },
    };
    return { dispatched, dispatcher };
  }
  function build(dispatcher: Dispatcher) {
    const store = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    const datasets = new InMemoryDatasetRegistry();
    let n = 0;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      runStore: runs,
      newId: () => `id-${n++}`,
    });
    return { store, runs, datasets, service };
  }

  it('runtime:"auto" expands to every registered runtime and shards; empty registry is a 400', async () => {
    const seen: string[] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job: CaseJob) {
        seen.push(job.evalCase.placement?.target ?? "?");
        return passResult(job.evalCase.id);
      },
    };
    const { store, datasets } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    let n = 0;
    const svc = new ScorecardService({
      dispatcher,
      store,
      datasets,
      newId: () => `auto-${n++}`,
      runtimesFor: async () => ["rt-x", "rt-y"],
    });
    const rec = await svc.submit({
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      runtime: "auto",
      concurrency: 1,
    });
    await waitTerminal(store, rec.id);
    expect(rec.runtime).toBe("rt-x,rt-y"); // the record shows the expansion
    expect(seen).toEqual(["rt-x", "rt-y", "rt-x"]);

    const empty = new ScorecardService({
      dispatcher,
      store: new InMemoryScorecardStore(),
      datasets,
      runtimesFor: async () => [],
    });
    await expect(
      empty.submit({
        tenant: "acme",
        dataset: { id: "rd", version: "1.0.0" },
        harness: { id: "h", version: "1" },
        runtime: "auto",
      }),
    ).rejects.toBeInstanceOf(BadRequestError);
  });

  it("a comma-separated runtime SHARDS the batch — cases round-robin across the listed runtimes", async () => {
    const seen: string[] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job: CaseJob) {
        seen.push(job.evalCase.placement?.target ?? "?");
        return passResult(job.evalCase.id);
      },
    };
    const { store, datasets, service } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      runtime: "nomad-a, k8s-b",
      concurrency: 1, // serial → deterministic round-robin order
    });
    await waitTerminal(store, rec.id);
    expect(seen).toEqual(["nomad-a", "k8s-b", "nomad-a"]);
    expect(rec.runtime).toBe("nomad-a, k8s-b"); // the record keeps the full sharding list
  });

  it("submit persists the orchestration inputs (judges/judge/concurrency/retries) needed to re-drive the batch", async () => {
    const { dispatcher } = capturingDispatcher();
    const { store, datasets, service } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      judge: { model: "gpt-5.4-mini" },
      concurrency: 7,
      retries: 2,
    });
    expect(rec.orchestration).toEqual({
      judges: [],
      judge: { model: "gpt-5.4-mini" },
      concurrency: 7,
      retries: 2,
    });
    await waitTerminal(store, rec.id);
  });

  it("resume keeps the finished children and re-dispatches only the unfinished cases", async () => {
    const { dispatched, dispatcher } = capturingDispatcher();
    const { store, runs, datasets, service } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    // An interrupted batch: c1 finished (child with result), c2 was mid-flight when the process died, c3 never started.
    await store.create({
      id: "sc-int",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "running",
      orchestration: { judges: [], concurrency: 2, retries: 0 },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
    await runs.create({
      id: "child-c1",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c1",
      status: "succeeded",
      result: passResult("c1"),
      parentScorecardId: "sc-int",
      createdAt: "2026-07-08T00:00:01.000Z",
      updatedAt: "2026-07-08T00:00:02.000Z",
    });
    await runs.create({
      id: "child-c2",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c2",
      status: "running",
      parentScorecardId: "sc-int",
      createdAt: "2026-07-08T00:00:01.000Z",
      updatedAt: "2026-07-08T00:00:01.000Z",
    });

    expect(await service.resume("sc-int")).toBe(true);
    const rec = await waitTerminal(store, "sc-int");

    expect(dispatched.sort()).toEqual(["c2", "c3"]); // c1 is never re-run
    expect(rec.status).toBe("succeeded");
    // Full case set in the final aggregate — the carried result plus the two re-runs.
    const hydrated = await service.get("sc-int");
    expect(hydrated?.scorecard?.results.map((r) => r.caseId).sort()).toEqual(["c1", "c2", "c3"]);
    expect(rec.runIds).toContain("child-c1"); // the seed child stays addressable
    expect(rec.steps?.some((s) => s.phase === "resume")).toBe(true);
    // The mid-flight child was superseded by the re-dispatch.
    expect((await runs.get("child-c2"))?.status).toBe("failed");
    expect((await runs.get("child-c2"))?.error?.code).toBe("INTERRUPTED");
  });

  it("resume ADOPTS a still-alive backend job instead of re-dispatching (in-flight adoption)", async () => {
    const { dispatched, dispatcher } = capturingDispatcher();
    const { store, runs, datasets } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    const adoptedFor: string[] = [];
    let n = 0;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      runStore: runs,
      newId: () => `ad-${n++}`,
      // The runtime still runs the job the dead control plane submitted — harvest it.
      adoptCase: async (_tenant, _runtime, caseId) => {
        adoptedFor.push(caseId);
        return caseId === "c2" ? passResult("c2") : undefined;
      },
    });
    await store.create({
      id: "sc-adopt",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "running",
      runtime: "nomad-local",
      orchestration: { judges: [], concurrency: 2, retries: 0 },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
    await runs.create({
      id: "child-c2",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c2",
      status: "running", // mid-flight when the process died — but its Nomad job is still alive
      runtime: "nomad-local",
      parentScorecardId: "sc-adopt",
      createdAt: "2026-07-08T00:00:01.000Z",
      updatedAt: "2026-07-08T00:00:01.000Z",
    });

    expect(await service.resume("sc-adopt")).toBe(true);
    const rec = await waitTerminal(store, "sc-adopt");

    expect(adoptedFor).toContain("c2");
    expect(dispatched.sort()).toEqual(["c1", "c3"]); // c2 was ADOPTED — never re-dispatched
    expect(rec.status).toBe("succeeded");
    const child = await runs.get("child-c2");
    expect(child?.status).toBe("succeeded"); // the same child settles with the harvested result (no INTERRUPTED)
    expect(child?.result?.caseId).toBe("c2");
    expect(rec.steps?.some((s) => s.phase === "resume" && s.message.includes("adopted"))).toBe(true);
  });

  it("resume refuses records it cannot faithfully re-drive (terminal status / no orchestration)", async () => {
    const { dispatcher } = capturingDispatcher();
    const { store, service, datasets } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    await store.create({
      id: "sc-done",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      orchestration: { judges: [], concurrency: 1, retries: 0 },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
    await store.create({
      id: "sc-legacy",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "running", // interrupted, but a pre-orchestration record
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
    expect(await service.resume("sc-done")).toBe(false);
    expect(await service.resume("sc-legacy")).toBe(false);
  });

  it("retryFailed re-runs only the failed cases into a NEW scorecard and carries the passes verbatim", async () => {
    const { dispatched, dispatcher } = capturingDispatcher();
    const { store, datasets, service } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    await store.create({
      id: "sc-src",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      orchestration: { judges: [], concurrency: 3, retries: 1 },
      scorecard: {
        suiteId: "rd",
        harness: "h@1",
        results: [passResult("c1"), passResult("c2", false), passResult("c3", false)],
      },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });

    const rec = await service.retryFailed({ tenant: "acme", id: "sc-src", submittedBy: "alice" });
    expect(rec.origin?.retryOf).toBe("sc-src");
    expect(rec.createdBy).toBe("alice");
    const done = await waitTerminal(store, rec.id);

    expect(dispatched.sort()).toEqual(["c2", "c3"]); // only the failed cases re-run
    expect(done.status).toBe("succeeded");
    const hydrated = await service.get(rec.id);
    expect(hydrated?.scorecard?.results.map((r) => r.caseId).sort()).toEqual(["c1", "c2", "c3"]);
    // The source record is untouched (history immutable).
    expect((await store.get("sc-src"))?.status).toBe("succeeded");
    expect((await store.get("sc-src"))?.scorecard?.results).toHaveLength(3);
  });

  it("retryFailed with failureClass=infra re-runs ONLY infra casualties — agent FAILs stay carried over", async () => {
    const { dispatched, dispatcher } = capturingDispatcher();
    const { store, datasets, service } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    const infraFailed: CaseResult = {
      ...passResult("c2", false),
      failure: {
        stage: "dispatch",
        class: "infra",
        code: "UPSTREAM_ERROR",
        message: "placement blip",
        retryable: true,
      },
    };
    await store.create({
      id: "sc-mixed",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      orchestration: { judges: [], concurrency: 3, retries: 1 },
      scorecard: {
        suiteId: "rd",
        harness: "h@1",
        // c1 passes · c2 infra-failed · c3 legitimate agent FAIL (grader verdict, no failure field)
        results: [passResult("c1"), infraFailed, passResult("c3", false)],
      },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });

    const rec = await service.retryFailed({ tenant: "acme", id: "sc-mixed", failureClass: "infra" });
    await waitTerminal(store, rec.id);
    expect(dispatched).toEqual(["c2"]); // only the infra casualty re-runs
    const hydrated = await service.get(rec.id);
    expect(hydrated?.scorecard?.results.map((r) => r.caseId).sort()).toEqual(["c1", "c2", "c3"]); // agent FAIL carried
    // Filter with no matches → 400 with a class-specific message.
    await expect(service.retryFailed({ tenant: "acme", id: "sc-mixed", failureClass: "config" })).rejects.toThrow(
      /config-class/,
    );
  });

  it("retryFailed with failureClass=agent never sweeps in a dead-judge case — unmeasured is not the agent's fault", async () => {
    const { dispatched, dispatcher } = capturingDispatcher();
    const { store, datasets, service } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    // c3 executed cleanly, but its only pass-deciding score is the unmeasured placeholder a crashed judge left
    // behind — no CaseFailure, no verdict. The old classifier read `verdict !== true` as class "agent",
    // filing the PLATFORM's judge outage under the product-blame label.
    const judgeDied: CaseResult = {
      caseId: "c3",
      harness: "h@1",
      trace: [],
      snapshot: { kind: "prompt", output: "done" },
      scores: [
        {
          graderId: "judge",
          metric: "judge:j",
          status: "unmeasured",
          reason: "grader_error",
          retryable: true,
          detail: "[grader-error] judge transport died",
        },
      ],
    };
    await store.create({
      id: "sc-blame",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      orchestration: { judges: [], concurrency: 3, retries: 1 },
      scorecard: {
        suiteId: "rd",
        harness: "h@1",
        // c1 passes · c2 legitimate agent FAIL · c3 judge died (unmeasured, no failure)
        results: [passResult("c1"), passResult("c2", false), judgeDied],
      },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });

    const rec = await service.retryFailed({ tenant: "acme", id: "sc-blame", failureClass: "agent" });
    await waitTerminal(store, rec.id);
    expect(dispatched).toEqual(["c2"]); // ONLY the real agent FAIL — the dead-judge case is not agent-class
  });

  it("retryFailed re-COLLECTS a collect-stage failure by its traceRef — the agent is never re-dispatched", async () => {
    const { dispatched, dispatcher } = capturingDispatcher();
    const { store, datasets } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    const pulled: string[] = [];
    let n = 0;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      newId: () => `rc-${n++}`,
      // The platform is reachable again at retry time — the pull recovers the case.
      buildTraceSource: () => ({
        async fetch(runId: string) {
          pulled.push(runId);
          return [{ t: 1, kind: "llm_call" as const, model: "m" }];
        },
      }),
    });
    // c2 ran fine (ground-truth PASS) but its trace pull died — classified {collect} with re-collect coordinates.
    const collectFailed: CaseResult = {
      ...passResult("c2"),
      traceRef: { kind: "otel", endpoint: "http://collector:9", runId: "rid-c2" },
      failure: {
        stage: "collect",
        class: "infra",
        code: "TRACE_COLLECT_FAILED",
        message: "trace collection failed: fetch failed",
        retryable: true,
      },
    };
    await store.create({
      id: "sc-collect",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      orchestration: { judges: [], concurrency: 3, retries: 1 },
      scorecard: {
        suiteId: "rd",
        harness: "h@1",
        results: [passResult("c1"), collectFailed, passResult("c3", false)],
      },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });

    const rec = await service.retryFailed({ tenant: "acme", id: "sc-collect" });
    const done = await waitTerminal(store, rec.id);

    expect(done.status).toBe("succeeded");
    expect(pulled).toEqual(["rid-c2"]); // re-pulled by the frozen correlation key
    expect(dispatched.sort()).toEqual(["c3"]); // ONLY the genuine failure re-dispatched — c2 never re-ran
    const hydrated = await service.get(rec.id);
    const c2 = hydrated?.scorecard?.results.find((r) => r.caseId === "c2");
    expect(c2?.failure).toBeUndefined(); // recovered — classification shed
    expect(c2?.trace.some((e) => e.kind === "llm_call")).toBe(true); // the collected platform trace landed
    expect(measuredScores(c2?.scores ?? []).some((s) => s.graderId === "tests-pass" && s.pass === true)).toBe(true); // ground truth kept
  });

  it("retryFailed doubles an OOM_KILLED case's memoryMb on the job only, and compounds across consecutive retries", async () => {
    const templates = new InMemoryHarnessTemplateRegistry();
    const instances = new InMemoryHarnessInstanceRegistry(templates);
    await templates.register("acme", {
      kind: "command",
      category: "cli-agent",
      id: "oomb",
      version: "1",
      resources: { memoryMb: 64 },
      setup: [],
      command: "run",
      env: {},
      params: {},
      trace: { kind: "none" },
    });
    await instances.register("acme", {
      template: { id: "oomb", version: "1" },
      id: "oomb",
      version: "1.0.0",
      pins: {},
    });

    const oomResult = (caseId: string): CaseResult => ({
      ...passResult(caseId, false),
      failure: { stage: "dispatch", class: "infra", code: "OOM_KILLED", message: "task OOM-killed", retryable: false },
    });
    // The dispatcher keeps OOM-killing c2 — each retry must escalate from the PREVIOUS boost, not the spec base.
    const jobs: CaseJob[] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        jobs.push(job);
        return oomResult(job.evalCase.id);
      },
    };
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", threeCaseDataset);
    let n = 0;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      harnesses: instances,
      newId: () => `oom-${n++}`,
    });
    await store.create({
      id: "sc-oom",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "oomb", version: "1.0.0" },
      status: "succeeded",
      orchestration: { judges: [], concurrency: 3, retries: 0 },
      scorecard: {
        suiteId: "rd",
        harness: "oomb@1.0.0",
        results: [passResult("c1"), oomResult("c2"), passResult("c3")],
      },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });

    const retry1 = await service.retryFailed({ tenant: "acme", id: "sc-oom" });
    await waitTerminal(store, retry1.id);
    expect(retry1.origin?.memoryBoostMb).toEqual({ c2: 128 }); // 64 → 128
    const job1 = jobs.find((j) => j.evalCase.id === "c2");
    expect(job1?.harnessSpec?.kind === "command" && job1.harnessSpec.resources?.memoryMb).toBe(128);

    // The retried case OOMed again → the next retry compounds from 128, not from the 64 spec base.
    jobs.length = 0;
    const retry2 = await service.retryFailed({ tenant: "acme", id: retry1.id });
    await waitTerminal(store, retry2.id);
    expect(retry2.origin?.memoryBoostMb).toEqual({ c2: 256 });
    const job2 = jobs.find((j) => j.evalCase.id === "c2");
    expect(job2?.harnessSpec?.kind === "command" && job2.harnessSpec.resources?.memoryMb).toBe(256);
    // The registry spec itself is untouched — the boost rides the job only.
    const spec = await instances.get("acme", "oomb", "1.0.0");
    expect(spec.kind === "command" && spec.resources?.memoryMb).toBe(64);
  });

  it("retryFailed with the Temporal driver: seeds materialize as child runs, the workflow is started, and planBatch sees only the failures", async () => {
    const { dispatcher } = capturingDispatcher();
    const store = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", threeCaseDataset);
    const started: string[] = [];
    let n = 0;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      runStore: runs,
      newId: () => `tp-${n++}`,
      temporalBatches: {
        workflowIdFor: (id) => `everdict-batch-${id}`,
        start: async (id) => {
          started.push(id);
        },
      },
    });
    await store.create({
      id: "sc-tp",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      orchestration: { judges: [], concurrency: 3, retries: 0 },
      scorecard: {
        suiteId: "rd",
        harness: "h@1",
        results: [passResult("c1"), passResult("c2", false), passResult("c3")],
      },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });

    const rec = await service.retryFailed({ tenant: "acme", id: "sc-tp" });
    // The async branch stamps + starts — settle it.
    for (let i = 0; i < 50 && started.length === 0; i++) await new Promise((r) => setTimeout(r, 10));

    expect(started).toEqual([rec.id]); // the retry batch is workflow-owned
    const stamped = await store.get(rec.id);
    expect(stamped?.orchestration?.workflowId).toBe(`everdict-batch-${rec.id}`);
    expect(stamped?.steps?.some((s) => s.phase === "resume" && s.message.includes("Retry of sc-tp"))).toBe(true);
    // Seeds (c1, c3) materialized as succeeded children → the idempotent plan drives only the failure.
    const children = await runs.list("acme", { scorecardId: rec.id });
    expect(children.map((c) => c.caseId).sort()).toEqual(["c1", "c3"]);
    const plan = await service.planBatch(rec.id);
    expect(plan.caseIds).toEqual(["c2"]);
  });

  it("submit validates a per-batch traceSink against the workspace sinks and persists it on orchestration", async () => {
    const { dispatcher } = capturingDispatcher();
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", threeCaseDataset);
    let n = 0;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      newId: () => `sink-${n++}`,
      sinkExists: async (_t, name) => name === "mlf",
    });
    await expect(
      service.submit({
        tenant: "acme",
        dataset: { id: "rd", version: "1.0.0" },
        harness: { id: "h", version: "1" },
        traceSink: "ghost", // not configured → 400 at submit, before any dispatch
      }),
    ).rejects.toBeInstanceOf(BadRequestError);

    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      traceSink: "mlf",
    });
    expect(rec.orchestration?.traceSink).toBe("mlf"); // persisted — resume/retry keep the destination
    await waitTerminal(store, rec.id);

    // "none" never needs a configured sink — it means "suppress export for this batch".
    const none = await service.submit({
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      traceSink: "none",
    });
    expect(none.orchestration?.traceSink).toBe("none");
    await waitTerminal(store, none.id);
  });

  it("estimate projects per-case medians from recent succeeded batches; no history = honest empty", async () => {
    const { dispatcher } = capturingDispatcher();
    const store = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", threeCaseDataset);
    let n = 0;
    const service = new ScorecardService({ dispatcher, store, datasets, runStore: runs, newId: () => `est-${n++}` });

    // No history yet — honest empty (a guess would be worse than nothing).
    expect(await service.estimate({ tenant: "acme", dataset: "rd", harness: "h" })).toEqual({
      basis: { scorecards: 0, samples: 0 },
    });

    // One past batch: 3 children, durations 10/20/30s, usd 0.01/0.02/0.03 → medians 20s / 0.02.
    await store.create({
      id: "sc-hist",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      orchestration: { judges: [], concurrency: 3, retries: 0 },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:10:00.000Z",
    });
    const mkChild = async (i: number, sec: number, usd: number) =>
      runs.create({
        id: `hist-${i}`,
        tenant: "acme",
        harness: { id: "h", version: "1" },
        caseId: `c${i}`,
        status: "succeeded",
        result: {
          caseId: `c${i}`,
          harness: "h@1",
          trace: [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd } }],
          snapshot: { kind: "prompt", output: "" },
          scores: [{ graderId: "tests-pass", metric: "tests-pass", value: 1, pass: true }],
        },
        parentScorecardId: "sc-hist",
        trigger: "scorecard",
        createdAt: "2026-07-08T00:00:00.000Z",
        updatedAt: new Date(Date.parse("2026-07-08T00:00:00.000Z") + sec * 1000).toISOString(),
      });
    await mkChild(1, 10, 0.01);
    await mkChild(2, 20, 0.02);
    await mkChild(3, 30, 0.03);

    const est = await service.estimate({ tenant: "acme", dataset: "rd", harness: "h", cases: 100, concurrency: 10 });
    expect(est.basis).toEqual({ scorecards: 1, samples: 3 });
    expect(est.perCase).toEqual({ usdMedian: 0.02, durationSecMedian: 20 });
    // 100 cases × $0.02 = $2 · ceil(100/10) waves × 20s = 200s.
    expect(est.estimate).toEqual({ cases: 100, usd: 2, wallSeconds: 200, concurrency: 10 });
  });

  it("a running batch's get() carries etaSeconds derived from its own finished children", async () => {
    const { dispatcher } = capturingDispatcher();
    const store = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", threeCaseDataset);
    const service = new ScorecardService({ dispatcher, store, datasets, runStore: runs, newId: () => "eta-1" });
    await store.create({
      id: "sc-eta",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "running",
      orchestration: { judges: [], concurrency: 1, retries: 0 },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
    // one finished child took 30s → 2 remaining of 3 at concurrency 1 → ETA 60s.
    await runs.create({
      id: "eta-child",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c1",
      status: "succeeded",
      result: passResult("c1"),
      parentScorecardId: "sc-eta",
      trigger: "scorecard",
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:30.000Z",
    });
    expect((await service.get("sc-eta"))?.etaSeconds).toBe(60);
    // terminal records never carry an ETA.
    await store.update("sc-eta", { status: "succeeded", updatedAt: "x" });
    expect((await service.get("sc-eta"))?.etaSeconds).toBeUndefined();
  });

  it("retryFailed rejects an in-flight source (400) and an all-pass source (nothing to retry)", async () => {
    const { dispatcher } = capturingDispatcher();
    const { store, datasets, service } = build(dispatcher);
    await datasets.register("acme", threeCaseDataset);
    await store.create({
      id: "sc-running",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "running",
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
    await store.create({
      id: "sc-clean",
      tenant: "acme",
      dataset: { id: "rd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      scorecard: { suiteId: "rd", harness: "h@1", results: [passResult("c1")] },
      createdAt: "2026-07-08T00:00:00.000Z",
      updatedAt: "2026-07-08T00:00:00.000Z",
    });
    await expect(service.retryFailed({ tenant: "acme", id: "sc-running" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(service.retryFailed({ tenant: "acme", id: "sc-clean" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(service.retryFailed({ tenant: "beta", id: "sc-clean" })).rejects.toBeInstanceOf(NotFoundError); // other-workspace = 404
  });
});

describe("ScorecardService.submit — N-trial (pass@k / flakiness)", () => {
  it("fans each case into N trials, creates a child run per trial, and derives a trialSummary on get()", async () => {
    // Given: a 1-case dataset and a dispatch where trial 1 fails (2/3 → flaky). job.trial reaches the dispatcher.
    const seenTrials: Array<number | undefined> = [];
    const trialDispatch: Dispatcher = {
      async dispatch(job) {
        seenTrials.push(job.trial);
        const pass = job.trial !== 1;
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [{ graderId: "tests-pass", metric: "tests_pass", value: pass ? 1 : 0, pass }],
        };
      },
    };
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    let n = 0;
    const service = new ScorecardService({
      dispatcher: trialDispatch,
      store,
      datasets,
      runStore,
      newId: () => `id-${n++}`,
    });

    // When: submitting with trials=3
    const created = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      trials: 3,
    });
    const done = await waitTerminal(store, created.id);

    // Then: 3 dispatches (trials 0..2), one child run per (case, trial), trials persisted for a re-drive
    expect(done.status).toBe("succeeded");
    expect(seenTrials.filter((t): t is number => t !== undefined).sort()).toEqual([0, 1, 2]);
    expect(done.orchestration?.trials).toBe(3);
    const children = await runStore.list("acme", { scorecardId: created.id });
    expect(children.filter((c) => c.caseId === "c1")).toHaveLength(3);

    // And: get() derives the trial roll-up — c1 passed 2/3 and is flaky
    const detail = await service.get(created.id);
    expect(detail?.trialSummary).toMatchObject({ cases: 1, flakyCases: 1, minTrials: 3, maxTrials: 3 });
    expect(detail?.trialSummary?.passAt1).toBeCloseTo(2 / 3, 10);
  });

  it("a single-run batch carries no trial index and no trialSummary (backward compatible)", async () => {
    const okDispatch: Dispatcher = {
      async dispatch(job) {
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
        };
      },
    };
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    let n = 0;
    const service = new ScorecardService({
      dispatcher: okDispatch,
      store,
      datasets,
      runStore,
      newId: () => `id-${n++}`,
    });

    const created = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    await waitTerminal(store, created.id);

    const children = await runStore.list("acme", { scorecardId: created.id });
    expect(children.filter((c) => c.caseId === "c1")).toHaveLength(1);
    expect(children[0]?.result?.trial).toBeUndefined();
    const detail = await service.get(created.id);
    expect(detail?.trialSummary).toBeUndefined();
    expect(detail?.orchestration?.trials).toBeUndefined();
  });
});

describe("ScorecardService usage metering", () => {
  it("meters each case's harness LLM cost against the billing tenant (meter-only, never blocks)", async () => {
    // Given: a dispatch whose result carries an llm_call cost
    const costDispatch: Dispatcher = {
      async dispatch(job) {
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [{ t: 0, kind: "llm_call", model: "m", cost: { usd: 0.05, inputTokens: 200, outputTokens: 0 } }],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
        };
      },
    };
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const usage = inMemoryUsageMeter();
    let n = 0;
    const service = new ScorecardService({
      dispatcher: costDispatch,
      store,
      datasets,
      usage,
      newId: () => `id-${n++}`,
    });

    // When: a managed batch runs
    const created = await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    await waitTerminal(store, created.id);

    // Then: the workspace's metered usage reflects the harness LLM cost (one evaluation)
    const u = usage.usage("acme");
    expect(u).toMatchObject({ usd: 0.05, tokens: 200, evaluations: 1 });
    expect(u.bySource.harness).toMatchObject({ usd: 0.05, tokens: 200, evaluations: 1 });
  });
});

describe("ScorecardService — adaptive batch concurrency (pressure shrinks the effective width)", () => {
  const fourCaseDataset: Dataset = {
    id: "ad",
    version: "1.0.0",
    cases: ["c1", "c2", "c3", "c4"].map((id) => ({
      id,
      env: { kind: "repo", source: { files: {} } },
      task: "t",
      graders: [],
      timeoutSec: 60,
      tags: [],
    })),
    tags: [],
  };

  // A parking dispatcher that records the in-flight high-water mark (the observable effective width).
  function parkingDispatcher() {
    let inFlight = 0;
    let maxSeen = 0;
    const pending: Array<() => void> = [];
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        inFlight += 1;
        maxSeen = Math.max(maxSeen, inFlight);
        await new Promise<void>((resolve) =>
          pending.push(() => {
            inFlight -= 1;
            resolve();
          }),
        );
        return { ...caseResult(true), caseId: job.evalCase.id };
      },
    };
    return {
      dispatcher,
      releaseAll: () => {
        while (pending.length > 0) pending.shift()?.();
      },
      pendingCount: () => pending.length,
      max: () => maxSeen,
    };
  }
  const until = async (cond: () => boolean | Promise<boolean>): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("condition not met");
  };

  it("a scheduler queue spike halves the effective width (4 workers → 2 concurrent dispatches)", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", fourCaseDataset);
    const park = parkingDispatcher();
    const events: string[] = [];
    const service = new ScorecardService({
      dispatcher: park.dispatcher,
      store,
      datasets,
      concurrency: 4,
      queueDepth: () => 100, // pressured from the start
      queuePressure: 10,
      onOrchestrationEvent: (e) => {
        if (e.kind === "concurrency_adapted") events.push(`${e.previous}->${e.effective}`);
      },
    });
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "ad", version: "latest" },
      harness: { id: "scripted", version: "0" },
    });
    await until(() => park.pendingCount() === 2); // only 2 of 4 cases dispatched under pressure
    expect(park.max()).toBe(2);
    // Drain: release the parked pair, the remaining two follow (still ≤2 at a time).
    park.releaseAll();
    await until(() => park.pendingCount() === 2);
    park.releaseAll();
    await until(async () => (await store.get(rec.id))?.status === "succeeded");
    expect(park.max()).toBe(2);
    expect(events).toContain("4->2"); // the shrink transition surfaced to the metrics seam
  });

  it("an open circuit on one of the batch's runtimes halves the width; all-open floors it at 1", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", fourCaseDataset);
    const park = parkingDispatcher();
    const breaker = new CircuitBreaker({ threshold: 1, cooldownMs: 60_000 });
    breaker.failure("acme:rt-a"); // rt-a is known-dead before the batch starts
    const service = new ScorecardService({
      dispatcher: park.dispatcher,
      store,
      datasets,
      concurrency: 4,
      breaker,
    });
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "ad", version: "latest" },
      harness: { id: "scripted", version: "0" },
      runtime: "rt-a,rt-b", // sharded — rt-a open → factor 0.5 → effective 2 (cases spill to rt-b and succeed)
    });
    await until(() => park.pendingCount() === 2);
    expect(park.max()).toBe(2);
    park.releaseAll();
    await until(() => park.pendingCount() === 2);
    park.releaseAll();
    await until(async () => (await store.get(rec.id))?.status === "succeeded");
    expect(park.max()).toBe(2);

    // All targets open → trickle at 1, then AUTO-RESTORE: the trickle probe succeeds (spillover reports
    // breaker.success), the circuits close, and the remaining cases fan back out without any reset call.
    breaker.failure("acme:rt-a");
    breaker.failure("acme:rt-b");
    const park2 = parkingDispatcher();
    const service2 = new ScorecardService({
      dispatcher: park2.dispatcher,
      store,
      datasets,
      concurrency: 4,
      breaker,
    });
    const rec2 = await service2.submit({
      tenant: "acme",
      dataset: { id: "ad", version: "latest" },
      harness: { id: "scripted", version: "0" },
      runtime: "rt-a,rt-b",
    });
    await until(() => park2.pendingCount() === 1);
    expect(park2.max()).toBe(1); // fully-open shard list → serialized probe, never a full stop
    park2.releaseAll(); // the probe succeeds on rt-a → breaker.success closes THAT circuit → width doubles
    await until(() => park2.pendingCount() === 2);
    park2.releaseAll(); // rt-b stays open (its cases spill to healthy rt-a first), so half-width is the plateau
    await until(() => park2.pendingCount() === 1);
    park2.releaseAll();
    await until(async () => (await store.get(rec2.id))?.status === "succeeded");
    expect(park2.max()).toBe(2); // trickle → half-width restore observed, no reset call anywhere
  });
});

describe("ScorecardService — in-batch OOM auto-boost (opt-in)", () => {
  const oneCaseDataset: Dataset = {
    id: "od",
    version: "1.0.0",
    cases: [
      { id: "m1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    ],
    tags: [],
  };
  const oomTemplate: HarnessTemplateSpec = {
    kind: "command",
    category: "cli-agent",
    id: "hungry",
    version: "1",
    resources: { memoryMb: 64 },
    setup: [],
    command: "run",
    env: {},
    params: {},
    trace: { kind: "none" },
  };
  async function fixtures() {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", oneCaseDataset);
    const templates = new InMemoryHarnessTemplateRegistry();
    const instances = new InMemoryHarnessInstanceRegistry(templates);
    await templates.register("acme", oomTemplate);
    await instances.register("acme", {
      template: { id: "hungry", version: "1" },
      id: "hungry",
      version: "1.0.0",
      pins: {},
    });
    return { datasets, instances };
  }
  // A dispatcher that OOM-kills any job under `needMb` of declared memory — the boost loop's foil.
  function oomBelow(needMb: number) {
    const memoriesSeen: number[] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        const mb = job.harnessSpec?.kind === "command" ? (job.harnessSpec.resources?.memoryMb ?? 0) : 0;
        memoriesSeen.push(mb);
        if (mb < needMb) throw new UpstreamError("UPSTREAM_ERROR", { signal: "OOM_KILLED" }, "task OOM-killed");
        return { ...caseResult(true), caseId: job.evalCase.id };
      },
    };
    return { dispatcher, memoriesSeen };
  }
  const waitTerminal = async (store: InMemoryScorecardStore, id: string) => {
    for (let i = 0; i < 200; i++) {
      const rec = await store.get(id);
      if (rec && rec.status !== "queued" && rec.status !== "running") return rec;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("not terminal");
  };

  it("with the knob set, an OOM case re-dispatches with doubled memory until it fits (64 → 128 → 256)", async () => {
    const { datasets, instances } = await fixtures();
    const store = new InMemoryScorecardStore();
    const oom = oomBelow(256);
    const boosts: number[] = [];
    const service = new ScorecardService({
      dispatcher: oom.dispatcher,
      store,
      datasets,
      harnesses: instances,
      onOrchestrationEvent: (e) => {
        if (e.kind === "oom_escalated") boosts.push(e.memoryMb);
      },
    });
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "od", version: "latest" },
      harness: { id: "hungry", version: "latest" },
      oomAutoBoost: true,
    });
    expect(rec.orchestration?.oomAutoBoost).toBe(true); // persisted — resume keeps the behavior
    const done = await waitTerminal(store, rec.id);
    expect(done.status).toBe("succeeded");
    expect(oom.memoriesSeen).toEqual([64, 128, 256]); // in-batch compounding, no retry-failed round-trip
    expect(boosts).toEqual([128, 256]); // each boost surfaced to the metrics seam
    expect(done.steps?.some((st) => st.message.includes("OOM auto-boost 64 → 128Mb"))).toBe(true);
  });

  it("without the knob, the OOM stays a fatal infra failure (no hidden re-runs)", async () => {
    const { datasets, instances } = await fixtures();
    const store = new InMemoryScorecardStore();
    const oom = oomBelow(256);
    const service = new ScorecardService({ dispatcher: oom.dispatcher, store, datasets, harnesses: instances });
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "od", version: "latest" },
      harness: { id: "hungry", version: "latest" },
    });
    const done = await waitTerminal(store, rec.id);
    expect(oom.memoriesSeen).toEqual([64]); // exactly one attempt
    expect(done.scorecard?.results[0]?.failure?.code).toBe("OOM_KILLED"); // classification preserved for retry-failed
  });

  it("boosting stops at the cap — a case that can never fit surfaces its OOM instead of looping", async () => {
    const { datasets, instances } = await fixtures();
    const store = new InMemoryScorecardStore();
    const oom = oomBelow(Number.POSITIVE_INFINITY); // insatiable
    const service = new ScorecardService({ dispatcher: oom.dispatcher, store, datasets, harnesses: instances });
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "od", version: "latest" },
      harness: { id: "hungry", version: "latest" },
      oomAutoBoost: true,
    });
    const done = await waitTerminal(store, rec.id);
    expect(oom.memoriesSeen[oom.memoriesSeen.length - 1]).toBe(16_384); // capped, then surfaced
    expect(done.scorecard?.results[0]?.failure?.code).toBe("OOM_KILLED");
  });
});

describe("ScorecardService — trace-correlation runId on batch jobs (observability ③)", () => {
  it("every dispatched case job carries evd-<batchId>-<caseId> (observers derive it with zero lookups)", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", {
      id: "cd",
      version: "1.0.0",
      cases: [
        { id: "x1", env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 60, tags: [] },
      ],
      tags: [],
    });
    const jobs: CaseJob[] = [];
    const capture: Dispatcher = {
      async dispatch(job) {
        jobs.push(job);
        return { ...caseResult(true), caseId: job.evalCase.id };
      },
    };
    const service = new ScorecardService({ dispatcher: capture, store, datasets, newId: () => "sc-rid" });
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "cd", version: "latest" },
      harness: { id: "scripted", version: "0" },
    });
    for (let i = 0; i < 100 && (await store.get(rec.id))?.status !== "succeeded"; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(jobs[0]?.runId).toBe(`evd-${rec.id}-x1`);
  });
});

describe("ScorecardService.submit — run-time grading plan (dataset stays pure data)", () => {
  const planDataset: Dataset = {
    id: "pd",
    version: "1.0.0",
    cases: [
      {
        id: "c1",
        env: { kind: "prompt" },
        task: "t",
        expected: "42",
        graders: [{ id: "steps" }],
        timeoutSec: 60,
        tags: [],
      },
    ],
    tags: [],
  };
  const capture = (jobs: CaseJob[]): Dispatcher => ({
    async dispatch(job) {
      jobs.push(job);
      return { ...caseResult(true), caseId: job.evalCase.id };
    },
  });

  it("a graders plan replaces every dispatched case's defaults and is persisted in orchestration (resume/retry parity)", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", planDataset);
    const jobs: CaseJob[] = [];
    const service = new ScorecardService({ dispatcher: capture(jobs), store, datasets, newId: () => "sc-plan" });
    await service.submit({
      tenant: "acme",
      dataset: { id: "pd", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      graders: [{ id: "answer-match" }, { id: "cost" }],
    });
    for (let i = 0; i < 100 && (await store.get("sc-plan"))?.status !== "succeeded"; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(jobs[0]?.evalCase.graders.map((g) => g.id)).toEqual(["answer-match", "cost"]); // the plan, not the case default
    expect(jobs[0]?.evalCase.expected).toBe("42"); // row data rides along untouched
    const rec = await store.get("sc-plan");
    expect(rec?.orchestration?.graders?.map((g) => g.id)).toEqual(["answer-match", "cost"]);
  });

  it("without a plan, each case keeps its own default graders and nothing extra is persisted", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", planDataset);
    const jobs: CaseJob[] = [];
    const service = new ScorecardService({ dispatcher: capture(jobs), store, datasets, newId: () => "sc-noplan" });
    await service.submit({
      tenant: "acme",
      dataset: { id: "pd", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    for (let i = 0; i < 100 && (await store.get("sc-noplan"))?.status !== "succeeded"; i++)
      await new Promise((r) => setTimeout(r, 5));
    expect(jobs[0]?.evalCase.graders.map((g) => g.id)).toEqual(["steps"]);
    expect((await store.get("sc-noplan"))?.orchestration?.graders).toBeUndefined();
  });
});

// Rich-domain-core S2 (docs/architecture/rich-domain-core.md): the previously-unguarded terminal re-write races
// are now read-guarded through the ScorecardBatch model — the first terminal write wins, a late loser is a skip.
describe("ScorecardService — first terminal write wins (rich domain guards)", () => {
  // A gating dispatcher — holds every case at the gate until release() so the test can act mid-flight.
  function gatedDispatcher() {
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        await gate;
        return { ...caseResult(true), caseId: job.evalCase.id };
      },
    };
    return { dispatcher, release: () => release() };
  }
  const until = async (cond: () => boolean | Promise<boolean>): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      if (await cond()) return;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("condition not met");
  };

  it("a late track success cannot overwrite a superseded batch (supersede raced ahead of the abort signal)", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const gate = gatedDispatcher();
    const completed: string[] = [];
    const service = new ScorecardService({
      dispatcher: gate.dispatcher,
      store,
      datasets,
      newId: () => "sc-race-ok",
      onComplete: async (_tenant, rec) => {
        completed.push(rec.status);
      },
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
    });
    await until(async () => (await store.get("sc-race-ok"))?.status === "running");
    // Simulate the exact race window: the supersede status write landed, but the in-flight abort has NOT fired.
    await store.update("sc-race-ok", {
      status: "superseded",
      error: { code: "SUPERSEDED", message: "Replaced by a newer fire of the same PR (sc-next)" },
    });
    gate.release();
    await until(() => completed.length === 1); // the track loop has fully settled

    const final = await store.get("sc-race-ok");
    expect(final?.status).toBe("superseded"); // pre-fix: the unguarded write revived it to succeeded
    expect(final?.error?.code).toBe("SUPERSEDED");
    expect(final?.scorecard).toBeUndefined(); // the losing terminal write is a full skip, not a partial merge
  });

  it("a late track failure cannot overwrite a superseded batch", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", {
      kind: "model",
      id: "j1",
      version: "1.0.0",
      provider: "anthropic",
      model: "claude-opus-4-8",
      rubric: "ok?",
      inputs: ["trace"],
      tags: [],
    });
    const gate = gatedDispatcher();
    const completed: string[] = [];
    const service = new ScorecardService({
      dispatcher: gate.dispatcher,
      store,
      datasets,
      judges,
      judgeRunner: {
        async run() {
          throw new Error("judge boom"); // fails the batch in the judges phase, after the supersede lands
        },
      },
      newId: () => "sc-race-fail",
      onComplete: async (_tenant, rec) => {
        completed.push(rec.status);
      },
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      judges: [{ id: "j1", version: "1.0.0" }],
    });
    await until(async () => (await store.get("sc-race-fail"))?.status === "running");
    await store.update("sc-race-fail", {
      status: "superseded",
      error: { code: "SUPERSEDED", message: "Replaced by a newer fire of the same PR (sc-next)" },
    });
    gate.release();
    await until(() => completed.length === 1);

    const final = await store.get("sc-race-fail");
    expect(final?.status).toBe("superseded"); // pre-fix: the unguarded write flipped it to failed
    expect(final?.error?.code).toBe("SUPERSEDED"); // the judge failure never replaces the supersede marker
  });

  it("planBatch does not revive a superseded batch to running (Temporal activity racing the workflow cancel)", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const service = new ScorecardService({ dispatcher, store, datasets, runStore: new InMemoryRunStore() });
    await store.create({
      id: "sc-plan-sup",
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "superseded",
      error: { code: "SUPERSEDED", message: "Replaced by a newer fire of the same PR (sc-next)" },
      orchestration: { judges: [], concurrency: 2, retries: 0, workflowId: "wf-sup" },
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    const plan = await service.planBatch("sc-plan-sup");
    expect(plan.caseIds).toEqual(["c1"]); // still answers the workflow (runBatchCase skips per case)
    expect((await store.get("sc-plan-sup"))?.status).toBe("superseded"); // pre-fix: blindly re-written to running
  });

  it("finalizeBatch cannot overwrite a superseded batch and skips its completion notification (Temporal)", async () => {
    const store = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const completed: string[] = [];
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      runStore: runs,
      onComplete: async (_tenant, rec) => {
        completed.push(rec.id);
      },
    });
    await store.create({
      id: "sc-fin-sup",
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "superseded",
      error: { code: "SUPERSEDED", message: "Replaced by a newer fire of the same PR (sc-next)" },
      orchestration: { judges: [], concurrency: 2, retries: 0, workflowId: "wf-fin" },
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });
    await runs.create({
      id: "child-c1",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c1",
      status: "succeeded",
      result: { ...caseResult(true), caseId: "c1" },
      parentScorecardId: "sc-fin-sup",
      createdAt: "2026-07-10T00:00:01.000Z",
      updatedAt: "2026-07-10T00:00:02.000Z",
    });

    await service.finalizeBatch("sc-fin-sup");
    const final = await store.get("sc-fin-sup");
    expect(final?.status).toBe("superseded"); // pre-fix: finalize revived it to succeeded
    expect(final?.summary).toBeUndefined(); // the losing terminal write is a full skip
    expect(completed).toEqual([]); // a replaced batch's completion notification is noise
  });
});

// User stop — cancel a running batch and free its runtime (cooperative abort + cancelQueued + cancelLeased + killCase).
describe("ScorecardService.cancel — user stop", () => {
  it("marks a running batch cancelled and requests both reclaim paths (queued scheduler + self-hosted lease), keyed by batch id", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("sc-run", { status: "running" }));
    let queuedPred: ((j: CaseJob) => boolean) | undefined;
    let leasedPred: ((j: CaseJob) => boolean) | undefined;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets: new InMemoryDatasetRegistry(),
      cancelQueued: (p) => {
        queuedPred = p;
        return 0;
      },
      cancelLeased: (p) => {
        leasedPred = p;
        return 1;
      },
    });

    const stopped = await service.cancel({ tenant: "acme", id: "sc-run" });

    expect(stopped.status).toBe("cancelled");
    expect(stopped.error).toEqual({ code: "CANCELLED", message: "Stopped by user" });
    // Both reclaim predicates target THIS batch (and only this batch).
    expect(queuedPred?.({ batchId: "sc-run" } as CaseJob)).toBe(true);
    expect(leasedPred?.({ batchId: "sc-run" } as CaseJob)).toBe(true);
    expect(leasedPred?.({ batchId: "other" } as CaseJob)).toBe(false);
  });

  it("force-kills only the RUNNING managed child runs, targeting each child's runtime", async () => {
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    await store.create(record("sc-k", { status: "running", runtime: "nomad-1" }));
    await runStore.create({
      id: "r1",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c1",
      status: "running",
      parentScorecardId: "sc-k",
      trigger: "scorecard",
      runtime: "nomad-1",
      createdAt: "t",
      updatedAt: "t",
    });
    await runStore.create({
      id: "r2",
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId: "c2",
      status: "succeeded",
      parentScorecardId: "sc-k",
      trigger: "scorecard",
      createdAt: "t",
      updatedAt: "t",
    });
    const killed: Array<{ runtime?: string; caseId: string }> = [];
    const service = new ScorecardService({
      dispatcher,
      store,
      runStore,
      datasets: new InMemoryDatasetRegistry(),
      killCase: async (_tenant, runtime, caseId) => {
        killed.push({ runtime, caseId });
      },
    });

    await service.cancel({ tenant: "acme", id: "sc-k" });

    expect(killed).toEqual([{ runtime: "nomad-1", caseId: "c1" }]); // finished c2 is left alone
  });

  it("a missing or cross-workspace scorecard is a NotFound (no existence leak)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("sc-other", { tenant: "other", status: "running" }));
    const service = svc(store);
    await expect(service.cancel({ tenant: "acme", id: "nope" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.cancel({ tenant: "acme", id: "sc-other" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("stopping an already-finished batch is a ConflictError (the domain rejects a terminal transition)", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("sc-done", { status: "succeeded" }));
    const service = svc(store);
    await expect(service.cancel({ tenant: "acme", id: "sc-done" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("cancel settles queued AND running child runs as failed{CANCELLED} — the ledger flip does not depend on an in-process drain", async () => {
    // No killCase and no live track loop wired — models a cancel after a control-plane restart (or a
    // Temporal-owned batch), where nobody is left to drain a dispatch rejection into the child record.
    const store = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    await store.create(record("sc-orphan", { status: "running" }));
    const child = (id: string, caseId: string, status: RunRecord["status"]): RunRecord => ({
      id,
      tenant: "acme",
      harness: { id: "h", version: "1" },
      caseId,
      status,
      parentScorecardId: "sc-orphan",
      trigger: "scorecard",
      createdAt: "t",
      updatedAt: "t",
    });
    await runs.create(child("r-running", "c1", "running"));
    await runs.create(child("r-queued", "c2", "queued"));
    await runs.create({ ...child("r-done", "c3", "succeeded"), result: { ...caseResult(true), caseId: "c3" } });
    const service = new ScorecardService({
      dispatcher,
      store,
      runStore: runs,
      datasets: new InMemoryDatasetRegistry(),
    });

    await service.cancel({ tenant: "acme", id: "sc-orphan" });

    // Pre-fix: r-running stayed "running" forever (and r-queued stayed "queued") — the batch read cancelled
    // while its children still reported live work and held their envelope slots.
    expect((await runs.get("r-running"))?.status).toBe("failed");
    expect((await runs.get("r-running"))?.error?.code).toBe("CANCELLED");
    expect((await runs.get("r-queued"))?.status).toBe("failed");
    expect((await runs.get("r-queued"))?.error?.code).toBe("CANCELLED");
    // A finished child's outcome is evidence — cancel never rewrites it.
    expect((await runs.get("r-done"))?.status).toBe("succeeded");
  });

  it("a case that lands after the stop cannot resurrect its cancelled child run (first terminal write wins)", async () => {
    const until = async (cond: () => boolean | Promise<boolean>): Promise<void> => {
      for (let i = 0; i < 200; i++) {
        if (await cond()) return;
        await new Promise((r) => setTimeout(r, 5));
      }
      throw new Error("condition not reached");
    };
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let drained = false;
    const gatedDispatcher: Dispatcher = {
      async dispatch(job) {
        await gate; // held in-flight until after the user stops the batch
        drained = true;
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [{ graderId: "tests-pass", metric: "tests-pass", value: 1, pass: true }],
        };
      },
    };
    let n = 0;
    const service = new ScorecardService({
      dispatcher: gatedDispatcher,
      store,
      datasets,
      runStore: runs,
      newId: () => (n++ === 0 ? "sc-late" : `id-${n}`),
    });
    await service.submit({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
    });
    // The case is in-flight (its child run exists) when the user stops the batch.
    await until(async () => (await runs.list("acme", { scorecardId: "sc-late" })).length === 1);
    await service.cancel({ tenant: "acme", id: "sc-late" });
    const stopped = await runs.list("acme", { scorecardId: "sc-late" });
    expect(stopped[0]?.status).toBe("failed");
    expect(stopped[0]?.error?.code).toBe("CANCELLED");

    // The held dispatch now lands with a SUCCESS — the drain must not overwrite the settled child.
    release?.();
    await until(() => drained);
    await new Promise((r) => setTimeout(r, 25));
    const final = await runs.list("acme", { scorecardId: "sc-late" });
    expect(final[0]?.status).toBe("failed"); // pre-fix: the stale-snapshot drain flipped it back to succeeded
    expect(final[0]?.error?.code).toBe("CANCELLED");
    expect((await store.get("sc-late"))?.status).toBe("cancelled");
  });

  it("runBatchCase skips a CANCELLED batch's queued activity — no fresh compute, no fresh child run (Temporal)", async () => {
    const store = new InMemoryScorecardStore();
    const runs = new InMemoryRunStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const service = new ScorecardService({ dispatcher, store, datasets, runStore: runs });
    await store.create({
      id: "sc-can-act",
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "cancelled",
      error: { code: "CANCELLED", message: "Stopped by user" },
      orchestration: { judges: [], concurrency: 2, retries: 0, workflowId: "wf-can" },
      createdAt: "2026-07-10T00:00:00.000Z",
      updatedAt: "2026-07-10T00:00:00.000Z",
    });

    const outcome = await service.runBatchCase("sc-can-act", "c1");

    // Pre-fix: the guard keyed on isSuperseded only, so a user-cancelled batch's queued activities still ran
    // whole cases and minted fresh queued child runs for a batch that was already dead.
    expect(outcome).toEqual({ settled: true, skipped: true });
    expect(await runs.list("acme", { scorecardId: "sc-can-act" })).toEqual([]);
  });
});

describe("ScorecardService.delete — hard delete (creator-or-admin, terminal only, child-run cascade)", () => {
  const principal = (roles: string[], subject = "u-alice"): Principal => ({
    subject,
    workspace: "acme",
    roles,
    via: "oidc",
  });
  const childRun = (id: string, scorecardId: string): RunRecord => ({
    id,
    tenant: "acme",
    harness: { id: "h", version: "1" },
    caseId: id,
    status: "succeeded",
    parentScorecardId: scorecardId,
    trigger: "scorecard",
    createdAt: "2026-06-19T00:00:00.000Z",
    updatedAt: "2026-06-19T00:00:00.000Z",
  });

  it("the creator (non-admin member) deletes their own terminal batch — the record AND its child runs are gone", async () => {
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    await store.create(record("sc-1", { createdBy: "u-alice" }));
    await runStore.create(childRun("c1", "sc-1"));
    await runStore.create(childRun("c2", "sc-1"));
    await runStore.create(childRun("c3", "sc-other")); // another batch's child survives
    const service = new ScorecardService({ dispatcher, store, runStore, datasets: new InMemoryDatasetRegistry() });

    const res = await service.delete({ principal: principal(["member"]), id: "sc-1" });

    expect(res).toEqual({ workspace: "acme", id: "sc-1", deleted: true, childRuns: 2 });
    expect(await store.get("sc-1")).toBeUndefined();
    expect(await runStore.list("acme", { scorecardId: "sc-1" })).toEqual([]);
    expect((await runStore.list("acme", { scorecardId: "sc-other" })).map((r) => r.id)).toEqual(["c3"]);
  });

  it("an admin who is not the creator can delete; a member who is neither creator nor admin is FORBIDDEN", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("sc-1", { createdBy: "u-alice" }));
    const service = svc(store);

    await expect(service.delete({ principal: principal(["member"], "u-bob"), id: "sc-1" })).rejects.toBeInstanceOf(
      ForbiddenError,
    );
    expect(await store.get("sc-1")).toBeDefined(); // nothing deleted on deny

    await expect(service.delete({ principal: principal(["admin"], "u-carol"), id: "sc-1" })).resolves.toMatchObject({
      deleted: true,
    });
    expect(await store.get("sc-1")).toBeUndefined();
  });

  it("a queued/running batch is a ConflictError even for an admin — stop (cancel) it first", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("sc-live", { status: "running", createdBy: "u-alice" }));
    const service = svc(store);
    await expect(service.delete({ principal: principal(["admin"]), id: "sc-live" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await store.get("sc-live")).toBeDefined();
  });

  it("a missing or cross-workspace scorecard is a NotFound (no existence leak); no runStore → childRuns 0", async () => {
    const store = new InMemoryScorecardStore();
    await store.create(record("sc-other", { tenant: "other", createdBy: "u-alice" }));
    await store.create(record("sc-1", { createdBy: "u-alice" }));
    const service = svc(store); // no runStore configured (dev wiring)
    await expect(service.delete({ principal: principal(["admin"]), id: "nope" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(service.delete({ principal: principal(["admin"]), id: "sc-other" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(service.delete({ principal: principal(["admin"]), id: "sc-1" })).resolves.toMatchObject({
      childRuns: 0,
    });
  });
});

describe("ScorecardService.submitExperiment — ungraded phase-1 groups (P1)", () => {
  // Records every dispatched job so the tests can assert what phase 1 actually ran.
  const capture = () => {
    const jobs: Parameters<Dispatcher["dispatch"]>[0][] = [];
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        jobs.push(job);
        return {
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd: 0.01 } }],
          snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
          scores: [], // ungraded — nothing scored the run
        };
      },
    };
    return { jobs, dispatcher };
  };

  it("an ad-hoc task experiment runs the prompt N times under the _adhoc sentinel — no judges, no verdict", async () => {
    const { jobs, dispatcher } = capture();
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({ dispatcher, store, datasets: new InMemoryDatasetRegistry() });
    const record = await service.submitExperiment({
      tenant: "acme",
      submittedBy: "alice",
      harness: { id: "scripted", version: "0" },
      task: { prompt: "say hi" },
      trials: 2,
    });
    expect(record.kind).toBe("experiment");
    expect(record.dataset).toEqual({ id: "_adhoc", version: "adhoc" }); // EXPERIMENT_ADHOC_REF sentinel
    expect(record.orchestration?.judges).toEqual([]);
    const done = await waitTerminal(store, record.id);
    expect(done.status).toBe("succeeded");
    expect(jobs).toHaveLength(2); // trials — the same task, twice
    expect(jobs[0]?.evalCase.task).toBe("say hi");
    expect(jobs[0]?.evalCase.graders).toEqual([]);
    // Ungraded end to end: no pass-deciding score exists, so no summary row carries a passRate.
    expect((done.summary ?? []).every((row) => row.passRate === undefined)).toBe(true);
  });

  it("a dataset experiment strips every case grader for the group (the dataset itself stays pure data)", async () => {
    const { jobs, dispatcher } = capture();
    const datasets = new InMemoryDatasetRegistry();
    const graded: Dataset = datasetWithCase();
    await datasets.register("acme", {
      ...graded,
      cases: graded.cases.map((c) => ({ ...c, graders: [{ id: "steps" }] })),
    });
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({ dispatcher, store, datasets });
    const record = await service.submitExperiment({
      tenant: "acme",
      harness: { id: "scripted", version: "0" },
      dataset: { id: "d", version: "1.0.0" },
    });
    expect(record.kind).toBe("experiment");
    expect(record.dataset).toEqual({ id: "d", version: "1.0.0" }); // the real ref — re-drivable, unlike _adhoc
    await waitTerminal(store, record.id);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.evalCase.graders).toEqual([]); // stripped for THIS group only
    expect((await datasets.get("acme", "d", "1.0.0")).cases[0]?.graders).toHaveLength(1); // registry untouched
  });

  it("an ad-hoc experiment never takes the Temporal batch driver (the workflow re-plans from the registry, which cannot see an inline dataset)", async () => {
    const { jobs, dispatcher } = capture();
    const store = new InMemoryScorecardStore();
    const started: string[] = [];
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets: new InMemoryDatasetRegistry(),
      temporalBatches: {
        workflowIdFor: (id) => `everdict-batch-${id}`,
        start: async (id) => {
          started.push(id);
        },
      },
    });
    const record = await service.submitExperiment({
      tenant: "acme",
      harness: { id: "scripted", version: "0" },
      task: { prompt: "say hi" },
    });
    const done = await waitTerminal(store, record.id);
    expect(started).toEqual([]); // in-process loop drove it — no workflow, no _adhoc 404-retry loop
    expect(done.orchestration?.workflowId).toBeUndefined();
    expect(jobs).toHaveLength(1);
  });

  it("rejects both/neither of dataset and task with a 400", async () => {
    const service = new ScorecardService({
      dispatcher: capture().dispatcher,
      store: new InMemoryScorecardStore(),
      datasets: new InMemoryDatasetRegistry(),
    });
    const base = { tenant: "acme", harness: { id: "scripted", version: "0" } };
    await expect(
      service.submitExperiment({ ...base, dataset: { id: "d", version: "1" }, task: { prompt: "hi" } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(service.submitExperiment(base)).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});

describe("ScorecardService.cancelCausedBy — the causal tree is the kill switch (§5.5, O8)", () => {
  it("cancels every NON-TERMINAL batch the run caused; settled and unrelated batches stay untouched", async () => {
    const store = new InMemoryScorecardStore();
    const base = {
      tenant: "acme",
      dataset: { id: "d", version: "1" },
      harness: { id: "h", version: "1" },
      createdAt: "2026-07-30T00:00:00Z",
      updatedAt: "2026-07-30T00:00:00Z",
    };
    await store.create({
      ...base,
      id: "caused-live",
      status: "running",
      origin: { source: "mcp", causedByRunId: "run-agent" },
    });
    await store.create({
      ...base,
      id: "caused-queued",
      status: "queued",
      origin: { source: "mcp", causedByRunId: "run-agent" },
    });
    await store.create({
      ...base,
      id: "caused-done",
      status: "succeeded",
      origin: { source: "mcp", causedByRunId: "run-agent" },
    });
    await store.create({ ...base, id: "unrelated", status: "running", origin: { source: "web" } });
    const service = new ScorecardService({
      dispatcher: {
        async dispatch() {
          throw new Error("unused");
        },
      },
      store,
      datasets: new InMemoryDatasetRegistry(),
    });
    const cancelled = await service.cancelCausedBy("acme", "run-agent");
    expect(cancelled).toBe(2); // the live and the queued one — one cancel revokes the tree
    expect((await store.get("caused-live"))?.status).toBe("cancelled");
    expect((await store.get("caused-queued"))?.status).toBe("cancelled");
    expect((await store.get("caused-done"))?.status).toBe("succeeded"); // terminal stays
    expect((await store.get("unrelated"))?.status).toBe("running"); // someone else's work stays
  });
});

describe("ScorecardService — the P4 causal admission leg (envelope 402 + draw-down)", () => {
  const agentRun = () =>
    Run.newAgentRun({
      id: "run-agent",
      tenant: "acme",
      agentId: "sentinel",
      agentVersion: "1.0.0",
      sessionId: "sess-1",
      eventKind: "scorecard.completed",
      createdBy: "alice",
      budgetUsd: 0.05,
      now: "2026-07-30T00:00:00.000Z",
    });
  const paidDispatch: Dispatcher = {
    async dispatch(job) {
      return {
        caseId: job.evalCase.id,
        harness: `${job.harness.id}@${job.harness.version}`,
        trace: [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 10, outputTokens: 10, usd: 0.01 } }],
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
        scores: [],
      };
    },
  };

  it("an agent-caused batch stamps its children with the envelope and DRAWS IT DOWN as cases settle", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const runStore = new InMemoryRunStore();
    await runStore.create(agentRun());
    const envelopes = new InMemoryEnvelopeStore();
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({ dispatcher: paidDispatch, store, runStore, datasets, envelopes });
    const rec = await service.submit({
      tenant: "acme",
      submittedBy: "alice",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "scripted", version: "0" },
      origin: { source: "mcp", causedByRunId: "run-agent" },
    });
    await waitTerminal(store, rec.id);
    const children = await runStore.list("acme", { scorecardId: rec.id });
    expect(children[0]?.envelope).toEqual({ id: "run-agent" }); // drawn from the causer's delegated slice
    const spend = await envelopes.spend("run-agent");
    expect(spend.runs).toBe(1); // admitted at the gate (fan-out counted)
    expect(spend.usd).toBeCloseTo(0.01); // the case's real cost metered against the envelope
  });

  it("refuses new agent-caused work at 402 once the delegated slice is spent — never silently", async () => {
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const runStore = new InMemoryRunStore();
    await runStore.create(agentRun());
    const envelopes = new InMemoryEnvelopeStore();
    await envelopes.settle("run-agent", "acme", 0.05); // the slice is fully spent
    const service = new ScorecardService({
      dispatcher: paidDispatch,
      store: new InMemoryScorecardStore(),
      runStore,
      datasets,
      envelopes,
    });
    await expect(
      service.submit({
        tenant: "acme",
        dataset: { id: "d", version: "1.0.0" },
        harness: { id: "scripted", version: "0" },
        origin: { source: "mcp", causedByRunId: "run-agent" },
      }),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", status: 402 });
  });
});

describe("ScorecardService.scoreGroup — phase 2 detached (P2)", () => {
  const ungraded: Dispatcher = {
    async dispatch(job) {
      return {
        caseId: job.evalCase.id,
        harness: `${job.harness.id}@${job.harness.version}`,
        trace: [{ t: 0, kind: "llm_call", model: "m", cost: { inputTokens: 1, outputTokens: 1, usd: 0.01 } }],
        snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
        scores: [],
      };
    },
  };
  const qualityJudge: JudgeSpec = {
    kind: "model",
    id: "quality",
    version: "1.0.0",
    provider: "anthropic",
    model: "claude-opus-4-8",
    rubric: "good?",
    inputs: ["trace"],
    tags: [],
  };
  const passRunner: JudgeRunner = {
    run: async (spec) => [{ graderId: `judge:${spec.id}`, metric: `judge:${spec.id}`, value: 1, pass: true }],
  };
  const waitScored = async (store: InMemoryScorecardStore, id: string): Promise<ScorecardRecord> => {
    for (let i = 0; i < 100; i++) {
      const rec = await store.get(id);
      if (rec?.kind === "scorecard" || rec?.steps?.some((s) => s.status === "failed")) return rec;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error("scoring did not settle");
  };

  it("judges an experiment's runs after the fact, writes scores back to the children, and promotes it", async () => {
    const datasets = new InMemoryDatasetRegistry();
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", qualityJudge);
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    const service = new ScorecardService({
      dispatcher: ungraded,
      store,
      runStore,
      datasets,
      judges,
      judgeRunner: passRunner,
    });
    const record = await service.submitExperiment({
      tenant: "acme",
      harness: { id: "scripted", version: "0" },
      task: { prompt: "say hi" },
    });
    await waitTerminal(store, record.id);

    const asOf = await service.scoreGroup({
      tenant: "acme",
      id: record.id,
      judges: [{ id: "quality", version: "latest" }],
      submittedBy: "bob",
    });
    expect(asOf.kind).toBe("experiment"); // returned as-of submission — scoring is async

    const scored = await waitScored(store, record.id);
    expect(scored.kind).toBe("scorecard"); // promoted — a group with a verdict is a scorecard
    expect(scored.summary?.some((row) => row.metric === "judge:quality" && row.passRate === 1)).toBe(true);
    // Phase 1's child runs carry the verdicts (write-back) — get() hydrates from them.
    const children = await runStore.list("acme", { scorecardId: record.id });
    expect(children.length).toBeGreaterThan(0);
    for (const child of children) {
      expect(
        measuredScores(child.result?.scores ?? []).some((s) => s.metric === "judge:quality" && s.pass === true),
      ).toBe(true);
    }
    const hydrated = await service.get(record.id);
    expect(hydrated?.scorecard?.results[0]?.scores.some((s) => s.metric === "judge:quality")).toBe(true);
  });

  it("re-scoring the same judge REPLACES its previous verdicts (no duplicate judge:<id> rows)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", qualityJudge);
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    const service = new ScorecardService({
      dispatcher: ungraded,
      store,
      runStore,
      datasets,
      judges,
      judgeRunner: passRunner,
    });
    const record = await service.submitExperiment({
      tenant: "acme",
      harness: { id: "scripted", version: "0" },
      task: { prompt: "hi" },
    });
    await waitTerminal(store, record.id);
    await service.scoreGroup({ tenant: "acme", id: record.id, judges: [{ id: "quality", version: "latest" }] });
    await waitScored(store, record.id);
    await service.scoreGroup({ tenant: "acme", id: record.id, judges: [{ id: "quality", version: "latest" }] });
    for (let i = 0; i < 100; i++) await new Promise((r) => setTimeout(r, 5)); // let the second pass settle
    const children = await runStore.list("acme", { scorecardId: record.id });
    const judgeScores = children[0]?.result?.scores.filter((s) => s.metric === "judge:quality") ?? [];
    expect(judgeScores).toHaveLength(1); // replaced, not appended
  });

  it("rescoreUnmeasured recovers ONLY the retryable-unmeasured judges — in place, no case re-execution", async () => {
    const datasets = new InMemoryDatasetRegistry();
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", qualityJudge);
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    let judgeCalls = 0;
    const runner: JudgeRunner = {
      run: async (spec) => {
        judgeCalls++;
        return [{ graderId: spec.id, metric: `judge:${spec.id}`, value: 1, pass: true }];
      },
    };
    const service = new ScorecardService({
      dispatcher: ungraded,
      store,
      runStore,
      datasets,
      judges,
      judgeRunner: runner,
    });
    const record = await service.submitExperiment({
      tenant: "acme",
      harness: { id: "scripted", version: "0" },
      task: { prompt: "hi" },
    });
    await waitTerminal(store, record.id);
    // Simulate a settled batch whose judge blipped (retryable unmeasured) + an in-job grader death (not
    // recoverable without a re-run). get() hydrates results from the CHILD runs, so the injection goes there.
    const settled = await store.get(record.id);
    await store.update(record.id, {
      orchestration: { ...settled?.orchestration, judges: [{ id: "quality", version: "1.0.0" }] },
    } as Partial<ScorecardRecord>);
    for (const child of await runStore.list("acme", { scorecardId: record.id })) {
      if (!child.result) continue;
      await runStore.update(child.id, {
        result: {
          ...child.result,
          scores: [
            ...child.result.scores,
            {
              graderId: "quality",
              metric: "judge:quality",
              status: "unmeasured" as const,
              reason: "grader_error" as const,
              retryable: true,
              detail: "skipped: judge upstream 503",
            },
            {
              graderId: "tests-pass",
              metric: "tests_pass",
              status: "unmeasured" as const,
              reason: "grader_error" as const,
              retryable: true,
              detail: "[grader-error] in-job",
            },
          ],
        },
        updatedAt: new Date().toISOString(),
      });
    }
    const out = await service.rescoreUnmeasured({ tenant: "acme", id: record.id });
    // The judge is re-scored (under the batch's PINNED version), the in-job grader is reported, never guessed
    expect(out.rescoredJudges).toEqual(["quality"]);
    expect(out.skipped.map((w) => w.metric)).toEqual(["tests_pass"]);
    await waitScored(store, record.id);
    expect(judgeCalls).toBeGreaterThan(0);
    const hydrated = await service.get(record.id);
    const scores = hydrated?.scorecard?.results[0]?.scores.filter((x) => x.metric === "judge:quality") ?? [];
    expect(scores).toHaveLength(1); // replaced in place — the unmeasured row is gone
    expect(measuredScores(scores)[0]?.pass).toBe(true);
  });

  it("the workflow bridge (plan → scoreCase → finalize) resumes with zero duplicate judging", async () => {
    const datasets = new InMemoryDatasetRegistry();
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", qualityJudge);
    let judgeCalls = 0;
    const countingRunner: JudgeRunner = {
      run: async (spec) => {
        judgeCalls++;
        return [{ graderId: `judge:${spec.id}`, metric: `judge:${spec.id}`, value: 1, pass: true }];
      },
    };
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    const service = new ScorecardService({
      dispatcher: ungraded,
      store,
      runStore,
      datasets,
      judges,
      judgeRunner: countingRunner,
    });
    const record = await service.submitExperiment({
      tenant: "acme",
      harness: { id: "scripted", version: "0" },
      task: { prompt: "hi" },
      trials: 3,
    });
    await waitTerminal(store, record.id);
    const sel = [{ id: "quality", version: "1.0.0" }];

    // The workflow's plan: all three (case, trial) children are unfinished.
    const plan = await service.planScore(record.id, sel);
    expect(plan.keys).toHaveLength(3);

    // Judge the first case, then "kill the CP": a fresh plan returns exactly the remainder.
    const first = plan.keys[0] ?? "";
    expect(await service.runScoreCase(record.id, first, sel)).toEqual({ scored: true });
    const resumed = await service.planScore(record.id, sel);
    expect(resumed.keys).toHaveLength(2);
    expect(resumed.keys).not.toContain(first);

    // Re-running an already-judged case is a skip — zero duplicate judging.
    expect(await service.runScoreCase(record.id, first, sel)).toEqual({ scored: false, skipped: true });
    expect(judgeCalls).toBe(1);

    for (const key of resumed.keys) await service.runScoreCase(record.id, key, sel);
    await service.finalizeScore(record.id, sel, "bob");
    const done = await store.get(record.id);
    expect(done?.kind).toBe("scorecard"); // promoted by the finalize
    expect(done?.summary?.some((row) => row.metric === "judge:quality" && row.passRate === 1)).toBe(true);
    expect(judgeCalls).toBe(3); // one judge call per (case, trial) — never more
  });

  it("routes to the durable score workflow when configured, and 409s a second pass (deterministic id dedup)", async () => {
    const datasets = new InMemoryDatasetRegistry();
    const judges = new InMemoryJudgeRegistry();
    await judges.register("acme", qualityJudge);
    const store = new InMemoryScorecardStore();
    const runStore = new InMemoryRunStore();
    const started: string[] = [];
    const service = new ScorecardService({
      dispatcher: ungraded,
      store,
      runStore,
      datasets,
      judges,
      judgeRunner: passRunner,
      temporalScores: {
        workflowIdFor: (id) => `everdict-score-${id}`,
        start: async (input) => {
          if (started.includes(input.groupId))
            throw new ConflictError("CONFLICT", { scorecard: input.groupId }, "already running");
          started.push(input.groupId);
        },
      },
    });
    const record = await service.submitExperiment({
      tenant: "acme",
      harness: { id: "scripted", version: "0" },
      task: { prompt: "hi" },
    });
    await waitTerminal(store, record.id);
    await service.scoreGroup({ tenant: "acme", id: record.id, judges: [{ id: "quality", version: "latest" }] });
    expect(started).toEqual([record.id]); // the durable workflow owns the pass — no in-process judging
    // The judge versions handed to the workflow are PINNED (latest → concrete).
    await expect(
      service.scoreGroup({ tenant: "acme", id: record.id, judges: [{ id: "quality", version: "latest" }] }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("guards: non-succeeded group → 409; empty judge list → 400; foreign workspace → 404", async () => {
    const store = new InMemoryScorecardStore();
    const service = new ScorecardService({
      dispatcher: ungraded,
      store,
      datasets: new InMemoryDatasetRegistry(),
      judges: new InMemoryJudgeRegistry(),
      judgeRunner: passRunner,
    });
    await store.create({
      id: "sc-run",
      tenant: "acme",
      dataset: { id: "d", version: "1" },
      harness: { id: "h", version: "1" },
      status: "running",
      createdAt: "2026-07-30T00:00:00Z",
      updatedAt: "2026-07-30T00:00:00Z",
    });
    await expect(
      service.scoreGroup({ tenant: "acme", id: "sc-run", judges: [{ id: "q", version: "latest" }] }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(service.scoreGroup({ tenant: "acme", id: "sc-run", judges: [] })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      service.scoreGroup({ tenant: "rival", id: "sc-run", judges: [{ id: "q", version: "latest" }] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("ScorecardService — batch_settled observability event (operator time series, catalog M0)", () => {
  it("fires once at settle with domain-derived outcome tallies, unmeasured reasons, and the submit->verdict latency", async () => {
    // One pass, one infra death, one unmeasured-only case — the closed vocabulary the counters promote.
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        if (job.evalCase.id === "b") throw new UpstreamError("UPSTREAM_ERROR", {}, "placement blip");
        if (job.evalCase.id === "c")
          return {
            caseId: "c",
            harness: "h@1",
            trace: [],
            snapshot: { kind: "prompt", output: "" },
            scores: [
              {
                graderId: "judge",
                metric: "judge:q",
                status: "unmeasured",
                reason: "grader_error",
                retryable: true,
              },
            ],
          };
        return {
          caseId: job.evalCase.id,
          harness: "h@1",
          trace: [],
          snapshot: { kind: "prompt", output: "" },
          scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
        };
      },
    };
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    const events: Array<{ kind: string } & Record<string, unknown>> = [];
    let n = 0;
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      newId: () => `bse-${n++}`,
      onOrchestrationEvent: (e) => events.push(e),
      // retries=0 via orchestration input below keeps the infra death terminal in one dispatch.
    });
    await datasets.register("acme", {
      id: "obs",
      version: "1.0.0",
      cases: (["a", "b", "c"] as const).map((id) => ({
        id,
        env: { kind: "prompt" },
        task: `q-${id}`,
        graders: [],
        timeoutSec: 60,
        tags: [],
      })),
      tags: [],
    });
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "obs", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      retries: 0,
    });
    await waitTerminal(store, rec.id);

    const settled = events.filter((e) => e.kind === "batch_settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]).toMatchObject({
      tenant: "acme",
      outcomes: { executed: 3, verdicted: 1, infraFailed: 1, unmeasured: 1, cancelled: 0 },
      unmeasuredReasons: { grader_error: 1 },
    });
    const latency = settled[0]?.latencySec;
    expect(typeof latency).toBe("number");
    expect(latency as number).toBeGreaterThanOrEqual(0);
  });
});

describe("ScorecardService.opsReport — the workspace's own SLA evidence (C1)", () => {
  it("derives the platform's failure share from the settled ledger, rates absent on empty windows", async () => {
    const dispatcher: Dispatcher = {
      async dispatch(job) {
        if (job.evalCase.id === "b") throw new UpstreamError("UPSTREAM_ERROR", {}, "placement blip");
        return {
          caseId: job.evalCase.id,
          harness: "h@1",
          trace: [{ t: 0, kind: "log", stream: "stdout", text: "ran" }],
          traceSealed: true,
          snapshot: { kind: "prompt", output: "done" },
          scores: [{ graderId: "tests-pass", metric: "tests_pass", value: 1, pass: true }],
        };
      },
    };
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    let n = 0;
    const service = new ScorecardService({ dispatcher, store, datasets, newId: () => `ops-${n++}` });
    await datasets.register("acme", {
      id: "ops",
      version: "1.0.0",
      cases: (["a", "b"] as const).map((id) => ({
        id,
        env: { kind: "prompt" },
        task: `q-${id}`,
        graders: [],
        timeoutSec: 60,
        tags: [],
      })),
      tags: [],
    });
    const rec = await service.submit({
      tenant: "acme",
      dataset: { id: "ops", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      retries: 0,
    });
    await waitTerminal(store, rec.id);

    const report = await service.opsReport("acme");
    expect(report.batches).toMatchObject({ total: 1, succeeded: 1 });
    expect(report.cases).toMatchObject({ executed: 2, verdicted: 1, infraFailed: 1 });
    expect(report.rates.infraFailure).toBeCloseTo(1 / 2);
    expect(report.rates.traceComplete).toBeCloseTo(1 / 2);
    expect(report.evidence.trace).toMatchObject({ complete: 1, missing: 1 });

    // Another workspace's ledger is empty — and empty means NO rates, never 0%.
    const empty = await service.opsReport("other");
    expect(empty.batches.total).toBe(0);
    expect(empty.rates).toEqual({});

    // A window that excludes everything behaves like the empty ledger.
    const outside = await service.opsReport("acme", { to: "2000-01-01T00:00:00Z" });
    expect(outside.batches.total).toBe(0);
  });
});

describe("ScorecardService.gate — the recorded release gate (A1/B1)", () => {
  const succeededRecord = (id: string, results: CaseResult[]): ScorecardRecord => ({
    id,
    tenant: "acme",
    dataset: { id: "d", version: "1.0.0" },
    harness: { id: "h", version: "1" },
    status: "succeeded",
    scorecard: { suiteId: "d@1.0.0", harness: "h@1", results },
    // Split-seal manifest so experiment identity verifies HELD — these tests exercise the OTHER knobs
    // (regressions, missingness, trials, unmeasured evidence); the identity gate has its own suite.
    manifest: {
      dataset: { id: "d", version: "1.0.0", digest: "sha256:composite" },
      cases: { a: "sha256:case-a", b: "sha256:case-b" },
      grading: "sha256:grading",
      harness: { id: "h", version: "1" },
    },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  });
  const scored = (caseId: string, pass: boolean): CaseResult => ({
    caseId,
    harness: "h@1",
    trace: [],
    snapshot: { kind: "prompt", output: "done" },
    scores: [{ graderId: "t", metric: "tests_pass", value: pass ? 1 : 0, pass }],
  });
  function build() {
    const log = new InMemoryPlatformEventStore();
    const store = new InMemoryScorecardStore(log);
    const datasets = new InMemoryDatasetRegistry();
    let n = 0;
    const service = new ScorecardService({
      dispatcher: {
        async dispatch() {
          throw new Error("gate never dispatches");
        },
      },
      store,
      datasets,
      newId: () => `g-${n++}`,
    });
    return { store, log, service };
  }

  it("records a BLOCK on the candidate with the regression named, and the fact rides the write", async () => {
    const { store, log, service } = build();
    await store.create(succeededRecord("base", [scored("a", true), scored("b", true)]));
    await store.create(succeededRecord("cand", [scored("a", true), scored("b", false)]));

    const decision = await service.gate({ tenant: "acme", baseline: "base", candidate: "cand", decidedBy: "ci" });
    expect(decision.decision).toBe("block");
    expect(decision.reasons.find((r) => r.kind === "regression")?.caseId).toBe("b");
    expect(decision.policy).toEqual({ maxRegressions: 0 });
    expect(decision.policyDigest).toBeTruthy();

    // Recorded on the candidate's ledger row — the audit scans these.
    const rec = await store.get("cand");
    expect(rec?.gates?.map((g) => g.id)).toEqual([decision.id]);
    // The fact persisted in the same write (E0 outbox).
    expect((await log.list("acme")).map((e) => e.kind)).toContain("scorecard.gate.decided");
  });

  it("override forces a BLOCK through with who and why — pass/not_comparable refuse (409)", async () => {
    const { store, log, service } = build();
    await store.create(succeededRecord("base", [scored("a", true)]));
    await store.create(succeededRecord("cand", [scored("a", false)]));
    const blocked = await service.gate({ tenant: "acme", baseline: "base", candidate: "cand" });
    expect(blocked.decision).toBe("block");

    const forced = await service.overrideGate({
      tenant: "acme",
      candidate: "cand",
      decisionId: blocked.id,
      reason: "known flake, ships with issue EV-12",
      by: "admin-user",
    });
    expect(forced.override).toMatchObject({ by: "admin-user", reason: "known flake, ships with issue EV-12" });
    expect((await log.list("acme")).map((e) => e.kind)).toContain("scorecard.gate.overridden");

    // A second override of the same decision refuses.
    await expect(
      service.overrideGate({ tenant: "acme", candidate: "cand", decisionId: blocked.id, reason: "again", by: "x" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // A PASS decision has nothing to force.
    await store.create(succeededRecord("cand2", [scored("a", true)]));
    const passed = await service.gate({ tenant: "acme", baseline: "base", candidate: "cand2" });
    expect(passed.decision).toBe("pass");
    await expect(
      service.overrideGate({ tenant: "acme", candidate: "cand2", decisionId: passed.id, reason: "r", by: "x" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  // The critical-case rule, end to end: the declaration rides the batch's own stamped verdict policy, so the
  // gate reads it off the record instead of off whatever flags CI happened to pass.
  it("a case the stamped policy declared CRITICAL blocks on collapse, past the regression budget", async () => {
    // Given both batches judged under a composed policy that names "login" critical
    const { store, service } = build();
    const policy = composeVerdictPolicy([], DEFAULT_VERDICT_POLICY, { criticalCases: [{ caseId: "login" }] });
    const stamped = (id: string, results: CaseResult[]): ScorecardRecord => ({
      ...succeededRecord(id, results),
      verdictPolicy: verdictPolicyRef(policy),
      manifest: {
        dataset: { id: "d", version: "1.0.0", digest: "dd" },
        harness: { id: "h", version: "1" },
        verdictPolicy: policy,
      },
    });
    await store.create(stamped("base", [scored("login", true), scored("other", true)]));
    await store.create(stamped("cand", [scored("login", false), scored("other", true)]));

    // When the gate runs with a budget generous enough to absorb an ordinary regression
    const decision = await service.gate({
      tenant: "acme",
      baseline: "base",
      candidate: "cand",
      policy: { maxRegressions: 5 },
    });

    // Then the budget does not reach a case the policy declared critical
    expect(decision.decision).toBe("block");
    expect(decision.reasons.find((r) => r.kind === "critical_case_failed")?.caseId).toBe("login");
    expect(decision.evidence.criticalFailures).toBe(1);
  });

  it("fdrAlpha reaches the trials diff and rides the recorded policy", async () => {
    const { store, service } = build();
    const trial = (caseId: string, pass: boolean, index: number): CaseResult => ({
      ...scored(caseId, pass),
      trial: index,
    });
    const side = (passes: number): CaseResult[] => Array.from({ length: 20 }, (_, i) => trial("a", i < passes, i));
    await store.create(succeededRecord("base", side(20)));
    await store.create(succeededRecord("cand", side(14))); // Fisher p ≈ 0.020 — clears its own alpha

    // With m=1 hypothesis BH's threshold IS alpha, so 0.02 survives at 0.05 and not at 0.01: the level the
    // caller sent is the one the diff was computed under, and it is embedded in the decision.
    const loose = await service.gate({
      tenant: "acme",
      baseline: "base",
      candidate: "cand",
      policy: { fdrAlpha: 0.05 },
    });
    expect(loose.decision).toBe("block");
    expect(loose.policy.fdrAlpha).toBe(0.05);
    const strict = await service.gate({
      tenant: "acme",
      baseline: "base",
      candidate: "cand",
      policy: { fdrAlpha: 0.01 },
    });
    expect(strict.decision).toBe("pass");
    expect(strict.evidence.suppressedByFdr).toBe(1);
  });

  it("a candidate that ran fewer cases than the baseline is BLOCKED_MISSING, and the force is overridable", async () => {
    // Given a 3-case baseline and a candidate that only re-ran 2 of them, regressing in neither
    const { store, service } = build();
    await store.create(succeededRecord("base", [scored("a", true), scored("b", true), scored("c", true)]));
    await store.create(succeededRecord("cand", [scored("a", true), scored("b", true)]));

    // When the gate decides under the default (fail-closed) policy
    const decision = await service.gate({ tenant: "acme", baseline: "base", candidate: "cand", decidedBy: "ci" });

    // Then it refuses rather than reading "no regressions" as a green light over a suite it never fully ran
    expect(decision.decision).toBe("blocked_missing");
    expect(decision.reasons.find((r) => r.kind === "missing_cases")).toMatchObject({ count: 1, fraction: 1 / 3 });
    expect(decision.evidence).toMatchObject({ comparability: "partial", regressions: 0 });

    // And knowingly shipping on the subset is possible — recorded, with a name and a reason against it.
    const forced = await service.overrideGate({
      tenant: "acme",
      candidate: "cand",
      decisionId: decision.id,
      reason: "the 3rd case is quarantined, tracked in EV-31",
      by: "release-manager",
    });
    expect(forced.override).toMatchObject({ by: "release-manager" });

    // Or the caller states up front that a subset is what it wants, within a tolerance.
    const deliberate = await service.gate({
      tenant: "acme",
      baseline: "base",
      candidate: "cand",
      policy: { comparability: "allow_partial", maxMissingFraction: 0.5 },
    });
    expect(deliberate.decision).toBe("pass");
    // The recorded policy is the caller's own document — nothing the gate defaulted leaks into the digest.
    expect(deliberate.policy).toEqual({
      maxRegressions: 0,
      comparability: "allow_partial",
      maxMissingFraction: 0.5,
    });
  });

  it("the policy's statistical bar reaches the trials diff — minDelta turns a significant-but-small drop into a pass", async () => {
    const { store, service } = build();
    const trials = (caseId: string, passes: number, total: number): CaseResult[] =>
      Array.from({ length: total }, (_, i) => ({ ...scored(caseId, i < passes), trial: i }));
    // 10/10 → 3/10: a real, Fisher-significant drop of 0.7.
    await store.create(succeededRecord("base", trials("a", 10, 10)));
    await store.create(succeededRecord("cand", trials("a", 3, 10)));

    const blocked = await service.gate({ tenant: "acme", baseline: "base", candidate: "cand" });
    expect(blocked.decision).toBe("block");
    expect(blocked.evidence).toMatchObject({ trialsGated: true, regressions: 1 });

    // A caller that only cares about drops of 0.8 or more gets its own bar applied to the trials diff.
    const tolerated = await service.gate({
      tenant: "acme",
      baseline: "base",
      candidate: "cand",
      policy: { minDelta: 0.8 },
    });
    expect(tolerated.decision).toBe("pass");
    expect(tolerated.evidence.regressions).toBe(0);
    expect(tolerated.policy).toMatchObject({ minDelta: 0.8 });
  });

  it("a batch whose scores were mostly dead graders is BLOCKED_MISSING under a maxUnmeasuredFraction", async () => {
    const { store, service } = build();
    const dead = (caseId: string): CaseResult => ({
      ...scored(caseId, true),
      scores: [
        { graderId: "t", metric: "tests_pass", value: 1, pass: true },
        { graderId: "j", metric: "judge:q", status: "unmeasured", reason: "grader_error", retryable: true },
        { graderId: "k", metric: "judge:r", status: "unmeasured", reason: "missing_secret", retryable: true },
      ],
    });
    await store.create(succeededRecord("base", [scored("a", true)]));
    await store.create(succeededRecord("cand", [dead("a")]));

    const decision = await service.gate({
      tenant: "acme",
      baseline: "base",
      candidate: "cand",
      policy: { maxUnmeasuredFraction: 0.25 },
    });
    expect(decision.decision).toBe("blocked_missing");
    expect(decision.reasons.find((r) => r.kind === "unmeasured_evidence")?.fraction).toBeCloseTo(2 / 3);
  });

  it("cross-policy candidates gate as NOT_COMPARABLE — never a false pass", async () => {
    // Both stamps resolve (each batch embeds its own composed document); they resolve to DIFFERENT documents.
    const basePolicy = composeVerdictPolicy([{ id: "schema_valid", authority: "objective" }]);
    const candPolicy = composeVerdictPolicy([{ id: "schema_valid", authority: "ground_truth" }]);
    const manifestFor = (p: typeof basePolicy) => ({
      dataset: { id: "d", version: "1.0.0", digest: "dd" },
      harness: { id: "h", version: "1" },
      verdictPolicy: p,
    });
    const { store, service } = build();
    await store.create({
      ...succeededRecord("base", [scored("a", true)]),
      verdictPolicy: verdictPolicyRef(basePolicy),
      manifest: manifestFor(basePolicy),
    });
    await store.create({
      ...succeededRecord("cand", [scored("a", true)]),
      verdictPolicy: verdictPolicyRef(candPolicy),
      manifest: manifestFor(candPolicy),
    });
    const decision = await service.gate({ tenant: "acme", baseline: "base", candidate: "cand" });
    expect(decision.decision).toBe("not_comparable");
    expect(decision.reasons[0]?.kind).toBe("policy_mismatch");
  });

  it("gates a TRIAL pair under the policy both batches were stamped with, not under today's ladder", async () => {
    // Given both batches judged under a composed policy that gives `schema_valid` OBJECTIVE authority — which
    // outranks the judge rung. Every case scores a passing judge, so the two policies disagree by design:
    //   default  → the judge decides    → both sides PASS → no regression → the gate would say PASS.
    //   stamped  → schema_valid decides → 6/6 → 0/6       → a Fisher-significant trial regression → BLOCK.
    // Pre-fix, caseTrialStats always judged under the default ladder, so this release shipped green.
    const policy = composeVerdictPolicy([{ id: "schema_valid", authority: "objective" }]);
    const stamp = verdictPolicyRef(policy);
    const manifest = {
      dataset: { id: "d", version: "1.0.0", digest: "dd" },
      harness: { id: "h", version: "1" },
      verdictPolicy: policy,
    };
    const trialResults = (schemaValid: boolean): CaseResult[] =>
      Array.from({ length: 6 }, (_, i) => ({
        caseId: "a",
        harness: "h@1",
        trial: i,
        trace: [],
        snapshot: { kind: "prompt", output: "done" } as const,
        scores: [
          { graderId: "schema", metric: "schema_valid", value: schemaValid ? 1 : 0, pass: schemaValid },
          { graderId: "j", metric: "judge", value: 1, pass: true },
        ],
      }));
    const { store, service } = build();
    await store.create({ ...succeededRecord("base", trialResults(true)), verdictPolicy: stamp, manifest });
    await store.create({ ...succeededRecord("cand", trialResults(false)), verdictPolicy: stamp, manifest });

    const decision = await service.gate({ tenant: "acme", baseline: "base", candidate: "cand" });
    expect(decision.decision).toBe("block");
    expect(decision.reasons.find((r) => r.kind === "trial_regression")?.caseId).toBe("a");
    expect(decision.evidence).toMatchObject({ trialsGated: true, regressions: 1 });
  });

  it("a candidate whose stamped policy cannot be restored gates as NOT_COMPARABLE", async () => {
    // The stamp names a composed document, and nothing carries it — so its verdicts cannot be re-derived and
    // there is nothing for a release decision to stand on.
    const stamp = verdictPolicyRef(composeVerdictPolicy([{ id: "schema_valid", authority: "objective" }]));
    const { store, service } = build();
    await store.create(succeededRecord("base", [scored("a", true)]));
    await store.create({ ...succeededRecord("cand", [scored("a", true)]), verdictPolicy: stamp });
    const decision = await service.gate({ tenant: "acme", baseline: "base", candidate: "cand" });
    expect(decision.decision).toBe("not_comparable");
    expect(decision.reasons[0]?.kind).toBe("policy_unresolvable");
  });
});

describe("ScorecardService — gate audit + manifest verification (B2/B3)", () => {
  it("gateAudit counts decisions and enumerates overrides; overrideRate absent with no block", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    let n = 0;
    const service = new ScorecardService({
      dispatcher: {
        async dispatch() {
          throw new Error("never");
        },
      },
      store,
      datasets,
      newId: () => `ga-${n++}`,
    });
    const rec = (id: string, pass: boolean): ScorecardRecord => ({
      id,
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      // Split-seal manifest so experiment identity verifies HELD — this test exercises the audit, not identity.
      manifest: {
        dataset: { id: "d", version: "1.0.0", digest: "sha256:composite" },
        cases: { a: "sha256:case-a" },
        grading: "sha256:grading",
        harness: { id: "h", version: "1" },
      },
      scorecard: {
        suiteId: "d@1.0.0",
        harness: "h@1",
        results: [
          {
            caseId: "a",
            harness: "h@1",
            trace: [],
            snapshot: { kind: "prompt", output: "x" },
            scores: [{ graderId: "t", metric: "tests_pass", value: pass ? 1 : 0, pass }],
          },
        ],
      },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    await store.create(rec("base", true));
    await store.create(rec("cand", false));
    const blocked = await service.gate({ tenant: "acme", baseline: "base", candidate: "cand" });
    await service.overrideGate({
      tenant: "acme",
      candidate: "cand",
      decisionId: blocked.id,
      reason: "hotfix window",
      by: "admin",
    });
    await store.create(rec("cand2", true));
    await service.gate({ tenant: "acme", baseline: "base", candidate: "cand2" });

    const audit = await service.gateAudit("acme");
    expect(audit.decisions).toEqual({ total: 2, pass: 1, block: 1, blockedMissing: 0, notComparable: 0 });
    expect(audit.overrides.count).toBe(1);
    expect(audit.overrides.entries[0]).toMatchObject({ candidate: "cand", by: "admin", reason: "hotfix window" });
    expect(audit.overrideRate).toBe(1);

    // A window before everything: no decisions, and overrideRate is ABSENT (0/0 is absence, not 0%).
    const empty = await service.gateAudit("acme", { to: "2000-01-01T00:00:00Z" });
    expect(empty.decisions.total).toBe(0);
    expect(empty.overrideRate).toBeUndefined();
  });

  it("verifyManifest reports drift when a judge spec changed under the same version, and honest unverifiable for a subset bundle", async () => {
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    const judges = new InMemoryJudgeRegistry();
    const service = new ScorecardService({
      dispatcher: {
        async dispatch() {
          throw new Error("never");
        },
      },
      store,
      datasets,
      judges,
    });
    const judgeSpec = {
      kind: "model" as const,
      id: "quality",
      version: "1.0.0",
      provider: "openai" as const,
      model: "gpt-5.4-mini",
      rubric: "good?",
      inputs: ["trace" as const],
      tags: [],
    };
    await judges.register("acme", judgeSpec);
    const dataset = {
      id: "vd",
      version: "1.0.0",
      cases: [{ id: "a", env: { kind: "prompt" as const }, task: "t", graders: [], timeoutSec: 60, tags: [] }],
      tags: [],
    };
    await datasets.register("acme", dataset);
    const { contentDigest } = await import("@everdict/domain");
    await store.create({
      id: "vm",
      tenant: "acme",
      dataset: { id: "vd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      manifest: {
        dataset: { id: "vd", version: "1.0.0", digest: contentDigest(dataset.cases) },
        harness: { id: "h", version: "1" },
        judges: [{ id: "quality", version: "1.0.0", specDigest: "0000000000000000" }], // sealed digest ≠ current spec
      },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });

    const v = await service.verifyManifest("acme", "vm");
    expect(v.checks.find((c) => c.subject === "dataset")?.status).toBe("match");
    expect(v.checks.find((c) => c.subject === "judge:quality")?.status).toBe("drifted");
    expect(v.caveat).toContain("never");

    // Subset bundles are honest unverifiable — the selection inputs are not replayable.
    await store.create({
      id: "vm-subset",
      tenant: "acme",
      dataset: { id: "vd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      subset: { total: 10, selected: 1 },
      manifest: {
        dataset: { id: "vd", version: "1.0.0", digest: "abc" },
        harness: { id: "h", version: "1" },
      },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    const vs = await service.verifyManifest("acme", "vm-subset");
    expect(vs.checks.find((c) => c.subject === "dataset")?.status).toBe("unverifiable");

    // Pre-manifest batches have nothing to verify — explicit 400, never an empty green report.
    await store.create({
      id: "vm-old",
      tenant: "acme",
      dataset: { id: "vd", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });
    await expect(service.verifyManifest("acme", "vm-old")).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("verifyManifest verifies the SPLIT seal — a subset's cases and grading verify individually, and the judge closure re-resolves (H9)", async () => {
    // Pre-fix, a subset run's whole dataset facet read `unverifiable` and the sealed judge closure
    // (model/rubric/harness) plus judgeRun were never re-checked at all — the report claimed "every stamped
    // digest checked" while skipping most of the seal.
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    const judges = new InMemoryJudgeRegistry();
    const rubrics = new InMemoryRubricRegistry();
    const service = new ScorecardService({
      dispatcher: {
        async dispatch() {
          throw new Error("never");
        },
      },
      store,
      datasets,
      judges,
      rubrics,
    });
    const { contentDigest, sealGrading } = await import("@everdict/domain");
    const cases = [
      { id: "a", env: { kind: "prompt" as const }, task: "t", graders: [], timeoutSec: 60, tags: [] },
      { id: "b", env: { kind: "prompt" as const }, task: "t", graders: [], timeoutSec: 60, tags: [] },
    ];
    await datasets.register("acme", { id: "vd2", version: "1.0.0", cases, tags: [] });
    // A judge whose rubric is a LATEST ref — sealed at submit while latest was 1.0.0.
    await rubrics.register("acme", { id: "style", version: "1.0.0", text: "clean?", tags: [] });
    await judges.register("acme", {
      kind: "model",
      id: "quality",
      version: "1.0.0",
      provider: "openai",
      model: "gpt-5.4-mini",
      rubric: { id: "style", version: "latest" },
      inputs: ["trace"],
      tags: [],
    });
    const selected = [cases[0]]; // the deliberate 1-of-2 subset
    await store.create({
      id: "vm-split",
      tenant: "acme",
      dataset: { id: "vd2", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded",
      subset: { total: 2, selected: 1 },
      orchestration: {
        judges: [{ id: "quality", version: "1.0.0" }],
        judge: { model: "judge-model-x" },
        concurrency: 1,
        retries: 0,
      },
      manifest: {
        dataset: { id: "vd2", version: "1.0.0", digest: "sha256:selection-composite" },
        cases: Object.fromEntries(selected.map((c) => [c?.id ?? "", contentDigest({ ...c, graders: undefined })])),
        ...sealGrading(
          undefined,
          selected.filter((c) => c !== undefined),
        ),
        harness: { id: "h", version: "1" },
        judges: [
          { id: "quality", version: "1.0.0", specDigest: "sha256:doc", model: "gpt-5.4-mini", rubric: "style@1.0.0" },
        ],
        judgeRun: { model: "judge-model-x" },
      },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    });

    const before = await service.verifyManifest("acme", "vm-split");
    const by = (subject: string) => before.checks.find((c) => c.subject === subject);
    expect(by("dataset")?.status).toBe("unverifiable"); // the selection-keyed composite stays honest
    expect(by("cases")?.status).toBe("match"); // …but the sealed case verifies INDIVIDUALLY despite the subset
    expect(by("grading")?.status).toBe("match"); // per-case defaults verified against the registry
    expect(by("judge:quality:model")?.status).toBe("match"); // raw binding re-seals verbatim
    expect(by("judge:quality:rubric")?.status).toBe("match"); // latest still resolves to 1.0.0
    expect(by("judge_run")?.status).toBe("match"); // verified against the persisted orchestration config

    // The rubric's latest MOVES — the sealed closure no longer matches a fresh resolution: reproducing this
    // batch today would judge under a different rubric document, and the report says so.
    await rubrics.register("acme", { id: "style", version: "2.0.0", text: "clean AND fast?", tags: [] });
    const after = await service.verifyManifest("acme", "vm-split");
    const rubricCheck = after.checks.find((c) => c.subject === "judge:quality:rubric");
    expect(rubricCheck?.status).toBe("drifted");
    expect(rubricCheck?.current).toBe("style@2.0.0");
  });

  it("seals the HARNESS model closure at submit — and verifyManifest reports the drift specDigest cannot see (H13)", async () => {
    // A command harness binding {ref} without a version resolves LATEST at dispatch: registering a new model
    // version changes what executes while the spec bytes — and therefore specDigest — stay identical.
    // Pre-fix, verifyManifest reported "match" for exactly that state: a false assurance from the assurance
    // surface. The closure now seals at submit and re-resolves at verify, so the pair below is the claim:
    // `harness` (the document) matches AND `harness:model` (the closure) reports drifted.
    class StubHarnessRegistry extends InMemoryHarnessInstanceRegistry {
      constructor(private readonly spec: HarnessSpec) {
        super(new InMemoryHarnessTemplateRegistry());
      }
      override get() {
        return Promise.resolve(this.spec);
      }
    }
    const commandSpec = {
      kind: "command",
      id: "cli",
      version: "1.0.0",
      command: "run {{task}}",
      model: { ref: "agent-model" },
      trace: { kind: "none" },
      setup: [],
      params: {},
    } as unknown as HarnessSpec;
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", datasetWithCase());
    const store = new InMemoryScorecardStore();
    let latest = "5.0.0"; // the model registry's moving latest
    const service = new ScorecardService({
      dispatcher,
      store,
      datasets,
      harnesses: new StubHarnessRegistry(commandSpec),
      resolveModelBinding: async (_tenant, binding) => `${binding.ref}@${latest}`,
      newId: () => "sc-harness-closure",
    });
    await service
      .submit({ tenant: "acme", dataset: { id: "d", version: "1.0.0" }, harness: { id: "cli", version: "1.0.0" } })
      .catch(() => undefined); // the throwing dispatcher fails the pipeline later — the record is already sealed
    const rec = await store.get("sc-harness-closure");
    expect(rec?.manifest?.harness.model).toBe("agent-model@5.0.0"); // the closure, sealed like the judges'

    // The registry's latest MOVES. The spec bytes never changed — the document facet still matches — but the
    // closure facet says re-running today would not execute under the model this batch ran with.
    latest = "6.0.0";
    const v = await service.verifyManifest("acme", "sc-harness-closure");
    expect(v.checks.find((c) => c.subject === "harness")?.status).toBe("match");
    const closure = v.checks.find((c) => c.subject === "harness:model");
    expect(closure?.status).toBe("drifted");
    expect(closure?.current).toBe("agent-model@6.0.0");
  });

  it("verifyManifest verifies a legacy FNV-sealed manifest under its OWN algorithm, and says so in the caveat", async () => {
    // Regression: manifests sealed before V1 carry bare 16-hex FNV digests. Comparing them against sha256
    // would report every one of them `drifted` — a reproducibility report accusing untouched registry
    // documents of having changed. The stamp names its algorithm; the check follows it.
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    const service = new ScorecardService({
      dispatcher: {
        async dispatch() {
          throw new Error("never");
        },
      },
      store,
      datasets,
    });
    const dataset = {
      id: "ld",
      version: "1.0.0",
      cases: [{ id: "a", env: { kind: "prompt" as const }, task: "t", graders: [], timeoutSec: 60, tags: [] }],
      tags: [],
    };
    await datasets.register("acme", dataset);
    const base = {
      tenant: "acme",
      dataset: { id: "ld", version: "1.0.0" },
      harness: { id: "h", version: "1" },
      status: "succeeded" as const,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    await store.create({
      ...base,
      id: "legacy-seal",
      manifest: {
        dataset: { id: "ld", version: "1.0.0", digest: legacyFnvOf(dataset.cases) },
        harness: { id: "h", version: "1" },
      },
    });
    const legacy = await service.verifyManifest("acme", "legacy-seal");
    const legacyCheck = legacy.checks.find((c) => c.subject === "dataset");
    expect(legacyCheck?.status).toBe("match");
    // stored and current are shown in the SAME algorithm, so the report does not read as a mismatch.
    expect(legacyCheck?.current).toBe(legacyCheck?.stored);
    expect(legacy.caveat).toContain("pre-sha256");

    // A batch sealed since V1 verifies under sha256 and its caveat states the stronger claim.
    const { contentDigest } = await import("@everdict/domain");
    await store.create({
      ...base,
      id: "sha-seal",
      manifest: {
        dataset: { id: "ld", version: "1.0.0", digest: contentDigest(dataset.cases) },
        harness: { id: "h", version: "1" },
      },
    });
    const sealed = await service.verifyManifest("acme", "sha-seal");
    expect(sealed.checks.find((c) => c.subject === "dataset")?.status).toBe("match");
    expect(sealed.caveat).toContain("collision-resistant");

    // A legacy stamp over a CHANGED bundle is still drift — dual-read verifies history, it never excuses it.
    await store.create({
      ...base,
      id: "legacy-drift",
      manifest: {
        dataset: { id: "ld", version: "1.0.0", digest: legacyFnvOf([{ ...dataset.cases[0], task: "other" }]) },
        harness: { id: "h", version: "1" },
      },
    });
    const drifted = await service.verifyManifest("acme", "legacy-drift");
    expect(drifted.checks.find((c) => c.subject === "dataset")?.status).toBe("drifted");
  });
});

// The pre-sha256 sealer, reproduced so a "legacy manifest" in these tests is one the OLD code would really
// have written. Canonicalization is unchanged, only the hash.
function legacyFnvOf(document: unknown): string {
  const canonicalize = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
    if (value !== null && typeof value === "object")
      return `{${Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
        .join(",")}}`;
    return JSON.stringify(value);
  };
  const text = canonicalize(document);
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return hash.toString(16).padStart(16, "0");
}

describe("ScorecardService.gate — the decision pins the revision it actually diffed (I4)", () => {
  it("a re-score settling between the diff read and the decision write cannot re-attribute the pin", async () => {
    // Pre-fix, gate() computed the diff and then REFETCHED both records for currentScoringPin — a rescore
    // landing in between stamped revision 2 onto numbers revision 1 produced. The snapshot reads once.
    const rev = (n: number) => ({
      revision: n,
      kind: n === 1 ? ("initial" as const) : ("rescore" as const),
      judges: [{ id: "q", version: `${n}.0.0` }],
      scorePlaneDigest: `sha256:plane-${n}`,
      createdAt: "2026-08-09T00:00:00.000Z",
    });
    const store = new InMemoryScorecardStore();
    await store.create(record("base", { scorecard: scorecard(true), scoring: [rev(1)] }));
    await store.create(record("cand", { scorecard: scorecard(true), scoring: [rev(1)] }));
    const service = svc(store);
    // Sabotage clock: after the FIRST candidate read (the diff's), the record silently gains revision 2 —
    // the exact interleaving a concurrent rescore finalize produces.
    const originalGet = store.get.bind(store);
    const originalUpdate = store.update.bind(store);
    let candReads = 0;
    store.get = async (id: string) => {
      const rec = await originalGet(id);
      if (id === "cand" && rec) {
        candReads++;
        if (candReads === 1) await originalUpdate("cand", { scoring: [rev(1), rev(2)] });
      }
      return rec;
    };
    const decision = await service.gate({ tenant: "acme", baseline: "base", candidate: "cand" });
    // The decision pins EXACTLY the revision whose plane it compared — never the one that landed after.
    expect(decision.candidateScoring).toEqual({ revision: 1, scorePlaneDigest: "sha256:plane-1" });
    expect(decision.baselineScoring).toEqual({ revision: 1, scorePlaneDigest: "sha256:plane-1" });
  });
});
