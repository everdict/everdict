---
kind: decision
title: "Everdict as the development system of record — a methodology seed, and lineage and direction per service"
status: proposed
updated: 2026-09-15
anchors: [packages/contracts/src/records/knowledge-entry.ts, packages/contracts/src/records/tracker.ts, packages/contracts/src/records/product.ts, packages/application-control/src/harness/harness-lineage-service.ts, plugin/.claude-plugin/plugin.json]
---
# Everdict as the development system of record — a methodology seed, and lineage and direction per service

> **What this proposes.** Everything a team learns while building and evolving a service — what was asked
> for, what was decided and against what, what an incident taught, what was reviewed, what was released under
> whose authority, how it was evaluated — accumulates in Everdict, not in the service's repositories. Everdict
> ships a default **methodology seed** so a workspace starts with a working loop instead of an empty tracker,
> and the Everdict **plugin** runs that loop from inside a coding session, so using the plugin is enough.
> Knowledge is read at the **service** level: every service — a software service or an agent harness — has a
> **lineage** (how it got here) and a **direction** (where it is going), across repositories and people.
> A code repository carries only its product: code, product documentation, and the conventions of that code.
> Proposed by the maintainer on 2026-09-15.

## Why

**This repository is the counterexample, measured.** It ran the AI-native SDLC loop on itself, in files: 34
change directories of `intent.md → spec.md → plan.md`, 10 lessons, 47 controls, a findings ledger, release
authorizations and an eval history — removed from the repository on 2026-09-15 and readable at `ddecfe1a`
(`docs/architecture/sdlc-out-of-the-repository.md`). It worked, and it had three properties no amount of care
fixes:

- **It is per repository.** A second repository starts from nothing; a decision that spans two services has no
  home; nothing can answer "what do we know about this service" across the repositories that compose it.
- **It is per person.** Review and release approval need a second person, and a repository of markdown has no
  identities to separate — declared as a limit that deployment could not satisfy.
- **Knowledge rots where nothing owns it.** The 2026-09-15 audit rewrote nearly every product page; the user
  guide had gone 467 code commits without an edit (`docs/architecture/repository-layout.md`).

**And Everdict already holds most of the entities the loop needs**, as products of its own:

| The loop's artifact | What Everdict already has | What is missing |
|---|---|---|
| intent | tracker Issue under Project and Initiative, GitHub issue import | the chain states and their ordering |
| spec, plan | issue comments, workspace filesystem documents | a typed attachment that names its intent and refuses to precede it |
| decision, lesson, convention | knowledge entries `decision` · `finding` · `convention` · `context`, with a `supersedes` chain, `evidence`, and pins to a version interval | a lesson's link to the eval it produced |
| skills | versioned skills in the capability store, first-party ones under `_everdict` | delivery into a coding session by the plugin |
| release authorization | Product ⊃ Release with a ship guard | the link from a release record to the git tag it authorizes |
| review findings, dismissals | checkpoints, `request_verification`, comments | a disposition ledger as an entity |
| config regression evals, drift bands | scorecards, schedules, watched series | a trigger on a change to the configuration |
| lineage of a harness | `harnessLineage`, `forked_from` · `succeeds` · `born_from` edges, seeds inside the version digest | the same read for a software service |
| improving a skill | evolution campaigns behind a held-out gate | the seed's skills as a campaign subject |

## The model

### A service is the unit knowledge is read at

A **service** is either a tracked Product service (a repository, optionally a path inside it — `ProductServiceSchema`
in `packages/contracts/src/records/product.ts`) or a Harness (template and instances). Both already have a
version ledger: releases imported from tags, and immutable harness instance versions. What is proposed is one
reference that can name either, usable wherever a claim or a request is ABOUT something — a knowledge pin, an
issue link — so the two kinds of service are read the same way.

### Lineage — how it got here, in one read

For each version of a service: the requests it was born from (issues, `born_from`), the decisions that shaped
it and the interval they are known to hold over (knowledge pins), the evidence it was judged on (scorecards),
what review found, and the authorization it shipped under. For a harness this is `harnessLineage` today; the
proposal extends the same read to a software service, whose versions are its releases.

### Direction — where it is going

The open requests linked to the service by chain state, the proposed decisions not yet settled, the watched
series that regressed, and the campaigns in flight. Direction is what a new member, or a session that just
opened a repository, needs before touching anything.

### The work chain

