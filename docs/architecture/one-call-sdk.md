# One-call SDK — reproduce env + N trials + score → verdict in one await

> Status: **M3 in progress.** Slice 1 (`@everdict/sdk` client + `evaluate()`) landed; later slices add
> language ports, a quickstart, and the pricing surface. SSOT for the packaged one-call developer
> experience over the control plane.

## Why

The market thesis's differentiator is bundling **environment reproduction + large parallel N-trial
execution + scoring** into *one call* that returns a defensible **verdict**. The control plane already
does the hard parts (M1 trials/pass@k, M2 standard-format on-ramp, the whole scorecard pipeline), but
using it today is several HTTP calls: register a harness, register a dataset, `POST /scorecards`, then
poll `GET /scorecards/:id`. The on-ramp friction is the DX, not the infra.

`@everdict/sdk` closes that: a thin, **zero-dependency** typed client whose `evaluate()` composes the
existing endpoints into a single `await` → a `Verdict`.

## Design — compose existing endpoints, no backend change

`evaluate({ harness, dataset, trials, judges?, runtime? })`:
1. **Resolve refs.** `harness`/`dataset` may be a string ref (`"id@version"`) or an inline spec. An
   inline spec is registered first (`POST /harnesses` / `POST /datasets`); a string is used as-is.
2. **Submit.** `POST /scorecards { dataset, harness, trials, judges?, runtime? }` → a queued record.
3. **Poll.** `GET /scorecards/:id` until terminal (`succeeded`/`failed`/`superseded`), with an
   injectable interval + timeout.
4. **Verdict.** Reduce the record to a headline `Verdict` — `passRate` (trial-aware: `trialSummary.passAt1`
   when the batch ran trials, else the authoritative metric's pass rate), `passAt1`/`passAtK`/`flakeRate`
   when present, the raw `summary`, and the full record.

Zero dependencies (no `@everdict/*`, no zod): a published SDK should be light. The client mirrors just the
response fields it reads with plain TS interfaces; the **server remains the validation authority** (a
`{code,message}` error body becomes an `EverdictError` with the HTTP status). `fetch` and `sleep` are
injectable, so the whole flow is unit-tested against a fake transport with no network and no real waiting.

## Auth & scope
`EverdictClient({ baseUrl, apiKey, workspace? })` sends `Authorization: Bearer ak_…` and, when set,
`x-everdict-workspace`. An API key resolves to the issuer's identity + role on the control plane
(rule `auth`); the SDK never decodes it.

## Margin / pricing (the BYOC-as-strength position)
The SDK deliberately does **not** run compute — it drives the control plane, which places work on the
tenant's **own** runtime (self-hosted runner / registered nomad·k8s; own-pays). So the billable surface is
**orchestration + verdict**, not resold compute — the thin-margin trap the thesis warns about. BYOC stops
being a risk and becomes the pitch: *your infra, our verdict*. A concrete pricing/quota surface (metering
the verdict calls, not the CPU) is a later slice on top of the existing `BudgetTracker`.

## Slices
1. **`@everdict/sdk` client + `evaluate()`** (this doc + client + fake-fetch tests). ✅ Zero-dep, green.
2. **Quickstart** — a 5-minute example (inline scripted harness + tiny dataset + `trials`) + README.
3. **Ergonomics** — streaming progress (poll → step callbacks), `diff()` / `leaderboard()` helpers,
   typed harness/dataset builders.
4. **Pricing surface** — meter verdict calls (not compute) via `BudgetTracker`; expose usage/quota.
5. **Ports** — a Python client mirroring the same `evaluate()` shape (the SDK contract is language-agnostic).

## Non-goals (for now)
- Re-implementing scoring/trials in the client — the verdict is computed server-side; the SDK only reduces
  the response.
- A new inline-spec submit endpoint — `evaluate()` registers-then-submits, so no control-plane change.
- Bundling compute — the SDK never provisions a sandbox; placement stays the control plane's job.
