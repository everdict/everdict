import type { CaseAttempt, CaseKey, CaseResult, ExecutionRevision, ScorecardRecord } from "@everdict/contracts";
import { BadRequestError, ConflictError, NotFoundError, caseKeyOf, encodeCaseKey } from "@everdict/contracts";
import {
  ScorecardBatch,
  keysRequiringReason,
  nextExecutionRevision,
  retrySummaryOf,
  summarizeScorecard,
  supersedeAttempts,
} from "@everdict/domain";
import { type ExecutionPassAuthority, executionPassAuthority } from "../ports/case-receipt-store.js";
import type { ScorecardBatchDeps } from "./scorecard-deps.js";

// How long a claim's lease runs before another caller may take the marker over. Staleness is a LEASE
// question, not an age one — a long retry behind a slow runtime legitimately outlives any fixed window.
const RETRY_PASS_LEASE_SECONDS = 15 * 60;

// The driver's per-case entry, as this pass uses it. Positional, because that is the shape the workflow
// driver already exposes and a second spelling of one call is one spelling too many.
export type RunRetryCase = (
  id: string,
  caseId: string,
  trial: number | undefined,
  authority: ExecutionPassAuthority,
) => Promise<{ settled: boolean; skipped?: boolean; displaced?: CaseAttempt["receipt"] }>;

export interface RetryCasesSupport {
  now: () => string;
  newId: () => string;
  runCase: RunRetryCase;
}

// ── RETRYING A CASE INSIDE ITS OWN SCORECARD (docs/architecture/in-place-case-retry-spec.md) ─────────
//
// The judgment axis has been repairable in place since `scoring[]`. This is the execution axis's
// equivalent, and the order of its steps IS the protocol:
//
//   1. read     — an unreadable record REFUSES; it is never "no attempts"
//   2. refuse   — a non-terminal batch, a key the batch never sealed, a decided case with no reason
//   3. CLAIM    — the pass marker is written and READ BACK before any case is dispatched (L1), and the
//                 authority is minted from what the store returned, never from what this caller built
//   4. dispatch — under that authority, which is the only thing that walks a settled record's guards
//   5. settle   — supersede the plane, append the revision, recompute, clear the marker, in ONE write
export class RetryCasesInPlace {
  constructor(
    private readonly deps: ScorecardBatchDeps,
    private readonly support: RetryCasesSupport,
  ) {}

