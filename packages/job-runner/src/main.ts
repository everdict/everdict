import { type CaseJob, CaseJobSchema, encodeLiveEvent, encodeResult } from "@everdict/contracts";
import { failureResult, runCaseJob } from "./run.js";

// Job-runner entrypoint (runs inside the sandbox/alloc).
// The CaseJob is passed as base64(JSON) in the EVERDICT_CASE_JOB env.
// The result is printed to stdout as one line: sentinel + CaseResult(JSON) → the backend parses it from logs.
// While the case runs, drained TraceEvents are ALSO printed as EVENT_SENTINEL lines (live-observability ⑨) —
// the job's stdout is the managed lane's only channel back, and the control plane's live-trace read extracts
// them from the orchestrator log the same way LiveLogs tails it. Neither line family shadows the result parse
// (parseResult takes the LAST result sentinel; log reads strip both).
async function main(): Promise<void> {
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

void main();
