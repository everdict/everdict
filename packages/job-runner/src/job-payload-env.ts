import { closeSync, fstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
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
    // ── UNLINK FIRST, THEN READ THE FD (arch-review 60 P1-security) ───────────────────────────────
    //
    // The previous shape read the file and unlinked it in a `finally` with the failure swallowed. A read that
    // SUCCEEDED and an unlink that failed — a read-only mount, a permission the lane got wrong, an ENOSPC on
    // the metadata write — returned the payload and left the bytes exactly where the agent could reach them,
    // while the contract this function exists to keep says the only way to obtain it is a call that has
    // already destroyed it. The swallow's own comment guessed the failure was always "already gone or never a
    // file"; ordinary unlink failures are neither.
    //
    // So the directory entry goes FIRST and its failure is fatal, and the bytes are then read through the
    // descriptor that is already open — which is what makes this atomic rather than ordered: after the
    // unlink there is no name left for anything else to open, and the content is still reachable to us alone.
    let fd: number;
    try {
      fd = openSync(path, "r");
    } catch {
      // A path that names nothing readable is `absent`, not a crash: a lane that rendered no file is the same
      // failure as one that set no variable, and neither leaves bytes behind.
      continue;
    }
    try {
      // A path that is not a regular file holds no payload bytes, so there is nothing here to leak and
      // nothing to refuse over — a lane that pointed the variable at a directory is a dispatch that will fail
      // for want of a payload, not a process that should die trying to unlink a directory.
      if (!fstatSync(fd).isFile()) continue;
      // Fatal on purpose, and only from here: the bytes exist. A payload whose NAME cannot be removed must
      // not be handed on — refusing is a dispatch that dies before the agent starts, which is the fail-closed
      // direction and the only reading under which this function's contract is true.
      unlinkSync(path);
      payload = readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
    if (payload !== "") found.push({ kind, payload });
  }
  // Verifier first, as the loop order says: a container carrying both is a lane bug, and the judging half is
  // the one whose disclosure matters more.
  return found[0] ?? { kind: "absent" };
}