  async run(input: {
    tenant: string;
    id: string;
    cases: readonly CaseKey[];
    reason?: string;
    submittedBy?: string;
  }): Promise<ScorecardRecord> {
    if (input.cases.length === 0)
      throw new BadRequestError("BAD_REQUEST", { scorecard: input.id }, "Name at least one case to retry.");

    // ── 1. READ ────────────────────────────────────────────────────────────────────────────────────
    // No `.catch(() => undefined)`: a store fault must not read as "no such scorecard", which would answer
    // a 404 to a caller whose batch is fine and whose database is not (protocol L2).
    const record = await this.deps.store.get(input.id);
    if (!record || record.tenant !== input.tenant)
      throw new NotFoundError("NOT_FOUND", { scorecard: input.id }, "scorecard not found.");

    // ── 2. REFUSE ──────────────────────────────────────────────────────────────────────────────────
    if (!ScorecardBatch.from(record).isTerminal())
      throw new ConflictError(
        "CONFLICT",
        { scorecard: input.id, status: record.status },
        "This batch is still running — retry a case after it settles.",
      );
    const plane = record.scorecard?.results ?? [];
    if (plane.length === 0)
      throw new BadRequestError("BAD_REQUEST", { scorecard: input.id }, "This batch has no per-case results.");

    // A key the batch never sealed is refused rather than appended. Adding a case to a sealed batch would
    // put a dataset the manifest never covered into the record, decided by a retry.
    const known = new Set(plane.map((r) => encodeCaseKey(caseKeyOf(r.caseId, r.trial))));
    const unknown = input.cases.filter((key) => !known.has(encodeCaseKey(key)));
    if (unknown.length > 0)
      throw new BadRequestError(
        "BAD_REQUEST",
        { scorecard: input.id, cases: unknown.map((k) => k.caseId).slice(0, 20) },
        "Some cases are not in this batch — a retry may not add a case to a sealed batch.",
      );

    // A case that reached a real verdict may be retried, and the pass must say why: a retry that launders a
    // failure is permitted and never silent. Refused as a whole rather than per case — a partial refusal
    // would leave the caller guessing which half ran.
    if (input.reason === undefined || input.reason.trim() === "") {
      const owed = keysRequiringReason(plane, input.cases, record.manifest?.verdictPolicy);
      if (owed.length > 0)
        throw new BadRequestError(
          "BAD_REQUEST",
          { scorecard: input.id, cases: owed.map((k) => k.caseId).slice(0, 20) },
          "These cases already reached a verdict — a retry that replaces one needs a `reason`.",
        );
    }

    // ── 3. CLAIM ───────────────────────────────────────────────────────────────────────────────────
    const live = record.executionPass ?? undefined;
    if (live && live.status === "running")
      throw new ConflictError(
        "CONFLICT",
        { scorecard: input.id, passId: live.passId, startedAt: live.startedAt },
        "A retry pass is already in flight on this scorecard — retry after it settles.",
      );
    const passId = this.support.newId();
    const targetRevision = nextExecutionRevision(record.executions);
    const claimed = await this.deps.store.update(
      input.id,
      {
        executionPass: {
          passId,
          epoch: (live?.epoch ?? 0) + 1,
          targetRevision,
          baseRevision: targetRevision - 1,
          cases: [...input.cases],
          ...(input.reason ? { reason: input.reason } : {}),
          startedAt: this.support.now(),
          ...(input.submittedBy ? { startedBy: input.submittedBy } : {}),
          status: "running",
        },
        updatedAt: this.support.now(),
      },
      undefined,
      {
        // The compare-and-swap. A rival that claimed between this caller's read and this write wins, and
        // this one is TOLD — a marker is not a lock, and read-check-write is not a claim.
        expectExecutionPassId: live?.passId ?? null,
        ...(live !== undefined ? { expectExecutionPassReclaimable: true } : {}),
        stampExecutionLeaseSeconds: RETRY_PASS_LEASE_SECONDS,
      },
    );
    if (claimed === undefined)
      throw new ConflictError(
        "CONFLICT",
        { scorecard: input.id },
        "another retry claimed this scorecard first — retry after it settles.",
      );
    // Minted from what the STORE RETURNED. A caller holding the record it read a moment ago cannot produce
    // one, which is the property the branded type stands in for.
    const authority = executionPassAuthority(claimed, passId);
    if (authority === undefined)
      throw new ConflictError(
        "CONFLICT",
        { scorecard: input.id },
        "the retry pass could not be authorized — its marker moved between the claim and the read-back.",
      );

    try {
      // ── 4. DISPATCH ──────────────────────────────────────────────────────────────────────────────
      const displacedReceipts = new Map<string, NonNullable<CaseAttempt["receipt"]>>();
      for (const key of input.cases) {
        const outcome = await this.support.runCase(input.id, key.caseId, key.trial, authority);
        if (outcome.displaced) displacedReceipts.set(encodeCaseKey(key), outcome.displaced);
      }

      // ── 5. SETTLE ────────────────────────────────────────────────────────────────────────────────
      return await this.settle(input, record, authority, targetRevision, displacedReceipts);
    } catch (err) {
      // The marker is left `failed` rather than cleared: a pass that died is addressable and re-drivable,
      // where a cleared one is indistinguishable from a pass that never ran. Best-effort by contract — a
      // store that cannot record the failure must not replace the original error with its own.
      await this.deps.store
        .update(
          input.id,
          {
            executionPass: {
              ...(claimed.executionPass as NonNullable<ScorecardRecord["executionPass"]>),
              status: "failed",
              failedAt: this.support.now(),
              failure: err instanceof Error ? err.message : String(err),
            },
          },
          undefined,
          { expectExecutionPassId: passId },
        )
        .catch(() => undefined);
      throw err;
    }
  }

