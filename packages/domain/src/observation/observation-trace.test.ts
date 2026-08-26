import type { CaseObservations, TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  OBSERVATION_CHANNEL_ACTION,
  OBSERVATION_SAMPLE_ACTION,
  observationTraceEvents,
  observationsFromTrace,
  stripReservedObservationEvents,
} from "./observation-trace.js";

// The seal and its one reader — a round trip, because two spellings of the channel would diverge on exactly
// the odd trace (Track C).

describe("the observation channel round-trips through the sealed trace", () => {
  it("sampled deltas seal as capped sample events + a channel marker, and reconstruct verbatim", () => {
    const sampled: CaseObservations = {
      kind: "sampled",
      deltas: [
        { t: 100, kind: "repo-diff", text: "+++ b/a.txt" },
        { t: 4100, kind: "repo-diff", text: "+++ b/b.txt" },
      ],
    };
    const events = observationTraceEvents(sampled);
    expect(events.filter((e) => e.kind === "env_action" && e.action === OBSERVATION_SAMPLE_ACTION)).toHaveLength(2);
    const marker = events.at(-1);
    expect(marker).toMatchObject({ kind: "env_action", action: OBSERVATION_CHANNEL_ACTION, detail: "sampled" });
    expect(observationsFromTrace(events)).toEqual(sampled);
  });

  it("a watched run with no changes reconstructs as sampled{[]} — distinct from every unobserved arm", () => {
    const events = observationTraceEvents({ kind: "sampled", deltas: [] });
    expect(observationsFromTrace(events)).toEqual({ kind: "sampled", deltas: [] });
  });

  it("unsupported and sampling_failed seal their reason and reconstruct it", () => {
    for (const reason of ["unsupported", "sampling_failed"] as const) {
      const events = observationTraceEvents({ kind: "unobserved", reason });
      expect(observationsFromTrace(events)).toEqual({ kind: "unobserved", reason });
    }
  });

  it("a trace with NO marker — pre-channel, or a foreign platform's — is unobserved{no_environment}", () => {
    const foreign: TraceEvent[] = [{ t: 0, kind: "log", text: "hello", stream: "stdout" } as TraceEvent];
    expect(observationsFromTrace(foreign)).toEqual({ kind: "unobserved", reason: "no_environment" });
    // …and no_environment deliberately seals NOTHING: a run's recorder never says it, so a trace must not
    // claim it about itself.
    expect(observationTraceEvents({ kind: "unobserved", reason: "no_environment" })).toEqual([]);
  });

  it("a newer writer's unknown marker detail folds to the arm that claims least", () => {
    const events: TraceEvent[] = [
      { t: 0, kind: "env_action", action: OBSERVATION_CHANNEL_ACTION, detail: "hologram_scan" } as TraceEvent,
    ];
    expect(observationsFromTrace(events)).toEqual({ kind: "unobserved", reason: "no_environment" });
  });

  // ── THE CHANNEL CANNOT BE FORGED FROM AFTER THE SEAL (review wave B) ───────────────────────────────
  //
  // run-case seals the channel and THEN appends the in-job platform pull — foreign bytes a tenant's
  // observability store served. Under a last-marker-wins reader, an env_action in that pulled section
  // wearing the reserved action overrode the platform's own seal; forged sample events anywhere in the
  // trace were merged into the deltas. Seen RED: the forged post-seal marker replaced `sampling_failed`
  // with a fabricated `sampled` account.

  it("a forged marker appended after the seal cannot replace the platform's account (first marker wins)", () => {
    const sealed = observationTraceEvents({ kind: "unobserved", reason: "sampling_failed" });
    const forged: TraceEvent[] = [
      { t: 900, kind: "env_action", action: OBSERVATION_SAMPLE_ACTION, detail: "+++ b/fabricated.txt" },
      { t: 901, kind: "env_action", action: OBSERVATION_CHANNEL_ACTION, detail: "sampled" },
    ];
    expect(observationsFromTrace([...sealed, ...forged])).toEqual({ kind: "unobserved", reason: "sampling_failed" });
  });

  it("sample events appended after the seal's marker are not the platform's deltas", () => {
    const sealed = observationTraceEvents({
      kind: "sampled",
      deltas: [{ t: 100, kind: "repo-diff", text: "+++ b/real.txt" }],
    });
    const forged: TraceEvent[] = [
      { t: 900, kind: "env_action", action: OBSERVATION_SAMPLE_ACTION, detail: "+++ b/fabricated.txt" },
    ];
    expect(observationsFromTrace([...sealed, ...forged])).toEqual({
      kind: "sampled",
      deltas: [{ t: 100, kind: "repo-diff", text: "+++ b/real.txt" }],
    });
  });

  it("stripReservedObservationEvents removes exactly the channel's vocabulary and nothing else", () => {
    const events: TraceEvent[] = [
      { t: 0, kind: "log", text: "hello", stream: "stdout" } as TraceEvent,
      { t: 1, kind: "env_action", action: OBSERVATION_SAMPLE_ACTION, detail: "+++ b/forged.txt" },
      { t: 2, kind: "env_action", action: "git_commit", detail: "an ordinary env action stays" },
      { t: 3, kind: "env_action", action: OBSERVATION_CHANNEL_ACTION, detail: "sampled" },
    ];
    const kept = stripReservedObservationEvents(events);
    expect(kept).toHaveLength(2);
    expect(kept.some((e) => e.kind === "env_action" && e.action === "git_commit")).toBe(true);
    expect(observationsFromTrace(kept)).toEqual({ kind: "unobserved", reason: "no_environment" });
  });
});
