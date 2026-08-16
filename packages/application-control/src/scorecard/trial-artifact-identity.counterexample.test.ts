import type { CaseResult } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { ArtifactStore } from "../ports/artifact-store.js";
import { offloadResults } from "./scorecard-observability.js";

// ── A TRIAL'S ARTIFACT IS ITS OWN (arch-review 52, Wave 1) ──────────────────────────────────────────
//
// `offloadResults` keys every result's media by `scorecards/<id>/<caseId>` — no trial. A trialled case is N
// physical executions of one case id (pass@k, the statistical regression gate), so N results share one object
// key and the LAST write wins: the screenshot a judge looked at for trial 0 is silently replaced by trial 2's,
// and every `screenshotRef` in the record points at the same bytes. Nothing detects it — the puts all succeed,
// the record looks complete, and the evidence for k−1 of the k trials is simply gone.
//
// The identity rule is the same one the receipt ledger already enforces (`(scorecard, case, trial)` is UNIQUE):
// whatever addresses a trial's evidence has to carry the trial.

// File-local ArtifactStore fake — records what was put under which key, and serves it back by key.
function recordingArtifacts(): { store: ArtifactStore; keys: string[] } {
  const objects = new Map<string, Uint8Array>();
  const keys: string[] = [];
  const store: ArtifactStore = {
    async put(key, data) {
      keys.push(key);
      objects.set(key, data);
      return `s3://bucket/${key}`;
    },
    async get(key) {
      return objects.get(key);
    },
    async publicUrlFor(ref) {
      return ref;
    },
  };
  return { store, keys };
}

const shot = (marker: string): string => Buffer.from(`png-bytes-${marker}`).toString("base64");

const trialResult = (trial: number, marker: string): CaseResult => ({
  caseId: "c1",
  trial,
  harness: "h@1.0.0",
  trace: [],
  snapshot: { kind: "os-use", screenshot: shot(marker), screenshotRef: "", windows: [] },
  scores: [],
});

// [WAVE-1 COUNTEREXAMPLE #2 — CLOSED] RED as of 02a3e15e: `AssertionError: expected 1 to be 2 // Object.is
// equality` — both trials offloaded to the one key `scorecards/sc-1/c1.png` (scorecard-observability.ts keyed by
// `<id>/<caseId>`), so trial 1 overwrote trial 0's screenshot in place. GREEN since wave 1: the key is
// `caseKeyAddress`, so a trialled result carries its trial and a trial-less one keeps its bare-caseId address.
// This is now the regression, not a pending counterexample.
describe("a trial's evidence is addressed by the trial that produced it", () => {
  it("two trials of one case offload to two objects, each holding its own screenshot", async () => {
    // Given two trials of the same case, each with its own screen
    const { store, keys } = recordingArtifacts();
    const results = [trialResult(0, "first"), trialResult(1, "second")];

    // When the batch offloads its media
    await offloadResults({ artifacts: store }, "sc-1", results);

    // Then each trial got its own object…
    expect(new Set(keys).size).toBe(2);
    // …and both are still readable — the assertion the shared key cannot satisfy, because the second put
    // replaced the first's bytes at the same address.
    const bodies = await Promise.all(keys.map((key) => store.get(key)));
    const decoded = bodies.map((b) => (b === undefined ? "" : Buffer.from(b).toString("utf8")));
    expect(decoded).toContain("png-bytes-first");
    expect(decoded).toContain("png-bytes-second");
    // …and each result points at its own object, so a judge re-reading trial 0's evidence gets trial 0's.
    const refs = results.map((r) => (r.snapshot.kind === "os-use" ? r.snapshot.screenshotRef : ""));
    expect(refs[0]).not.toBe(refs[1]);
  });
});
