import type { CaseResult, PublicationPlan, ScorecardExport, ScorecardRecord } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import type { ArtifactStore } from "../ports/artifact-store.js";
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
export function planPublication(input: PublicationPlanInput): PublicationPlan | undefined {
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
export async function drainPublication(
  deps: PublicationDeps,
  record: ScorecardRecord,
  results: CaseResult[],
  now: () => string,
): Promise<PublicationOutcome> {
  const plan = record.publication;
  if (!plan || plan.state !== "pending") return { kind: "skipped" };

  let owed: string | undefined;

  // (a) THE MUTABLE ALIAS, promoted from the immutable object the settle staged. Read-then-put rather than
  // re-serializing the bundle: the alias must be byte-identical to the artifact the winning revision points
  // at, and the only way to guarantee that is to copy the object the revision names.
  for (const artifact of plan.artifacts ?? []) {
    if (!deps.artifacts) {
      owed = "no artifact store is wired here — the alias cannot be promoted";
      continue;
    }
    try {
      const bytes = await deps.artifacts.get(artifact.from);
      if (!bytes) {
        owed = `the staged analysis artifact '${artifact.from}' is not in the store`;
        continue;
      }
      const staged = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
      if (contentDigest(staged) !== artifact.digest) {
        // Not retried into success by the sweep either — the object under that key is not the settlement's,
        // and promoting it would put another pass's bundle behind this batch's current-analysis alias.
        owed = `the staged analysis artifact '${artifact.from}' does not digest to the planned bundle`;
        continue;
      }
      await deps.artifacts.put(artifact.key, Buffer.from(bytes), "application/json");
    } catch (err) {
      owed = `analysis alias promotion failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // (b) THE EXPORT. An export failure has never failed a scorecard and does not start now: the OUTCOME is
  // recorded on the record (`status: "failed"` with a reason) and the plan closes, because the export ran —
  // it is the sink that refused. Only a throw (a contract violation, or an unreachable dependency) leaves
  // the plan owed for the sweep to retry.
  let exported: ScorecardExport | undefined;
  for (const wanted of plan.exports ?? []) {
    if (!deps.exportResults) {
      owed = "no trace-sink exporter is wired here";
      continue;
    }
    if (contentDigest(results) !== wanted.payloadDigest) {
      owed = "the record's results are no longer the ones this settlement counted — not exported";
      continue;
    }
    try {
      exported = await deps.exportResults(
        record.tenant,
        {
          scorecardId: record.id,
          dataset: `${record.dataset.id}@${record.dataset.version}`,
          harness: `${record.harness.id}@${record.harness.version}`,
          ...(wanted.sink !== undefined ? { sinkOverride: wanted.sink } : {}),
          ...(wanted.judgeModels !== undefined ? { judgeModels: wanted.judgeModels } : {}),
        },
        results,
        wanted.attach,
      );
    } catch (err) {
      owed = `trace-sink export failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (owed !== undefined) {
    // Still owed. The reason is recorded for an operator and never read as control — `state` alone decides
    // whether the next sweep retries, exactly as it does for a cancellation operation.
    await deps.store
      .update(record.id, { publication: { ...plan, lastError: owed }, updatedAt: now() }, undefined, {
        expectPublicationState: "pending",
      })
      .catch(() => undefined);
    return { kind: "owed", reason: owed };
  }

  // THE RECEIPT, under the plan's own fence. Two publishers may both have performed the effects (the alias
  // promotion is idempotent by content; the export is the at-least-once half documented above) — exactly one
  // of them writes the receipt, and the loser learns it did not publish.
  const settled = await deps.store.update(
    record.id,
    {
      publication: { ...plan, state: "published", publishedAt: now() },
      ...(exported ? { export: exported } : {}),
      updatedAt: now(),
    },
    undefined,
    { expectPublicationState: "pending" },
  );
  if (settled === undefined) return { kind: "skipped" };
  return { kind: "published", ...(exported ? { export: exported } : {}) };
}

// ── THE OWNER OF A PLAN WHOSE PROCESS DIED ──────────────────────────────────────────────────────────
//
// The winner drains its own plan inline, which is what makes the export prompt. A crash between the terminal
// commit and that drain leaves a durable plan and nobody running it — the same gap `CancellationCoordinator`
// closes for a teardown, and closed the same way: a leader-gated sweep over the owed rows.
export class PublicationCoordinator {
  constructor(
    private readonly deps: PublicationDeps & {
      // The HYDRATING read: a settled batch stores its results on the child runs, and the export payload is
      // those results. Re-read rather than remembered, because the process that planned this is gone.
      getRecord: (id: string) => Promise<ScorecardRecord | undefined>;
      now: () => string;
    },
  ) {}

  // Drain one batch's plan — the winner's inline call and the sweep's per-row call are the same code path.
  async publish(id: string): Promise<PublicationOutcome> {
    const record = await this.deps.getRecord(id);
    if (!record) return { kind: "skipped" };
    return drainPublication(this.deps, record, record.scorecard?.results ?? [], this.deps.now);
  }

  // Every plan still owed. Returns how many it PUBLISHED — a row it could not drain stays owed with its
  // reason, and the next sweep tries again.
  async reconcile(limit = 50): Promise<number> {
    const owed = await this.deps.store.list(undefined, { publicationPending: true });
    let published = 0;
    for (const row of owed.slice(0, limit)) {
      const outcome = await this.publish(row.id).catch((err: unknown) => ({
        kind: "owed" as const,
        reason: err instanceof Error ? err.message : String(err),
      }));
      if (outcome.kind === "published") published += 1;
    }
    return published;
  }
}
