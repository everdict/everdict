import type { AdmissionLedger } from "@everdict/application-control";
import type { CaseJob, CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { Backend } from "../backend.js";
import { BackendRegistry } from "../placement/registry.js";
import { Scheduler } from "./scheduler.js";

// Trust suite (docs/trust-certification.md) — TRUST-29.
//
// A CANCELLATION RACING PERMIT ACQUISITION NEVER DISPATCHES AND NEVER STRANDS A PERMIT. The window is the
// admission await inside pump(): an abort landing there removes and rejects the entry through onAbort while
// the ledger claim may still commit. Queue removal is the dispatch COMMIT POINT — a pump that ignored its
// answer dispatched the cancelled entry anyway (saved only by every backend refusing pre-aborted signals, a
// convention carrying an invariant) and re-held a permit the abort had released. Certified over the real
// Scheduler + FairQueue, with only the ledger's timing controlled — stubbing the queue would re-implement
// the very commit point under test.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const job = (id: string): CaseJob => ({
  harness: { id: "scripted", version: "0" },
  tenant: "acme",
  evalCase: { id, env: { kind: "repo", source: { files: {} } }, task: "t", graders: [], timeoutSec: 1, tags: [] },
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

class RecordingBackend implements Backend {
  readonly id = "a";
  readonly dispatched: string[] = [];
  async capacity() {
    return { total: 100, used: 0 };
  }
  async dispatch(j: CaseJob): Promise<CaseResult> {
    this.dispatched.push(j.evalCase.id);
    return {
      caseId: j.evalCase.id,
      harness: "scripted@0",
      trace: [],
      snapshot: { kind: "repo", diff: "", changedFiles: [], headSha: "h" },
      scores: [],
    };
  }
}

describeTrust("TRUST-29 — cancellation racing the permit claim", () => {
  it("the aborted entry never dispatches and the late-committed permit is returned", async () => {
    const permits = new Map<string, string>();
    let releaseGate: (() => void) | undefined;
    const ledger: AdmissionLedger = {
      inFlightByTenant: async () => ({}),
      tryAdmit: async (tenant, permitId) => {
        await new Promise<void>((r) => {
          releaseGate = r;
        });
        permits.set(permitId, tenant);
        return true;
      },
      releaseAdmission: async (permitId) => {
        permits.delete(permitId);
      },
    };
    const backend = new RecordingBackend();
    const sched = new Scheduler(new BackendRegistry().register("a", backend), { tenantQuota: () => 3, ledger });
    const controller = new AbortController();
    const p = sched.dispatch(job("x"), { signal: controller.signal });
    await flush(); // pump parks on the gated claim
    controller.abort(); // the entry leaves the queue through onAbort while the claim is in flight
    await expect(p).rejects.toMatchObject({ code: "CANCELLED" });
    releaseGate?.(); // the claim commits — too late to dispatch
    await flush();
    await flush();
    expect(backend.dispatched).toHaveLength(0); // never reached compute
    expect(permits.size).toBe(0); // the late permit was returned, not held and renewed
  });
});
