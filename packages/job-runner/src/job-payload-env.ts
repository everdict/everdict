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
//
// ── WHAT THIS EARNS, AND WHAT IT DOES NOT (arch-review 59) ───────────────────────────────────────────
//
// It closes INHERITANCE. It does not close `/proc`, and the difference is the whole remaining exposure:
// `delete process.env.X` edits this process's copy and what its future children inherit, while
// `/proc/<pid>/environ` reports the environment this process was EXECVE'd with and keeps reporting it. The
// agent under test runs as a child, same uid, same PID namespace, so:
//
//     tr '\0' '\n' < /proc/1/environ | grep EVERDICT_CASE_JOB
//
// still yields the payload. Verified by execution, not by reading the man page — and the sharp part is that
// a child exec'd with a COMPLETELY clean environment (an explicit allowlist, no inheritance at all) reads it
// out of the parent just the same. So no amount of care at the exec site closes this; the payload must not
// arrive in the initial environment at all.
//
// The repair is a transport change, not a discipline: the payload is written where the runner can DELETE it
// (a Nomad `template` into the task dir, a K8s initContainer into an emptyDir) and the environment carries
// only a path. Designed in `docs/architecture/secret-free-execution-envelope.md`; this function is the seam
// it lands behind, which is why the seam exists.
//
// Until then the honest sentence is the narrow one: the agent no longer INHERITS the payload from us. That
// is a different claim from "the agent cannot read it", and only one of them is earned (rule `protocol`,
// "a secret in a process's initial environment").
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
