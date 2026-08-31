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
3. **Run both sides.** `POST /scorecards` for baseline and candidate, each with `trials` at least the
   frame's `trialsPerCase`. Statistics need repeats; one trial per case produces no signal at all.
4. **Wait.** Scorecards are async. Poll `GET /scorecards/:id`, or subscribe to `scorecard.completed` —
   it is a triggerable kind, so a subscription can wake an agent when a side lands. The campaign's own
   facts (`campaign.round_logged`, `campaign.closed`) are feed facts and are NOT triggerable: the loop
   cannot wake itself on its own progress.
5. **Log the round.** `POST /campaigns/:id/rounds` `{hypothesis, candidateVersion, baselineScorecardId,
   candidateScorecardId}` (MCP: `log_campaign_round`). **You do not send a verdict.** The service derives it
   from the production scorecard diff — trial significance plus experiment identity — so the loop cannot
   write its own report card. A round that could not be compared is recorded as such and counts as rejected;
   `references/rejection-catalogue.md` is every reason, and what causes it.
6. **Ask.** `GET /campaigns/:id/decision` (MCP: `campaign_decision`) returns `CampaignGateAnswer` without
   touching anything: `continue` (go to 2), `adopt`, or `halt` with a reason. Ask this rather than counting
   rounds yourself — the arithmetic is the frame's, not yours.
7. **Close.** `POST /campaigns/:id/settle` (MCP: `settle_campaign`) writes the gate's answer. It REFUSES
   while the answer is `continue`: a campaign settles on an adoptable candidate or on its own ending.
8. **Spend it.** A close that adopted leaves a durable authorization; read it with
   `GET /campaigns/:id/adoption` (MCP: `campaign_adoption`) and present it to `POST /campaigns/:id/adopt`
   `{proof, spec}` (MCP: `adopt_campaign_candidate`), which registers the version and reads it back.

## The three things that surprise every first driver

- **Settling is not adopting.** `campaign.closed` says the gate decided; the registry write is a separate,
  spendable authorization, and it stays owed until somebody spends it. A campaign reading `adopted` whose
  `operation` is still `decided` is not a bug — it is work not yet done.
- **The exam is the frame's.** The compared cases must be EXACTLY the frame's scenarios (missing and extra
  both reject) and the judges exactly the frame's judges. Run a different dataset slice and every round is
  incomparable, with no error at submit time to warn you.
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
