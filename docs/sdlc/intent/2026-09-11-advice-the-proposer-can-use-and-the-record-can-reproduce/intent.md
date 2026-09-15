# Intent: advice a proposer can use, and a record that can reproduce which advice it used

Author: Claude (session designing the evolution direction, at the maintainer's request — "SkillOpt and
WikiSkill now need a direction design"). Status: draft

## Problem

WikiSkill (arXiv 2608.27454v1, S00 in the literature review) reports the largest single effect in the whole
catalogue, and it is not about skill evolution: giving the PROPOSER durable development knowledge moved the
four-benchmark mean from 48.7 to 63.7 (+15.0 points) with executor access disabled. Everdict already holds the
hard half of that — `campaignRoundBrief` gives the proposer the mechanism and the executor nothing, by
construction, and its own comment cites the ablation.

What Everdict does not have is the easy-sounding half, and it is missing in two different ways.

### 1. Nineteen paragraphs of prose is not a knowledge layer

`CampaignRound.learned` was added for exactly this, and the field's comment already chose its shape: append-only
with the round, because *a document the loop may rewrite is a document the loop can use to revise its own
history* (L4). That decision is right and is not being reopened. But the READ side was never built:

- round twenty-one is handed every prior `learned` in sequence, unranked, with no ordering by relevance to the
  candidate being proposed;
- two rounds that learned contradictory things both appear, and nothing marks the contradiction — the later
  one does not supersede the earlier one, because a round cannot edit a round;
- `inherited` carries other campaigns' findings labelled by source, which is the right provenance and the same
  flat list one level up;
- nothing links a lesson to the evidence that produced it beyond the round it sits on, so a proposer cannot
  ask "which cases support this" without re-reading every round's evidence.

`KnowledgeEntryRecord` is the shape this wants — a claim with subject-time pins, `evidence` refs, `supersedes`
lineage, extraction provenance, a confidence, and a `verifiedAt` freshness signal — and it is a WORKSPACE
registry with a human review gate, which is precisely why a curator may not write into it.

### 2. A proposal cannot say what it read

This is the half that makes the first experiment impossible rather than merely awkward. Comparing a curated
projection against a same-budget flat history requires knowing, per proposal, which bytes each arm actually
had. A round records `learned`, `informedBy` and the campaigns it inherited from — pointers into records that
keep changing as the walk continues. A pointer to a mutable projection is not a record of what was read.

Everdict already solved this exact problem for evidence: a round references frozen payloads by `{key, digest}`
rather than re-reading "the record's current results" (L4). Advice needs the same treatment and does not have
it.

## Proposed outcome

- A proposal records the exact advisory bytes it was made under, by key and digest, in the shape rounds already
  use for evidence. Re-reading a campaign months later reproduces what round seven was told, not what the walk
  has since learned.
- A driver can obtain a ranked, contradiction-aware, source-linked projection of everything the walk and its
  ancestors recorded — as a READ over the append-only ledger, not as a second store and not as a new authority.
- A curator that finds a claim worth keeping beyond the campaign can offer it through the existing knowledge
  proposal path, where a person approves it. Nothing machine-written becomes `active` workspace knowledge on
  its own.
- The executor's disclosure is unchanged in every respect. This intent adds nothing a delegate can read.

## Affected users and systems

`packages/contracts` (the advisory rider on the round, in the existing `{key, digest}` shape),
`packages/domain` (`campaignRoundBrief` renders the digest's provenance line; the projection's ordering rule if
it turns out to belong on the platform), `packages/application-control` (the read the driver calls; the
knowledge proposal path is already there), `packages/db` (nothing new if the snapshot rides the existing
artifact store), `apps/api` (one read door, BFF↔MCP parity).

`docs/architecture/evolution-first-loop.md` is the direction this narrows — specifically its third step and its
first experiment's arm (c). `docs/architecture/evolution-research-directions.md` C1 is the proposal it comes
from, and `docs/architecture/evolution-literature-review.md` S00 is the source.

## Constraints

- **Advice is never evidence.** `campaignAdoption` does not read `learned` and must not read this. The gate's
  answer has to be identical with the advisory layer present and absent, and the counterexample that pins that
  for `learned` today is the one this must not break.
- **The curator may not promote.** `KnowledgeEntryRecord`'s `proposed → active` gate exists so machine advice
  does not silently become reviewed workspace knowledge. A curator writes a driver-owned projection and
  proposes; a person approves.
- **No executor-side memory.** WikiSkill's own ablation lost 2.8 points when the executor also saw the wiki,
  and the brief's three exclusions are enforced by construction. This intent may not widen them, and runtime
  memory — which is a legitimate product feature — is evaluated as part of a CANDIDATE with its own identity.
- **The append-only ledger stays the substrate.** The projection is derived; a claim that cannot be traced back
  to the rounds it came from is not admissible to it.
- **A snapshot is derived input, not a verdict source.** An unavailable required input fails or is explicitly
  omitted by a recorded policy — never silently substituted with whatever is current at evaluation time
  (L2: "we could not read the advice" is not "there was no advice").
- **The digest covers what was READ, not what exists.** A projection the driver requested and did not use is
  not what the round was made under; the rider records the bytes handed to the proposal.

## Open questions

These are the design pass, not leftovers from it.

- **Where does the ordering rule live?** Ranking, contradiction detection and supersession look like driver
  procedure under the ownership rule in the direction decision — a wrong ranking wastes a proposal and corrupts
  nothing. But if two drivers must produce comparable arms in one experiment, the ordering may have to be
  declared and frozen like everything else the comparison depends on. The test is the same one the direction
  decision uses: would a second driver need it to be the same?
- **Is the snapshot an artifact or a field?** `{key, digest}` into the existing artifact store matches how
  evidence travels and survives large projections. An inline field is cheaper and bounded. The answer probably
  follows from how big a useful projection actually is, which nobody here has measured.
- **What does the curator read for a campaign that inherited?** `inherited` already crosses the campaign
  boundary with findings labelled by source. Whether the projection spans the whole `continues` chain by
  default, or only what the driver asks for, changes what "the same advice" means across arms.
- **Does a lesson need its own identity?** Supersession and contradiction want stable ids for claims, and a
  round's `learned` is prose with no id. Minting ids in the projection makes them derived and unstable across
  re-projections; minting them on the round changes an append-only record's shape. Neither is obviously right.
- **How is the C1 arm (b) built?** "Same-budget flat history" needs a token budget that matches arm (c), and
  the budget is a property of the projection nobody has built yet. The experiment cannot be specified before
  the projection has a measured size.
