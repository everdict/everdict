---
paths: "packages/environments/**"
description: "The world a run acts on — seed and snapshot. Read when editing an Environment or adding one."
---
# Environment rules (push)

An `Environment` is the WORLD a case runs against: it seeds a known initial state and, when the run ends,
takes the observation the graders and judges read. Implementations: `RepoEnvironment` (git/inline/in-image),
`PromptEnvironment`, `OsUseEnvironment`.

- **The snapshot is EVIDENCE, not a convenience.** It is what every downstream reader has: the graders that
  do not touch compute, the judge, the re-score, the trace sink, and — since arch-review 56 — the verifier
  job, which reconstitutes a repo case's workspace in a container the agent was never in. A snapshot that
  under-reports what changed silently narrows every one of those.
- **`seed` establishes a KNOWN state; it never adapts to what it finds.** A seed that skips work because the
  target "looks right" makes two runs of one case incomparable, which is the one thing an eval may not be.
- **A repo snapshot is a DIFF against the seeded HEAD** (`{diff, changedFiles, headSha}`) — not a file dump
  and not the working tree. That is what makes it transportable: `runVerifierJob` applies it with `git apply`
  to rebuild the agent's work somewhere else.
- **Credentials are transient and never stored on the case.** A private clone's token arrives as
  `CaseJob.repoToken`, resolved by the control plane from `env.source.connectionId` at dispatch; the case
  document carries the connection id, never the secret.
- A new environment kind adds its snapshot variant to `EnvSnapshotSchema` (`@everdict/contracts`) and states
  what a grader may read from it. A kind with no file tree (prompt, browser, os-use) cannot be judged by a
  verifier job — `withVerifierPass` records that as `unmeasured` rather than judging an empty container.
