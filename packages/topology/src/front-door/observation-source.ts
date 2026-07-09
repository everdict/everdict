import { type EnvSnapshot, EnvSnapshotSchema, InternalError, type ObservationDelivery } from "@everdict/core";
import { getField, interpolatePath } from "./front-door-driver.js";

// Abstraction for retrieving the observation — the sibling (HOW-observe) of TopologyRuntime (WHERE) / FrontDoorDriver (HOW-drive).
// The path by which the observation reaches the grader/judge differs per delivery.mode:
//   reference — the eval pulls from a store (browser CDP etc.) (current, no regression). Pairs with store-locality (co-locate).
//   sentinel  — the run returns it inline via the result channel (front-door response). No store hop — good for small observations.
//   egress    — the run pushes to a sink, the eval retrieves from that sink. Push instead of pull when the judge is far.
// Design: docs/architecture/judge-placement-locality.md.

// Only the per-case target's observation surface (snapshot) — the provisionBrowserEnv handle satisfies it structurally. Minimizes runtime coupling.
export interface ObservationTarget {
  snapshot(): Promise<EnvSnapshot>;
}

export interface ObserveRequest {
  target: ObservationTarget | undefined; // no target → undefined → reference yields a prompt snapshot
  response?: unknown; // result-channel body (DriveOutcome.response) — sentinel extracts the observation from here
  getJson?: (url: string) => Promise<unknown>; // fetch primitive for egress sink retrieval
  wiring?: Record<string, string>; // sink/path interpolation variables ({run_id} etc.)
}

export interface ObservationSource {
  observe(req: ObserveRequest): Promise<EnvSnapshot>;
}

// Validate an inline/remote retrieval body as an EnvSnapshot — a format mismatch fails explicitly rather than silently (external-contract error → run failure).
function parseSnapshot(raw: unknown, label: string): EnvSnapshot {
  const parsed = EnvSnapshotSchema.safeParse(raw);
  if (!parsed.success) {
    throw new InternalError(
      "HARNESS_RUN_FAILED",
      { label, issues: parsed.error.issues.map((i) => i.message) },
      `${label} is not in EnvSnapshot format.`,
    );
  }
  return parsed.data;
}

// Result-channel body → prompt output text: a string as-is, other shapes as JSON. The response is evidence for
// judges/graders, not a structured EnvSnapshot (that's what sentinel is for).
function responseText(response: unknown): string {
  if (response == null) return "";
  return typeof response === "string" ? response : JSON.stringify(response);
}

// reference (store-fetch): pull the target's snapshot if present. With no target there is no stage to pull from —
// carry the result-channel body (DriveOutcome.response) as the prompt output so the final response still reaches
// judges/graders (dropping it left the snapshot empty for trace-less harnesses).
export const referenceObservationSource: ObservationSource = {
  async observe({ target, response }) {
    return target ? target.snapshot() : { kind: "prompt", output: responseText(response) };
  },
};

// sentinel (return channel): extract the observation the agent returned inline in the front-door response. With a path, via dot-path;
// without one, treat the whole body as an EnvSnapshot.
export function sentinelObservationSource(path: string | undefined): ObservationSource {
  return {
    async observe({ response }) {
      const raw = path ? getField(response, path) : response;
      return parseSnapshot(raw, `sentinel observation (${path ?? "response body"})`);
    },
  };
}

// egress (push-to-sink): the agent pushes the observation to a sink, and the eval retrieves it from that sink. sink is a {run_id}-interpolated URL
// — GET via getJson then validate as EnvSnapshot. (Reads from where the agent sent it, not a pull from an Everdict-provisioned target.)
export function egressObservationSource(sink: string): ObservationSource {
  return {
    async observe({ getJson, wiring }) {
      if (!getJson) {
        throw new InternalError(
          "HARNESS_RUN_FAILED",
          { sink },
          "Missing the fetch primitive required for egress retrieval.",
        );
      }
      const url = interpolatePath(sink, wiring ?? {});
      return parseSnapshot(await getJson(url), `egress observation (${url})`);
    },
  };
}

// delivery → retrieval strategy. Implements unset/reference + sentinel + egress. An unknown mode is filtered at the boundary
// by the schema (discriminatedUnion) — by the time it reaches here it's one of the three.
export function observationSourceFor(delivery: ObservationDelivery | undefined): ObservationSource {
  if (!delivery || delivery.mode === "reference") return referenceObservationSource;
  if (delivery.mode === "sentinel") return sentinelObservationSource(delivery.path);
  return egressObservationSource(delivery.sink);
}
