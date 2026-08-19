import {
  type CaseJob,
  CaseJobSchema,
  type Score,
  VerifierJobSchema,
  encodeLiveEvent,
  encodeResult,
} from "@everdict/contracts";
import { LocalDriver } from "@everdict/drivers";
import { failureResult, runCaseJob } from "./run.js";
import { runVerifierJob } from "./verifier-job.js";

// Job-runner entrypoint (runs inside the sandbox/alloc).
// The CaseJob is passed as base64(JSON) in the EVERDICT_CASE_JOB env.
// The result is printed to stdout as one line: sentinel + CaseResult(JSON) → the backend parses it from logs.
// While the case runs, drained TraceEvents are ALSO printed as EVENT_SENTINEL lines (live-observability ⑨) —
// the job's stdout is the managed lane's only channel back, and the control plane's live-trace read extracts
// them from the orchestrator log the same way LiveLogs tails it. Neither line family shadows the result parse
// (parseResult takes the LAST result sentinel; log reads strip both).
async function main(): Promise<void> {
  // ── THE JUDGING HALF, WHEN THIS UNIT IS THE VERIFIER (arch-review 56, Wave K) ────────────────────
  //
  // The same image, dispatched a second time with a different payload. A verifier unit has no harness and no
  // agent: it restores the workspace the case left, runs the deciding graders, and prints their scores behind
  // the same sentinel the backends already parse. Branching here rather than in a second entrypoint keeps one
  // image and one result contract — and keeps the two payload names the only thing that differs, which is
  // what makes "the agent's container never held the plan" checkable.
  const verifierRaw = process.env.EVERDICT_VERIFIER_JOB;
  if (verifierRaw) {
    await runVerifierEntry(verifierRaw);
    return;
  }
  const raw = process.env.EVERDICT_CASE_JOB;
  if (!raw) {
    console.error("✗ EVERDICT_CASE_JOB (env) is missing.");
    process.exitCode = 1;
    return;
  }
  // Parse INSIDE the try: a corrupt job (bad base64/JSON, schema mismatch) must still cross the process boundary as
  // a CLASSIFIED CaseResult behind the sentinel. Parsing outside would let it crash bare — surfacing backend-side as
  // a mushy "sentinel not found" dispatch error that erases WHERE it died. `job` stays undefined until decoded, so a
  // parse failure is attributed to the dispatch stage with an unknown identity (see failureResult).
  let job: CaseJob | undefined;
  try {
    job = CaseJobSchema.parse(JSON.parse(Buffer.from(raw, "base64").toString("utf8")));
    const result = await runCaseJob(job, {
      reportTrace: async (events) => {
        for (const event of events) {
          const line = encodeLiveEvent(event);
          if (line) console.log(line);
        }
      },
    });
    console.log(encodeResult(result));
  } catch (err) {
    console.log(encodeResult(failureResult(err, job)));
  }
}

// The verifier unit's whole life. A parse failure crosses the boundary the same way the case entry's does —
// as a result behind the sentinel — because a bare crash surfaces backend-side as "sentinel not found", which
// erases where it died.
async function runVerifierEntry(raw: string): Promise<void> {
  let scores: Score[];
  try {
    const job = VerifierJobSchema.parse(JSON.parse(Buffer.from(raw, "base64").toString("utf8")));
    scores = await runVerifierJob(job, { driver: new LocalDriver() });
  } catch (err) {
    // An `unmeasured` verdict, never a zero: a verifier that could not run produced no number, and a number
    // the benchmark never produced must not reach a mean.
    scores = [
      {
        graderId: "verifier",
        metric: "tests_pass",
        status: "unmeasured",
        reason: "grader_error",
        retryable: true,
        detail: err instanceof Error ? err.message : String(err),
      } as Score,
    ];
  }
  console.log(encodeResult({ caseId: "", harness: "", trace: [], scores } as never));
}

void main();
