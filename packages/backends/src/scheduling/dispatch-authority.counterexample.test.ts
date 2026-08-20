import type { CaseJob, CaseResult, PersistedWorkIntent, RuntimeWorkRef } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { Backend } from "../backend.js";
import { BackendRegistry } from "../placement/registry.js";
import { Scheduler } from "./scheduler.js";

// ── AN OPTIONAL HOOK IN A FORWARDING CHAIN IS A HOOK THAT WILL BE DROPPED (arch-review 58, W2) ───────
//
// The dispatch options are forwarded through the Scheduler by an explicit allowlist — one `...(entry.x ? {x} :
// {})` line per hook — and the allowlist's own comment says what it is:
//
//     "…and onAttempt, for the same reason: this whitelist is the ONE place a hook can silently die"
//
// `onActivate` then died in exactly that whitelist. It was added to the options type and to both managed
// backends, a producer was wired in the run service, and the Scheduler — which every SaaS dispatch goes
// through — never carried it. So the activation transition that arch-review 57 built, and that arch-review 58
// gave a producer, still never runs in production. `requireActivation` returns immediately when the hook is
// absent, so nothing anywhere reports the loss.
//
// Adding a fifth line to the allowlist would fix this instance and leave the shape that produced it. The
// shape is the defect: two halves of ONE protocol — reserve the work, then re-present that reservation where
// the object is born — as two independent optional fields, so every forwarder, every composition and every
// wrapper can carry one and drop the other. Half a protocol type checks.
//
// So they become one capability. `DispatchOptions.authority` is a single object with both operations, and a
// caller either holds the authority to place managed work or does not. A forwarder carries one field. Half is
// unrepresentable.
//
// Seen RED before the merge, observed:
//   the scheduler forwarded the reservation and dropped the activation: expected undefined to be defined

const job = (): CaseJob =>
  ({
    tenant: "acme",
    runId: "evd-run-r1",
    harness: { id: "h", version: "1" },
    evalCase: { id: "c1", task: "t", env: { kind: "prompt" }, graders: [], timeoutSec: 60 },
  }) as unknown as CaseJob;

const RESULT = {
  caseId: "c1",
  harness: "h@1",
  trace: [],
  snapshot: { kind: "prompt", output: "" },
  scores: [],
} as unknown as CaseResult;

// A backend that records the options it was handed and nothing else.
function recordingBackend(): { backend: Backend; seen: Array<Record<string, unknown>> } {
  const seen: Array<Record<string, unknown>> = [];
  return {
    seen,
    backend: {
      id: "rec",
      async dispatch(_job: CaseJob, opts?: Record<string, unknown>) {
        seen.push(opts ?? {});
        return RESULT;
      },
      async capacity() {
        return { total: 1, used: 0 };
      },
    } as unknown as Backend,
  };
}

const AUTHORITY = {
  reserve: async (work: RuntimeWorkRef): Promise<PersistedWorkIntent> => ({
    attemptId: "a1",
    work,
    persistedAt: new Date(0).toISOString(),
  }),
  activate: async () => ({ kind: "activate" }) as const,
};

describe("[R58 W2 COUNTEREXAMPLE] the authority to place managed work survives the scheduler", () => {
  it("forwards the WHOLE authority, not the half it happens to list", async () => {
    const { backend, seen } = recordingBackend();
    const scheduler = new Scheduler(new BackendRegistry().register("rec", backend));

    await scheduler.dispatch(job(), { authority: AUTHORITY });

    expect(seen, "the scheduler dispatched nothing").toHaveLength(1);
    const forwarded = seen[0]?.authority as typeof AUTHORITY | undefined;
    expect(forwarded, "the scheduler forwarded the reservation and dropped the activation").toBeDefined();
    // Both halves, because the whole point is that they cannot travel apart.
    expect(typeof forwarded?.reserve).toBe("function");
    expect(typeof forwarded?.activate).toBe("function");
  });

  it("carries nothing when the caller holds no authority", async () => {
    // A ledger-less lane (the CLI, in-process dev) legitimately has no reservation to make. The managed
    // backends refuse such a job when it names a run; the scheduler's job is only not to invent one.
    const { backend, seen } = recordingBackend();
    const scheduler = new Scheduler(new BackendRegistry().register("rec", backend));
    await scheduler.dispatch(job());
    expect(seen[0]?.authority).toBeUndefined();
  });
});
