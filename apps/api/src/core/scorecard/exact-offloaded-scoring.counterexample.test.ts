import { OffloadingTrajectoryStore, ScorecardService } from "@everdict/application-control";
import { EVERDICT_TRACE_SOURCE, isMeasured } from "@everdict/contracts";
import type { CaseResult, TraceEvent } from "@everdict/contracts";
import { InMemoryScorecardStore, InMemoryTrajectoryStore } from "@everdict/db";
import { describe, expect, it } from "vitest";

// ── [R120 COUNTEREXAMPLE] A VERDICT READS THE PAYLOAD, NOT ITS PREVIEW ──────────────────────────────
//
// The payload offload moves an oversized value to object storage and leaves an EXCERPT plus a ref in the
// event. That is the right default for a read that DISPLAYS. A read that DECIDES has to ask for the bytes
// back (`{ resolve: true }`), and the offloading store already fails closed when the object is gone.
//
// Asking was optional, and the owned-trace scorecard ingest did not ask:
//
//     collectTrajectoryEvents(this.deps.trajectories, tenant, r.runId)      ← previews
//
// six lines under a comment saying "This path genuinely needs every event — it is scoring the trace, not
// showing it". The re-score path four hundred lines down in the SAME FILE passed the flag, with a comment
// explaining exactly why. One law, two lanes, one of them written after it.
//
//     the payload was preserved   ≠   the verdict read the payload
//
// Production reaches this: `main.ts` wraps the raw trajectory store in `OffloadingTrajectoryStore` whenever
// an artifact store is configured and hands THAT to the scorecard service. So an evaluation whose decisive
// evidence sits past the preview boundary — a failure after 32 KB of plausible output, a secret in the tail,
// the verifier's own note — was scored on the head and committed as the batch's verdict.
//
// This drives the production composition: the real decorator over the real store, the real ingest service,
// and the score that comes out of it.
//
// Seen RED before the fix:
//   "the verdict was reached on an excerpt: expected 1 to be 0" — the DECISIVE marker never reached the
//   grader, so the trace-derived score disagreed with the sealed evidence.

const HEAD = "plausible but wrong ".repeat(3_000); // > EVENT_INLINE_MAX (32_000) on its own
const DECISIVE = "__THE_ANSWER_IS_IN_THE_TAIL__";
const BIG_OUTPUT = `${HEAD}${DECISIVE}`;

const events = (): TraceEvent[] => [
  { t: 0, kind: "message", role: "user", text: "run it" },
  { t: 1, kind: "tool_call", id: "c1", name: "shell", args: { cmd: "./run" } },
  // One leaf, larger than the inline ceiling: the offload moves it and leaves a head-only preview behind.
  { t: 2, kind: "tool_result", id: "c1", ok: true, output: BIG_OUTPUT },
];

// The smallest artifact store that actually holds bytes — the decorator's `put`/`get` are the seam under test.
function artifacts() {
  const objects = new Map<string, Uint8Array>();
  return {
    keys: () => [...objects.keys()],
    async put(key: string, data: Uint8Array) {
      objects.set(key, data);
      return `https://example.invalid/${key}`;
    },
    async get(key: string) {
      return objects.get(key);
    },
    async publicUrlFor() {
      return undefined;
    },
  };
}

// A grader that answers the only question this test is about: did the DECISIVE bytes reach the scorer? It
// reads the trace it is handed — the same trace every judge and grader on this path receives.
const tailGrader = {
  id: "tail",
  metric: "tail_present",
  declaredAuthority: "objective" as const,
  async grade(ctx: { trace: TraceEvent[] }) {
    const found = (ctx.trace ?? []).some(
      (e) => e.kind === "tool_result" && typeof e.output === "string" && e.output.includes(DECISIVE),
    );
    return [{ graderId: "tail", metric: "tail_present", value: found ? 1 : 0, pass: found }];
  },
};

