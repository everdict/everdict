---
name: evolve
description: Driving an evolution campaign — freeze a frame, log rounds whose verdict the platform derives, spend the adoption the gate authorizes. Use when running or designing a campaign, when a round comes back not-comparable, or when an adoption is refused.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Evolve — driving a campaign

An evolution campaign optimizes candidate VERSIONS of one capability (an agent, or a harness) against a
fixed baseline, and records the result as evidence somebody else can check.

**The record is a settlement, not an engine.** It is a frozen frame + an append-only round trace + a pure
gate. It does not propose candidates, does not run scorecards, and does not wake itself — that is the
DRIVER's job, and this file is the driver. The exclusion is deliberate: `docs/architecture/evolution-lineage.md`
§"Deliberately not" says *no campaign workflow engine*, because orchestration belongs to whoever is running
the loop and the discipline belongs to the record.

So the split to hold in mind, because every mistake below is a confusion of the two:

    you own      what to try next · running the two scorecards · when to stop asking
    the record   what the exam is · what the round scored · whether that authorizes anything

## Before the first round

- **An issue.** `POST /campaigns` takes `issueId` and the campaign inherits that issue's team. With no
  tracker configured the door answers 404 — a campaign whose authority cannot be established is not opened.
- **The subject registered, and the baseline too.** The candidate of every round must be a real registered
  version by the time its scorecard runs.
- **A dataset whose case ids you can name**, because the frame names them one by one.
- Roles: `scorecards:run` to open, log and settle; adopting also needs `agents:write` or
  `harnesses:register` for the candidate's family.

## The loop

1. **Open.** `POST /campaigns` `{issueId, frame}` (MCP: `open_campaign`). The frame is frozen here and
   referenced by digest forever after — changing your mind is a NEW campaign, never an edit. What goes in it,
   and how to choose each field, is `references/frame-design.md`.
2. **Author a candidate.** Register a new version of the subject through its ordinary door — a harness
   instance, or `save_agent`. Nothing in the campaign does this for you.

   Before you choose what to change, read what the walk already knows: `GET /campaigns/:id` carries every
   round's `learned`, the rounds that LOST included, and a rejected round is the one most likely to know why.
   Then open the failing cases' traces — they read a page at a time, so a long run costs a window rather than
   the whole thing, and a hypothesis formed from scores alone is a guess about a mechanism nobody looked at.

   ⚠️ **The candidate never receives the findings.** They shape your proposal; they do not go into the thing
   being measured. A subject told what its evaluators concluded stops producing traces that show how it
   actually behaves, and the next round loses its evidence. This is measured: WikiSkill (arXiv 2608.27454)
   gave the same knowledge to the proposer for +15.0 points and then also to the executing agent, and it went
   down 2.8. It is the oracle rule wearing a different coat.
3. **Run both sides.** `POST /scorecards` for baseline and candidate, each with `trials` at least the
   frame's `trialsPerCase`. Statistics need repeats; one trial per case produces no signal at all.
4. **Wait.** Scorecards are async. Poll `GET /scorecards/:id`, or subscribe to `scorecard.completed` —
   it is a triggerable kind, so a subscription can wake an agent when a side lands. The campaign's own
   facts (`campaign.round_logged`, `campaign.closed`) are feed facts and are NOT triggerable: the loop
   cannot wake itself on its own progress.
