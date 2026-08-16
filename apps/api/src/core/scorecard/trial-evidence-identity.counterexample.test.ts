import { ScorecardService } from "@everdict/application-control";
import type { CaseResult, ScorecardRecord, TraceEvent } from "@everdict/contracts";
import { InMemoryScorecardStore, InMemoryTrajectoryStore } from "@everdict/db";
import { InMemoryDatasetRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";

// ── A TRIAL'S TRAJECTORY IS ITS OWN (arch-review 52, Wave 1) ────────────────────────────────────────
//
// Ingest materializes every imported trace as OUR copy and then JUDGES the sealed copy — the whole point of
// materialize-on-import. The seal key is `ingest:<scorecardId>:<caseId>` (scorecard-ingest-service.ts), and the
// trajectory store is first-seal-wins, so an upload of N tries for one scenario — which the same service
// correctly stamps as trials 0..N-1 — seals ONCE and reads trial 0's trace back for every trial.
//
// The result is not a missing copy but a WRONG one: trials 1..N-1 are scored, judged, exported and diffed
// against evidence they did not produce, and the record shows N identical traces with N different verdicts.
// Nothing anywhere reports an error; the second seal is refused silently, by design (a retried settle must not
// rewrite evidence).
//
// The invariant: what addresses a trial's evidence carries the trial — the same rule the commit receipt's
// UNIQUE `(scorecard, case, trial)` already states.

const trace = (marker: string): TraceEvent[] => [
  { t: 0, kind: "llm_call", model: `model-${marker}` },
  { t: 1, kind: "tool_call", id: `tool-${marker}`, name: "bash", args: {} },
];

const dataset = () => ({
  id: "d",
  version: "1.0.0",
  tags: [],
  cases: [{ id: "c1", env: { kind: "prompt" as const }, task: "t", graders: [], timeoutSec: 60, tags: [] }],
});

async function waitTerminal(store: InMemoryScorecardStore, id: string): Promise<ScorecardRecord> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    const rec = await store.get(id);
    if (rec && ["succeeded", "failed", "cancelled", "superseded"].includes(rec.status)) return rec;
    if (Date.now() > deadline) throw new Error(`ingest ${id} never settled (status ${rec?.status})`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

// [WAVE-1 COUNTEREXAMPLE #1] RED as of 02a3e15e: `AssertionError: expected [ [ { t: +0, …(2) }, …(1) ], …(2) ] to
// deeply equal [ … ]` — trials 1 and 2 read back trial 0's events ("model-first"), because
// scorecard-ingest-service.ts seals under `ingest:<scorecardId>:<caseId>` (no trial) into a first-seal-wins store.
// Un-skip when wave 1 lands.
describe.skip("a trial's evidence is its own", () => {
  it("three ingested traces under one caseId materialize three trajectories, one per trial", async () => {
    // Given three tries of one scenario uploaded together — the agent-eval shape the trial stamping exists for
    const store = new InMemoryScorecardStore();
    const datasets = new InMemoryDatasetRegistry();
    await datasets.register("acme", dataset());
    const trajectories = new InMemoryTrajectoryStore();
    // …watching WHICH coordinate each materialization is sealed under (the key is the service's business; that
    // there are three of them is the invariant).
    const sealedUnder = new Set<string>();
    const seal = trajectories.seal.bind(trajectories);
    trajectories.seal = async (input: Parameters<typeof seal>[0]) => {
      sealedUnder.add(input.runId);
      return seal(input);
    };
    let ids = 0;
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(): Promise<CaseResult> {
          throw new Error("ingest never dispatches");
        },
      },
      store,
      datasets,
      trajectories,
      newId: () => `sc-${ids++}`,
    } as never);

    // When they are ingested as one batch
    const created = await service.ingest({
      tenant: "acme",
      dataset: { id: "d", version: "1.0.0" },
      traces: [
        { caseId: "c1", trace: trace("first") },
        { caseId: "c1", trace: trace("second") },
        { caseId: "c1", trace: trace("third") },
      ],
      judges: [],
    });
    const done = await waitTerminal(store, created.id);
    expect(done.status).toBe("succeeded");

    // Then the batch holds three trials…
    const results = done.scorecard?.results ?? [];
    expect(results.map((r) => r.trial)).toEqual([0, 1, 2]);
    // …each judged from the evidence IT arrived with. Reading one trial's trace out of another's seal is a
    // verdict attributed to a run that never happened.
    expect(results.map((r) => r.trace)).toEqual([trace("first"), trace("second"), trace("third")]);
    // …and three copies were actually retained: the fix is a per-trial coordinate, not the removal of the
    // materialization the "never judge what you don't retain" rung exists for.
    expect(sealedUnder.size).toBe(3);
  });
});
