import { createHash } from "node:crypto";
import type { CaseResult, DispatchManifest, StoreFixture } from "@everdict/contracts";
import type { RecordingStore } from "./ports/recording-store.js";

// Build a dispatched case's audit manifest for the sealed recording. Records a stable content hash of the case's
// world-state fixtures (P2) so the recording is self-describing — it says WHAT data the run was seeded with, for
// audit/reproducibility. Absent fixtures → a harness-only manifest. docs/architecture/dependency-store-roles.md
export function dispatchManifest(harness: string, fixtures?: StoreFixture[]): DispatchManifest {
  return {
    harness,
    ...(fixtures && fixtures.length > 0
      ? { fixtures: createHash("sha256").update(JSON.stringify(fixtures)).digest("hex").slice(0, 32) }
      : {}),
  };
}

// Fold the in-run environment deltas (repo git-diff checkpoints, captured in-sandbox onto CaseResult.envDeltas) into a
// case's replay recording, as inline "repo-diff" entries on the open `custom` lane — so a coding harness (Claude Code /
// Codex / any non-visual agent) replays how the repo evolved, not just its final diff. Called right before seal at
// finalize (standalone RunService + batch write-back), so it works self-hosted AND managed (the deltas ride the
// CaseResult back, not a self-hosted-only push channel). Best-effort. After folding, the deltas are cleared from the
// result so they are not double-stored on the persisted record (they now live on the recording). docs/architecture/replay.md.
export async function foldEnvDeltas(store: RecordingStore, runId: string, result: CaseResult): Promise<void> {
  const deltas = result.envDeltas;
  if (!deltas || deltas.length === 0) return;
  for (const d of deltas) {
    try {
      await store.append(runId, { track: "custom", entry: { t: d.t, name: d.kind, text: d.text } });
    } catch {
      // best-effort — a recording failure never affects the run
    }
  }
  result.envDeltas = undefined;
}
