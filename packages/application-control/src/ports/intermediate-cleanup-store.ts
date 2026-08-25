import { UpstreamError } from "@everdict/contracts";
import type { ExecutionId } from "@everdict/contracts";

// ── THE DEBT IS RECORDED WHERE THE BYTES ARE WRITTEN (arch-review 66 P1-high · P1-security) ──────────
//
// A two-phase case stages two intermediate objects, and until now the coordinate for deleting them rode the
// CASE RESULT (`CaseResult.intermediates`). Three things were wrong with that, and only the first was the one
// it was added to fix:
//
//   IDENTITY   the normal path attached it and the recovery path did not, so the same agent bytes and the
//              same verdict produced different `caseResultDigest` AND `caseObservationDigest` depending on
//              whether a process had crashed. An observation digest exists to say "the same thing was
//              observed"; lifecycle metadata inside it makes one measurement read as two experiments.
//   AUTHORITY  `submit_job_result` parses a self-hosted runner's JSON with that same schema, so a
//              workspace-controlled runner could name the objects the settlement would delete. Same tenant,
//              same execution — and a sibling attempt's staged half is inside that boundary.
//   LIFECYCLE  the delete ran inline after the commit, in the same process, best-effort. That covers the one
//              ending that needed no help. A transient refusal rethrown for retry, a refused post-stage CAS,
//              the batch recovery's success path, a crash between the commit and the delete, and a delete
//              that simply failed all leaked.
//
// So the debt lives HERE: written by the pass that stages the bytes, before anything can fail, and
// discharged by the canonical settlement in its own transaction. Inline deletion stays as a latency
// optimization whose failure costs nothing, which is the only shape in which "best-effort" is honest.
//
// Keyed by EXECUTION rather than by result document: every ending of one execution owes the same objects,
// and an execution is the coordinate all of them can name (rule `protocol`, the every-ending law).

// One staged object. The digest is what the READ verifies the bytes against — an address that encodes
// content is not content authentication until somebody re-derives it (arch-review 66 P1-provenance).
export interface ArtifactRef {
  key: string;
  digest?: string;
  // Set by `confirm` once the object store returned. A ref that is owed but not written is a row pointing at
  // bytes that may not exist — a sweep deleting it and completing the debt would orphan the put still in
  // flight behind it.
  written?: boolean;
}

// ── RETENTION AND DELETION ARE TWO STATES, NOT ONE (arch-review 67 P1-high) ─────────────────────────
//
// The first version wrote the row as `owed` the moment the bytes were staged — and `owed` is the state that
// means DELETE THIS. So from the agent half's birth until the case settled, the ledger said "delete me"
// about the artifact a crash would need. Nothing deleted it only because no reconciler was wired, and
// wiring one is the entire purpose of the row.
//
// `retained` is where a debt starts: the object exists (or is about to) and a recovery may still need it.
// Only the CANONICAL SETTLEMENT — the write that makes the outcome the record's answer — releases it.
export type IntermediateLifecycle =
  // Staged, and the case may still need it. A reconciler must not touch these.
  | "retained"
  // The settlement took its answer; the bytes are now garbage and a sweep may remove them.
  | "gc_owed"
  // A sweep tried and could not converge. Backoff, never terminal (rule `protocol` L5).
  | "retry_wait"
  | "completed";

export interface IntermediateCleanupDebt {
  operationId: string;
  tenant: string;
  executionId: ExecutionId;
  refs: ArtifactRef[];
  state: IntermediateLifecycle;
  attempts: number;
  nextAttemptAt?: string;
  lastError?: string;
}

