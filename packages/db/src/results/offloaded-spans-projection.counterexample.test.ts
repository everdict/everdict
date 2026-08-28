import { type ArtifactStore, OffloadingTrajectoryStore, collectTrajectoryEvents } from "@everdict/application-control";
import { EVERDICT_ATTR, GEN_AI, GEN_AI_OPERATION, type TraceSpan } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryTrajectoryStore } from "./trajectory-store.js";

// ── RESOLVING THE RECORD DOES NOT RESOLVE THE PROJECTION (R1, found while building it) ──────────────
//
// A spans plane IS the record, and the events every judge reads are projected out of its attributes by the
// store, before anything downstream sees them. So when an attribute bag is offloaded, the projection runs
// over the PREVIEW: a `tool_result` derived from `everdict.output` carries the excerpt, and — unlike an
// events plane — it has no ref of its own, because a projected event is not what was stored.
//
// A resolve that patched the spans afterwards would therefore hand back a correct RECORD beside a truncated
// STREAM, and the stream is the half that gets scored. Nothing would look wrong: the spans are right, the
// events parse, the count matches. The verdict would just be about less evidence than the caller asked for.
//
// The repair is to resolve the record FIRST and redo the projection from it, with the plane's own batch
// facts (carried on the page for exactly this) so the re-projection is the whole-plane one.
//
// SEEN RED with the resolve path patching the spans instead of re-projecting, observed:
//   a resolved spans plane still projected the PREVIEW: expected 32000 to be 200000

const TRACE = "0123456789abcdef0123456789abcdef";
const BIG = "y".repeat(200_000);

// A tool span in the shape `spansToEvents` reads: the result text lives in an ATTRIBUTE, which is exactly
// the value the offload moves.
const TOOL_SPAN: TraceSpan = {
  traceId: TRACE,
  spanId: "aaaaaaaaaaaaaaaa",
  name: "execute_tool read_file",
  kind: "internal",
  startedAt: "2026-08-28T00:00:00.000Z",
  endedAt: "2026-08-28T00:00:01.000Z",
  attributes: {
    [GEN_AI.operationName]: GEN_AI_OPERATION.executeTool,
    "gen_ai.tool.name": "read_file",
    "gen_ai.tool.call.id": "c1",
    [EVERDICT_ATTR.output]: BIG,
  },
};

function artifactStore(): ArtifactStore {
  const objects = new Map<string, Uint8Array>();
  return {
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

async function sealedPlane(): Promise<OffloadingTrajectoryStore> {
  const store = new OffloadingTrajectoryStore(new InMemoryTrajectoryStore(), artifactStore());
  await store.seal({ runId: "r1", tenant: "acme", source: "run", spans: [TOOL_SPAN] });
  return store;
}

describe("[R1 COUNTEREXAMPLE] a resolved spans plane projects the resolved bytes", () => {
  it("a resolve reaches the EVENTS, not only the record they were projected from", async () => {
    const store = await sealedPlane();

    const resolved = await collectTrajectoryEvents(store, "acme", "r1", { resolve: true });

    const result = resolved.find((e) => e.kind === "tool_result");
    // Non-vacuous: the fixture has to project a tool_result at all, or the assertion below is about nothing.
    expect(result, "the fixture projected no tool_result — the attribute mapping changed").toBeDefined();
    expect(
      result?.kind === "tool_result" && result.output.length,
      "a resolved spans plane still projected the PREVIEW",
    ).toBe(BIG.length);
  });

  it("…and the DEFAULT read still serves the excerpt, which is the whole point of moving it", async () => {
    // The control. If the unresolved read returned the full bytes too, the offload would be buying nothing
    // and this file would be asserting a property the code does not have.
    const store = await sealedPlane();

    const preview = await collectTrajectoryEvents(store, "acme", "r1");

    const result = preview.find((e) => e.kind === "tool_result");
    expect(
      result?.kind === "tool_result" && result.output.length,
      "the default read materialized the whole payload — nothing was bounded",
    ).toBeLessThan(BIG.length);
  });
});
