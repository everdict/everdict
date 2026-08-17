import type {
  CaseResult,
  PublicationOperation,
  PublicationPlan,
  ScorecardExport,
  ScorecardRecord,
} from "@everdict/contracts";
import { publicationOperationId } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import type { ArtifactStore } from "../ports/artifact-store.js";
import type { PublicationOperationStore } from "../ports/publication-operation-store.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import type { AnalysisBundle, AnalysisOffload } from "./scorecard-observability.js";
import { analysisArtifactKey } from "./scorecard-observability.js";

// ── PREPARED BYTES MAY PRECEDE COMMIT. PUBLICATION MAY NOT (arch-review 52, Wave 4) ─────────────────
//
// Both batch drivers and the ingest path used to write the MUTABLE current-analysis alias and export to the
// tenant's observability platform, and only THEN attempt the terminal settle. Every fence in those files
// held; the effects simply ran on the wrong side of one. A finalizer that a cancel beat to the record still
// overwrote `analyses/<id>.json` with its own bundle and still created traces in someone else's system —
// neither of which any later CAS result can take back.
//
// This module is the seam that fixes the ORDER rather than adding another check:
//
//   · `planPublication` builds what the settlement OWES, from bytes already staged under a content-addressed
//     key. The plan rides the terminal patch, so it is persisted by the same store update that decides
//     whether this attempt won — a settlement that did not commit leaves no plan behind.
//   · `drainPublication` performs the owed effects and records the receipt. It is called INLINE by the
//     winner (which already holds the results) and by the reconciler for a plan whose process died between
//     the commit and the drain. Both go through the `expectPublicationState` fence, so the receipt is
//     written exactly once.
//
// The alias promotion is idempotent by content (the same bytes under the same key). The export is
// at-least-once against the sink under a crash between the call and the receipt write — the same class of
// window every outbox has, and a strict improvement on the defect it replaces, which was an export by a
// process whose settlement never committed at all.

// What a settlement owes, and everything the drain needs to owe it. `staged` is the analysis bundle's
// content-addressed pass key (`stageAnalysis`); when it is absent nothing is promoted, because there is no
// immutable object to promote.
export interface PublicationPlanInput {
  scorecardId: string;
  bundle: AnalysisBundle;
  staged: AnalysisOffload;
  passId: string;
  // Absent = this deployment exports nothing (no sink wired), so the plan owes no export.
  exports: boolean;
  results: CaseResult[];
  sink?: string;
  judgeModels?: Record<string, string>;
  // Pull-ingest only: the coordinates that make the export ATTACH to the tenant's original traces instead of
  // creating duplicates of them.
  attach?: { sourceKind: string; externalIdByCase: Record<string, string> };
  now: string;
}

// `undefined` when the settlement owes NOTHING outward — no artifact store to promote an alias into, no sink
// wired, or a stage that failed. A plan is a debt, and recording a debt of zero would put every batch of a
// storeless install on the reconciler's sweep forever to publish nothing.
// ── ONE SETTLEMENT'S OWED EFFECTS, AS AN OPERATION (arch-review 53, Wave C) ────────────────────────
//
// The same computation `planPublication` made, producing a row with an IDENTITY instead of a value for one
// mutable field. `scoringRevision` is which ledger entry this settle appended; together with the pass id it
// names the decision, and `publicationOperationId` turns that into the id a publisher claims by.
export function planPublicationOperation(
  input: PublicationPlanInput & { scoringRevision: number },
): PublicationOperation | undefined {
  const plan = planPublication(input);
  if (!plan) return undefined;
  const settlement = {
    scorecardId: input.scorecardId,
    scoringRevision: input.scoringRevision,
    passId: input.passId,
  };
  return {
    id: publicationOperationId(settlement),
    settlement,
    state: "pending",
    effects: [
      ...(plan.artifacts ?? []).map((a) => ({ kind: "artifact" as const, ...a })),
      ...(plan.exports ?? []).map((e) => ({ kind: "export" as const, ...e })),
    ],
    plannedAt: input.now,
  };
}

