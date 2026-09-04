---
kind: decision
title: "Documentation ships in the repository — the published site is removed"
status: accepted
updated: 2026-09-04
anchors: [scripts/check-docs.mjs]
---
# Documentation ships in the repository — the published site is removed

> **What this decides.** `docs/` is read in the repository and on github.com, and nothing is published to
> GitHub Pages. The Docusaurus app (`site/`), its workflow and its homepage are deleted. This supersedes
> [docs-site.md](docs-site.md), which planned the site; the part of that page that was never about the site
> is carried forward below, because a live decision still rests on it.

## Why

The site was a second surface for one body of text, and a second surface is a second thing to be wrong. It
cost:

- **A build nobody could run as part of the gate.** site is not a pnpm-workspace member, so `pnpm ci:local`
  never touched it and .github/workflows/docs.yml was the only thing that ever built it. A documentation
  change went green locally and could still fail in a workflow the author had no way to reproduce.
- **A second index.** `docs/README.md` orders the tree and site/sidebars.ts ordered it again by hand for the
  root pages. Two readers of one question is one reader too many, and the hand-ordered half is the one that
  silently falls behind.
- **A second theory of what a page is.** The site's section split (`/docs` · `/guides` · `/reference` ·
  `/internals`) is a fifth classification laid over a tree that now declares its own in frontmatter — see
  [document-kinds.md](document-kinds.md). Two taxonomies over one corpus is the drift that page was written
  to end, arriving from the other direction.

None of that is a Docusaurus complaint. The site worked. It was a duplicate, and the duplicate is what made
it confusing.

## What survives from the superseded page

[docs-site.md](docs-site.md) §2.0 measured something that has nothing to do with publishing, and it is still
load-bearing: **this codebase cites its documentation from its code.** A sweep counted **988 references to
`docs/architecture/**`** (353 `.ts` files, 38 migrations, 21 live scripts) and **461 to the root docs**
(`tracker.md` 94, `web.md` 71, `trust-certification.md` 51).

That count is why the tree is not reorganised — not by section, and not by document kind. `document-kinds.md`
rests on it directly: the taxonomy is frontmatter precisely because applying it must not move a file. The
count outlives the site, so it is restated here rather than left inside a superseded page.

## What was removed, and what to do if you want it back

    site/                              the Docusaurus app, its config, the hand-ordered sidebar, the homepage
    .github/workflows/docs.yml         build + GitHub Pages deploy, and the PR job that ran the same build
                                       with onBrokenLinks: 'throw'
    site/static/img/*.webp             six product screenshots nothing referenced

The two screenshots the root `README.md` actually uses moved to `docs/assets/img/`. Everything else is in git
history; nothing here is unrecoverable, and reviving the site means restoring those paths and re-adding the
workflow.

**Two things live outside this repository and are not changed by deleting files.** A workflow that no longer
exists cannot report a check, so if **Docs site** was a REQUIRED status check in branch protection it must be
removed there, or every pull request waits forever on a job nobody will run. And whatever GitHub Pages last
published stays served until Pages is disabled in repository settings — the deploy stops, the deployed copy
does not.

## What is lost, said plainly

- **Dead-link checking across the rendered site.** The PR job built with `onBrokenLinks: 'throw'`.
  `pnpm docs-check` covers the same ground for markdown — every document reachable from the index, every
  relative link resolving to a file, every cited repository path alive — and it runs in the main gate, which
  the site build never did. What is genuinely gone is the check on links *Docusaurus* would have rewritten.
- **A public URL for the documentation.** Read it in the repository. If a public surface is wanted later it is
  a new decision, and it should start by saying which single tree is authoritative.
- **Search, versioning and the guide's rendered navigation.** Real, and the reason to reopen this.

## What would reopen it

- **Documentation becoming a product surface for people outside the repository.** The guide (`docs/guide/`)
  was written for someone using Everdict, not maintaining it, and a user who has to clone a monorepo to read
  it is being asked for too much. The moment there are such users, this decision is wrong.
- **The tree outgrowing one index.** `docs/README.md` orders 177 documents today. It is the only navigation
  there is now, so if it stops being usable, the answer is either a generated index or the site again.
