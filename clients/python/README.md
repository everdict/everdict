# everdict (Python)

The one-call [Everdict](../../README.md) client for Python — reproduce an environment, run **N trials** of
every case, score them, and get back a **verdict** in one call. Zero dependencies (stdlib only). Mirror of
the TypeScript [`@everdict/sdk`](../../packages/sdk/README.md).

```python
from everdict import EverdictClient

everdict = EverdictClient("https://api.everdict.dev", api_key="ak_…", workspace="acme")

verdict = everdict.evaluate(
    harness="claude-code@1.0.0",                 # a registered ref, or an inline spec dict
    dataset={"id": "smoke", "version": "1.0.0", "cases": [
        {"id": "writes-file", "env": {"kind": "prompt"}, "task": "…",
         "graders": [{"id": "tests-pass", "config": {"cmd": "true"}}]},
    ]},
    trials=5,                                     # pass@k / flakiness
    runtime="self",                              # your own runner (own-pays); omit for the default
    on_progress=lambda r: print(r["status"]),
)

print(verdict["pass_rate"], verdict["pass_at_k"], verdict["flake_rate"])
```

`evaluate()` resolves a `"id@version"` ref or registers an inline spec, submits, polls to terminal, and
returns a verdict dict: `scorecard_id`, `status`, `pass_rate`, `pass_at_1` / `pass_at_k` / `flake_rate`,
`summary`, and the raw `record`.

`pass_rate` is the control plane's own `headlinePassRate` — trial-aware (`passAt1`), else the highest-authority
metric that carries a pass rate, `None` when nothing was pass-deciding. The client reads that number; it never
re-derives one from `summary`, because the ranking follows the batch's stamped verdict policy, which the client
cannot see. If the response carries no `headlinePassRate` at all (a control plane older than the served
verdict), `evaluate()` raises `EverdictError` 502 `HEADLINE_NOT_SERVED` rather than guessing — read
`record["summary"]` yourself if that is the answer you want.

Also: `diff(baseline, candidate, z=…)`, `leaderboard(dataset, …)`, `usage()`. A `{code, message}` error body
becomes an `EverdictError` carrying the HTTP `status`. Pass a `transport` (and `sleep`) to unit-test without a
network. Run the tests with `pnpm python` from the repository root, or `python3 tests/test_client.py` from this
directory — they need nothing but the interpreter (there is no `pytest` in this repository's tooling).

See `docs/architecture/one-call-sdk.md` for the design.