// The effect computation itself, kept INTERNAL: `planPublicationOperation` is the only producer, because a
// plan with no operation id is a debt nobody can claim (arch-review 53, Wave C).
function planPublication(input: PublicationPlanInput): PublicationPlan | undefined {
  const artifacts =
    input.staged.revisionKey !== undefined
      ? [
          {
            key: analysisArtifactKey(input.scorecardId),
            from: input.staged.revisionKey,
            digest: contentDigest(input.bundle),
          },
        ]
      : [];
  const exports = input.exports
    ? [
        {
          idempotencyKey: `${input.scorecardId}:${input.passId}`,
          payloadDigest: contentDigest(input.results),
          // The frozen bytes this settlement owes (arch-review 54, Phase 4), when staging produced them.
          // Absent = the pre-Phase-4 path: compare the record's current results against the digest and refuse
          // on mismatch, which is honest but cannot converge after a legitimate re-score.
          ...(input.staged.payloadKey !== undefined ? { payloadKey: input.staged.payloadKey } : {}),
          ...(input.sink !== undefined ? { sink: input.sink } : {}),
          ...(input.judgeModels !== undefined ? { judgeModels: input.judgeModels } : {}),
          ...(input.attach !== undefined ? { attach: input.attach } : {}),
        },
      ]
    : [];
  if (artifacts.length === 0 && exports.length === 0) return undefined;
  return {
    state: "pending",
    plannedAt: input.now,
    ...(artifacts.length > 0 ? { artifacts } : {}),
    ...(exports.length > 0 ? { exports } : {}),
  };
}

// What the drain needs. Every one of these is already on `ScorecardBatchDeps`, so a driver hands its own
// `deps` in; the reconciler builds the same bag from the composition root.
export interface PublicationDeps {
  store: ScorecardStore;
  artifacts?: ArtifactStore;
  exportResults?: (
    tenant: string,
    ctx: {
      scorecardId: string;
      dataset: string;
      harness: string;
      sinkOverride?: string;
      judgeModels?: Record<string, string>;
      // The key the sink may dedupe on (arch-review 53, Wave C) — an at-least-once export whose receiver
      // cannot collapse duplicates is a duplicate problem handed to the tenant.
      idempotencyKey?: string;
    },
    results: CaseResult[],
    attach?: { sourceKind: string; externalIdByCase: Record<string, string> },
  ) => Promise<ScorecardExport | undefined>;
}

// The drain's answer. `skipped` is not a failure: the record carries no pending plan, so there was nothing
// this call could publish (the ordinary result of racing another publisher, and of a batch that settled
// before plans existed).
export type PublicationOutcome =
  // `export` is the receipt this drain wrote, handed back so the caller can state it on the batch's step
  // timeline without re-reading the record it just wrote.
  { kind: "published"; export?: ScorecardExport } | { kind: "skipped" } | { kind: "owed"; reason: string };

