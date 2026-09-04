---
kind: wiki
title: "The documentation site — information architecture (plan)"
status: current
updated: 2026-08-11
---
# The documentation site — information architecture (plan)

> The repo has 121 markdown files and 288,654 words. Almost none of it is documentation a
> newcomer can read. This plan says what the public docs site is made of, what has to be
> written before it opens, and where the 121 existing files land.

Stack decision (settled): **Docusaurus 3** built from this monorepo, deployed to **GitHub Pages**
via Actions. The app lives in `site/` (replacing the current hand-written static HTML); content
stays where it is under `docs/`, consumed through the plugin's `path` option — no file moves, no
sync script, no duplicated source of truth.

## 1. The finding that shapes everything

`docs/` is an **engineering design record**, not product documentation:

| Group | Files | What it is |
| --- | ---: | --- |
| `docs/architecture/**` | 89 | design records — 11 titled `(design)`, 20 `— collaboration model`, 21 under `rearchitecture/` |
| `docs/*.md` (root) | 24 | the closest thing to reference docs (api, auth, datasets, judges, scorecards, runtimes, …) |
| `docs/migration/**` | 6 | migration preflight notes |
| `docs/runbooks/**` | 2 | operator runbooks |

Missing entirely: install, quickstart, concepts, glossary, CLI reference, a self-hosting path.
The only quickstart in the repo is a section of the root `README.md`.

Peer projects keep these two things apart. Mastra publishes `docs/src/content/en/{docs,guides,reference}`
and keeps exploratory design in `explorations/` and `.dev/`. Langfuse and promptfoo publish no
design records at all. Everdict is inverted: 74% of the corpus is the part peers do not publish.

So the site is **not** "render `docs/`". It is: publish a small, written-for-users tree, and publish
the design record beside it, clearly labelled as such.

## 2. Section layout — four content plugins

| Route | Source | Audience | State |
| --- | --- | --- | --- |
| `/docs` | `docs/guide/**` | adopters, operators | **14 pages written** (start · concepts · self-host) |
| `/guides` | `docs/guide/tutorials/**` | someone with a task | to be written |
| `/reference` | `docs/*.md` (the 24 root files) + generated + `docs/migration/**` | someone with the API open | in place, partly generated later |
| `/internals` | `docs/architecture/**` (89 files, unchanged) | maintainers, agents | publish as-is |

### 2.0 Why nothing existing moves

The obvious tidy — relocate the 24 root docs into `reference/` and `architecture/` into `design/` —
was measured and rejected. This codebase **cites its documentation from its code**: an invariant names
the design record that justifies it. A sweep counts **988 references to `docs/architecture/**`** (353
`.ts` files, 38 migrations, 21 live scripts) and **461 to the root docs** (`tracker.md` 94, `web.md`
71, `trust-certification.md` 51). Moving either group rewrites ~450 source files for a gain the index
and the site's section split already deliver.

So the structure grows a layer instead of shuffling one: `docs/guide/` is new and holds the
user-facing tree; everything that was there stays where the code expects to find it.

The same count is why the document TAXONOMY is frontmatter rather than a directory per kind. See
[document-kinds.md](document-kinds.md): four kinds (`wiki` · `decision` · `spec` · `runbook`), each
with what it owes and how it is allowed to change, checked by `pnpm docs-check` — and applied without
moving a single file, so the 988 references above stay valid.

