---
kind: wiki
title: "One-call SDK — reproduce env + N trials + score → verdict in one await"
status: current
updated: 2026-09-15
anchors: [packages/sdk/src/client.ts, packages/sdk/src/types.ts, clients/python/everdict/client.py]
---
# One-call SDK — reproduce env + N trials + score → verdict in one await

The packaged one-call developer experience over the control plane: `@everdict/sdk` (`packages/sdk`, TypeScript)
and its Python mirror (`clients/python`). Both are thin, zero-dependency clients; neither is published
(`packages/sdk/package.json` is `private`).

## Why

The differentiator is bundling **environment reproduction + parallel N-trial execution + scoring** into *one
call* that returns a defensible **verdict**. The control plane already does the hard parts (trials/pass@k, the
scorecard pipeline), but using it directly is several HTTP calls: register a harness, register a dataset,
`POST /scorecards`, then poll `GET /scorecards/:id`. The on-ramp friction is the DX, not the infra.

## Design — compose existing endpoints, no backend change

`evaluate({ harness, dataset, trials?, judges?, runtime?, poll?, onProgress?, campaignEvaluation? })`:
1. **Resolve refs.** `harness`/`dataset` may be a string ref (`"id@version"`, version defaulting to `latest`) or an
   inline object, which is registered first (`POST /harnesses` / `POST /datasets`). `POST /harnesses` accepts only
   a harness **instance** (`{template, id, version, pins}` on a registered template —
   [harness-taxonomy](./harness-taxonomy.md)), so an inline harness must have that shape.
2. **Submit.** `POST /scorecards { dataset, harness, trials?, judges?, runtime?, campaignEvaluation? }`.
3. **Poll.** `GET /scorecards/:id` until terminal (`succeeded`/`failed`/`superseded`), with an injectable interval
   (default 2s) and timeout (default 30 min, then an `EverdictError` 408); `onProgress` receives every polled
   record.
4. **Verdict.** Reduce the record to a `Verdict`: `passRate` = the server-computed `headlinePassRate`,
   `passAt1`/`passAtK`/`flakeRate` from `trialSummary` when the batch ran trials, the raw `summary`, and the full
   record.

Beside `evaluate`, the client exposes `registerDataset`, `registerHarness`, `submitScorecard`, `getScorecard`,
`poll`, `diff(baseline, candidate, {z?})` (`GET /scorecards/diff`) and `leaderboard(query)`
(`GET /scorecards/leaderboard`).

Zero dependencies (no `@everdict/*`, no zod): the client mirrors just the response fields it reads with plain TS
interfaces; the **server remains the validation authority** (a `{code,message}` error body becomes an
`EverdictError` with the HTTP status). `fetch` and `sleep` are injectable, so the flow is unit-tested against a
fake transport (`packages/sdk/src/client.test.ts`).

## Auth & scope

`new EverdictClient({ baseUrl, apiKey, workspace? })` sends `Authorization: Bearer ak_…` and, when set,
`x-everdict-workspace`. An API key resolves to the issuer's identity + role on the control plane (rule `auth`);
the SDK never decodes it.

## Python client

`clients/python/everdict/client.py` mirrors the same surface in stdlib-only Python: `evaluate`, `poll`, `diff`,
`leaderboard`, the register/submit/get calls, and `usage()` (`GET /usage`, the workspace's metered usage). One
difference: its verdict `pass_rate` is derived client-side (`_headline_pass_rate`: `trialSummary.passAt1`, else an
authority-ordered metric list), not read from `headlinePassRate`.

## Margin / pricing (the BYOC-as-strength position)

The SDK deliberately does **not** run compute — it drives the control plane, which places work on the tenant's
**own** runtime (self-hosted runner / registered nomad·k8s). So the billable surface is **orchestration +
verdict**, not resold compute. No verdict-call metering or quota surface exists beyond `GET /usage`.

## Non-goals

- Re-implementing scoring/trials in the client — the verdict is computed server-side; the SDK only reduces the
  response.
- A new inline-spec submit endpoint — `evaluate()` registers-then-submits.
- Bundling compute — the SDK never provisions a sandbox; placement stays the control plane's job.
