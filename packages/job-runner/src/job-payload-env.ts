// ── READING THE JOB PAYLOAD IS THE SAME ACT AS REMOVING IT (arch-review 58 P0) ───────────────────────
//
// The control plane dispatches a unit of work by base64-ing the whole job into an env var on the container.
// The runner decodes it once at startup and never needs the string again — but for as long as the variable
// stands, every process the runner starts inherits it, and one of those processes is the agent under test.
// `LocalDriver` execs with `{ ...process.env, ...opts.env }`, and the agent runs with permissions
// deliberately disabled, so `base64 -d <<< "$EVERDICT_CASE_JOB"` yields the workspace's repo token, its
// registry passwords, the provider key resolved for this dispatch — and `evalCase.graders`, which in an
// evaluation product is the answer key.
//
// That last one is why this is not merely a credential leak. Two prior waves exist to keep grading material
// away from the agent: the payload serializer REFUSES a case whose grading depends on hidden material, and
// the verifier runs the deciding graders in a second container the agent was never in. Both protect the
// split path, and the environment variable handed over the ordinary path's rubric to any agent that thought
// to read its own environment.
//
// "Unset it after parsing" is a discipline, and a discipline is what was missing. This is the shape that
// cannot be half-done: the only way to obtain the payload is a call that has already deleted it.
export type JobPayload = { kind: "case"; payload: string } | { kind: "verifier"; payload: string } | { kind: "absent" };

const CASE = "EVERDICT_CASE_JOB";
const VERIFIER = "EVERDICT_VERIFIER_JOB";

export function takeJobPayload(): JobPayload {
  const verifier = process.env[VERIFIER];
  const caseJob = process.env[CASE];
  // BOTH names go, whichever one answers. A container that carried the other must not keep it because a
  // branch happened not to look at it.
  delete process.env[VERIFIER];
  delete process.env[CASE];
  if (verifier) return { kind: "verifier", payload: verifier };
  if (caseJob) return { kind: "case", payload: caseJob };
  return { kind: "absent" };
}
