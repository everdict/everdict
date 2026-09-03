# Parallel evolution — the walk branches, and what may cross between branches

> Status: **design**. Nothing here is landed. The one code change it proposes is named in "What is missing"
> and is deliberately small; everything else is an argument for leaving the existing design alone.

A campaign is a walk: open a frame, log rounds, settle. Run several at once and the walk becomes a **tree** —
`continues` names a predecessor, and several campaigns may continue the same one. That is already possible
today and already accounted for. What is not possible is the operation a tree makes people want: taking two
of its leaves and applying **both**.

This page decides what crosses a branch boundary, what does not, and why the answer is different for bytes
than for evidence.

## What already holds (and this page does not restate)

- **The tree is already the unit of statistical accounting.** `assertChainIsHonest`
  (`packages/application-control/src/evolution/campaign-service.ts`) walks the ancestors of `continues` AND,
  transitively, every campaign that continues any member — across the tenant, deliberately without the
  caller's team ceiling, because "a private team's sibling spent the rows just the same". The pre-registered
  `heldOutFamilySize` is spent by the whole tree, not by one line through it.
- **A chain link is verified, in six checks**: the predecessor ADOPTED something; of the same subject; this
  frame baselines exactly the version it adopted; the held-out rows are identical; the significance block is
  identical; and the rounds already spent plus this campaign's `budget.maxRounds` still fit inside the shared
  family. A walk longer than `MAX_CHAIN_LINKS` (64) is refused rather than followed.
- **Adoption is an authorization over BYTES.** The proof names a `specDigest`, the spend re-reads what the
  registry resolves and compares it, and the gate refuses to answer `adopt` at all when it cannot name the
  candidate's bytes (unless the frame froze `allowLabelOnlyAdoption`). See Track D of
  `evolution-lineage.md`.
- **`learned` is advice and the gate does not read it** — "a finding is advice, never evidence" (skill
  `evolve`). It is the one value a loop authors about its own walk.
- **A three-way merge already exists**: `mergeThreeWay(base, ours, theirs)` in `@everdict/domain`
  (`packages/domain/src/workspace-file/merge.ts`), written for concurrent workspace-file edits.

## The observation this page starts from

**Parallelism is free in execution and is not free in evidence.**

Branches are independent in every way that matters operationally: separate campaigns, separate rounds,
separate candidates, no shared mutable state, and — the property that makes them worth running at once —
neither can disturb the other's world. That independence is real and it is the reason to fan out.

It is not statistical independence. Every branch asks the SAME frozen held-out rows, so N branches make N
times the comparisons against one population. The design already prices this, which is why the family walk
is a transitive closure rather than a line. A fan-out of ten at `heldOutFamilySize: 3` is not ten cheap
experiments; it is a pre-registration that ten rounds will exhaust.

Stated as the trade: **the tree buys wall-clock and spends significance.**

## The decision: two merges, opposite rules

"Apply both leaves" is two operations that people say in one breath, and they have opposite answers.

### Bytes merge — yes, and the frozen baseline is what makes it possible

Sibling leaves share a baseline BY CONSTRUCTION: check 3 of the chain rules says a campaign baselines exactly
what its predecessor adopted, so two campaigns continuing the same parent start from the same frozen version.
That version is the merge base, and `mergeThreeWay(base, ours, theirs)` is defined on exactly that shape.

A conflict is an honest refusal, not a failure to handle: two directions edited the same place, and which one
survives is a decision no arithmetic can make. It goes back to the driver.

