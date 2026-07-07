import { AgentJobSchema } from "@everdict/core";
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
  const result = await runAgentJob(job);
  console.log(RESULT_SENTINEL + JSON.stringify(result));
}

void main();
