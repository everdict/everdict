import { type FsActor, NotFoundError, type ViewSnapshot } from "@everdict/contracts";
import { type AnalysisConfig, type AnalysisResult, analysisConfigFromStored, computeAnalysis } from "@everdict/domain";
import { viewSnapshotDir, viewSnapshotPath } from "../fs/content-projection.js";
import type { ScorecardStore } from "../ports/scorecard-store.js";
import type { ViewStore } from "../ports/view-store.js";
import type { WorkspaceFs } from "../ports/workspace-fs.js";

// Capture a saved View onto the workspace filesystem.
//
// A View is a recipe: open it and it recomputes against today's data, remembering nothing. That is right for a
// lens and wrong for a record — "what did this say last Monday" has no answer, and a config edit silently
// rewrites the past. A capture writes the computed numbers, WITH the config that produced them, as an ordinary
// file under `views/<viewId>/`.
//
// They are files on purpose. The Files tree, the shell and an agent's list_files/get_file already read that
// tree, so accumulation costs no new read API, no new store and no new migration — and every capture is
// attributed through the same revision ledger as any other write.

export interface CaptureViewSnapshotInput {
  tenant: string;
  viewId: string;
  actor: FsActor; // who the filesystem records as the publisher
  trigger?: "manual" | "schedule";
  scheduleId?: string;
}

export interface ViewSnapshotRef {
  path: string;
  capturedAt: string;
  totals: { scorecards: number; cases: number };
}

export interface ViewSnapshotServiceDeps {
  views: ViewStore;
  scorecards: ScorecardStore;
  fs: WorkspaceFs;
  now?: () => string;
}

export class ViewSnapshotService {
  private readonly now: () => string;

  constructor(private readonly deps: ViewSnapshotServiceDeps) {
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  async capture(input: CaptureViewSnapshotInput): Promise<ViewSnapshotRef> {
    const { tenant, viewId, actor } = input;
    const view = await this.deps.views.get(tenant, viewId);
    // A private View belongs to its owner; anyone else must not learn it exists (the read rule everywhere else).
    if (!view || (view.visibility === "private" && view.createdBy !== actor.subject))
      throw new NotFoundError("NOT_FOUND", { id: viewId }, `view '${viewId}' not found.`);

    // A stored config is a recipe written by an older web build, so it is normalized rather than trusted —
    // the same defensive read the web does when it opens a View.
    const config: AnalysisConfig = analysisConfigFromStored(view.config);
    const records = await this.deps.scorecards.list(tenant);
    const result = computeAnalysis(records, config);

    const capturedAt = this.now();
    const snapshot: ViewSnapshot = {
      viewId,
      viewName: view.name,
      capturedAt,
      capturedBy: actor.subject,
      trigger: input.trigger ?? "manual",
      ...(input.scheduleId !== undefined ? { scheduleId: input.scheduleId } : {}),
      config,
      result: toWireResult(result),
      totals: { scorecards: result.total, cases: totalCases(result) },
    };

    const path = viewSnapshotPath(viewId, capturedAt);
    const body = new TextEncoder().encode(`${JSON.stringify(snapshot, null, 2)}\n`);
    await this.deps.fs.write(tenant, path, body, "application/json", {
      actor,
      message: `View snapshot — ${view.name}`,
    });
    return { path, capturedAt, totals: snapshot.totals };
  }

  // Where a View's captures accumulate — handed to callers so a UI can link straight into the Files tree
  // instead of re-deriving the layout.
  directoryOf(viewId: string): string {
    return viewSnapshotDir(viewId);
  }
}

// The whole capture's sample size. A grid already carries per-row case counts; a line result is a set of rates
// with no counts attached, so its sample size is not recoverable and reports 0 rather than a made-up number.
function totalCases(result: AnalysisResult): number {
  if (result.kind !== "grid") return 0;
  return result.rows.reduce((sum, row) => sum + row.cases, 0);
}

// A missing point is `undefined` inside the engine and `null` on the wire (JSON has no undefined). The file IS
// the wire form, so the gap is closed here explicitly instead of being left to JSON.stringify's array coercion —
// a reader parsing the snapshot against the contract must not depend on a serializer side effect.
function toWireResult(result: AnalysisResult): ViewSnapshot["result"] {
  if (result.kind !== "line") return result;
  return {
    ...result,
    series: result.series.map((s) => ({ ...s, points: s.points.map((p) => p ?? null) })),
  };
}
