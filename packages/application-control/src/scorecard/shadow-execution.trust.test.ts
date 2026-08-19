import type { CaseResult, Dataset, HarnessSpec, ScorecardRecord } from "@everdict/contracts";
import { contentDigest, sealGrading } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import type { DatasetRegistry } from "../ports/dataset-registry.js";
import type { HarnessInstanceRegistry } from "../ports/harness-instance-registry.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import type { ScorecardServiceDeps } from "./scorecard-deps.js";
import { ScorecardService } from "./scorecard-service.js";

// Trust suite (docs/trust-certification.md) — TRUST-92 · TRUST-93.
//
// PRODUCTION SEAM, not the decision function. The previous wave's shadow scenarios drive
// `verifySealedSelection` directly and say so; these drive `ScorecardService.resume()`, which is what startup
// recovery actually calls. The distinction matters here more than anywhere else in the suite: the last two
// defects in this area were both WIRING — one path verifying the dataset, another verifying the harness, and
// a third exempting itself entirely — and no amount of decision-level green could have seen any of them.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const NOW = "2026-08-10T00:00:00.000Z";

const caseOf = (task: string) =>
  ({ id: "c1", env: { kind: "prompt" }, task, graders: [], timeoutSec: 60, tags: [] }) as never;

const datasetOf = (task: string): Dataset => ({ id: "support", version: "1.0.0", cases: [caseOf(task)], tags: [] });

const harnessOf = (command: string): HarnessSpec =>
  ({
    kind: "command",
    id: "agent",
    version: "1",
    command,
    image: "base:1",
    trace: { kind: "none" },
    setup: [],
    params: {},
  }) as unknown as HarnessSpec;

// A registry that applies pins the way the real one does — the pinned IMAGE replaces the base's, and the rest
// of the document is whatever the (possibly shadowed) base says.
const registryFor = (spec: () => HarnessSpec): HarnessInstanceRegistry =>
  ({
    async get() {
      return spec();
    },
    async resolveWithPins(_t: string, _id: string, _v: string, pins: Record<string, string>) {
      return { ...spec(), image: pins.main } as unknown as HarnessSpec;
    },
    async versions() {
      return ["1"];
    },
  }) as unknown as HarnessInstanceRegistry;

function seededRecord(dataset: Dataset, effectiveSpec: HarnessSpec, pins?: Record<string, string>): ScorecardRecord {
  return {
    id: "sc-1",
    tenant: "acme",
    dataset: { id: dataset.id, version: dataset.version },
    harness: { id: "agent", version: "1" },
    status: "running",
    runIds: [],
    ...(pins ? { origin: { source: "api", pinOverrides: pins } } : {}),
    orchestration: { concurrency: 1, retries: 1 },
    manifest: {
      identityVersion: 1,
      dataset: { id: dataset.id, version: dataset.version, digest: contentDigest(dataset.cases) },
      cases: Object.fromEntries(dataset.cases.map((c) => [c.id, contentDigest({ ...c, graders: undefined })])),
      ...sealGrading(undefined, dataset.cases),
      // Submit seals the EFFECTIVE spec — post-pin — which is exactly why the pinned path needs no exemption.
      harness: { id: "agent", version: "1", specDigest: contentDigest(effectiveSpec) },
    },
    createdAt: NOW,
    updatedAt: NOW,
  } as unknown as ScorecardRecord;
}

function service(record: ScorecardRecord, datasets: DatasetRegistry, harnesses: HarnessInstanceRegistry) {
  let dispatched = 0;
  const store = {
    async create() {},
    async update() {
      return record;
    },
    async get() {
      return record;
    },
    async list() {
      return [];
    },
    async delete() {
      return false;
    },
  } as ScorecardStore;
  const svc = new ScorecardService({
    dispatcher: {
      async dispatch(): Promise<CaseResult> {
        dispatched += 1;
        throw new Error("a shadowed document must never reach dispatch");
      },
    },
    store,
    datasets,
    harnesses,
    newId: () => "id",
    now: () => NOW,
  } as unknown as ScorecardServiceDeps);
  return { svc, dispatched: () => dispatched };
}

