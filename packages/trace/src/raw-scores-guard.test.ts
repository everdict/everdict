import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The structural half of the measured gate, export side (the twin of the domain and application-control
// guards). This package is where a score LEAVES the product for someone else's observability platform, and a
// republished placeholder zero is the worst version of the dilution bug: it stops being ours to correct.
// The gate therefore lives upstream — TraceSinkService filters through `measuredScores` and hands the sinks a
// `TraceSinkScore[]`, a shape with no measurement status to reason about — and this guard pins that the
// adapters never start reading a `CaseResult.scores` array of their own.
const ALLOWED = new Set([
  // The four sinks iterate `TraceSinkCase.scores` — already-measured TraceSinkScore rows, gated in
  // application-control's trace-sink-service before the adapter ever sees them.
  "sinks/mlflow-sink.ts",
  "sinks/langfuse-sink.ts",
  "sinks/langsmith-sink.ts",
  "sinks/phoenix-sink.ts",
]);

function tsFilesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (statSync(full).isDirectory()) return tsFilesUnder(full, rel);
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) return [];
    return [rel];
  });
}

describe("raw-scores guard (trace export) — a placeholder never leaves the product", () => {
  it("every trace file touching `.scores` is on the gate allowlist", () => {
    const root = __dirname;
    const offenders = tsFilesUnder(root).filter((rel) => {
      if (ALLOWED.has(rel)) return false;
      return /\.scores\b/.test(readFileSync(join(root, rel), "utf8"));
    });
    expect(offenders).toEqual([]);
  });
});
