# Bundles

A harness, a dataset, a runtime and a grading recipe are four registrations. A **bundle** is all of
them as one document you apply in a single call — so "here is a working evaluation setup" becomes a
file someone can read before running it.

```bash
cat examples/bundles/codex-pinch/bundle.json      # read it first
curl -XPOST localhost:8787/bundles/apply \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' \
  -d @examples/bundles/codex-pinch/bundle.json
```

That one call registers a Codex `command` harness, two datasets, and a benchmark recipe. Nothing about
the control plane changed to support Codex — the specifics live in the bundle, not in the product.

## What goes in one

```json
{
  "id": "codex-pinch",
  "version": "1.1.0",
  "description": "codex harness + pinch benchmark. Pure data — no core changes.",
  "harnessTemplates": [ { "kind": "command", "id": "codex", "version": "1", "command": "…" } ],
  "harnesses":        [ { "template": { "id": "codex", "version": "1" }, "id": "codex", "version": "1.0.0", "pins": {} } ],
  "datasets":         [ { "id": "pinch-dashboards", "version": "1.0.0", "cases": [ … ] } ],
  "benchmarkRecipes": [ { "id": "pinch", "source": "…", "mapping": { … } } ]
}
```

Every section is optional. A bundle that is only a dataset is a fine bundle.

## Why this exists

It is a design commitment, not a convenience: **benchmark- and harness-specific knowledge stays out of
the core.** Supporting a new agent or a new benchmark should be a data file someone contributes, not a
package release.

Two things follow that you will feel immediately:

- **It is reviewable.** A bundle is a diff. You can see what an eval setup registers before you run it,
  which is not true of a setup script.
- **It is portable.** The same file applies to a colleague's workspace, a CI environment, and a
  self-hosted install, producing the same registrations.

## Applying is idempotent by version

Re-applying the same bundle is a no-op — versions are immutable, so a registration that already exists
is not rewritten. Bump the version inside the bundle to publish a change.

:::warning
Read a bundle before applying it, the same way you would read a shell script before piping it to bash.
It registers harnesses that will execute commands on your runtime.
:::

## Writing your own

Start from a shipped one and replace the parts that are yours:

```bash
cp -r examples/bundles/codex-pinch my-bundle
$EDITOR my-bundle/bundle.json
curl -XPOST localhost:8787/bundles/apply -H 'content-type: application/json' -d @my-bundle/bundle.json
```

The most useful bundle a team writes is usually its own house setup — the harness for the agent they
ship, the dataset that mirrors their traffic, and the runtime they run it on — so a new engineer gets
the whole evaluation environment in one command.

## See also

- [Bring your own agent](bring-your-agent.md) — the pieces a bundle assembles
- [Running Codex](../integrations/codex.md) — the bundle on this page, end to end
- [`../../architecture/bundles.md`](../../architecture/bundles.md) — the design record