describeTrust("TRUST-92/93 — resume() refuses a shadowed document (production seam)", () => {
  it("TRUST-92 — a PINNED harness is verified too: the seal is the effective spec, so there is nothing to exempt", async () => {
    // The exemption this closes skipped harness verification entirely whenever pins were present, on the
    // reasoning that a deliberate image swap must differ from the registry document. Submit seals the
    // POST-PIN spec and every re-resolution re-applies the same pins, so the digests were directly
    // comparable — the exemption bought nothing and made the pinned path the one place a shadowed harness
    // could execute uncaught.
    const dataset = datasetOf("book a flight");
    const pins = { main: "pinned-image:9" };
    const sealed = { ...harnessOf("run {{task}}"), image: pins.main } as HarnessSpec;
    const record = seededRecord(dataset, sealed, pins);
    // The base is shadowed: same id@version, a different command — the pins are untouched, so the pinned
    // image still matches and only the document underneath moved.
    const { svc, dispatched } = service(
      record,
      {
        async get() {
          return dataset;
        },
      } as unknown as DatasetRegistry,
      registryFor(() => harnessOf("run --v2 {{task}}")),
    );
    // `unresumable`, NOT `retry_later`: a shadowed document is a permanent refusal — asking again cannot
    // un-shadow it — and the two are different debts (arch-review 55). Asserting the kind rather than a
    // truthiness keeps this test honest about WHICH refusal it pinned.
    await expect(svc.resume("sc-1")).resolves.toEqual({ kind: "unresumable" });
    expect(dispatched()).toBe(0);
  });

  it("…and an UNSHADOWED pinned harness resumes — the check is not a ban on pins", async () => {
    const dataset = datasetOf("book a flight");
    const pins = { main: "pinned-image:9" };
    const base = harnessOf("run {{task}}");
    const record = seededRecord(dataset, { ...base, image: pins.main } as HarnessSpec, pins);
    const { svc } = service(
      record,
      {
        async get() {
          return dataset;
        },
      } as unknown as DatasetRegistry,
      registryFor(() => base),
    );
    // It gets past verification and into the batch loop; the dispatcher throwing is the loop's business, not
    // the guard's — what matters is that the refusal did NOT happen.
    await expect(svc.resume("sc-1")).resolves.toEqual({ kind: "resumed" });
  });

  it("TRUST-93 — a shadowed DATASET is refused on the same path, not just on Temporal's", async () => {
    const dataset = datasetOf("book a flight");
    const base = harnessOf("run {{task}}");
    const record = seededRecord(dataset, base);
    const { svc, dispatched } = service(
      record,
      {
        async get() {
          return datasetOf("book a train instead");
        },
      } as unknown as DatasetRegistry,
      registryFor(() => base),
    );
    await expect(svc.resume("sc-1")).resolves.toEqual({ kind: "unresumable" });
    expect(dispatched()).toBe(0);
  });
});

// Trust suite — TRUST-94.
//
// LOSING THE QUESTION IS A REASON TO REFUSE, NOT A REASON TO ASK A WEAKER ONE.
//
// A detached re-score re-reads the dataset to rebuild the judge's context. When that read fails, the fallback
// synthesizes shell cases — `task: ""`, no expected answer, no milestones — which is the honest shape for a
// record that never had a registry dataset (an ad-hoc experiment, a directly-evaluated trace). Applied to a
// batch whose manifest SEALED case documents it produces the most dangerous output this system has: the trace
// and snapshot are the real execution's evidence, so a judge reads genuine evidence against a question that
// has been emptied out and returns a MEASURED verdict for it. Nothing downstream looks anomalous.
describeTrust("TRUST-94 — a lost dataset refuses the re-score instead of judging an empty question", () => {
  const judged: CaseResult[] = [
    {
      caseId: "c1",
      harness: "agent@1",
      trace: [{ t: 0, kind: "message", role: "assistant", text: "booked" }],
      snapshot: { kind: "prompt", output: "booked" },
      scores: [],
    } as unknown as CaseResult,
  ];

  const scoreService = (datasets: DatasetRegistry, record: ScorecardRecord) => {
    const svc = new ScorecardService({
      dispatcher: {
        async dispatch() {
          throw new Error("unused");
        },
      },
      store: {
        async create() {},
        async update() {
          return record;
        },
        async get() {
          return record;
        },
        async list() {
          return [];
        },
        async delete() {
          return false;
        },
      } as ScorecardStore,
      datasets,
      newId: () => "id",
      now: () => NOW,
    } as unknown as ScorecardServiceDeps);
    return svc;
  };

  const scored = (over: Partial<ScorecardRecord> = {}): ScorecardRecord =>
    ({
      ...seededRecord(datasetOf("book a flight"), harnessOf("run {{task}}")),
      status: "succeeded",
      scorecard: { suiteId: "support@1.0.0", harness: "agent@1", results: judged },
      scoringPass: {
        passId: "pass-A",
        epoch: 1,
        leaseUntil: "2999-01-01T00:00:00.000Z",
        heartbeatAt: NOW,
        targetRevision: 1,
        baseRevision: 0,
        judges: [],
        startedAt: NOW,
        status: "running",
      },
      ...over,
    }) as unknown as ScorecardRecord;

  const dead: DatasetRegistry = {
    async get() {
      throw new Error("dataset registry unavailable");
    },
  } as unknown as DatasetRegistry;

  it("refuses when the batch sealed real case documents it can no longer read", async () => {
    await expect(
      scoreService(dead, scored()).runScoreCase("sc-1", "c1#0", [{ id: "q", version: "1.0.0" }], "dana", "pass-A"),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("…and still falls back for a record that never had a registry dataset", async () => {
    // The ad-hoc and trace-eval sentinels are the shapes the shell was written for: there is no document to
    // lose, so synthesizing one is not a weaker question — it is the only question there ever was.
    const adhoc = scored({ dataset: { id: "_adhoc", version: "1.0.0" } } as Partial<ScorecardRecord>);
    await expect(
      scoreService(dead, adhoc).runScoreCase("sc-1", "c1#0", [{ id: "q", version: "1.0.0" }], "dana", "pass-A"),
    ).resolves.toBeDefined();
  });
});
