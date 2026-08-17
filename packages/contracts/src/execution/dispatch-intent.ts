import { z } from "zod";
import { RuntimeWorkRefSchema } from "./runtime-work-ref.js";

// ── THE DECISION TO CREATE WORK, TAKEN BEFORE THE WORK EXISTS (arch-review 53, Wave A) ───────────────
//
// `RuntimeWorkRef` says WHERE a piece of compute is running. It was minted, until now, at the moment the
// compute started running — the backend applied the K8s Job or submitted the Nomad job and THEN handed the
// handle back. Everything about that ordering is wrong for a control plane that can die:
//
//     applyJob(manifest)        ← the cluster now holds a running Job
//     ── process dies here ──   ← the only record of its exact name was a local variable
//     onWork(handle)            ← never runs
//
// What survives is a Job burning money that nothing can address. Cancellation falls back to the case-id
// kill (which reaches other runs' jobs), and boot recovery cannot adopt it at all, because adoption needs a
// name it does not have. The window is small and it is hit constantly, because a deploy, an OOM kill and a
// node drain all land in exactly that window for whichever dispatches are in flight.
//
// A `DispatchIntent` inverts it. The external id is COMPUTABLE without calling anyone — `k8sJobName(job)`
// and the Nomad `jobId` are built from the job locally — so the control plane can decide the name, make
// that decision durable, and only then ask the cluster to create precisely the object it already named:
//
//     reserve(job)              ← pure. decides the exact name. no external effect.
//     commit the intent         ← durable. now the name outlives this process.
//     submit(work, job)         ← creates exactly the object the intent names.
//
// A crash anywhere in that sequence leaves an intent whose object may or may not exist, and BOTH answers are
// reachable by asking about the exact name: the teardown probes it and gets `absent` (nothing was created)
// or stops it (it was). That is the whole point — an intent is a question the system can always answer,
// where a lost handle was a question it could not even ask.
//
// STORAGE: the physical-attempt ledger row is the intent's durable home (`runtime_work`, mig 0185) rather
// than a table of its own. The row already exists before dispatch (`openPhysicalAttempt`), it is already
// keyed by the attempt this work belongs to, and it is already what teardown and recovery read. A second
// ledger would be a second thing to reconcile, holding the same fact.
export const DISPATCH_INTENT_STATES = ["reserved", "submitted", "settled"] as const;
export const DispatchIntentStateSchema = z.enum(DISPATCH_INTENT_STATES);
export type DispatchIntentState = z.infer<typeof DispatchIntentStateSchema>;

export const DispatchIntentSchema = z.object({
  // The exact coordinate the backend will create, decided before it is created.
  work: RuntimeWorkRefSchema,
  // `reserved` — the name is durable and the external object may or may not exist yet. A teardown or a
  // recovery reading this state must PROBE rather than assume either way; an ambiguous submit (the cluster
  // accepted the request and the response never arrived) is exactly this state.
  // `submitted` — the submit call returned successfully, so the object existed at least once.
  // `settled` — the dispatch finished and the object was reaped; nothing is owed.
  state: DispatchIntentStateSchema,
  at: z.string(),
});
export type DispatchIntent = z.infer<typeof DispatchIntentSchema>;