export interface IntermediateCleanupStore {
  // Record what this execution now owes. Called BEFORE the external object is reclaimed, so a crash between
  // the two leaves a debt a reconciler can drain rather than bytes nobody will look for.
  //
  // Returns the row it wrote, never `void` — a decision rests on this (rule `protocol` L1), and the caller
  // must be able to tell "recorded" from "the store was down".
  // Recorded BEFORE the put, in state `retained`: a crash between the two must leave a row a sweep can find,
  // and a row that says "keep this" is the safe thing to find.
  owe(input: { tenant: string; executionId: ExecutionId; refs: ArtifactRef[] }): Promise<IntermediateCleanupDebt>;
  // …and confirmed AFTER it, so a sweep can tell an object that exists from one whose write never landed.
  // Without this the owe-before-put ordering lets a reconciler delete an absent key, mark the debt paid, and
  // orphan the put that follows it.
  confirm(input: { tenant: string; executionId: ExecutionId; keys: string[] }): Promise<void>;
  // THE SETTLEMENT'S RELEASE. Until this, the artifacts are retained and no sweep may remove them. Returns
  // what became collectable, so the caller can delete inline as a latency optimization.
  //
  // ── …AND THE ROW'S OWN NAME, BECAUSE THE CALLER WAS RE-DERIVING IT (arch-review 69 P2) ────────────
  //
  // This answered `ArtifactRef[]`, so `dischargeIntermediates` had to invent an operation id to defer
  // against — and it invented `gc-${executionId}` while the Postgres adapter mints
  // `gc/${tenant}/${executionId}`. Against a real database the deferral therefore matched NO ROW: the debt
  // stayed `gc_owed`, attempts and lastError never moved, no backoff applied, and the reconciler re-attempted
  // the same failing delete every tick with nothing recording why. In-memory the two spellings agreed, which
  // is why every unit test was green (rule `testing`: a guard the in-memory twin does not have).
  //
  // Rule `protocol` L3 — a predicate written twice has already diverged. The identity now comes back from
  // the row that was released, so there is no second spelling to keep in step.
  releaseForGc(tenant: string, executionId: ExecutionId): Promise<ReleasedCleanup | undefined>;
  // The reconciler's discharge: mark a released debt paid.
  complete(tenant: string, executionId: ExecutionId): Promise<boolean>;
  // The reconciler's worklist — RELEASED debts only, oldest first. A `retained` row is not work.
  due(now: string, limit: number): Promise<IntermediateCleanupDebt[]>;
  // A deletion that did not converge. Backoff, never a terminal: "we could not find out" is an escalation
  // field (rule `protocol` L5), so the row stays owed and the attempt count is what an operator reads.
  deferred(operationId: string, error: string, nextAttemptAt: string): Promise<void>;
}

// What a release actually freed: the row's own identity, and what it names. `undefined` is "there was no
// debt to release" — a case that staged nothing, or one already swept — which is different from a debt that
// released zero refs and is why this is a union rather than an empty array.
export interface ReleasedCleanup {
  operationId: string;
  refs: ArtifactRef[];
}

// In-process store for dev/test, the same posture as the other InMemory ports.
export class InMemoryIntermediateCleanupStore implements IntermediateCleanupStore {
  private readonly debts = new Map<string, IntermediateCleanupDebt>();

  // ⚠️ THE SEPARATOR IS WRITTEN AS AN ESCAPE, not as a literal byte (rule `typescript`). A raw NUL makes
  // git treat the source as binary — no diff, no `git grep`, and every scanner in this repo goes blind to the
  // file. It reached this file the way it has reached seven others: invisibly.
  private key(tenant: string, executionId: string): string {
    return `${tenant}\u0000${executionId}`;
  }

  async owe(input: {
    tenant: string;
    executionId: ExecutionId;
    refs: ArtifactRef[];
  }): Promise<IntermediateCleanupDebt> {
    const k = this.key(input.tenant, input.executionId);
    const prior = this.debts.get(k);
    // ACCUMULATED, not replaced: the two halves are staged at different moments and the second call must not
    // forget the first. Deduplicated by key, because a retry re-staging the same object owes it once.
    const refs = [...(prior?.refs ?? [])];
    for (const ref of input.refs) if (!refs.some((r) => r.key === ref.key)) refs.push(ref);
    const debt: IntermediateCleanupDebt = {
      operationId: prior?.operationId ?? `gc-${input.executionId}`,
      tenant: input.tenant,
      executionId: input.executionId,
      refs,
      // A re-stage after a completed sweep re-opens the debt as RETAINED: new bytes exist and the case that
      // wrote them is not finished, whatever happened to the older ones.
      state: "retained",
      attempts: prior?.attempts ?? 0,
    };
    this.debts.set(k, debt);
    return debt;
  }

  // Everything this store holds, whatever its state. The in-memory twin's own affordance — like `keys()` on
  // the artifact doubles — so a test can assert what is RETAINED without the port growing a read nothing in
  // production calls (rule `api-layer`: no hypothetical surface).
  snapshot(): IntermediateCleanupDebt[] {
    return [...this.debts.values()];
  }

  async confirm(input: { tenant: string; executionId: ExecutionId; keys: string[] }): Promise<void> {
    const k = this.key(input.tenant, input.executionId);
    const debt = this.debts.get(k);
    if (!debt) return;
    this.debts.set(k, {
      ...debt,
      refs: debt.refs.map((r) => (input.keys.includes(r.key) ? { ...r, written: true } : r)),
    });
  }

  async releaseForGc(tenant: string, executionId: ExecutionId): Promise<ReleasedCleanup | undefined> {
    const k = this.key(tenant, executionId);
    const debt = this.debts.get(k);
    if (!debt || debt.state === "completed") return undefined;
    this.debts.set(k, { ...debt, state: "gc_owed" });
    return { operationId: debt.operationId, refs: debt.refs };
  }

