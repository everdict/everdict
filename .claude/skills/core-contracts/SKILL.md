---
name: core-contracts
description: The @everdict/core dependency root — interfaces, Zod schemas, and the AppError model that every other package builds on. No I/O, no SDKs. Use when editing packages/core (contracts/schemas/errors).
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Core contracts (the dependency root)

`packages/core` is where every contract lives: pluggable-adapter **interfaces** + paired **Zod
schemas** + the **AppError** hierarchy. Pure types only — no I/O, no SDK imports, no reverse deps.
Re-exported flat from `packages/core/src/index.ts`.

## Checklist
1. New contract? Write the **Zod schema first** (SSOT), derive the type with `z.infer`. Export both.
2. Add the `export * from "./<file>.js"` line to `packages/core/src/index.ts`.
3. Interface (many impls) vs schema (data over the wire) — pick deliberately (see below).
4. Failures throw an `AppError` subclass from `errors.ts`; never a bare `Error`, never a raw SDK error.
5. No `any`, no `!`, no silent nullable default (`?? ""`); named exports; `import type` for types.
6. Verify no forbidden import crept in: `core` may not touch drivers/harnesses/graders/runner/apps/SDKs.

## Interfaces ARE used here (deliberate inversion)
Single-impl codebases ban interfaces (one impl per concept); Everdict's whole product is pluggable adapters, so the
spine contracts MUST be interfaces — many impls live in adapter packages, the interface lives in `core`.
- `EvaluableHarness` — the agent under test (`harness.ts`); `install`+`run`→`AsyncIterable<TraceEvent>`.
- `Environment<S>` — the world it acts on (`environment.ts`); `seed(spec)` → `snapshot()` → `EnvSnapshot`.
- `Driver` + `ComputeHandle` — in-sandbox compute (`compute.ts`); `provision(ComputeSpec)`→handle.
- `Grader` — scoring, fully separate from the harness (`grader.ts`); `grade(GradeContext)`→`Score`.
- (`Backend`, the placement analog, is one more — but it lives in `@everdict/backends`, not `core`.)
`ComputeHandle` holds a real sandbox: callers always `dispose()` in a `finally` (contract, not impl).

## The spine, file by file
- **Harness** — `packages/core/src/harness/harness.ts`: `EvaluableHarness` + `RunContext`. Process-boundary, so
  the harness may be any language; its native output is normalized to `TraceEvent`.
- **Environment** — `packages/core/src/execution/environment.ts`: `EnvSpec` (repo|browser|prompt|os-use) and
  `EnvSnapshot` are **discriminated unions on `kind`** — add a variant, don't rewrite core.
- **Driver/Compute** — `packages/core/src/execution/compute.ts`: `Driver`, `ComputeHandle`, `ComputeSpec`,
  `ExecResult`, `Capability` (`shell|browser|desktop`). Isolation is the Backend's job, not the Driver's.
- **Grader** — `packages/core/src/execution/grader.ts`: `Score{graderId,metric,value,pass?}` + `GradeContext`.

## Error model (`packages/core/src/errors.ts`)
`AppError` is abstract; each subclass fixes `readonly status` → **HTTP status derives from the subtype**,
never from the `ErrorCode`. `BadRequestError` 400 · `NotFoundError` 404 · `ConflictError` 409 ·
`UnauthenticatedError` 401 · `ForbiddenError` 403 · `RateLimitError` 429 · `PaymentRequiredError` 402 ·
`UpstreamError` 502 · `InternalError` 500. External/SDK failures are **remapped** to an `AppError`
(usually `UpstreamError`) so monitoring blames us, not the user — never propagate a raw error across a
package boundary. `toEnvelope()` produces the flat `{code,message,data}` wire shape.

## Zod at every boundary
Schema is the source of truth; the type is `z.infer`. `.parse()` throws on a bad enum — **no fallback,
no default-to-first**. Discriminated unions carry the shape variants:
- `HarnessSpecSchema` (`harness-spec.ts`) — `process | service | command`. `command` = declarative CLI
  agent (no code). `service` carries topology (`TopologyService`, `FrontDoorSpec`, `TraceSourceSpec`).
- `HarnessTemplateSpec` + `HarnessInstanceSpec` (`harness-template.ts`) — template (structure, versioned by
  shape) + `pins`/`overrides` (deltas); `resolveHarnessInstance()` merges → a resolved `HarnessSpec`,
  throwing `BadRequestError` on a missing/mismatched slot.
- `EvalCase` (`eval-case.ts`) — case bundle (env, task, graders, image?); also `CaseResult`/`Scorecard`.
- `AgentJob` (`agent-job.ts`) — one dispatched unit; `tenant`/`submittedBy` key the SaaS machinery.
- `TraceEvent` (`trace.ts`) — union on `kind` (message/llm_call/tool_call/…); cost comes from here.
- `RuntimeSpec` (`runtime-spec.ts`) — `local | nomad | k8s` execution infra; **never store secrets**
  (only SecretStore key *names* like `authSecret`).

## Capability & trust-zone vocab
- `packages/core/src/infra/capability.ts` — SSOT `CAPABILITY_DEFS` keyed by `kind`: **functional**→placement gate
  (`functionalGate`/`runtimeSatisfies`), **security**→trust-zone, **auth**→budget. Adding a capability is
  one line here; the kind's layer then enforces it. `CapabilityNameSchema` rejects vocabulary outsiders.
- `packages/core/src/infra/trust-zone.ts` — `TrustZone` + `assertHardenedIsolation()`: untrusted tenants (arbitrary
  eval code) are forced onto a hardened runtime (never shared-kernel `runc`). Label ≠ enforcement.

See `packages/core/src/index.ts` for the full export list and the `foundation` skill for module
boundaries; rule `core-contracts.md` has the inlined push rules (no I/O, schema = SSOT, interfaces here).
