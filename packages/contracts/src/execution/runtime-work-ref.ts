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
  // ── WHICH PROTOCOL READS THIS WORK'S ANSWER (arch-review 59 P1) ──────────────────────────────────
  //
  // A verifier's container prints a DIFFERENT document than a case's — its own sentinel, its own schema,
  // deliberately unreadable as the other (arch-review 58). Adoption did not know that. Boot recovery
  // enumerates a run's handles and adopts each with the case parser, and a standalone run's verifier row
  // carries the same `executionId`, so its handle is in that list: the case parser finds no sentinel, throws,
  // and the whole run answers `retry_later` — forever, escalating after five attempts, while its agent's
  // compute sat perfectly adoptable one handle away.
  //
  // Present ONLY on a verifier's handle, and it carries the identity the answer must match, because
  // `parseVerifierResult` requires it: a verdict adopted after a restart is exactly as much this case's as
  // one adopted in-line, and the coordinates cannot be re-derived at the recovery site without becoming the
  // downstream re-derivation rule `protocol` L3 forbids. It rides the HANDLE rather than a new ledger column
  // because the handle is already the persisted coordinate (`runtime_work` jsonb) and is already what a
  // control call is addressed by — one object, so the two halves cannot come apart in storage.
  verifier: z
    .object({
      planDigest: z.string().min(1),
      workspaceDigest: z.string().min(1),
      caseId: z.string().min(1),
    })
    .optional(),
});
export type RuntimeWorkRef = z.infer<typeof RuntimeWorkRefSchema>;

// ── THE PROOF THAT THE HANDLE IS DURABLE (arch-review 54, Phase 1) ───────────────────────────────────
//
// A `RuntimeWorkRef` is a NAME. Computing one costs nothing and proves nothing — it is a string the backend
// derived from the job. Wave A made the backend report that name BEFORE creating the external object, which
// fixed the order and left the question the order exists to answer: was it written down?
//
// It was not, and could not be told apart from having been. The reporting hook returned early when the
// dispatching lane held no attempt id (`if (!attempts || work.attemptId === undefined) return;`), the ledger
// write was `Promise<void>` over an UPDATE with no affected-row check, and both of those RESOLVE. So the
// backend's `await options.onReserved(work)` succeeded in exactly the situation where nothing had been
// recorded, and it went on to create a cluster object that no teardown, recovery or cancellation could ever
// name.
//
// `PersistedWorkIntent` is the store's ANSWER: it exists only if a row was actually updated, it carries the
// attempt it was written against, and the reserving hook returns it. A backend that has one may submit; a
// backend that does not must not, because "the caller could not record where this work will be" and "the
// caller must not get this work" are the same sentence (rule `protocol` L1).
//
// It is deliberately not a boolean. A boolean beside an optional value is the shape this codebase has now
// watched a caller half-consume twice — the value gets read and the flag does not.
export const PersistedWorkIntentSchema = z.object({
  // The ledger row the handle was written onto. Present by construction: a reservation with no attempt has
  // nothing to prove, which is precisely the state that must refuse rather than resolve.
  attemptId: z.string().min(1),
  // The handle as PERSISTED — read back from the write rather than echoed from the argument, so a store that
  // normalises or rejects part of it cannot leave the caller believing something else was stored.
  work: RuntimeWorkRefSchema,
  // When the row was written. The audit answer to "did this exist before the cluster object did".
  persistedAt: z.string().min(1),
});
export type PersistedWorkIntent = z.infer<typeof PersistedWorkIntentSchema>;
