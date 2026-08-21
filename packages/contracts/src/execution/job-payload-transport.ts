// ── THE PAYLOAD DOES NOT TRAVEL IN THE ENVIRONMENT (arch-review 59 follow-through) ───────────────────
//
// A dispatched case used to arrive as base64(JSON) in `EVERDICT_CASE_JOB`, an environment variable on the
// container. The process that decodes it is also the process that starts the agent under test, and
// `takeJobPayload` deleting the variable closed INHERITANCE but not `/proc`:
//
//     delete process.env.X   →   edits this process's copy and what its children inherit
//     /proc/<pid>/environ    →   reports the environment this process was EXECVE'd with, forever
//
// Verified by execution: a child exec'd with a COMPLETELY clean environment — no inheritance at all — still
// reads the payload out of the parent's `/proc`. So nothing done at the exec site closes it. What is being
// read is the workspace's repo token, its registry passwords, the judge key resolved for this dispatch, and
// `evalCase.graders`, which in an evaluation product is the answer key.
//
// So the environment carries a PATH and the payload is a file the runner DELETES before it starts anything.
// A path is not a secret and is worthless once the file is gone. `docs/architecture/secret-free-execution-envelope.md`
// has the option analysis; the two constraints that ruled out the obvious answers are that an offline case
// (`network: none`) cannot fetch its payload from the control plane, and that the pod may run the TENANT's own
// image (`evalCase.image ?? opts.image`), so nothing may depend on an entrypoint or a shell we control.
//
// THE NAMES ARE THE CONTRACT; THE PATHS ARE THE LANE'S. Nomad renders a template into the task directory,
// which its docker driver mounts at `/local`; K8s writes into an emptyDir this lane chooses the mount for.
// Fixing a path here would have made one of them lie, and a runner that searched both would be a fork of the
// same question — so each lane states where it put the file, in the variable named below.
export const JOB_PAYLOAD_FILE_ENV = {
  case: "EVERDICT_CASE_JOB_FILE",
  verifier: "EVERDICT_VERIFIER_JOB_FILE",
} as const;
export type JobPayloadKind = keyof typeof JOB_PAYLOAD_FILE_ENV;

// The K8s side's mount point and volume name. Here rather than in the lane only because the counterexample
// and the live check both assert on them, and a second copy is how the assertion and the manifest drift.
export const JOB_PAYLOAD_DIR = "/run/everdict";
export const JOB_PAYLOAD_VOLUME = "everdict-job-payload";

// The shell that writes it, run by a step that has TERMINATED before the agent's container starts — so the
// environment holding the payload belongs to a process that no longer exists.
//
// `printf` is a POSIX shell BUILTIN: a separate process would put the payload in its own `/proc/<pid>/cmdline`
// for as long as it lived, which is the same disclosure one layer down. The value is a quoted expansion of a
// base64 string (`A-Za-z0-9+/=`), so there is nothing for the shell to split or interpret.
export function jobPayloadWriteCommand(destPath: string, envName: string): string[] {
  return ["sh", "-c", `umask 077; printf %s "$${envName}" > ${destPath}`];
}
