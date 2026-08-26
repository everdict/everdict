import type { CaseObservations, TraceEvent } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  OBSERVATION_CHANNEL_ACTION,
  OBSERVATION_SAMPLE_ACTION,
  observationTraceEvents,
  observationsFromTrace,
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
});
