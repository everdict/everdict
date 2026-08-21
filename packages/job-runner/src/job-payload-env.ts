import { readFileSync, unlinkSync } from "node:fs";
import { JOB_PAYLOAD_FILE_ENV } from "@everdict/contracts";

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
// THAT IS WHY THE PAYLOAD NO LONGER ARRIVES IN THE ENVIRONMENT AT ALL. It is a FILE — rendered by a Nomad
// template into the task directory, or written by a K8s initContainer into a tmpfs emptyDir — and the
// environment carries only the PATH, which is not a secret and is worthless once the file is gone. The
// process that held the payload in its environment is the init step, and it has terminated before the agent's
// container starts, so there is no `/proc` left to read it out of. See
// `docs/architecture/secret-free-execution-envelope.md` and `JOB_PAYLOAD_FILE_ENV`.
//
// This function is still the one seam, and it still cannot be half-done — the only way to obtain the payload
// is a call that has already unlinked it. What changed is what "already deleted" means: `delete process.env`
// bounded inheritance, `unlink` removes the bytes.
//
// SYNCHRONOUS unlink on purpose. This runs before anything else in the process, and the whole property is
// that no child can exist between the read and the removal; an `await` here is a window, however short, and
// a window is what the previous version was.
export type JobPayload = { kind: "case"; payload: string } | { kind: "verifier"; payload: string } | { kind: "absent" };

export function takeJobPayload(): JobPayload {
  // BOTH names, whichever answers. A container that carried the other must not keep it because a branch
  // happened not to look at it — the discipline the env version had, applied to files.
  const found: Array<{ kind: "case" | "verifier"; payload: string }> = [];
  for (const kind of ["verifier", "case"] as const) {
    const path = process.env[JOB_PAYLOAD_FILE_ENV[kind]];
    if (path === undefined || path === "") continue;
    // The path itself goes too. It is not a secret, but a stale name pointing at nothing is a thing a future
    // reader has to reason about, and this process has no further use for it.
    delete process.env[JOB_PAYLOAD_FILE_ENV[kind]];
    let payload: string;
    try {
      payload = readFileSync(path, "utf8");
    } catch {
      // A path that names nothing is `absent`, not a crash: an operator reading "the payload is missing" is
      // being told the truth, and a lane that rendered no file is the same failure as one that set no
      // variable. Nothing is left behind either way.
      continue;
    } finally {
      // Removed WHATEVER the read did. A read that threw halfway still leaves bytes on the tmpfs, and this
      // process is about to start the thing they are being kept from.
      //
      // `unlink`, not a recursive remove, and swallowed: this variable is set by our own lane, but a lane
      // that set it wrong would hand a recursive delete a path nobody checked — and the failure mode of
      // getting that wrong is unbounded, while the failure mode of refusing is a payload that was never a
      // file. Refusing to remove something that is not a file is the safe direction, and it must not take
      // the process down: this runs before the case has started, so a throw here is a dispatch that dies
      // with no result rather than a case that reports one.
      try {
        unlinkSync(path);
      } catch {
        // Already gone, or never a file. Neither leaves payload bytes behind.
      }
    }
    if (payload !== "") found.push({ kind, payload });
  }
  // Verifier first, as the loop order says: a container carrying both is a lane bug, and the judging half is
  // the one whose disclosure matters more.
  return found[0] ?? { kind: "absent" };
}
