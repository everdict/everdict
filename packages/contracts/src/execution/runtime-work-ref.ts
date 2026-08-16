import { z } from "zod";

// ── THE HANDLE THAT NAMES ONE PHYSICAL PIECE OF RUNTIME WORK (arch-review 52, Wave 2) ────────────────
//
// A placement backend used to be addressed for CONTROL — stop it, adopt it, read its log — by the case id.
// A case id is not an execution. The same case runs concurrently under two runs (a re-evaluation beside a
// scheduled batch, a shadow beside its baseline, a retry beside the attempt it is replacing), in two
// tenants' namespaces, and on K8s under two DIFFERENT case ids that truncate to one label value. Every one
// of those is a live job somebody else owns, and the case-id control paths reached all of them: the K8s kill
// deleted every job carrying `everdict.dev/case=<slug>`, and the Nomad kill listed
// `prefix=everdict-<caseId>-&namespace=*` and deregistered whatever came back. One run's cancellation
// stopped another run's compute, and the batch that owned it read an infra failure it never caused —
// silently, because kill is best-effort and returns void.
//
// `RuntimeWorkRef` is the exact coordinate instead: WHICH external object, in WHICH namespace, placed for
// WHICH run of WHICH tenant. It is minted by the backend at the moment it creates the external work
// (`DispatchOptions.onWork`), persisted on the physical-attempt ledger row so it survives the process that
// dispatched it, and read back by teardown — so a stop is scoped to the work it was issued for.
//
// SEMANTIC identity (`CaseKey`, `AttemptRef`) says WHAT ran; this says WHERE it is running. They are not
// interchangeable, and the whole defect class this type exists to close came from spending one as the other.
export const RuntimeWorkRefSchema = z.object({
  // The trust zone the work was placed for. Present on every destructive selector: a cross-tenant stop is the
  // same defect as a cross-tenant read, and the tenant label already rides every job we submit.
  tenant: z.string().min(1),
  // The runtime (`RuntimeSpec` id, or the registered backend key) the work was placed on, when the layer that
  // routed the job knew it. Absent on a job dispatched straight at a statically-registered backend — the
  // handle stays addressable without it (the external id is exact), this just says where to look first.
  runtimeId: z.string().optional(),
  // The EXECUTION this work belongs to — `CaseJob.runId` (`evd-run-<id>` / `evd-<batchId>-<caseId>[-t<n>]`).
  // The coordinate that makes a case id addressable again: two runs of one case are two runIds, and this is
  // the one a stop is issued for.
  runId: z.string().min(1),
  // The physical attempt this work IS, when the dispatching lane opened a ledger row for it (`AttemptRef.
  // attemptId`). Optional because the handle is minted inside the backend, which is below the ledger: the
  // stamp joins the two afterwards.
  attemptId: z.string().optional(),
  // The orchestrator's OWN name for the object — a K8s Job name, a Nomad job ID. Exact and unique per
  // dispatch: this is what makes the control call address one execution instead of a prefix or a label.
  externalJobId: z.string().min(1),
  // The namespace the work was placed in. Absent means "the runtime's default"; it never means "search them
  // all" — the sweep across namespaces is precisely the defect this handle replaces.
  namespace: z.string().optional(),
});
export type RuntimeWorkRef = z.infer<typeof RuntimeWorkRefSchema>;