// Perform a committed settlement's owed outward effects and record the receipt.
//
// `results` is what the settlement counted. The winner passes the copies it already holds; the reconciler
// re-reads them from the record. A drain whose results do not digest to the plan's payload is looking at a
// plane the settlement never published (a re-score landed in between) — it promotes nothing and exports
// nothing, and leaves the plan owed with that stated, because silently exporting the newer bytes under the
// older settlement's receipt is the very substitution this seam exists to prevent.
// ── PERFORM ONE OPERATION'S EFFECTS, UNDER A CLAIM ON THAT OPERATION ──────────────────────────────
//
// The publisher claims BY ID and completes BY ID (arch-review 53, Wave C). The fence it replaces asked only
// whether something was pending on the scorecard, which a publisher holding a superseded plan passed against
// a NEWER settlement's plan — marking the re-score's publication published while it never happened. And the
// claim is taken BEFORE the effects run, so two publishers no longer both export and then race for one
// receipt: the loser never calls the sink at all.
export async function drainPublicationOperation(
  deps: PublicationDeps & { operations?: PublicationOperationStore },
  record: ScorecardRecord,
  // The operation itself, not just its id: the no-ledger path below needs the effects, and every caller
  // holds the object anyway (the settle planned it; the sweep listed it).
  operation: PublicationOperation,
  results: CaseResult[],
  owner: string,
  now: () => string,
  leaseSeconds = 120,
): Promise<PublicationOutcome> {
  // NO LEDGER WIRED = no reconciler either, so there is exactly one publisher by construction (the inline
  // winner in a single process). Performing the effects without a claim is that deployment's honest shape;
  // refusing to publish because the fence is absent would silently drop every export a storeless install
  // owes, which is a worse answer than the one Wave 4 already gave.
  if (!deps.operations) {
    const direct = await performEffects(deps, record, operation, results);
    if (direct.kind !== "published") return { kind: "owed", reason: direct.reason };
    if (direct.export !== undefined)
      await deps.store.update(record.id, { export: direct.export, updatedAt: now() }).catch(() => undefined);
    return direct;
  }
  const claimed = await deps.operations.claim(operation.id, owner, leaseSeconds, now());
  if (!claimed) return { kind: "skipped" }; // published already, or another publisher holds a live lease
  const outcome = await performEffects(deps, record, claimed, results);
  if (outcome.kind === "published") {
    const wrote = await deps.operations.complete(operation.id, owner, now());
    if (!wrote) return { kind: "skipped" }; // the lease expired and the sweep finished it — not ours to claim
    // THE RECEIPT ON THE RECORD, after the operation's own completion. It is a projection for readers (the
    // scorecard detail's export panel), not the fence — the fence is the claim above.
    //
    // …and it is MONOTONIC for the same reason the alias is (arch-review 54, Phase 4). "Only one publisher
    // can reach this line for one operation" was true and beside the point: two settlements are two
    // operations, and an older one draining late would replace a newer settlement's export receipt with its
    // own. Whoever is behind writes nothing.
    if (outcome.export !== undefined && !(await aliasIsAhead(deps, operation)))
      await deps.store.update(record.id, { export: outcome.export, updatedAt: now() }).catch(() => undefined);
    return outcome;
  }
  await deps.operations.release(operation.id, owner, outcome.reason, outcome.owed, now());
  return { kind: "owed", reason: outcome.reason };
}

// The effects themselves, shared by the operation drain and the legacy plan drain below.
// Has a LATER settlement already published this scorecard's alias? (arch-review 54, Phase 4.)
//
// Skipping is not a failure: `current` is a monotonic projection of the revision ledger, so an operation that
// finds a newer one already there has nothing to do — the world is where it wanted it, or ahead. Reporting
// that as owed would put the sweep in a loop it can never leave.
//
// Unreadable = do not promote. A projection moved on a guess is exactly the backwards write this exists to
// prevent, and the operation stays owed so a later sweep can decide with a readable ledger.
async function aliasIsAhead(
  deps: PublicationDeps & { operations?: PublicationOperationStore },
  operation: PublicationOperation,
): Promise<boolean> {
  if (!deps.operations) return false; // single-publisher deployment: no second settlement can race this one
  const siblings = await deps.operations.listForScorecard(operation.settlement.scorecardId).catch(() => undefined);
  if (siblings === undefined) return true;
  return siblings.some(
    (o) => o.state === "published" && o.settlement.scoringRevision > operation.settlement.scoringRevision,
  );
}

