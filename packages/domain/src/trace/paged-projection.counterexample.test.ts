import { GEN_AI, GEN_AI_OPERATION, type TraceSpan } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { spanBatchFacts, spansToEvents } from "./spans-to-events.js";

// ── A SPANS PLANE CANNOT BE PROJECTED PAGE BY PAGE (long-horizon OOM, R2 prerequisite) ───────────────
//
// The windowed read exists so a long-horizon trajectory is never materialized whole. For an EVENTS plane
// that is a slice and nothing more. For a SPANS plane — which is the record, per otel-trace-model.md N6 —
// it is not, because `spansToEvents` reads two facts off the WHOLE array it is handed:
//
//     baseMs         the earliest startedAt; every projected event's relative `t` counts from it
//     perCallTokens  does ANY chat span carry token counts; decides whether an `invoke_agent` aggregate
//                    projects as an llm_call or is suppressed as a double-count
//
// Project a PAGE and both are measured against the page. The `t` axis restarts at every page boundary, and a
// page that happens to hold the aggregate span but no per-call chat span emits an llm_call the whole-plane
// projection deliberately suppresses. So the same sealed evidence reads two ways depending on page size: a
// judge scoring the paged stream and a cost fold reading the plane whole would disagree, and nothing in
// either would look wrong.
//
// The repair keeps the projection on the READ side (N6: one copy of the truth, no stored projection). The two
// batch facts become the plane's own provenance, derived at seal where the whole plane is legitimately in
// hand, and injected into every page. `spanBatchFacts` is their single owner so the seal and the projection
// cannot compute them differently.
//
// SEEN RED by neutralizing the protocol in the production file — `spansToEvents` made to derive the facts
// from whatever batch it is handed (`spanBatchFacts(sorted)` instead of `opts.batch ?? …`). Observed:
//   paging at 1 changed the projection: expected [ { t: +0, …(6) }, …(4) ] to deeply equal [ { t: +0, …(6) }, …(3) ]
//   expected 4 to be 3
// Four events where the plane yields three: the page holding the aggregate span emitted the llm_call the
// whole-plane projection suppresses as a double-count. That is the defect, in the number that reaches an
// invoice.
//
// The second and third tests keep the un-batched paging as a CONTROL, so this file cannot go vacuous later:
// if paging ever stops differing on this fixture, the fixture rather than the mechanism is what makes the
// first assertion green.

const TRACE = "0123456789abcdef0123456789abcdef";
const at = (ms: number) => new Date(Date.UTC(2026, 7, 28) + ms).toISOString();

function chat(index: number, startMs: number, tokens: boolean): TraceSpan {
  return {
    traceId: TRACE,
    spanId: `${index}`.padStart(16, "a"),
    name: `chat ${index}`,
    kind: "client",
    startedAt: at(startMs),
    endedAt: at(startMs + 400),
    attributes: {
      [GEN_AI.operationName]: GEN_AI_OPERATION.chat,
      [GEN_AI.requestModel]: "opus",
      ...(tokens ? { [GEN_AI.inputTokens]: 900, [GEN_AI.outputTokens]: 100 } : {}),
    },
  };
}

// The agent-level span whose tokens are an AGGREGATE of the chat spans under it. Whether it projects at all
// is the `perCallTokens` decision — which is exactly the fact a page cannot see.
function aggregate(startMs: number): TraceSpan {
  return {
    traceId: TRACE,
    spanId: "ffffffffffffffff",
    name: "agent turn",
    kind: "internal",
    startedAt: at(startMs),
    endedAt: at(startMs + 9_000),
    attributes: {
      [GEN_AI.operationName]: GEN_AI_OPERATION.invokeAgent,
      [GEN_AI.requestModel]: "opus",
      [GEN_AI.inputTokens]: 1_800,
      [GEN_AI.outputTokens]: 200,
    },
  };
}

// Sorted by startedAt, because that is the order the store pages in — seq order IS projection order.
const PLANE: TraceSpan[] = [aggregate(0), chat(1, 1_500, true), chat(2, 3_000, true), chat(3, 4_500, true)].sort(
  (a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt),
);

// Concatenate the projection of every page, the way a streaming reader does.
function paged(spans: TraceSpan[], size: number, batch?: ReturnType<typeof spanBatchFacts>) {
  const out = [];
  for (let i = 0; i < spans.length; i += size)
    out.push(...spansToEvents(spans.slice(i, i + size), batch !== undefined ? { batch } : {}));
  return out;
}

describe("[R2 COUNTEREXAMPLE] a spans plane projects identically however it is paged", () => {
  it("every page size reproduces the whole-plane projection, event for event", () => {
    const whole = spansToEvents(PLANE);
    const facts = spanBatchFacts(PLANE);

    // Non-vacuous: the plane must actually produce a projection with the properties under test.
    expect(whole.length, "the fixture projected nothing — nothing below is being asserted").toBeGreaterThan(2);
    expect(
      new Set(whole.map((e) => e.t)).size,
      "every event landed on one instant; `t` is not under test",
    ).toBeGreaterThan(1);

    for (const size of [1, 2, 3, PLANE.length]) {
      expect(paged(PLANE, size, facts), `paging at ${size} changed the projection`).toEqual(whole);
    }
  });

  it("…and WITHOUT the plane's facts it does not — which is the defect, kept as a control", () => {
    // If this ever starts passing, the test above has stopped proving anything: it would mean paging is
    // harmless on this fixture and the fixture, not the mechanism, is what makes the first test green.
    const whole = spansToEvents(PLANE);

    expect(paged(PLANE, 1), "paging one span at a time somehow matched the whole-plane projection").not.toEqual(whole);
  });

  it("suppresses the aggregate's duplicate tokens on every page size, not only the first", () => {
    // The `perCallTokens` half, stated on its own: the aggregate span carries the same tokens the chat spans
    // already reported, so the whole-plane projection emits one llm_call per chat span and none for it. A
    // page holding only the aggregate cannot see the chat spans, so without the plane's facts it emits an
    // extra llm_call — 2000 tokens of double-counted spend, in the number that reaches an invoice.
    const facts = spanBatchFacts(PLANE);
    const calls = (events: ReturnType<typeof spansToEvents>) => events.filter((e) => e.kind === "llm_call").length;

    const wholeCalls = calls(spansToEvents(PLANE));
    expect(wholeCalls, "the fixture emitted no llm_call — the token rule is not being exercised").toBeGreaterThan(0);
    expect(calls(paged(PLANE, 1, facts))).toBe(wholeCalls);
    expect(calls(paged(PLANE, 1)), "a page-local projection double-counted the aggregate's tokens").toBeGreaterThan(
      wholeCalls,
    );
  });
});
