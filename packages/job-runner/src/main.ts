import { type CaseJob, CaseJobSchema, encodeResult } from "@everdict/contracts";
import { failureResult, runCaseJob } from "./run.js";

// Job-runner entrypoint (runs inside the sandbox/alloc).
// The CaseJob is passed as base64(JSON) in the EVERDICT_CASE_JOB env.
// The result is printed to stdout as one line: sentinel + CaseResult(JSON) → the backend parses it from logs.
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
    const result = await runCaseJob(job);
    console.log(encodeResult(result));
  } catch (err) {
    console.log(encodeResult(failureResult(err, job)));
  }
}

void main();
