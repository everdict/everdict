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
returns a verdict dict: `scorecard_id`, `status`, `pass_rate` (trial-aware), `pass_at_1` / `pass_at_k` /
`flake_rate`, `summary`, and the raw `record`.

Also: `diff(baseline, candidate, z=…)`, `leaderboard(dataset, …)`, `usage()`. A `{code, message}` error body
becomes an `EverdictError` carrying the HTTP `status`. Pass a `transport` (and `sleep`) to unit-test without a
network. Run the tests with `python3 -m pytest` from this directory.

See `docs/architecture/one-call-sdk.md` for the design.
