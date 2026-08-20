---
paths: "packages/drivers/**"
---
# Driver rules (push)

A Driver = *in-sandbox compute* (`ComputeHandle`): it runs the harness inside an already-isolated unit.
`LocalDriver` (host process — dev, and inside the agent) and `DockerDriver` (a container from the case's
own image). **Placement and isolation are the Backend's job** (Nomad/K8s/Windows — see skill `backends`),
not the Driver's.

- Implement the `Driver` interface from `@everdict/contracts`; export it by a `*Driver` name.
- The returned `ComputeHandle` MUST be releasable via `dispose()`; callers release in `finally`.
- Map failures to an `AppError` (`COMPUTE_EXEC_FAILED`); never leak a raw OS/SDK error.
- A non-zero command exit is a *result* (`{exitCode, stdout, stderr}`), not a thrown error.
- **A DECLARED WORLD IS ENFORCED OR REFUSED — never accepted and ignored.** `ComputeSpec` carries what the
  case declared it needs: `os`, `needs`, and (since the world fields) `resources` (cpu millicores /
  memoryMb / gpu) + `network` (`public` | `none` | `allowlist`). A driver that cannot provide one of them
  throws `BadRequestError` in `provision()`, BEFORE anything runs. Silently substituting is the defect this
  rule exists for: an under-provisioned case reads as an agent that failed, and an offline-declared case
  that ran online answered a different question — and in both cases the result has the same shape as a
  valid one. `LocalDriver` therefore refuses any resource or non-`public` network declaration (a host
  process has neither), and `DockerDriver` enforces cpu/memory/gpu/`none` but refuses `allowlist` (it has
  no egress filter). Translation lives ONCE in `dockerWorldArgs` — a second container driver imports it.
- **…UNLESS THE LAYER THAT BUILT THE BOX PROVES IT ENFORCED IT** (arch-review 57 P1-high). A managed case
  runs two layers deep, and the refusal above was the only half implemented: the outer backend read
  `harnessSpec.resources` and never `evalCase.resources`, so a case declaring cpu/memory could not run on a
  managed lane AT ALL — refused by the inner driver after the container was already up. Container-task
  corpora declare one routinely. The fix is not to strip the declaration on the way in (that is a run in a
  world nobody provided, reported as an ordinary result) but to give the inner driver something to accept:
  `ProvisionedWorldProof` on the `CaseJob`, set by the backend, checked by the driver with
  `worldProofCovers`. Exact match per axis — a bigger box is a different world — and a proof SILENT on an
  axis does not cover it, so partial enforcement cannot read as enforcement. **A lane claims only what it
  really applies**: both managed lanes translate cpu/memory/gpu into the unit's own request+limit and claim
  that; neither writes a NetworkPolicy or a task network block, so NEITHER claims `network`, and an
  offline-declared case still meets the refusal. Claiming an unenforced axis is worse than the defect.
- Absence keeps its meaning: no declaration = the runtime's default box and ordinary network, exactly as
  before the fields existed. `isEmptyResourceRequest`/`isDefaultNetwork` (`@everdict/contracts`) are the
  one spelling of "asks for nothing", so a driver never refuses work it could have run.