Four separate `@docusaurus/plugin-content-docs` instances, each with its own `sidebars.ts` — the
mastra arrangement. `/internals` carries a banner ("design records, not product documentation;
they describe intent at the time of writing") and `noindex`, so it never competes with `/docs` in
search results.

### 2.1 `/docs` tree

Categories are grouped by **verb**, and every category's sidebar link is its own `overview` page
(mastra's pattern — a category is never a dead click).

```
Get started
  What is Everdict            ← new
  Quickstart (compose)        ← new, from README §Quickstart + deploy/compose
  Your first scorecard        ← new
  Connect an agent (MCP)      ← new, from README §Connect an agent + docs/mcp.md
Core concepts                 ← new, 7 pages, the vocabulary everything else assumes
  Run · Harness · Dataset · Grader & Judge · Scorecard · Verdict · Workspace (tenant = trust zone)
Evaluate
  overview · harnesses · datasets · judges · scorecards · suites & regression
  views · trials and pass@k
Execute
  overview · runtimes · backends vs drivers · self-hosted runner · desktop app
  service topologies · worlds
Observe
  overview · traces (OTel) · trace sources · trace sinks · live observability · notifications
Organize
  overview · tracker (Initiative ⊃ Project ⊃ Issue) · product timeline · knowledge · agents
Self-host
  overview · install · auth (Keycloak) · secrets · database & migrations · multi-replica
  behind a corporate proxy · usage metering · trust certification
Security & tenancy
```

`Self-host` is a top-level category rather than a leaf, following langfuse — for an OSS project it
is the section that decides adoption, and it is the one everdict currently has no entry point for.

### 2.2 `/guides`

Task-shaped, each one end-to-end and runnable. Seed set, drawn from what `examples/` already holds
(`agents`, `benchmarks`, `bundles`, `datasets`, `github-action`, `harness-templates`, `runtimes`,
`servers`, `task-formats`):

- Bring your own CLI agent (no code) — from `docs/command-harness.md`
- Bring an existing agent benchmark — from `docs/architecture/standard-task-formats.md`
- Gate a pull request on an eval — from `docs/architecture/github-actions-trigger.md`
- Run evals on your own machine — from `docs/architecture/self-hosted-runner.md`
- Score traces you already have (no harness run) — from `docs/scorecards.md` ingest sections
- Write a judge

### 2.3 `/reference`

Exhaustive and, where possible, **generated** — a hand-maintained reference for a surface this size
rots within a release:

- HTTP API — generated from the Fastify OpenAPI document (`apps/api`)
- MCP tools — generated from the tool registry (BFF↔MCP parity makes this a table, not prose)
- CLI — generated from `apps/cli` command definitions
- Configuration / environment variables
- Migrations — `docs/migration/**` as-is

## 3. Rules for the content work

1. **One page, one audience.** Today's root docs mix both: `docs/scorecards.md` (6,182 words) opens
   as a user explanation and ends in internal mechanics. The split is the work — the user-facing part
   moves to `/docs`, the rest stays in `/internals` and is linked, not copied.
2. **Length ceiling ~1,500 words.** Peer pages run 500–1,500. `docs/service-harness.md` is 17,121 —
   that is a category, not a page. Splitting candidates, by size: service-harness (17.1k),
   tracker (9.4k), capability-store (7.0k), trust-certification (6.3k), scorecards (6.2k),
   execution-model (6.2k), web (5.1k).
3. **Frontmatter only where it earns its keep.** Docusaurus takes the title from the first `# h1`,
   so the 89 internals files publish untouched. New and re-arranged `/docs` pages get
   `title`/`description`/`sidebar_label`.
4. **Sidebars are hand-written, and CI enforces completeness.** A `validate-sidebar-docs` script
   (mastra has exactly this) fails the build when a file under `docs/` appears in no sidebar. That is
   what makes the repo rule "docs travel with the code" mechanically true instead of aspirational.
5. **Code references must resolve.** A sweep in this tree found 68 of 121 documents citing paths that
   no longer exist — nearly all of them casualties of the re-architecture (`packages/core` →
   `contracts`/`domain`, `suite`/`run-case`/`billing` folded in, `apps/api/src/execution/**` →
   `packages/application-control/**`). 97 references were rewritten to their current homes and the
   index rebuilt; what remains is confined to the historical records below. Keeping it at zero is what
   the `validate-docs` check in D4 is for.

## 4. Sequencing — content first, deploy last

| Phase | Output | Blocking? |
| --- | --- | --- |
| **D0** | ~~Correctness sweep~~ **DONE** — dead code references rewritten, the 19 re-architecture records relabelled `HISTORICAL`, superseded facts corrected (runtime kinds are `local\|nomad\|k8s`; the 0023 connections migration is superseded), and `README.md` rebuilt as a complete index: 0 orphans, 0 broken links across all 121 files | — |
| **D1** | ~~Write the minimum set that makes a site worth opening~~ **DONE** — `docs/guide/`: 4 Get-started + 7 Core-concepts + 2 section indexes + Self-host overview = **14 pages**, 153–765 words each, every code reference verified | — |
| **D2** | Publish the 24 root docs as `/reference` (frontmatter + slugs, no file moves); split the 7 oversized pages | no |
| **D3** | Publish `/internals` — 89 files as-is, banner + `noindex` | no |
| **D4** | ~~Add the documentation gate to CI~~ **DONE** (`scripts/check-docs.mjs` → `pnpm docs-check`, wired into `ci.yml` + `ci:local` + `docs.yml`). Still open: generate `/reference` from OpenAPI + the MCP registry + the CLI | no |
| **D5** | ~~Docusaurus app + Pages workflow + strict link check~~ **DONE** — `site/` builds 136 doc pages with `onBrokenLinks: 'throw'`; `.github/workflows/docs.yml` deploys to Pages | — |

The D0 sweep also produced the audience split D0 was meant to establish: `docs/architecture/rearchitecture/**`
(19 files) is `internal/historical`, the 24 root docs are the `user` candidates, and the remaining
`docs/architecture/**` is `internal` — living, but written for maintainers.

D1 is the real gate. A docs site whose front door is a design record for splitting `server.ts` is
worse than no docs site.

## 4a. What the first build actually cost

Four things blocked the build; each is now pinned in `site/docusaurus.config.ts` with the reason:

1. **MDX vs CommonMark.** Docusaurus parses `.md` as MDX v3, which reads a literal `<total>` in prose
   as a JSX tag and `{skipped}` as an expression. This tree is CommonMark written for github.com, so
   `markdown.format: 'md'` is not a preference — the content is the constraint. Two `{…}` tokens that
   MDX still evaluates were escaped into backticks at the source, which reads better on GitHub anyway.
2. **webpack ≥ 5.109 tightened the ProgressPlugin schema** and Docusaurus 3.9.2 fails against it;
   3.10.2 is the floor.
3. **Cross-instance links.** Four plugin instances (the mastra shape) would have broken every relative
   `.md` link that crosses sections — Docusaurus resolves those only *within* an instance. One instance
   with three sidebars keeps `onBrokenLinks: 'throw'` reachable.
4. **The static homepage is not a route.** Docusaurus copies `static/index.html` but does not register
   `/`, so the navbar brand read as a broken link. An absolute href states the truth rather than
   weakening the check.

Only one genuine content bug surfaced: a directory link (`../architecture/`), which resolves on
github.com and has no page on the site. The gate now rejects directory links for that reason.

## 5. GitHub Pages specifics

- `baseUrl: '/'` with a custom domain, or `'/everdict/'` on `everdict.github.io` — decided when the
  domain is.
- Build + deploy in a dedicated workflow filtered on `paths: ['docs/**', 'site/**']`, so the root
  `ci.yml` (the CI SSOT that `pnpm ci:local` mirrors) is untouched and push-gate parity holds.
- No per-PR preview URLs on Pages. The compensation is a PR job that runs `docusaurus build` with
  `onBrokenLinks: 'throw'` plus a link check — a broken docs PR fails before merge even though no
  preview exists.
- `llms.txt` (mastra ships a plugin for it and advertises it with a `Link: </llms.txt>; rel="llms-txt"`
  header) is high value here specifically: everdict's users arrive with agents.

## 6. Deliberately out of scope for v1

Versioned docs (Docusaurus versioning), i18n (`ko` locale), Algolia DocSearch, an "Ask AI" widget.
Each is a switch that can be thrown later; none of them help until D1 exists.
