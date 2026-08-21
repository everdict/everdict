# The secret-free execution envelope

> Status: **designed, not implemented.** The exposure below is open on `main` today. This document exists so
> the transport change is made deliberately, against a cluster, rather than improvised.

A dispatched eval case carries its whole job into the container as one base64 environment variable. That
payload holds the workspace's repo token, its registry passwords, the judge's provider key resolved for this
dispatch — and `evalCase.graders`, which in an evaluation product is the answer key. The process that decodes
it is also the process that starts the agent under test: arbitrary code, permissions deliberately disabled.

Two waves have already narrowed this. `caseJobPayload` REFUSES a case whose grading depends on material the
lane would hand the agent (arch-review 56), the private verifier runs deciding graders in a container the
agent was never in (arch-review 56), and `takeJobPayload` deletes the variable at the moment it is read, so
nothing the runner starts inherits it (arch-review 58).

What remains is not a discipline problem, and that is why it needs a design rather than another careful line.

## The fact this rests on

`delete process.env.X` edits this process's copy of the environment and what its future children inherit. It
does not edit `/proc/<pid>/environ`, which reports the environment the process was EXECVE'd with and goes on
reporting it for the life of the process. `clearenv()` moves pointers; it does not scrub the bytes.

Verified by execution rather than by reading about it:

| observation | result |
|---|---|
| value present in `/proc/self/environ` before the delete | yes |
| …still present after `delete process.env.X` | **yes** |
| a child exec'd with a **completely clean** env (`{PATH}`, no inheritance) can read it from the parent's `/proc` | **yes** |

The third row is the one that decides the design. An explicit allowlist at the exec site — the thing rule
`protocol` asks for, and a good idea for its own reasons — does not close this. The agent runs as the same
uid in the same PID namespace, so it reads the parent's environ directly:

```
tr '\0' '\n' < /proc/1/environ | grep EVERDICT_CASE_JOB
```

So the payload must never arrive in the initial environment. Everything else is a mitigation of a channel
that stays open.

## What must hold

1. **No secret in any process's execve-time environment.** Not the runner's, not an init step's that is still
   alive when the agent runs.
2. **Works offline.** A case declaring `network: none` gets a deny-all egress policy, so any design that
   fetches the payload over the network at startup is unavailable exactly where isolation matters most.
3. **Works when the pod runs the TENANT's image.** `image = job.evalCase.image ?? opts.image` — a container
   task's pod runs the tenant's own image with the runner baked in, so nothing may depend on wrapping an
   entrypoint we control, or on `sh` existing.
4. **One transport, not a preferred one.** A fallback that stays alive is the escape hatch rule `protocol`
   forbids: every lane would be free to keep the old path and the exposure would survive in whichever one
   nobody re-read.

## Options considered

| option | why not |
|---|---|
| Allowlist the child's env at the exec site | Does not close `/proc` — see the table above. Worth doing for inheritance, insufficient alone. |
| Fetch the payload from the control plane with a single-use bootstrap token | Strongest in principle (the leaked token is spent), but violates (2): an offline case cannot reach the control plane, and punching a hole for it is a hole in the guarantee being measured. |
| A shell wrapper that writes the payload to a file and `exec`s the runner with a clean env | Genuinely closes `/proc` — same PID, environ replaced at execve — but violates (3): needs `sh` in the tenant's image, and `printf` must be a builtin or the payload lands in another process's `cmdline`. |
| Mount the payload as a K8s Secret volume | Read-only tmpfs: the runner cannot delete it, so it is readable by the agent for the whole case. |
| Run the agent as a different uid | Closes `/proc` (environ is `0400`, owned by the runner). A larger change to how `LocalDriver` execs and to workspace file ownership; worth doing later, not the minimum. |

## The design

**The environment carries a path. The payload is a file the runner deletes before it starts anything.**

```
EVERDICT_JOB_FILE=/run/everdict/job     # not a secret; worthless once read
```

- **Nomad** — a `template` stanza renders the payload into the task's own writable directory
  (`${NOMAD_TASK_DIR}`). No extra container, no `sh`. The payload lives in the job spec, which is exactly
  where the env value lives today, so nothing about the control plane's own trust level changes.
- **K8s** — an emptyDir at `/run/everdict`, plus an **initContainer** running the runner image (ours, always
  present) that holds the payload in its environment and writes it into the volume. The initContainer has
  TERMINATED before the main container starts, so its `/proc` is gone with it; the main container gets only
  the path. Works with a distroless tenant image because nothing in the main container needs a shell.
- **Docker / self-hosted / `everdict run`** — the driver writes the file directly; it is already the parent
  process and has a writable path.

The runner reads and unlinks in one act, behind the seam that already exists:

```ts
// packages/job-runner/src/job-payload-env.ts
takeJobPayload()   // reads EVERDICT_JOB_FILE, unlinks it, removes the directory
```

`takeJobPayload` is why this is a contained change: every lane already obtains its payload through one
function whose contract is "the only way to get it is a call that has already destroyed it". This swaps what
that call destroys.

### Residual exposure, stated

Between the file being written and the runner unlinking it, it exists at `0600` under the uid the agent will
later run as. There is no concurrent reader — the runner unlinks at startup and the agent is started by
`runCase` afterwards — so the window contains no adversary. It is written down because "no window" would be
the stronger sentence and it is not the true one.

Running the agent under a different uid would close both this window and the `/proc` channel structurally.
That is the next step after this one, not a substitute for it.

## Verification plan

Local, before anything is deployed:

- The runner's own seam: a counterexample that gives `takeJobPayload` a file and asserts the file is **gone**
  when it returns, and that the payload is absent from `process.env` — both directions, and RED with the
  unlink removed.
- The manifest builders: a counterexample asserting no rendered pod, task or container spec carries a
  secret-bearing value in `env` — asserted over every builder in one file, the shape
  `untrusted-pod-identity.counterexample.test.ts` already uses, because this too is one invariant that must
  hold in three places.

Against a cluster, because a manifest that type-checks is not a pod that starts:

- `scripts/live/` checks for both lanes: dispatch a case, and from inside the container assert
  `/proc/1/environ` contains no payload and `EVERDICT_JOB_FILE` names a path that no longer exists.
- The K8s initContainer ordering is the part that cannot be proven locally: an initContainer that fails leaves
  the Job pending rather than running a case with no payload, which is the fail-closed direction, but it has
  to be seen.

Then, and only then, the env transport is deleted rather than kept as a fallback.

## Related

- Rule `protocol` — *a secret in a process's initial environment is not revoked by a language-level delete*.
- Rule `job-runner` — the payload is TAKEN, never read.
- Rule `backends` — an untrusted pod carries no identity in our cluster (the sibling exposure, closed).
- `docs/architecture/execution-model-design.md` · `docs/execution-backends.md`.