async function performEffects(
  deps: PublicationDeps & { operations?: PublicationOperationStore },
  record: ScorecardRecord,
  operation: PublicationOperation,
  results: CaseResult[],
): Promise<{ kind: "published"; export?: ScorecardExport } | { kind: "failed"; reason: string; owed: boolean }> {
  // The reason a drain reports is the FIRST PERMANENT one when there is one, else the last transient one: a
  // permanent failure decides whether this operation can ever converge, so a later "no exporter wired here"
  // must not overwrite "these are not the bytes this settlement staged".
  let owed: string | undefined;
  let permanent = false;
  const fail = (reason: string, isPermanent = false): void => {
    if (permanent && !isPermanent) return;
    if (isPermanent && !permanent) permanent = true;
    owed = reason;
  };
  let exported: ScorecardExport | undefined;
  for (const effect of operation.effects) {
    if (effect.kind === "artifact") {
      if (!deps.artifacts) {
        fail("no artifact store is wired here — the alias cannot be promoted");
        continue;
      }
      try {
        const bytes = await deps.artifacts.get(effect.from);
        if (!bytes) {
          // PERMANENT: the immutable object this settlement staged is gone, and no retry brings it back.
          fail(`the staged analysis artifact '${effect.from}' is not in the store`, true);
          continue;
        }
        const staged = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
        if (contentDigest(staged) !== effect.digest) {
          fail(`the staged analysis artifact '${effect.from}' does not digest to the planned bundle`, true);
          continue;
        }
        // ── `current` MOVES FORWARD ONLY (arch-review 54, Phase 4) ─────────────────────────────────
        //
        // This promotion used to be an unguarded put, under a comment that is true PER OPERATION and false
        // ACROSS them: "only one publisher can reach this line for one operation". Two settlements are two
        // operations, claimed independently, drained whenever their retries land — so a revision-1 sweep
        // finishing after revision 2 published moved `analyses/<id>.json` BACKWARDS, and the analysis a
        // human opens described a pass the ledger had already superseded.
        //
        // The alias is a monotonic projection of the ledger, so the guard is the revision it carries. Losing
        // the race is not a failure: a newer settlement is already there, which is the state this operation
        // wanted the world to be in or better.
        // The projection's current position comes from the LEDGER, not from the object: the operations table
        // already records which settlement published, and asking it costs no new artifact shape, no sidecar
        // object and no second race. A published operation for a HIGHER revision means the alias is already
        // ahead of this one.
        if (await aliasIsAhead(deps, operation)) continue;
        await deps.artifacts.put(effect.key, Buffer.from(bytes), "application/json");
      } catch (err) {
        fail(`analysis alias promotion failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      continue;
    }
    if (!deps.exportResults) {
      fail("no trace-sink exporter is wired here");
      continue;
    }
    // ── THE BYTES THIS SETTLEMENT OWES (arch-review 54, Phase 4) ─────────────────────────────────
    //
    // Read from the frozen object the settle staged, NOT from the record. Re-reading the record made an
    // ordinary re-score fatal: the plane moved, the digests disagreed, and the earlier settlement's owed
    // export closed PERMANENTLY unverifiable — a batch that ran, was judged and was recorded as pending
    // export simply never reached the tenant's platform. Refusing to ship the NEW bytes under the OLD
    // receipt was right; concluding the old export could never happen was a consequence of nobody having
    // frozen what it owed.
    let payload = results;
    if (effect.payloadKey !== undefined) {
      if (!deps.artifacts) {
        fail("no artifact store is wired here — the settlement's frozen export payload cannot be read");
        continue;
      }
      let frozen: unknown;
      try {
        const bytes = await deps.artifacts.get(effect.payloadKey);
        if (!bytes) {
          // PERMANENT: the immutable object is gone and no retry brings it back.
          fail(`the staged export payload '${effect.payloadKey}' is not in the store`, true);
          continue;
        }
        frozen = JSON.parse(new TextDecoder().decode(bytes));
      } catch (err) {
        fail(`the staged export payload could not be read: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      // The digest still guards it — a staged object that does not digest to what was planned is not this
      // settlement's payload, whatever its key says.
      if (contentDigest(frozen) !== effect.payloadDigest) {
        fail(`the staged export payload '${effect.payloadKey}' does not digest to the planned payload`, true);
        continue;
      }
      payload = frozen as CaseResult[];
    } else if (contentDigest(results) !== effect.payloadDigest) {
      // PRE-PHASE-4 operations (mig 0188's backfill, and any settle whose payload staging failed) carry a
      // digest and no key. They keep the old behaviour exactly: compare the record's current results and
      // refuse on mismatch. Honest, and unable to converge after a re-score — which is why new operations
      // freeze their bytes.
      fail("the record's results are no longer the ones this settlement counted — not exported", true);
      continue;
    }
    try {
      exported = await deps.exportResults(
        record.tenant,
        {
          scorecardId: record.id,
          dataset: `${record.dataset.id}@${record.dataset.version}`,
          harness: `${record.harness.id}@${record.harness.version}`,
          // THE KEY TRAVELS TO THE SINK (arch-review 53, Wave C). The export is at-least-once against a crash
          // between the call and the receipt; minting a key and not passing it left the receiving platform no
          // way to collapse the duplicates.
          idempotencyKey: effect.idempotencyKey,
          ...(effect.sink !== undefined ? { sinkOverride: effect.sink } : {}),
          ...(effect.judgeModels !== undefined ? { judgeModels: effect.judgeModels } : {}),
        },
        payload,
        effect.attach,
      );
    } catch (err) {
      fail(`trace-sink export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (owed !== undefined) return { kind: "failed", reason: owed, owed: !permanent };
  return { kind: "published", ...(exported ? { export: exported } : {}) };
}

// The legacy singleton drain (`drainPublication`, mig 0187) is GONE (arch-review 53, Wave C). Its four call
// sites moved to `drainPublicationOperation`, and keeping a second drain that fences on
// `expectPublicationState` would keep alive exactly the CAS this wave replaced — one that a publisher holding
// a superseded plan passes against a newer settlement's. Rows the old field still carries were migrated into
// the operations table by mig 0188's backfill.

// ── THE OWNER OF A PLAN WHOSE PROCESS DIED ──────────────────────────────────────────────────────────
//
// The winner drains its own plan inline, which is what makes the export prompt. A crash between the terminal
// commit and that drain leaves a durable plan and nobody running it — the same gap `CancellationCoordinator`
// closes for a teardown, and closed the same way: a leader-gated sweep over the owed rows.
export class PublicationCoordinator {
  constructor(
    private readonly deps: PublicationDeps & {
      operations: PublicationOperationStore;
      // The HYDRATING read: a settled batch stores its results on the child runs, and the export payload is
      // those results. Re-read rather than remembered, because the process that planned this is gone.
      getRecord: (id: string) => Promise<ScorecardRecord | undefined>;
      publisherId: string;
      now: () => string;
    },
  ) {}

  // Drain ONE operation — the winner's inline call and the sweep's per-row call are the same code path.
  async publish(operation: PublicationOperation): Promise<PublicationOutcome> {
    const record = await this.deps.getRecord(operation.settlement.scorecardId);
    if (!record) return { kind: "skipped" };
    return drainPublicationOperation(
      this.deps,
      record,
      operation,
      record.scorecard?.results ?? [],
      this.deps.publisherId,
      this.deps.now,
    );
  }

  // Every operation still owed — `pending`, plus `claimed` rows whose publisher's lease expired. Returns how
  // many it PUBLISHED; a row it could not drain stays owed with its reason, and the next sweep tries again.
  async reconcile(limit = 50): Promise<number> {
    const owed = await this.deps.operations.listOwed(limit, this.deps.now());
    let published = 0;
    for (const operation of owed) {
      const outcome = await this.publish(operation).catch((err: unknown) => ({
        kind: "owed" as const,
        reason: err instanceof Error ? err.message : String(err),
      }));
      if (outcome.kind === "published") published += 1;
    }
    return published;
  }
}
