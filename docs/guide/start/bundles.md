---
kind: wiki
title: "Bundles"
status: current
updated: 2026-09-15
anchors: [apps/api/src/core/bundle/bundle-service.ts, apps/api/src/api/bundle/bundle.routes.ts, examples/bundles/codex-pinch/bundle.json]
---

> Design SSOT: [bundles.md](../../architecture/bundles.md) — the maintainer page holds the mechanism. Describe the behaviour here; do not re-derive the design.
# Bundles

Harness templates, harness instances, datasets, benchmark recipes, judges, rubrics, models and runtimes
are separate registrations. A **bundle** is any mix of them as one document you apply in a single call
— so "here is a working evaluation setup" becomes a file someone can read before running it.

```bash
cat examples/bundles/codex-pinch/bundle.json      # read it first
curl -XPOST localhost:8787/bundles/apply \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' \
  -d @examples/bundles/codex-pinch/bundle.json
```

That one call registers a Codex `command` harness (template and instance), two datasets, and a
benchmark recipe. Nothing about the control plane changed to support Codex — the specifics live in the
bundle, not in the product.

## What goes in one

```json
{
  "id": "codex-pinch",
  "version": "1.1.0",
  "description": "codex harness + pinch benchmark. Pure data — no core changes.",
  "harnessTemplates": [ { "kind": "command", "category": "cli-agent", "id": "codex", "version": "1", "command": "…" } ],
  "harnesses":        [ { "template": { "id": "codex", "version": "1" }, "id": "codex", "version": "1.0.0", "pins": {} } ],
  "datasets":         [ { "id": "pinch-dashboards", "version": "1.0.0", "cases": [ … ] } ],
  "benchmarkRecipes": [ { "id": "pinch", "version": "1.0.0", "source": "…", "mapping": { … } } ]
}
```

Every section is optional: `harnessTemplates`, `harnesses`, `datasets`, `benchmarkRecipes`, `judges`,
`rubrics`, `models`, `runtimes`. A bundle that is only a dataset is a fine bundle. Applying it needs the
permission each section would need on its own.

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

The response lists every item with a status: `ok`, `conflict`, `error` or `skipped` (no registry for
that section on this deployment). One failing item never aborts the rest.

Versions are immutable, so re-applying identical content is `ok` and rewrites nothing, while different
content under a version that already exists is a `conflict`. Bump the item's own version to publish a
change.

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