5. **Log the round.** `POST /campaigns/:id/rounds` `{hypothesis, learned, candidateVersion,
   baselineScorecardId, candidateScorecardId}` (MCP: `log_campaign_round`). **You do not send a verdict.**

   A frame that budgets the delegation (`delegation {ttlSec, maxUsd}`) makes the round name the sandbox
   session that produced its candidate (`delegationRunId`); the platform reads what it cost off the run
   ledger and refuses (409) a round whose session ran past the budget.

   The round also records where its candidate came from (`verdict.candidateSource`: the candidate
   scorecard's origin — repo, sha, pull request, pin override — copied by the platform, never sent by you).
   An adopted close and its proof carry the same block, so a merge can name the pull request it is about.

   `learned` is required and it is the half that survives the round. The verdict is derived and the budget is
   spent either way; what the round TAUGHT is the only thing round N+1 can use. Write the MECHANISM, not the
   outcome — "the tool budget was the binding constraint, not the prompt" is a finding, "it did not improve"
   is the verdict restated. A round the platform could not compare has no verdict at all and still has a
   finding, which is precisely the round this field exists for.

   The VERDICT, by contrast, is the platform's: the service derives it from the production scorecard diff —
   trial significance plus experiment identity — so the loop cannot write its own report card. A round that
   could not be compared is recorded as such and counts as rejected; `references/rejection-catalogue.md` is
   every reason, and what causes it.

   The round door REFUSES (409) once the frame's own ending has fired — the budget is spent, or the rejected
   streak was reached. The record enforces its endings; you do not count, and you cannot overrun them. Ask
   step 6 and settle. It also refuses (400) a round the row could not hold: `hypothesis` up to 2000
   characters, `learned` 10 to 4000, `candidateVersion` up to 100 — the same bounds on both transports.
6. **Ask.** `GET /campaigns/:id/decision` (MCP: `campaign_decision`) returns `CampaignGateAnswer` without
   touching anything: `continue` (go to 2), `adopt`, or `halt` with a reason. Ask this rather than counting
   rounds yourself — the arithmetic is the frame's, not yours.
7. **Close.** `POST /campaigns/:id/settle` (MCP: `settle_campaign`) writes the gate's answer. It REFUSES
   while the answer is `continue`: a campaign settles on an adoptable candidate or on its own ending.
8. **Spend it.** A close that adopted leaves a durable authorization; read it with
   `GET /campaigns/:id/adoption` (MCP: `campaign_adoption`) and present it to `POST /campaigns/:id/adopt`
   `{proof, spec}` (MCP: `adopt_campaign_candidate`), which registers the version and reads it back.
   When the candidate came from a pull request (its scorecard's origin named one), the same close also
   recorded a CODE debt: `POST /campaigns/:id/merge` `{proof}` (MCP: `merge_campaign_candidate`) merges that
   pull request at the head the round measured, after the bytes are registered. A chain (`continues`) is
   refused over an adoption whose code is still owed.

## The three things that surprise every first driver

- **Settling is not adopting.** `campaign.closed` says the gate decided; the registry write is a separate,
  spendable authorization, and it stays owed until somebody spends it. A campaign reading `adopted` whose
  `operation` is still `decided` is not a bug — it is work not yet done.
- **The exam is the frame's.** The compared cases must be EXACTLY the frame's scenarios (missing and extra
  both reject) and the judges exactly the frame's judges. Run a different dataset slice and every round is
  incomparable, with no error at submit time to warn you.
- **A rejected round is not always a dead end.** Read WHY it lost. Held-out regressions mean the direction was
  wrong — abandon it. But a comparable round with zero improvements and zero regressions is NEUTRAL, and a
  neutral candidate is a foundation: author the next one on top of it and keep its version alive. Every round
  compares against the frame's FROZEN baseline, never against the previous round, so two steps that only pay
  off together are measured as one cumulative delta.

  And the family a chain pre-registers covers the whole TREE the chain roots — a halted sibling that continued
  the same predecessor spent its rounds against the same held-out rows, and the open counts them.

  This is where the design differs from the literature it resembles. WikiSkill (arXiv 2608.27454) records
  "strict validation gating excludes neutral updates" as a limitation, and it is one for them because their
  loop rolls the skill directory back to the last ACCEPTED state — the neutral step is destroyed. Here the
  baseline is frozen and the candidate is free, so nothing is destroyed unless the driver deletes it. And the
  family correction makes neutral rounds MORE common (a round is judged at `fdrAlpha / heldOutFamilySize`, so
  a real but small effect often will not clear it), which means discarding them wastes precisely what the
  correction cost.
- **Ingested rounds are unverified on every axis, and label-only.** An ingested scorecard seals no
  manifest and names no registry document, so a round over one carries every identity axis as unverified and
  no candidate spec digest. Both are refused by default, and both are repairable only at OPEN: a frame for a
  loop over ingested traces (`agent_evolve`) declares `allowUnverifiedIdentity` AND `allowLabelOnlyAdoption`,
  or its first winning round halts `identity_unverified` with nothing to settle. The halt's detail names the
  field. `harness_evolve` runs real batches and needs neither.
- **A finding is advice, never evidence.** `learned` is the one value on a round the loop authors about its
  own walk, so the adoption gate does not read it and must not — the whole reason the verdict is derived is
  that a loop may not write its own report card. It feeds the next proposal, which is a different question
  from what decides.
- **Held-out is what decides.** Whole-round improvements are feedback about your SEARCH; the gate reads the
  held-out block, and a frame needs at least two held-out scenarios to be created at all.

## Depth

- `references/frame-design.md` — every frame field, what it costs to get wrong, and the three waivers
  (`allowUnverifiedIdentity`, `allowLabelOnlyAdoption`, `observationPolicy.allowDivergent`) with the
  refusal each one turns off. Read before opening a campaign.
- `references/rejection-catalogue.md` — every refusal a round, a settle or an adoption can answer, its exact
  cause, and the repair. Read when something comes back not-comparable or 409.
- Rule `protocol` for why the verdict is derived rather than accepted; skill `evaluation` for the scorecard
  and diff semantics the round verdict is built from.

This file is the driver for a human or an outside agent. The product's own agent has the same walk as three
first-party skills in `packages/application-control/src/capability/first-party.ts` — `agent_evolve` for an
agent configuration (shadow tries, ingested traces), `harness_evolve` for a harness (real batches, so no
identity waiver), and `code_evolve` for a harness whose CODE changes: a delegated coding agent in a sandbox
makes the change, Everdict builds the image into its own managed store and mints the candidate version
(`docs/architecture/code-evolution-loop.md`). They are the same protocol with different subjects;
when this file changes, check whether they say the same thing.