The chain this repository enforces from its commit graph becomes a property of an Issue: a request moves
`draft → accepted | rejected → shipped`; an accepted request carries a spec or one line declining it; a plan
is written against the spec and may not precede it; commits and pull requests link to the issue, and the issue
records the commit that shipped it.

⚠️ **The witness changes, and that is the design's load-bearing question.** Git proved "the plan came after
the request" because commits cannot be back-dated without rewriting history. In Everdict the witness is the
order of durable writes (rule `protocol` L1 — authority before effect), and the bar that keeps the two sources
honest is **linkage in both directions**: a commit trailer names the issue, and the issue records the commit
SHA. A record whose linked commit does not exist, or a commit naming an issue that was accepted after it, is
refused — the same checks the repository's removed intent-chain gate made, asked of a different store.

### Knowledge

A decision is a `decision` entry pinned to the service versions it governs, superseded rather than edited. A
lesson is a `finding` whose evidence names the eval case it produced, or declares why none. A convention is a
`convention` entry, or a skill when it is a procedure. Extraction from sessions produces `proposed` entries;
a person approves them. Nothing here is new vocabulary — it is the knowledge layer used for the purpose it was
built for.

## The methodology seed

A first-party, versioned seed a workspace adopts — the loop this repository ran on itself, generalised so it
applies to any software service or agent harness, and stripped of what is specific to Everdict's own code:

- **Workflow** — the chain states as tracker workflow states, and the one-line declarations that make a
  refusal a decision: `Design: none — <why>`, `Regression-test: none — <why>`, `Docs-unchanged: <doc> — <why>`.
- **Skills** — the review passes (who authors each value the change made load-bearing; what existing code it now
  depends on), choosing a layer for knowledge, writing a request / spec / plan, writing a lesson, authorizing a
  release.
- **Agent templates** — the design pass that writes a spec, the reviewer, the scanner of code nobody touched,
  the triage of a red gate. First-party agent templates are already seeded into `_shared` and adopted by a
  workspace; the seed uses the same path.
- **Gates** — the chain ordering, the review stamp, the release authorization, a fix's regression test, a
  document's owner — as definitions the plugin enforces, not prose.
- **Eval cases** — the seed's own configuration regression suite, run as Everdict scorecards: the product
  evaluating the configuration that steers the agents building with it.
- **Generic conventions** — an empty corpus is not a pass; a failed read is a third value; a control is real
  only once it has been seen refusing.

**Adoption is a fork, and the methodology has a lineage too.** A workspace adopts a seed version into its own
namespace with `forkedFrom` recorded, edits it as versions, and can see what it changed from the seed and
offer an improvement back. A seed skill is improved through an evolution campaign behind a held-out gate, never
by editing it in place — ungated self-editing of skills is the failure SkillOpt measured
(`docs/architecture/evolution-papers/R38.md`).

**What is not in the seed:** Everdict's own protocol laws, layer rules and gates over its TypeScript. Those are
conventions of this codebase and stay in this repository's `.claude/`.

## The plugin — using it is enough

The plugin today ships MCP tools, one skill and two commands (`plugin/`). It gains the loop:

- **Session start** — resolve the repository (and path) to its service; load that service's active decisions,
  conventions and the open request the branch belongs to into the session.
- **While working** — commands to open a request, write a spec or plan against it, record a decision; a
  session's decisions and lessons proposed as knowledge entries for a person to approve.
- **Before a push** — ask Everdict for the gates that apply. **An Everdict that cannot be reached is not a pass**
  (rule `protocol` L2): the push is refused, with a recorded break-glass whose reason is visible afterwards.
- **After** — link the commits and the pull request to the request; record what shipped.

## Where the work's bytes go, and the two homes of a skill

**Images.** Every image the work produces or runs in — a service build, a harness build, a coding agent's work
environment — is pushed to the workspace's managed image store, which Everdict owns the way it owns the
filesystem (`docs/architecture/managed-image-store.md`). A release, a harness version and a session's
environment then each name a digest the lineage can follow, instead of a tag in a registry nobody links to. The
code-evolution loop already builds its candidates into that store (`docs/architecture/code-evolution-loop.md`).

**Files.** What a session produces and the team keeps — specs, plans, reports, review findings, chosen
transcripts — is written to the workspace filesystem as attributed revisions
(`docs/architecture/workspace-filesystem.md`), where knowledge extraction reads it and the web browses it. The
tree is per workspace; a workspace never sees another's.

