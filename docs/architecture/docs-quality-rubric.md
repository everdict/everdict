---
kind: wiki
title: "Documentation quality rubric — scoring against Mastra"
status: current
updated: 2026-08-11
---
# Documentation quality rubric — scoring against Mastra

> This page is the instrument that says *how* not-good the documentation is, in numbers that move, so
> improvement is a measured activity rather than a feeling. The benchmark is
> [mastra.ai/docs](https://mastra.ai/docs), chosen by the maintainer.
>
> ⚠️ **The instrument is out of date and the gap number is not comparable until it is re-weighted.** It
> was written against a published Docusaurus site, which [docs-site-removal.md](docs-site-removal.md)
> removed. **D6 Findability** (10) and **D7 Visual design** (10) score a surface that no longer exists,
> and rounds **R4** (Algolia search) and **R5** (homepage and theme) cannot be built. The content
> dimensions — D1 · D2 · D3 · D5, and most of D4 — are unaffected and still say what to do first.
>
> **Target: close the gap to ≤ 5 points.** Re-score after every round; a round that does not move a
> number did not happen.

## 1. How scoring works

Seven dimensions, each scored 0–10 against written anchors, weighted to 100. Where a dimension can be
counted, it is counted — a score that rests on taste alone is a score nobody can argue with, and this
document exists to be argued with.

| # | Dimension | Weight | What it measures |
| --- | --- | ---: | --- |
| D1 | **Executable content** | 20 | Can a reader run what they just read? |
| D2 | **Surface coverage** | 15 | Does every capability a user meets have a page? |
| D3 | **Onboarding path** | 15 | How long from landing to first working result? |
| D4 | **Page craft** | 15 | Progressive disclosure, callouts, diagrams, tabs |
| D5 | **Voice** | 15 | Written *for a reader*, or extracted *from code*? |
| D6 | **Navigation & findability** | 10 | Search, cross-links, "where am I" |
| D7 | **Visual design** | 10 | Homepage and docs theme as a product surface |

## 2. Anchors

Each dimension's 2 / 5 / 8 / 10 anchors, so two people scoring separately land within a point.

**D1 — Executable content**
- 2: concepts explained in prose and tables; code appears only in a quickstart.
- 5: most task pages carry one example; concept pages carry none.
- 8: every concept page opens with a runnable example; ≥3 examples per page; copy-paste works.
- 10: examples are complete files with paths, multiple package managers, and an expected output.

**D2 — Surface coverage**
- 2: the primitives are documented; whole product areas are absent.
- 5: most areas have a page; several user-visible surfaces are missing.
- 8: every surface a user can click or call has a page.
- 10: plus integration pages per external tool, and an explicit "not supported" list.

**D3 — Onboarding path**
- 2: reader must assemble the path themselves.
- 5: a quickstart exists but first success needs several manual steps.
- 8: one command to a running system; a second to a first result; both verified in the page.
- 10: plus templates/examples to clone, and framework-specific on-ramps.

**D4 — Page craft**
- 2: flat prose plus dense tables; no callouts, no diagrams.
- 5: occasional callouts; structure is uniform regardless of content.
- 8: progressive disclosure, admonitions used semantically, diagrams where structure matters.
- 10: plus tabs for alternatives, collapsible depth, and inline navigation between related pages.

**D5 — Voice**
- 2: reads as a summary of the implementation; assumes the reader already knows the domain.
- 5: correct and readable, but every page is the same shape and nothing is motivated.
- 8: each page answers a question a real user has, in their words, and says when *not* to use a thing.
- 10: plus worked scenarios end-to-end and honest limitations.

**D6 — Navigation & findability**
- 2: one index page; no search.
- 5: sidebars and cross-links; no search.
- 8: full-text search, sensible grouping, related-page links.
- 10: plus AI-assisted search and per-section landing pages.

**D7 — Visual design**
- 2: default theme, no product identity.
- 5: themed colors; homepage is a wall of text.
- 8: coherent identity across homepage and docs, real product imagery, responsive.
- 10: plus motion/interaction that carries meaning, and a homepage that converts.

## 3. Baseline — 2026-08-11

Measured on `docs/guide/**` (14 pages) and <https://everdict.github.io/everdict/> against
<https://mastra.ai/docs>.

| Dim | Mastra | Everdict | Evidence |
| --- | ---: | ---: | --- |
| D1 Executable | 9 | **2** | Mastra's `agents/overview` carries **8** runnable TypeScript examples in ~1,900 words. Ours: **7 of 8 concept pages have 0 code blocks**; the whole guide has 13 blocks across 14 pages, most of them `curl`. |
| D2 Coverage | 9 | **3** | No page for: workspace agents · workspace filesystem · image registry · environments · MCP (guide-level) · Claude Code plugin · Codex plugin. All seven exist as product surfaces. |
| D3 Onboarding | 9 | **5** | Mastra: one `create` command scaffolds a project, then a framework on-ramp. Ours: compose up, then hand-write a `curl` with a nested JSON body. No template to clone. |
| D4 Craft | 8 | **2** | Ours: **0 diagrams**, callouts on 2 of 14 pages, and up to **15 tables on a single page** — tables used as a substitute for explanation. |
| D5 Voice | 8 | **3** | Ours reads as extracted-from-code: definitions and property lists, no scenario, no "when not to". |
| D6 Findability | 9 | **4** | Mastra: Algolia + an Ask-AI assistant. Ours: three sidebars, no search at all. |
| D7 Design | 9 | **4** | Mastra: a designed homepage and docs theme. Ours: a single hand-written HTML page and a recolored default Docusaurus theme. |
| **Weighted total** | **87.0** | **31.5** | **gap 55.5** |

Weighted total = Σ(weight × score ÷ 10).

## 4. What the numbers say to do first

Ordered by points available, not by effort:

| Round | Work | Dimensions | Points |
| --- | --- | --- | ---: |
| **R1** | The seven missing pages, written example-first | D2, D1 | ~15 |
| **R2** | A runnable example in every concept page; replace tables that are standing in for explanation | D1, D4 | ~14 |
| **R3** | Onboarding: a template to clone, a verified "first result in N minutes" path, per-tool on-ramps | D3, D5 | ~9 |
| **R4** | Search (Algolia DocSearch), section landing pages, related-page links | D6 | ~5 |
| **R5** | Homepage rewrite and docs theme as a designed surface | D7 | ~5 |
| **R6** | Voice pass over everything: scenarios, "when not to use", limitations | D5 | ~7 |

Reaching ≤5 requires ~50 points, so every round lands and then some — R1–R6 as scoped are roughly 55.
None of them is a rewrite of the site; all of them are content and craft.

## 5. Re-score — after R1–R7

| Dim | Mastra | Everdict | Evidence |
| --- | ---: | ---: | --- |
| D1 Executable | 9 | **8** | 104 code blocks across 30 guide pages (3.4/page, was 0.9). Every concept page opens with something runnable; `examples/quickstart/` is a working evaluation you clone. 5 pages still carry none — all of them section landings, which is correct. Short of 9 because examples are single blocks rather than complete files with expected output. |
| D2 Coverage | 9 | **8** | Six sections: start · concepts · workspace · integrations · **operate** · self-host. The seven named gaps are pages; the operating loop (tracker, schedules, views, notifications) is covered. Still absent: browser profiles, the product timeline, the desktop app as a guide page. |
| D3 Onboarding | 9 | **8** | Two commands to a verified verdict, a clonable example, and a per-agent-kind on-ramp. Short of 9 because there is no scaffolding command and no framework-specific integrations. |
| D4 Craft | 8 | **7** | 17 of 30 pages carry semantic callouts; 8 diagrams; explanation-tables removed from every concept page. Short because diagrams are ASCII (CommonMark constraint) and there are no tabs for alternatives. |
| D5 Voice | 8 | **7** | Pages open on a scenario and argue rather than assert; three carry explicit "when not to use" / limitations, including advice against adopting the tracker. Short because the pattern is not yet everywhere. |
| D6 Findability | 9 | **8** | Offline full-text search (index built and served), five section landings, See-also on every page. Short of 9: no AI-assisted search. |
| D7 Design | 9 | **8** | Homepage rebuilt around the argument, product screenshots, OG/Twitter cards, responsive; docs theme given measure, heading and code-block treatment. Short because it is a themed default rather than a designed system. |
| **Weighted total** | **87.0** | **77.0** | **gap 10.0** |

Seven rounds moved 45.5 points. The remaining 10 is concentrated in things that need either design
work (D7 as a system, D4 tabs) or a scaffolding tool (D3), plus the coverage tail (D2).

### What R8+ would need

| Round | Work | Dim | Points |
| --- | --- | --- | ---: |
| R8 | Complete examples — full files with paths and expected output; tabs for alternatives | D1, D4 | ~3.5 |
| R9 | Remaining surfaces: browser profiles, product timeline, desktop app | D2 | ~1.5 |
| R10 | `everdict init` scaffolding, framework on-ramps | D3 | ~1.5 |
| R11 | Voice pass over the reference tier (the 24 root docs) | D5 | ~1.5 |
| R12 | Custom components, illustrated hero, an actual design system | D7 | ~1.5 |

## 6. Log

| Date | Round | Everdict | Gap | Note |
| --- | --- | ---: | ---: | --- |
| 2026-08-11 | baseline | 31.5 | 55.5 | The site shipped; quality measured for the first time. |
| 2026-08-11 | R1 | 37.5 | 49.5 | The seven missing surfaces get pages. |
| 2026-08-11 | R2 | 51.0 | 36.0 | Concept pages become executable; explanation-tables removed. |
| 2026-08-11 | R3 | 60.0 | 27.0 | A first result you clone rather than assemble. |
| 2026-08-11 | R4 | 65.0 | 22.0 | Offline search and section landings. |
| 2026-08-11 | R5 | 70.0 | 17.0 | Homepage and docs surface rebuilt. |
| 2026-08-11 | R6 | 73.0 | 14.0 | When not to use it, and what it costs. |
| 2026-08-11 | R7 | 77.0 | 10.0 | The operating loop; diagrams that survive CommonMark. |
| 2026-08-11 | R8 | 78.0 | 9.0 | Runtime becomes the eighth concept; Temporal gets the page it never had. Found by the maintainer, not by the rubric — see below. *(First logged as 80.0. Recomputed from the anchors it was 78.0 — an optimistic score, corrected here rather than left standing.)* |
| 2026-08-11 | R9 | 80.0 | **7.0** | The mention-without-a-page sweep, run as a measurement instead of a guess. |

### R9 — the lesson, executed

R8 ended by saying the next pass should measure **terms with a high mention count and no page**,
because that is the shape of a gap a writer cannot see from inside. R9 ran it before writing anything:

| Term | Mentions | Page |
| --- | ---: | --- |
| secret | 42 | none |
| bundle | 23 | none |
| browser | 13 | none |
| budget | 8 | none |
| release | 6 | none |
| desktop app | 5 | none |

`secret` was the largest gap in the entire guide and nothing had surfaced it — 42 mentions across 11
pages, every one of them assuming the reader already knew where credentials live. It is also the most
security-relevant page in the set: the asymmetry where model keys are injected into the job and cluster
credentials are stripped from it was documented nowhere a user would look.

Six pages followed. The measurement found in one command what four rounds of writing had missed, which
is the argument for keeping it: `secret 42 / bundle 23` is not a judgement call, and neither is the
absence of a file.

D2 moves to 9 — coverage is now genuinely comprehensive rather than section-complete — and D5 to 8,
since most pages now carry a "when not to" or a warning about a failure that is silent.

### What R8 exposed about the rubric

The maintainer asked whether runtime, the workspace agent, schedules and Temporal were covered. Two of
the four were not, and **the D2 score did not notice**:

- **runtime** — 31 mentions across 15 guide pages and no page of its own. Every page assumed it. It is
  the entity a user registers and selects on every batch, and it was not one of the concepts.
- **Temporal** — 5 mentions in the whole guide, one paragraph inside `schedules.md`, for the property
  that decides what happens to a two-hour batch when you deploy.

The lesson for D2: counting *sections that exist* misses a topic that is mentioned everywhere and
explained nowhere. A mention is not coverage. The next scoring pass should measure the inverse —
terms with high mention counts and no page — because that is exactly the shape of a gap a writer
cannot see from inside.