async function waitTerminal(store: InMemoryScorecardStore, id: string) {
  for (let i = 0; i < 400; i++) {
    const record = await store.get(id);
    if (record && (record.status === "succeeded" || record.status === "failed")) return record;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("the ingest never settled");
}

describe("[R120 COUNTEREXAMPLE] owned-trace scoring reads the sealed payload, not its preview", () => {
  it("scores the DECISIVE tail that the offload moved out of the event", async () => {
    const store = new InMemoryScorecardStore();
    // The production wrapping: raw store + artifact store → offloading decorator → the scorecard service.
    const raw = new InMemoryTrajectoryStore();
    const objects = artifacts();
    const trajectories = new OffloadingTrajectoryStore(raw, objects as never);
    await trajectories.seal({ runId: "run-1", tenant: "acme", source: "run", events: events() });
    // The offload actually happened — otherwise this test would pass over an inline payload and prove nothing.
    expect(objects.keys().length, "nothing was offloaded, so there is no preview to be fooled by").toBe(1);

    let ids = 0;
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(): Promise<CaseResult> {
          throw new Error("ingest never dispatches");
        },
      },
      store,
      trajectories,
      defaultTraceGraders: () => [tailGrader],
      newId: () => `sc-${ids++}`,
    } as never);

    const created = await service.ingestPull({
      tenant: "acme",
      source: { name: EVERDICT_TRACE_SOURCE },
      runs: [{ caseId: "c1", runId: "run-1" }],
      judges: [],
    } as never);

    const done = await waitTerminal(store, created.id);
    expect(done.status, "the ingest failed instead of scoring").toBe("succeeded");
    const score = (done.scorecard?.results ?? []).flatMap((r) => r.scores).find((s) => s.metric === "tail_present");
    expect(score, "the grader never ran, so this proves nothing about what it read").toBeDefined();
    // A Score is a union: `measured` carries a value, `unmeasured` carries a reason. Reading `.value` off the
    // union would be a fixture that cannot tell "scored 0" from "never scored" — the two answers this test
    // exists to keep apart.
    // `isMeasured` is the kernel's own predicate for that union — asked here rather than re-spelled, so the
    // test cannot drift from what the ladder counts.
    expect(
      score !== undefined && isMeasured(score),
      "the grader did not MEASURE, which is not the same as scoring the excerpt",
    ).toBe(true);
    expect(score !== undefined && isMeasured(score) ? score.value : -1, "the verdict was reached on an excerpt").toBe(
      1,
    );
  });

  it("REFUSES when the payload object is gone — a short trace is not a shorter answer", async () => {
    // Fail-closed is the other half: an offloaded ref whose object cannot be read must stop the ingest, not
    // score whatever survived inline. Otherwise a lost object degrades silently into a smaller verdict.
    const store = new InMemoryScorecardStore();
    const raw = new InMemoryTrajectoryStore();
    const objects = artifacts();
    const trajectories = new OffloadingTrajectoryStore(raw, objects as never);
    await trajectories.seal({ runId: "run-2", tenant: "acme", source: "run", events: events() });
    const lost = {
      ...objects,
      async get() {
        return undefined;
      },
    };
    const blind = new OffloadingTrajectoryStore(raw, lost as never);

    let ids = 0;
    const service = new ScorecardService({
      dispatcher: {
        async dispatch(): Promise<CaseResult> {
          throw new Error("ingest never dispatches");
        },
      },
      store,
      trajectories: blind,
      defaultTraceGraders: () => [tailGrader],
      newId: () => `sc-${ids++}`,
    } as never);

    const created = await service.ingestPull({
      tenant: "acme",
      source: { name: EVERDICT_TRACE_SOURCE },
      runs: [{ caseId: "c1", runId: "run-2" }],
      judges: [],
    } as never);

    const done = await waitTerminal(store, created.id);
    expect(done.status, "a scorecard was committed over evidence nobody could read").toBe("failed");
  });
});
