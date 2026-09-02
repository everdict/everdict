---
kind: design
title: "The world a case acts on — delivery, lifecycle, engagement"
status: current
updated: 2026-09-03
---
# The world a case acts on — delivery, lifecycle, engagement

> **What this decides.** Three deferred capabilities and two by-name refusals share one root cause, and it is
> not a missing field: `EvalCase` and `HarnessSpec` each carry more than one concern, so the concern that has
> no owner cannot be versioned, provisioned, observed or evolved. This page models the case space evolution
> has to support, names the two axes the domain is missing, and says what each blocked item becomes once they
> exist. It is the SSOT for that decision; `docs/architecture/harness-definability-spec.md` §2 is where the
> environment entity itself is specified.

## Why this page exists

The environment became an entity (a registry, immutable versions, a manifest seal, its own identity axis, a
campaign subject). Building it produced a list of things that still could not be expressed, and every one of
them turned out to be the same sentence: **the world a case acts on has no lifecycle and no delivery, and how
the actor meets the question has no declaration at all.**

    deferred    a `service` environment (a topology the environment provides)
    deferred    a source+build recipe on an environment
    deferred    tau-bench (an adapter whose case is a dialogue)
    refused     an api target's observation (`observe` is declared; nothing produces it)
    refused     an os target's provisioning (acquired through a session API or not at all)

## The case space evolution must support

Every row is a benchmark or product case this repository already ships an adapter, harness or spec for. The
last two columns are the ones the domain cannot currently state.

| # | Case | The world is | Delivered by | Engagement | Evidence read from |
| - | ---- | ------------ | ------------ | ---------- | ------------------ |
| A | SWE-bench, Terminal-Bench | a repo at a commit, inside an image | the case's own compute | one-shot | git diff + the verifier's reward |
| B | GAIA, gsm8k, BrowseComp | nothing (or context text) | — | one-shot | the final message |
| C | WebVoyager (managed browser) | a browser instance | the platform (topology runtime) | one-shot | DOM snapshot + trace |
| D | WebArena | **several services (the app under test)** + a browser | nobody — the workspace hosts them | one-shot | trace + final page |
| E | an API client agent | a deployed API | nobody — a base URL is declared | one-shot | **the exchanges (unbuilt)** |
| F | OSWorld | a desktop with apps | the case's own compute (Xvfb in the image) | one-shot | screenshot + window titles |
| G | tau-bench | a domain database + tool APIs | **unbuilt** | **dialogue with a simulated user** | the conversation + the DB's final state |
| H | a service-topology harness under test | — (the harness IS services) | the platform | one-shot through a front door | trace |

Read down the "Delivered by" column: three different answers — *the case's own compute*, *the platform*, and
*nobody, the operator arranged it* — and the domain has a word for none of them. Read down "Engagement": one
value everywhere, and the one row that differs is the row that cannot be built.

## The four concerns, and who owns each today

    the QUESTION      EvalCase.task / expected / milestones / graders          ✔ owned
    the WORLD         EvalCase.env + image + resources + network,              ✗ split three ways
                      HarnessSpec.services + target (for a topology harness),
                      EnvironmentSpec.env (as of §2)
    the ENGAGEMENT    — (implicit: one-shot)                                    ✗ unowned
    the EVIDENCE      Environment.snapshot + trace + target.observe             ~ partly owned

`EvalCase` already states the right idea for half of the world — *"the world this case needs, as data the case
owns … an execution site that cannot provide the declared world REFUSES the case"* (`packages/contracts/src/execution/eval-case.ts`).
That sentence is the model this page extends. What it covers is the world as a **property of the compute**
(how much CPU, what network). What it cannot cover is a world that must be **brought into existence** and
addressed: a running app, a browser, a desktop session.

## The two axes the domain is missing

### Axis 1 — delivery: `in-compute` vs `provided`

An environment says how its world reaches the actor.

- **in-compute** (rows A, B, F): the world IS the actor's container — a repo at `/testbed`, a desktop under
  Xvfb, a prompt. Its bytes are an image. There is nothing to provision and nothing to tear down.
- **provided** (rows C, D, E, G, H): the world exists outside the actor's container and is reached by
  **coordinates** — a base URL, a CDP endpoint, a session id. Somebody must produce those coordinates before
  the actor runs, and somebody must be able to say they are gone afterwards.

This single distinction is what the three deferred items were each missing:

- A `service` environment is a **provided** world. Its blocker was never the schema arm; it was that nothing
  produces coordinates for anything except a service HARNESS's own topology.
- An environment **build recipe** produces bytes, and bytes are an **in-compute** world's form. The blocker
  was that an environment could not carry an image, so a build had nowhere to put its output.
- An api target's `observe` is an obligation of whoever **provides** the world, because only the provider
  stands between the actor and the world.

### Axis 2 — engagement: how the actor meets the question

    one-shot   the actor is given the task and produces a trace                (every row but G)
    dialogue   the actor and a USER exchange turns until a stop condition      (row G)

