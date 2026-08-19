import { readFileSync } from "node:fs";
import { type CaseJob, type HarnessSpec, HarnessSpecSchema } from "@everdict/contracts";

// A declarative harness, loaded as DATA. `CommandHarness` promises that any CLI agent becomes evaluable from a
// spec with no code adapter — but the CLI could only name the two built-in adapters (`--harness claude-code|
// scripted`), so that promise stopped at the HTTP control plane. This is the same capability at the CLI: point
// `--harness-spec` at the spec and the agent it describes is the one under test.
export function harnessSpecFrom(path: string | undefined): HarnessSpec | undefined {
  if (!path) return undefined;
  // Parsed at the boundary: a malformed spec fails here, naming the field, instead of dispatching a job whose
  // harness silently falls back to a built-in adapter and quietly evaluates the wrong agent.
  return HarnessSpecSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

// Attach the spec to the job. The spec also NAMES the harness (id/version), because a declarative harness's
// identity lives in the spec — requiring the caller to retype it as `--harness` would make disagreement possible,
// and the disagreement would be invisible in the scorecard.
export function withHarnessSpec(job: CaseJob, spec: HarnessSpec | undefined): CaseJob {
  return spec ? { ...job, harness: { id: spec.id, version: spec.version }, harnessSpec: spec } : job;
}
