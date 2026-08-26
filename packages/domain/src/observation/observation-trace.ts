import type { CaseObservations, TraceEvent } from "@everdict/contracts";
import { stamp } from "@everdict/contracts";

// ── THE OBSERVATION CHANNEL, SEALED INTO THE TRACE (evolution-lineage Track C) ───────────────────────
//
// A re-score and a deferred judgment read the SEALED trajectory, not the live run — an observation that
// lives only in the replay recording makes the same execution judge differently in-line vs after a crash
// (the durable-document law). So the channel rides the trace: one capped `env_action` per sample plus one
// CHANNEL MARKER stating the outcome, and the reconstruction below is the one reader every scoring path
// shares. A trace with NO marker predates the channel (or came from a foreign platform) and reconstructs as
// `unobserved{no_environment}` — absent is never upgraded to "watched and nothing changed" (L2).

export const OBSERVATION_SAMPLE_ACTION = "platform_observation_sample";
export const OBSERVATION_CHANNEL_ACTION = "platform_observation_channel";
// Per-sample cap inside the sealed trace — the replay recording keeps full fidelity; the trace carries what
// a judgment needs without letting a chatty diff dominate the evidence budget.
export const OBSERVATION_SAMPLE_DETAIL_CAP = 4000;

type EnvActionEvent = Extract<TraceEvent, { kind: "env_action" }>;

export function observationTraceEvents(observations: CaseObservations): TraceEvent[] {
  if (observations.kind === "unobserved") {
    // `no_environment` is a statement about a SCORING PATH, not about a run — a run's recorder never says
    // it, so it is deliberately not a marker value: sealing it would make a real run's trace claim it had
    // no environment at all.
    if (observations.reason === "no_environment") return [];
    return [
      { ...stamp(Date.now), kind: "env_action", action: OBSERVATION_CHANNEL_ACTION, detail: observations.reason },
    ];
  }
  return [
    ...observations.deltas.map(
      (d): TraceEvent => ({
        ...stamp(() => d.t),
        kind: "env_action",
        action: OBSERVATION_SAMPLE_ACTION,
        detail: d.text.slice(0, OBSERVATION_SAMPLE_DETAIL_CAP),
      }),
    ),
    { ...stamp(Date.now), kind: "env_action", action: OBSERVATION_CHANNEL_ACTION, detail: "sampled" },
  ];
}

// The one reader. Total: every trace answers, and the answer states exactly what the trace states.
export function observationsFromTrace(trace: readonly TraceEvent[]): CaseObservations {
  const isEnvAction = (e: TraceEvent): e is EnvActionEvent => e.kind === "env_action";
  let marker: EnvActionEvent | undefined;
  for (const e of trace) if (isEnvAction(e) && e.action === OBSERVATION_CHANNEL_ACTION) marker = e; // last wins
  if (marker === undefined) return { kind: "unobserved", reason: "no_environment" };
  if (marker.detail === "sampled") {
    const deltas = trace
      .filter((e): e is EnvActionEvent => isEnvAction(e) && e.action === OBSERVATION_SAMPLE_ACTION)
      .map((e) => ({ t: e.t, kind: "repo-diff" as const, text: typeof e.detail === "string" ? e.detail : "" }));
    return { kind: "sampled", deltas };
  }
  if (marker.detail === "unsupported" || marker.detail === "sampling_failed")
    return { kind: "unobserved", reason: marker.detail };
  // A marker whose detail this reader does not know: a NEWER writer's vocabulary. Unknown is unignorable —
  // fold to the arm that claims least.
  return { kind: "unobserved", reason: "no_environment" };
}
