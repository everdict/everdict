# @everdict/sdk

The one-call developer surface over the [Everdict](../../README.md) control plane: reproduce an
environment, run **N trials** of every case in parallel, score them, and get back a **defensible
verdict** — in a single `await`.

Zero dependencies. The SDK never runs compute — it drives the control plane, which places work on
**your** runtime (self-hosted runner / your nomad·k8s). Your infra, our verdict.

## Install

```sh
npm add @everdict/sdk
```

## Quickstart (5 minutes)

```ts
import { EverdictClient } from '@everdict/sdk'

const everdict = new EverdictClient({
  baseUrl: 'https://api.everdict.dev', // your control plane
  apiKey: process.env.EVERDICT_API_KEY!, // ak_…
})

// Reproduce env + run 5 trials/case + score → verdict, in one call.
const verdict = await everdict.evaluate({
  harness: 'claude-code@1.0.0', // a registered harness ("id@version"), or an inline spec
  dataset: {
    // …or a registered dataset ref like 'swe-lite@1.0.0'
    id: 'smoke',
    version: '1.0.0',
    cases: [
      {
        id: 'writes-file',
        env: { kind: 'repo', source: { files: {} } },
        task: 'Create a file ok.txt containing the word done.',
        graders: [{ id: 'tests-pass', config: { cmd: 'test -f ok.txt' } }],
      },
    ],
  },
  trials: 5, // pass@k / flakiness
  runtime: 'self', // place on your own runner (own-pays). Omit for the control-plane default.
  onProgress: (r) => console.log(r.status), // live: queued → running → succeeded
})

console.log(verdict.passRate) // trial-aware: pass@1 when trials ran
console.log(verdict.passAtK, verdict.flakeRate)
```

`evaluate()` resolves a string ref or registers an inline spec, submits the batch, polls to terminal,
and reduces the result to a `Verdict`:

```ts
interface Verdict {
  scorecardId: string
  status: string // succeeded | failed | superseded
  passRate: number | null // trialSummary.passAt1 when trials ran, else the authoritative metric
  passAt1?: number
  passAtK?: number
  flakeRate?: number
  summary: MetricSummary[]
  record: ScorecardRecord // the full record
}
```

## Compare & rank

```ts
// Regression gate — when either side ran trials, `trials` carries the statistically-gated (two-proportion) diff.
const diff = await everdict.diff('scorecard-a', 'scorecard-b', { z: 1.96 })
for (const r of diff.trials?.regressions ?? []) {
  console.log(`${r.caseId}: ${r.baselineRate} → ${r.candidateRate} (z ${r.z.toFixed(2)})`)
}

// Leaderboard — rank (harness × model) on one dataset.
const board = await everdict.leaderboard({ dataset: 'swe-lite', metric: 'tests_pass', window: 'best' })
console.table(board.rows)
```

## Auth & scope

`Authorization: Bearer ak_…` is sent on every request; pass `workspace` to target a specific workspace
(`x-everdict-workspace`), else the key's default is used. The control plane enforces authorization — a
`{ code, message }` error body becomes an `EverdictError` carrying the HTTP `status`.

## Testability

`fetch` and `sleep` are injectable, so you can unit-test flows that use the client against a fake
transport with no network and no real waiting:

```ts
const client = new EverdictClient({ baseUrl, apiKey, fetch: myFakeFetch, sleep: async () => {} })
```

See `docs/architecture/one-call-sdk.md` for the design.