  async complete(tenant: string, executionId: ExecutionId): Promise<boolean> {
    const k = this.key(tenant, executionId);
    const debt = this.debts.get(k);
    if (!debt || debt.state === "completed" || debt.state === "retained") return false;
    this.debts.set(k, { ...debt, state: "completed" });
    return true;
  }

  async due(now: string, limit: number): Promise<IntermediateCleanupDebt[]> {
    // RELEASED ONLY. A `retained` row is an artifact the case may still need, and returning it here is what
    // would turn this ledger from a cleanup into a way of destroying the recovery it exists to enable.
    return [...this.debts.values()]
      .filter(
        (d) =>
          (d.state === "gc_owed" || d.state === "retry_wait") &&
          (d.nextAttemptAt === undefined || d.nextAttemptAt <= now),
      )
      .slice(0, limit);
  }

  async deferred(operationId: string, error: string, nextAttemptAt: string): Promise<void> {
    for (const [k, d] of this.debts)
      if (d.operationId === operationId)
        // …INCLUDING THE STATE. This set the counters and left `state` alone, so a deferred debt still read
        // as `gc_owed` — indistinguishable from one no sweep had ever tried. The Pg adapter sets it, and an
        // adapter pair that disagrees is a protocol only one of them has (arch-review 68).
        this.debts.set(k, { ...d, state: "retry_wait", attempts: d.attempts + 1, lastError: error, nextAttemptAt });
  }
}

// WHICH store owns a staged key. The two prefixes are minted by `agentHalfKey`/`verifierVerdictKey`, and
// routing on them keeps the discharge from deleting into the wrong bucket or double-counting a success.
//
// ⚠️ IT MUST NOT SWALLOW. `discardAgentHalf` exists to swallow — a best-effort delete beside a merge — and
// wiring the discharge through it made a failed deletion indistinguishable from a converged one, so the debt
// was marked paid over objects still sitting in the bucket. That is the exact leak this ledger exists to
// close, reintroduced one call inside it (arch-review 66 P1-high).
export function removeStagedObject(stores: {
  agentHalves?: { remove(key: string): Promise<void> };
  verdicts?: { remove(key: string): Promise<void> };
}): (key: string) => Promise<void> {
  return async (key: string) => {
    const store = key.startsWith("verifier-verdict/") ? stores.verdicts : stores.agentHalves;
    // No store for this prefix: nothing this deployment can delete, and nothing it should keep owing either.
    if (!store) return;
    await store.remove(key);
  };
}

// The settlement's half, in one place so both lanes spend it the same way. Reads what the execution owes,
// deletes it best-effort, and marks the debt paid ONLY when every delete converged — an unconfirmed delete
// leaves the row owed for the reconciler, which is the difference between a cleanup and a lifecycle.
export async function dischargeIntermediates(
  deps: {
    cleanup?: IntermediateCleanupStore;
    remove: (key: string) => Promise<void>;
  },
  tenant: string,
  executionId: ExecutionId,
): Promise<{ deleted: number; owed: number }> {
  if (!deps.cleanup) return { deleted: 0, owed: 0 };
  // RELEASE, not read: this is the canonical settlement, and until it runs the artifacts are retained.
  const released = await deps.cleanup.releaseForGc(tenant, executionId);
  if (released === undefined || released.refs.length === 0) return { deleted: 0, owed: 0 };
  const refs = released.refs;
  let deleted = 0;
  const failures: string[] = [];
  for (const ref of refs) {
    try {
      await deps.remove(ref.key);
      deleted += 1;
    } catch (err) {
      failures.push(`${ref.key}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failures.length > 0) {
    // Owed still. The reconciler retries; the settlement is not failed for it, because the case's outcome is
    // not what a storage hiccup should decide.
    // The identity the ROW has, not one this caller spells for itself (arch-review 69 P2). The two spellings
    // disagreed for two waves and the Postgres deferral matched nothing.
    await deps.cleanup
      .deferred(released.operationId, failures.join("; "), new Date(Date.now() + 60_000).toISOString())
      .catch(() => undefined);
    return { deleted, owed: failures.length };
  }
  await deps.cleanup.complete(tenant, executionId);
  return { deleted, owed: 0 };
}

// A staging call that could not record its debt must not proceed to hand the bytes to a lane that will
// reclaim the container: the object would exist with nothing pointing at it. Same shape as the reservation's
// refusal — a caller that cannot record where the work is does not get the work.
export function requireOwed(recorded: IntermediateCleanupDebt | undefined, key: string): void {
  if (recorded !== undefined) return;
  throw new UpstreamError(
    "UPSTREAM_ERROR",
    { key },
    `the cleanup debt for ${key} could not be recorded, so these bytes would be written with nothing owning their removal`,
  );
}