**A skill has one of two homes, and each has its own way to get better.**

    methodology skills   how a team works — review, requests, specs, lessons, releases
                         HOME: Everdict — the seed under `_everdict`, adopted into a workspace as versioned
                         capabilities, delivered to sessions by the plugin
                         IMPROVED: in Everdict, by an evolution campaign over the skill behind a held-out gate

    product skills       how one codebase is built — the product repository's own `.claude/skills`
                         HOME: the product's repository, because the coding agent loads them from the checkout
                         IMPROVED: by the code-evolution loop — a delegated coding agent edits the skill in a
                         sandbox with the repository checked out, the campaign evaluates the candidate against
                         the product's eval cases, and an adoption becomes a pull request to that repository

The repository stays the source of truth for its own skills; Everdict holds the evidence for every version of
them and the lineage between versions. Session evidence feeds both paths: a recurring review finding or a
repeated correction is a candidate for the skill that should have prevented it.

⚠️ **Improving the seed from many workspaces is a tenancy question before it is a learning question.** A
workspace is a trust zone, and a seed that carries one workspace's finding into another is already named a leak
(`docs/architecture/harness-identity-and-seeds-spec.md` §4). So cross-workspace improvement is opt-in, and only
aggregate evaluation outcomes cross the boundary — "seed skill version N passed the held-out suite in this
workspace" — never a workspace's files, images or knowledge text.

## What stays in a repository

Product code; product documentation (guide, reference, design records like this one); the conventions of that
code (`CLAUDE.md`, `.claude/rules/`, codebase skills); and the quality gates that read the code — lint, types,
tests, the scanners under `scripts/`. This repository's own process records already left it
(`docs/architecture/sdlc-out-of-the-repository.md`).

## What was rejected

- **Keeping the loop in each repository.** It is what this repository did, and the three properties under
  *Why* are the result. A template repository or a copy of that process per project reproduces them per project.
- **Shipping the methodology as documentation or skills alone.** A skill is advisory; a policy that must hold
  needs something that refuses (`.claude/skills/README.md`, the enforcement table). A seed without the plugin's
  gates is guidance, and guidance is what drifted here.
- **An external tracker as the system of record, mirrored.** Two sources of truth for one artifact, and the
  tracker holds none of what makes the record defensible — the evals, the version digests, the lineage.
- **A new domain on the layer spine.** `CLAUDE.md` admits a spine domain only if it strengthens the trust
  harness or the owner protocol. The entities exist as applications — tracker, knowledge, capability store,
  product timeline — and the work chain is an application over them.

## Open decisions

1. **Visibility.** Requests and lessons are public in this open-source repository today; in a workspace they are
   private by default. Recommendation: private by default; what should be public is a design record in the
   repository.
2. **Unreachable Everdict at push time.** Recommendation: refuse, with a recorded break-glass.
3. **Where it lives.** Recommendation: an application over tracker, knowledge and capability store — no spine
   domain.
4. **The service reference.** A new reference type naming a product service or a harness, or a graph node only.
5. **Bootstrap.** Everdict's own development would run on a deployed Everdict, so a broken deployment gates its
   own repair. It needs a declared limit and a break-glass.
6. **What crosses workspaces to improve the seed.** Recommendation: opt-in, aggregate evaluation outcomes only.
7. **Retention.** Keeping every work image and output costs storage without bound; each needs a retention policy
   per workspace, and a released or adopted digest is never collected while something references it.

## Order of work

Each slice gets its own spec (`*-spec.md`) before code.

1. The service reference, and lineage and direction readable for a product service (extending `harnessLineage`).
2. The work chain on an Issue, with commit and pull-request linkage and the ordering checks.
3. Seed v1 under `_everdict` — workflow states, skills, agent templates, gate definitions — and adoption as a fork.
4. The plugin loop: session context, the push gate against Everdict, knowledge capture — and pushing the work's
   images to the store and its outputs to the filesystem.
5. Develop this product through Everdict and verify the record accumulates there (the repository's own process
   records were removed first, so there is nowhere local for it to go).
6. The seed's eval cases as scorecards; seed skills as evolution-campaign subjects (opt-in aggregate evidence
   across workspaces); product skills improved through the code-evolution loop's pull-request mode.

## What would reopen it

- **Teams that keep their tracker elsewhere and will not move it.** Then linkage, not ownership, is the product,
  and the chain lives beside an external record.
- **A push gate that cannot be enforced from the plugin** — a client that does not run plugin hooks, or offline
  work as the common case. Then enforcement stays in repository hooks and Everdict is the record without being
  the gate.
- **The seed not transferring.** If adopted workspaces edit most of it away, the methodology is not general, and
  the seed should shrink to the parts that survived adoption.
