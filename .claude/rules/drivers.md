---
paths: "packages/drivers/**"
---
# Driver rules (push)

A Driver = "where a run executes". See skill `drivers`.

- Implement the `Driver` interface from `@assay/core`; export it by a `*Driver` name.
- The returned `ComputeHandle` MUST be releasable via `dispose()`; callers release in `finally`.
- Never leak the backend SDK type (E2B/KubeVirt/Tart) above the adapter — return `ComputeHandle` only.
- Map every backend failure to an `AppError` (`DRIVER_PROVISION_FAILED` / `COMPUTE_EXEC_FAILED`). No raw SDK errors escape.
- v1 = Linux only (`os: "linux"`). Windows/macOS arrive as Pool drivers (runner-agent + VM checkpoint).