  // The plane after the retry is the LEDGER's, not this process's memory: the superseding commits moved the
  // receipts, and `canonicalChildPerCase` is the one function that resolves which child a receipt names.
  // Rebuilding from what this loop happens to be holding would be the "latest row wins" re-derivation the
  // whole design refuses.
  private async settle(
    input: { tenant: string; id: string; reason?: string; submittedBy?: string },
    before: ScorecardRecord,
    authority: ExecutionPassAuthority,
    revision: number,
    displacedReceipts: Map<string, NonNullable<CaseAttempt["receipt"]>>,
  ): Promise<ScorecardRecord> {
    const runStore = this.deps.runStore;
    const receipts = this.deps.caseReceipts;
    const plane = before.scorecard?.results ?? [];
    let retried: CaseResult[] = [];
    if (runStore && receipts) {
      const children = await runStore.list(input.tenant, { scorecardId: input.id });
      const committed = await receipts.list(input.id);
      const canonical = ScorecardBatch.canonicalChildPerCase(children, committed);
      retried = [...canonical.values()]
        .map((c) => c.result)
        .filter((r): r is CaseResult => r !== undefined)
        // Only the keys this pass asked for. A canonical child that moved for any other reason is not this
        // pass's business, and claiming it would put a case on the revision that this pass never ran.
        .filter((r) => displacedReceipts.has(encodeCaseKey(caseKeyOf(r.caseId, r.trial))));
    }

    const at = this.support.now();
    const moved = supersedeAttempts({
      results: plane,
      retried,
      attempts: before.caseAttempts,
      revision,
      at,
      ...(input.submittedBy ? { by: input.submittedBy } : {}),
    });
    // The displaced RECEIPT rides its own attempt entry — the only copy of the decision the supersession
    // replaced, and the reason the receipt store hands it back rather than dropping it.
    const superseded: CaseAttempt[] = moved.superseded.map((entry) => {
      const receipt = displacedReceipts.get(encodeCaseKey(caseKeyOf(entry.caseId, entry.trial)));
      return receipt ? { ...entry, receipt } : entry;
    });
    const attempts = [...(before.caseAttempts ?? []), ...superseded];
    const executions: ExecutionRevision[] = [
      ...(before.executions ?? []),
      {
        revision,
        kind: "retry",
        cases: moved.cases,
        ...(input.reason ? { reason: input.reason } : {}),
        passId: authority.passId,
        createdAt: at,
        ...(input.submittedBy ? { createdBy: input.submittedBy } : {}),
      },
    ];

    const settled = await this.deps.store.update(
      input.id,
      {
        // The summary is recomputed from the NEW plane, or not at all. A batch with no embedded scorecard has
        // no plane to move, and a summary derived from an invented one would be a number about nothing —
        // rule `suite`: losing historical context is a reason to refuse, never to continue with less.
        ...(before.scorecard
          ? {
              scorecard: { ...before.scorecard, results: moved.results },
              summary: summarizeScorecard({ ...before.scorecard, results: moved.results }),
            }
          : {}),
        caseAttempts: attempts,
        executions,
        retrySummary: retrySummaryOf(attempts),
        executionPass: null, // the revision boundary: cleared in the same write that appends the revision
        updatedAt: at,
      },
      undefined,
      // …and only while this pass still owns the marker. A pass whose lease expired and was taken over must
      // not be able to settle over its successor's work.
      { expectExecutionPassId: authority.passId },
    );
    if (settled === undefined)
      throw new ConflictError(
        "CONFLICT",
        { scorecard: input.id, passId: authority.passId },
        "this retry pass no longer owns the scorecard — its marker moved before it could settle.",
      );
    return settled;
  }
}