Engagement belongs to the **case**, not to the harness: it is a property of the question ("this task is a
conversation"), and the harness merely has to be capable of it. A harness that does not declare
`conversational` meeting a dialogue case is a refusal by name, exactly as an execution site that cannot
provide a declared world refuses the case.

## What each blocked item becomes under the model

| Item | Under the model | What it still needs |
| ---- | --------------- | ------------------- |
| `service` environment | a **provided** world with a dynamic provider | a `WorldProvider` port, a lifecycle owner, and a teardown that reads back zero |
| environment build recipe | an **in-compute** world's bytes | ✅ landed 2026-09-03 — the environment carries an image and a `source`+`build` recipe, and an environment campaign builds it |
| tau-bench | **dialogue** engagement + a state-comparing grader | ✅ the turn loop (scripted user); still needs a model-driven user simulator and the benchmark's domain database |
| api observation | the **provider's** obligation | a recording provider (a proxy) that yields coordinates AND events |
| os target | a **provided** world | the same provider port; a session API is one implementation of it |

The shape of the port is not invented here: `SeedingDispatcher`
(`apps/api/src/core/execution/seeding-dispatcher.ts`) already decorates a dispatch to materialize something a
case declares and refuses when it cannot — a provided world is the same decoration with a lifecycle.

## Rejected alternatives

- **"One more service in the harness's topology."** Reads naturally, and destroys the experiment: the harness
  is what ACTS, the world is what is ACTED ON, and a comparison that cannot say which side moved cannot say
  what a delta is evidence about. Already rejected in `docs/architecture/harness-definability-spec.md` §2;
  restated here because the delivery axis is what makes the rejection *constructive* rather than a refusal.
- **"Let the case name a target URL directly."** The cheapest thing that works for row D — and it has no
  identity, so it cannot be versioned, cannot be sealed, cannot be an axis, and cannot be a campaign subject.
  It reproduces exactly the state §2 was written to end, one field lower.
- **"Provision inside each backend that needs it."** Three lanes, three lifecycles, three teardowns, and the
  one written last is the one that leaks. The whole point of a port is that a world's ending is written once.
- **"Make `EvalCase.image` mean the world."** It already means the actor's compute on every managed lane. A
  field that means two things is how the next reader gets it wrong; the precedence has to be stated between
  two fields, not resolved by overloading one.
- **"Model engagement on the harness."** A harness CAPABILITY (`conversational`) is not the same claim as a
  question's SHAPE. Two datasets, one harness: only the case can say which of them is a dialogue.

## Landing order, and what each slice must carry

1. ✅ **In-compute bytes** (landed 2026-09-03) — an environment carries an image; a case that references an environment takes the
   world's bytes from it, and a case that also names its own image for the same world is refused rather than
   silently preferred. Complete on its own, and it is what unblocks the build recipe.
2. ✅ **Provided worlds, static** (landed 2026-09-03) — an environment declares `provides: { kind: "static",
   wiring }`, the resolution attaches those coordinates to the case as platform-authored `world`, the job
   carries them, and a command harness renders `{{target.baseUrl}}` / `EVERDICT_TARGET_BASE_URL` from them.
   **The sealed world wins over the harness's own `target`**, which is the whole point: a new environment
   version moves the world with no harness edited, and the diff reads that as the `environment` axis rather
   than as a change to the agent under test. Row D (WebArena on workspace-hosted sites) is expressible now.
   Nothing is brought up, so nothing must be torn down — which is what makes this slice complete on its own
   rather than half a lifecycle.
3. **Provided worlds, dynamic** — bring-up and teardown, with the lifecycle owner and the verified-zero
   ending. The second implementation of a port that already has a consumer.
3.5 ✅ **Building the world** (landed 2026-09-03) — the recipe moved to one owner (`execution/build-recipe.ts`,
   re-exported under its historical harness names), an environment declares `source`+`build` beside its
   `image`, and `CampaignBuildService` grew the second subject: same session, same captured layer, and a mint
   that registers a NEW version of the world rather than re-pinning a slot. The version name is derived from
   the observed commit, so a re-driven build re-mints the same name and the BASELINE — a world somebody has
   already compared against — is never overwritten. A recipe with no image to land in is refused at
   registration and again where a build would start.

4. ✅ **Dialogue engagement, scripted** (landed 2026-09-03) — `EvalCase.engagement` declares the exchange, and
   `runCase` drives the opening task and then the user's lines over the harness's own continuity contract, so
   the agent RESUMES its session instead of meeting each line cold. `dialogueTurns` is the one reader of the
   bound. A harness that does not declare `conversational` is refused before the first turn: driving it would
   make every turn an independent run, and the conversation the score is computed over would be a fiction.
   A model-driven user is a different user KIND and plugs in at `engagement.user`, not into the loop.

Each slice lands with a counterexample that drives the production composition, and slices 3 and 4 land with
their refusals: a world that cannot be provided, and a harness that cannot hold a conversation.

## What would reopen this

- A case whose world must change **during** the run (a world that the actor mutates and a later phase
  re-provisions) — the model above assumes one world per case for its whole life.
- A world shared by several cases ON PURPOSE (a warm pool of one expensive app) — the lifecycle axis above is
  per-case; a shared world needs a slice key, which is what `wiringVars`/`keysFor`
  (`packages/topology/src/environment-manager.ts`) already do for topology dependencies.
- An engagement with more than two parties (an actor, a user, and an adversary).
