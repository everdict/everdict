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

### Observation belongs to whoever provides the world

An `observe` list on a harness TARGET is the actor's own view of what should be watched, and nothing on the
acting side can watch an exchange — only what stands BETWEEN the actor and the world can. So the declaration
lives on the environment (`EnvironmentSpec.observe: { from }`, naming the wiring key whose URL holds the
recording), the platform fetches it once after the drive and before grading, and it lands on the PLATFORM's
observation channel (`EnvDelta{kind:"world-recording"}`) rather than in the agent's trace — the agent's story
and the world's account stay two accounts, which is the only arrangement in which a judge can compare them.

A recording that was promised and could not be read makes the observation `sampling_failed`. Never `sampled`
with nothing in it: an empty account of a world nobody could read is the L2 collapse this channel exists to
refuse, and it is the reading that would let a judge conclude the world was quiet.

The workspace supplies the proxy — as a service of a created world, as part of a session's response, or in
front of a static one. Everdict references images and does not ship a recorder.

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
| `service` environment | a **provided** world | ✅ static + session-opened landed; a world Everdict CREATES still needs a durable worklist and a verified zero |
| environment build recipe | an **in-compute** world's bytes | ✅ landed 2026-09-03 — the environment carries an image and a `source`+`build` recipe, and an environment campaign builds it |
| tau-bench | **dialogue** engagement + a state-comparing grader | ✅ the turn loop (scripted user); still needs a model-driven user simulator and the benchmark's domain database |
| api observation | the **provider's** obligation | ✅ landed 2026-09-03 — the environment declares `observe: { from }`, a wiring key whose URL the platform fetches after the drive and before grading, onto the observation channel |
| os target | a **provided** world | ✅ expressible now: a desktop handed out by a session API is `provides: { kind: "session" }` |

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
3. ✅ **Provided worlds, opened per case** (landed 2026-09-03) — an environment declares
   `provides: { kind: "session", endpoint, acquire }` and `WorldProvidingDispatcher` opens the world before
   the actor, merges its coordinates onto the job, and asks for the close when the case ends — including when
   it FAILED. Two invariants the seam owns: a world that cannot be opened REFUSES the case (running it
   against the harness's own default would measure a different experiment), and the acquire spec is REMOVED
   before dispatch, so a runner receives coordinates and never the means of minting more sessions. The
   implementation is the acquirer a browser target has always used (`serviceAcquirer`), with the environment's
   endpoint standing in for a topology service.

   **Who owns the lifetime, stated:** the SESSION SERVICE. It hands out sessions and expires them; this
   platform asks for an early close and REPORTS one that did not happen instead of swallowing it. That is
   strictly more than the browser-session lane does today and strictly less than a teardown Everdict could
   certify — which is the honest description, and the reason the next item is still open.

3.9 ✅ **Provided worlds, CREATED** (landed 2026-09-03) — an environment declares
   `provides: { kind: "topology", services, wiring }` and the platform brings those services up for the case,
   hands their endpoints over as wiring, and tears them down after. What this arm owes and the other two do
   not, both landed:

   - **A durable worklist.** `everdict_created_worlds` (migration 0208) records the intent BEFORE anything is
     created — a create whose row could not be written is refused, because compute nothing can address is
     what a ledger exists to prevent (L1). The row carries what to tear down and WHERE, so a sweep needs no
     registry read and no case to ask.
   - **A verified zero.** `released` is written only after a read-back says the world is not standing. A
     teardown that threw is settled by the read-back rather than by the throw; a world still standing, or a
     runtime that could not say, stays owed with its reason on the row (L5).
   - **One verifier for both paths.** The dispatch's `finally` and the reconciler call the SAME release, so a
     sweep and the request path cannot disagree about what "gone" means. `released` is first-write-wins: a
     late sweep may not reopen a proven ending.

   **Any runtime that can PROVE a teardown may create a world** — Nomad, K8s and the local Docker daemon all
   implement ensure/teardown/describe, which is all a world needs (a browser SESSION needs more: a
   provisioner and a CDP this control plane can reach, which is why that lane is Nomad-only and why copying
   its constraint here was the wrong inheritance). What is genuinely required is `describeTopology`: a
   runtime that cannot say whether a topology still stands could never prove a world gone, so a case placed
   there is refused rather than run into a leak.
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
   ✅ **And the model-driven user landed the same day**: `engagement.user` is a union, and a `model` user
   declares a PERSONA the simulator plays. It is asked for each turn with the exchange so far, and it ends
   the conversation by saying its stop sentence — which is dropped rather than delivered, so the transcript a
   judge reads carries no instruction the platform wrote. `maxTurns` is REQUIRED for a model user: a scripted
   user runs out of lines and a model does not. The simulator is built from the same grant the judge is (this
   job's own model and key), because it is the same kind of call — made on the platform's behalf, never on
   the agent's — and it is never handed the case's expected answer or its grading material, because a user
   who knows the answer stops being a user and becomes a hint. A case that declares a model user where no
   simulator was given is REFUSED: running it as a one-shot would measure a first turn and report it as a
   conversation.

Each slice lands with a counterexample that drives the production composition, and slices 3 and 4 land with
their refusals: a world that cannot be provided, and a harness that cannot hold a conversation.

## What would reopen this

- A case whose world must change **during** the run (a world that the actor mutates and a later phase
  re-provisions) — the model above assumes one world per case for its whole life.
- A world shared by several cases ON PURPOSE (a warm pool of one expensive app) — the lifecycle axis above is
  per-case; a shared world needs a slice key, which is what `wiringVars`/`keysFor`
  (`packages/topology/src/environment-manager.ts`) already do for topology dependencies.
- An engagement with more than two parties (an actor, a user, and an adversary).
