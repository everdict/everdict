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
}

export interface IntermediateCleanupDebt {
  operationId: string;
  tenant: string;
  executionId: ExecutionId;
  refs: ArtifactRef[];
  state: "owed" | "completed";
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
  owe(input: { tenant: string; executionId: ExecutionId; refs: ArtifactRef[] }): Promise<IntermediateCleanupDebt>;
  // What this execution owes right now — the settlement's worklist, read inside its own transaction.
  owed(tenant: string, executionId: ExecutionId): Promise<ArtifactRef[]>;
  // The settlement's discharge: mark the debt paid. Returns false when there was nothing owed (an execution
  // that staged nothing) so a caller can tell that from a store that refused.
  complete(tenant: string, executionId: ExecutionId): Promise<boolean>;
  // The reconciler's worklist — debts whose deletion has not been confirmed, oldest first.
  due(now: string, limit: number): Promise<IntermediateCleanupDebt[]>;
  // A deletion that did not converge. Backoff, never a terminal: "we could not find out" is an escalation
  // field (rule `protocol` L5), so the row stays owed and the attempt count is what an operator reads.
  deferred(operationId: string, error: string, nextAttemptAt: string): Promise<void>;
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
      // A re-stage after a completed sweep re-opens the debt: new bytes are owed even if older ones were paid.
      state: "owed",
      attempts: prior?.attempts ?? 0,
    };
    this.debts.set(k, debt);
    return debt;
  }

  async owed(tenant: string, executionId: ExecutionId): Promise<ArtifactRef[]> {
    const debt = this.debts.get(this.key(tenant, executionId));
    return debt?.state === "owed" ? debt.refs : [];
  }

  async complete(tenant: string, executionId: ExecutionId): Promise<boolean> {
    const k = this.key(tenant, executionId);
    const debt = this.debts.get(k);
    if (!debt || debt.state === "completed") return false;
    this.debts.set(k, { ...debt, state: "completed" });
    return true;
  }

  async due(now: string, limit: number): Promise<IntermediateCleanupDebt[]> {
    return [...this.debts.values()]
      .filter((d) => d.state === "owed" && (d.nextAttemptAt === undefined || d.nextAttemptAt <= now))
      .slice(0, limit);
  }

  async deferred(operationId: string, error: string, nextAttemptAt: string): Promise<void> {
    for (const [k, d] of this.debts)
      if (d.operationId === operationId)
        this.debts.set(k, { ...d, attempts: d.attempts + 1, lastError: error, nextAttemptAt });
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
  const refs = await deps.cleanup.owed(tenant, executionId);
  if (refs.length === 0) return { deleted: 0, owed: 0 };
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
    await deps.cleanup
      .deferred(`gc-${executionId}`, failures.join("; "), new Date(Date.now() + 60_000).toISOString())
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
