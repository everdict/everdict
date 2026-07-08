import { AgentJobSchema, classifyFailure, stageForError } from "@everdict/core";
import { RESULT_SENTINEL, runAgentJob } from "./run.js";

// Runner-agent entrypoint (runs inside the sandbox/alloc).
// The AgentJob is passed as base64(JSON) in the EVERDICT_AGENT_JOB env.
// The result is printed to stdout as one line: sentinel + CaseResult(JSON) → the backend parses it from logs.
async function main(): Promise<void> {
  const raw = process.env.EVERDICT_AGENT_JOB;
  if (!raw) {
    console.error("✗ EVERDICT_AGENT_JOB (env) is missing.");
    process.exitCode = 1;
    return;
  }
  const job = AgentJobSchema.parse(JSON.parse(Buffer.from(raw, "base64").toString("utf8")));
  try {
    const result = await runAgentJob(job);
    console.log(RESULT_SENTINEL + JSON.stringify(result));
  } catch (err) {
    // An in-job failure (harness install/run, grader, driver) still crosses the process boundary as a CLASSIFIED
    // CaseResult — a bare non-zero exit would surface backend-side as a mushy "sentinel not found" dispatch error,
    // erasing WHERE the case died. The stage comes from the error code (install|run|grade|dispatch).
    const failure = classifyFailure(err, stageForError(err));
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      RESULT_SENTINEL +
        JSON.stringify({
          caseId: job.evalCase.id,
          harness: `${job.harness.id}@${job.harness.version}`,
          trace: [{ t: 0, kind: "error", message }],
          snapshot: { kind: "prompt", output: "" },
          scores: [
            {
              graderId: failure.stage,
              metric: "error",
              value: 0,
              pass: false,
              detail: `[${failure.class}] ${message}`,
            },
          ],
          failure,
        }),
    );
  }
}

void main();