**The discipline of freezing the baseline pays twice.** It was introduced so that a round measures the
CUMULATIVE delta rather than the delta from the previous round ("two steps that only pay off together are
measured as one cumulative delta", skill `evolve`). Mergeability is the second dividend, and it was not
designed for — it falls out.

### Evidence merge — no, and this is the point rather than a limitation

Leaf A's adoption authorizes A's bytes. Leaf B's authorizes B's. **A∪B is a document neither campaign
measured**, so its evidence is not weak — it is absent. Rule `protocol` L4 (a settlement owns immutable
bytes) and the gate's own rule ("adoption is of the current variant, never archaeology over the trace") both
say the same thing from different directions.

So the merge produces **a candidate, not an adoption**. It has to be measured like any other candidate, in a
round, against the frozen baseline — which spends family budget, which the tree accounting already counts.

There is no compose-two-proofs operation and there should not be one. A platform that had it would let a
driver assemble an adoption out of parts that were never run together, which is the "a fallback is a new
semantic decision" failure (rule `suite`) at the level of the whole walk.

## What is missing: the shape is a tree, and a merge is a DAG

```ts
continues: z.string().min(1).max(200).optional()   // one parent
```

A merge node has two. The schema cannot hold it, and that is the entire structural gap.

**The workaround, and what it costs.** Continue ONE parent and treat the other branch's delta as the
candidate. This measures "B's increment on top of A", which is a genuinely useful question — and the record
then says the campaign came from A alone. The provenance is half-written, which rule `protocol` L3 names
(provenance is born at the source, never re-derived downstream). Nothing later can reconstruct that this
version came from two lineages.

**The change is DESIGNED AND DELIBERATELY NOT BUILT, because nothing merges leaves today.** Rule
`api-layer` is explicit — "a field, parameter, or endpoint exists only if it has a current caller; 'could be
useful later' is removal grounds, not justification" — and a `continues: string[]` with no driver that
produces a merge is that surface exactly. Two things would give it one: a driver that fans out and wants both
results, or a second campaign that cannot express its ancestry without it. Until then the workaround above is
the honest shape, and its cost (half the provenance) is recorded here rather than discovered later.

What it would be, when it has a caller. `continues` becomes a list, and three things follow — none of them large,
because the existing code is already set-shaped:

1. **The family walk unions and de-duplicates.** `assertChainIsHonest` already builds a `Set` and grows it to
   a fixed point; seeding it from several roots is the same loop. Without de-duplication a merge would
   double-count the shared trunk, which over-charges the family and refuses honest campaigns.
2. **Checks 4 and 5 must hold against EVERY parent.** The same held-out rows and the same significance block,
   for both — which is a strictly stronger requirement than the single-parent case, and the right one: a
   merge of two walks that were judged at different levels is a merge of two different pre-registrations.
3. **Check 3 becomes the merge.** "This frame baselines what its predecessor adopted" becomes "this frame
   baselines the MERGE of what its parents adopted" — computed by `mergeThreeWay` against the shared
   ancestor, refused when it conflicts. The baseline of a merge campaign is a document the platform derived,
   so it is registered like any other version before the campaign opens, and the frame names it by digest.

**What was checked before writing that.** The tree accounting is not a comment: `assertChainIsHonest` grows
the closure to a fixed point and then sums it —
`for (const c of everyCampaign) if (tree.has(c.id) && !seen.has(c.id)) spent += c.rounds.length` — so a
sibling's rounds really are charged to the family. There is no defect to fix here; there is a shape the
schema cannot express, and no caller that needs it expressed.

## Rejected alternatives

**A merge inherits the stronger parent's evidence.** Tempting because both parents' adoptions are real
authorizations and the merge "contains" them. Rejected: the adoption's proof names a `specDigest`, and the
merged document's digest is not either parent's. Honouring it would mean the adoption gate accepting a
document it never compared, which is precisely the state arch-review 71-73 spent three waves abolishing.

**A merge is a fresh campaign with no ancestry** (`continues` omitted). Cheapest, and it type-checks today.
Rejected because the family accounting is the thing that keeps a fan-out honest: a merge that forgets its
parents asks the same held-out rows again for free, and a driver could then launder an exhausted family by
merging. The whole reason the walk counts the tree is that spent tests do not come back.

**Findings are global to every branch.** This is what the loops in the literature do, and the appeal is
real — a fan-out of ten produces ten times the findings, and they are the only thing that can cross a branch
boundary safely (the gate does not read `learned`, so sharing it cannot contaminate evidence).

Rejected AS THE DEFAULT, for a cost a chain does not have: **branches that read each other's findings stop
being independent searches.** They converge, and correlated branches spend the same family budget while
asking fewer distinct questions — the tree's one purchase, given away. WikiSkill (arXiv 2608.27454) does not
meet this because it is a single lineage; its measured split (the same knowledge to the proposer, +15.0; also
to the executing agent, −2.8) is about WHO reads a finding, not about how many walks read it.

So: findings stay readable, and a campaign that reads another branch's findings DECLARES which ones. That
keeps the +15.0 half available and makes the diversity cost visible to whoever reads the tree afterwards,
instead of it being an invisible correlation between rows that look independent.

## What this does not change

The environment is now its own identity axis (a case's environment version is sealed on the manifest). Two
leaves that ran against different environment versions are results from different worlds, and merging their
bytes does not merge their worlds. The platform already says so — the diff reports `confoundedAxes` for an
axis VERIFIED different and `unverifiedAxes` for one it could not check — so a merge campaign gets the same
answer every other round gets, from machinery that already exists. No new check is proposed; the point is
that a bytes merge is not an experiment merge, and the identity axes are where that shows up.

## What would reopen this

- **A merge whose parents genuinely cannot share a baseline.** The design above rests on siblings, and
  siblings share a baseline by construction. Merging leaves from two different roots is a different problem
  and this page does not solve it.
- **Evidence that correlated branches are the cheaper trade.** The rejection of global findings is an
  argument, not a measurement. A fan-out run twice — findings shared and findings scoped — measured on
  distinct-questions-per-family rather than on score, would settle it.
- **A fan-out wide enough that the family is the binding constraint rather than compute.** At that width the
  honest move may be a per-branch held-out split rather than a shared one, which changes what a chain means
  and would supersede check 4.

## Related

- `docs/architecture/evolution-lineage.md` — ancestry at the write, the campaign as a settlement (Track D).
- `docs/architecture/evolution-routing-spec.md` — memory across campaigns; who proposes and from what.
- `docs/architecture/code-evolution-loop.md` — the code arm, whose `merge` is a pull request landing and is
  not the merge this page is about.
- Skill `evolve` — driving a campaign; why the verdict is derived and a finding is not evidence.
- Rule `protocol` — L3 (provenance at the source) and L4 (a settlement owns immutable bytes), which are the
  two laws the evidence-merge refusal is an application of.
