---
paths: "packages/drivers/**"
---
# Driver rules (push)

A Driver = *in-sandbox compute* (`ComputeHandle`): it runs the harness as a subprocess inside an
already-isolated unit. `LocalDriver` is the only one (dev, and inside the agent). **Placement and
isolation are the Backend's job** (Nomad/K8s/Windows — see skill `backends`), not the Driver's.

- Implement the `Driver` interface from `@everdict/core`; export it by a `*Driver` name.
- The returned `ComputeHandle` MUST be releasable via `dispose()`; callers release in `finally`.
- Map failures to an `AppError` (`COMPUTE_EXEC_FAILED`); never leak a raw OS/SDK error.
- A non-zero command exit is a *result* (`{exitCode, stdout, stderr}`), not a thrown error.
