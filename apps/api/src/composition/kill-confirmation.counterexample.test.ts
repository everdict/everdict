import type { Backend, BackendCapacity } from "@everdict/backends";
import type { CaseResult, KillOutcome, RuntimeSpec } from "@everdict/contracts";
import { killConverged } from "@everdict/contracts";
import type { RuntimeRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { buildRuntimeAccess } from "./runtime-access.js";

// ── A KILL THAT CANNOT BE CONFIRMED IS NOT A KILL (arch-review 52, Wave 3) ──────────────────────────
//
// `killCase` in the composition root swallows the backend's rejection (`backend.kill(caseId).catch(() => {})`)
// and answers `Promise<void>` either way. So the one caller that treats a failed teardown as its own failure —
// RunService.stopRun, which wraps the kill in an UpstreamError precisely so the caller retries — can never see
// one: the arm it awaits resolves cleanly while the cluster job keeps running. Cancellation then certifies a
// teardown that did not happen, and every later reader (the run record, the batch's operation row, the
// operator's console) agrees that the compute was freed.
//
// The invariant: an unconfirmable stop surfaces. Wave 3 gives the seam an answer it can give — a rejection, or
// a `KillOutcome` that says "unknown" — and the assertion below is written to accept either, because what is
// wrong today is the third option: reporting done.

const capacity = async (): Promise<BackendCapacity> => ({ total: 1, used: 0 });
const noDispatch = async (): Promise<CaseResult> => {
  throw new Error("no dispatch in kill tests");
};

// A managed backend whose stop cannot be confirmed — the cluster API is unreachable, which is exactly when a
// cancellation most needs to be honest (the job is probably still running).
function unreachableBackend(killed: string[]): Backend {
  return {
    capacity,
    dispatch: noDispatch,
    async adopt() {
      return { status: "unknown" as const };
    },
    async kill(caseId: string) {
      killed.push(caseId);
      throw new Error("k8s api unreachable");
    },
  } as unknown as Backend;
}

const nomadSpec: RuntimeSpec = {
  kind: "nomad",
  id: "rt-a",
  version: "1.0.0",
  tags: [],
  addr: "http://nomad:4646",
  image: "reg/job-runner:1",
} as RuntimeSpec;

const registryOf = (spec: RuntimeSpec): RuntimeRegistry =>
  ({
    async get() {
      return spec;
    },
  }) as unknown as RuntimeRegistry;

// [WAVE-3 COUNTEREXAMPLE #7] RED as of 02a3e15e: `AssertionError: expected { settled: 'resolved', value: undefined }
// to not deeply equal { settled: 'resolved', value: undefined }` — runtime-access.ts killCase did
// `backend.kill(caseId).catch(() => {})`, so an unreachable cluster was reported to the caller as a completed
// teardown. UN-SKIPPED (wave 3): the seam answers with a `KillOutcome`, and this backend's rejection becomes
// `failed` rather than silence.
describe("the runtime-access seam never reports a teardown it could not confirm", () => {
  it("surfaces a backend kill that failed instead of resolving as if the compute were freed", async () => {
    // Given a run placed on a runtime whose cluster API is down
    const killed: string[] = [];
    const access = buildRuntimeAccess({
      runtimeRegistry: registryOf(nomadSpec),
      runtimeSecretsFor: async () => ({}),
      runtimeBuildBackend: () => unreachableBackend(killed),
    });

    // When the cancellation's kill arm runs
    const outcome = await access.killCase("acme", "rt-a", "c1").then(
      (value: unknown) => ({ settled: "resolved" as const, value }),
      (error: unknown) => ({ settled: "rejected" as const, error }),
    );

    // …the backend was genuinely asked (the assertion below is about the ANSWER, not about a skipped call)
    expect(killed).toEqual(["c1"]);
    // Then the seam did not answer "done". Rejecting is one honest answer and an outcome the caller can read
    // ("unknown") is the other; silently resolving with nothing is the one answer that makes a live job look
    // like a freed one.
    expect(outcome).not.toEqual({ settled: "resolved", value: undefined });
    // …and the answer it DID give says NOT CONVERGED. The line above was written before the seam had a
    // vocabulary and only rules out silence; this is the semantics the callers act on, and it is what a
    // re-swallow would break (a re-swallow that returned `stopped` still satisfies the line above).
    if (outcome.settled === "resolved") {
      const value = outcome.value as KillOutcome;
      expect(killConverged(value), `an unreachable cluster answered ${value.status}`).toBe(false);
      expect(value.reason).toBeDefined(); // …with the cluster's own words, for the operation's lastError
    }
  });
});
