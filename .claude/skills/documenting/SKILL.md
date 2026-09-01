---
name: documenting
description: Which layer a piece of knowledge belongs in — a doc, a rule, or a skill — and what each one owes. Use before writing or moving any document, rule or skill, and when a change leaves knowledge with nowhere obvious to go.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash
---
# Documenting — which layer, and what it owes

`.claude/skills/README.md` splits the convention system by **how the knowledge fails**, and that frame is
right. It just stops at two layers. `docs/` appears there only as something `pnpm docs-check` also scans, so
the question a writer actually has — *where does this go?* — has never had an answer.

It shows: this repository has 166 documents, 28 rules and 19 skills, and nothing states the choice between
them. Everyone picks by instinct, and instinct puts the same knowledge in three places at once or in none.

## The three layers, by the failure each one prevents

    RULE   (.claude/rules/)   fails as: nobody remembers it at the moment of editing
                              so it is: pushed by a `paths:` glob, thin, and about what you would
                              otherwise do "the standard way" and get wrong here

    SKILL  (.claude/skills/)  fails as: a design made without context that already existed
                              so it is: pulled by name or description, a recipe or a domain model

    DOC    (docs/)            fails as: the REASON is lost, and the question is re-litigated
                              so it is: a record — the decision, what it rejected, and the evidence

The test is one question: **what breaks if this is missing?** A defect written at the keyboard is a rule. A
design that goes the wrong way for lack of context is a skill. An argument nobody can reconstruct in six
months is a document.

## Choosing, in order

1. **Is it a prohibition that fires while typing?** → rule. Keep it to the non-default: what an ecosystem
   default would get wrong here. Rules are injected by a glob nobody chose to read, so a rule nobody obeys is
   a rule that arrived at the wrong moment, not one written badly.
2. **Is it what you wish you had read before starting?** → skill. Recipes, domain models, subsystem
   specifics, the passes of a review. A skill is allowed to be long because it is pulled deliberately.
3. **Is it a decision plus its reason?** → document. This is the layer with a memory: a rule says *do this*,
   a skill says *how*, and only a document says *why, and what we chose against*.
4. **Is it none of them?** Then it is a code comment, and this repository's comments carry that weight — the
   case law in rule `protocol` lives beside the code it constrains, not in a document.

## What a design record owes

A document that records only the current shape is a description, and a description is what the code already
is. The record is the part the code cannot hold:

- **The alternative that was rejected, and why.** `docs/architecture/docs-site.md` is the exemplar in this
  tree: it proposes the obvious tidy — move the root docs under a reference directory, the architecture ones
  under a design directory — and then rejects it against a measured count of in-code references that the move
  would break. A reader who arrives with the same idea is answered in one paragraph instead of re-running the
  sweep.
- **The number, not the adjective.** "Many references" ages into nothing; a counted sweep stays checkable and
  its expiry is visible when the count moves.
- **What would reopen it.** A decision with no stated trigger is a decision nobody can revisit honestly.

## Where a document goes

The tree's own layout is a recorded decision, not an accident — read `docs/architecture/docs-site.md` before
moving anything. In short: `guide/` is product documentation written for someone using Everdict; everything
else is for maintainers, indexed by topic in `docs/README.md` rather than by directory. Placement between the
root and `architecture/` is historical and deliberately frozen, because in-code references make relocation
expensive.

So: add the document where its neighbours are, link it from `docs/README.md` — `pnpm docs-check` refuses an
orphan — and do not reorganise the tree as a side effect of writing one page.

## What the gates cannot see

`pnpm docs-check` proves every document is reachable from the index, that its relative links resolve, that
every backticked repository path exists, and that every symbol a rule or skill names is one the source
declares. `pnpm convention-harness` proves every rule reaches live paths and every workspace is governed.

None of them can see:

- **a document that records state instead of a decision** — it passes every check and answers nothing;
- **a decision the code has since reversed** — the paths still exist, the symbols still exist, and the
  sentence is now false. Rule `protocol` names this: a claim about another component is the part that needs
  checking, and the present tense is the half that slips through;
- **the same knowledge in two layers** — a rule and a skill saying it differently have already diverged, and
  the reader obeys whichever arrived last.

The third one is the reason to choose deliberately rather than write in all three and hope.

## When a change must update this layer

CLAUDE.md already says skills travel with the code: a change to a convention or an invariant updates the
matching skill reference in the same change, and mere implementation churn does not. The same sentence
applies to the other two layers with the same test — did the RULE change, or only the code that follows it?

A change that reverses a recorded decision updates the record. Leaving the old one standing beside the new
behaviour is worse than having written nothing, because the next reader has two answers and no way to tell
which is live.
