---
kind: decision
title: "Document kinds — wiki, decision, spec, runbook"
status: accepted
updated: 2026-09-04
anchors: [scripts/check-docs.mjs]
---
# Document kinds — wiki, decision, spec, runbook

> **What this decides.** `docs/` holds four different things and had names for two of them. This page fixes
> the vocabulary, says what each kind owes and how each one is allowed to CHANGE, and moves the taxonomy
> from a frontmatter field nobody read into check 5 of `pnpm docs-check`.

## The count that forced it

`kind:` had been in every document's frontmatter since the tree was laid out, and nothing consumed it. That
is a declaration with no reader — this repository's most-repeated defect, in a documentation costume. Counting
the field said so out loud:

| `kind` | count | what was actually in there |
|---|---|---|
| `wiki` | 142 | descriptions of what is — the honest majority |
| `decision` | 24 | **20 frozen** re-architecture records, and **4 specs** |
| `runbook` | 8 | migration preflights + two operator procedures |
| `design` | 1 | a word no other document spells |
| *(none)* | 1 | `docs/architecture/parallel-evolution.md`, which opens `Status: **design**` in prose |

So the layer skill `documenting` calls the whole point of `docs/` — *"only a document says why, and what we
chose against"* — had **zero live members**. Every non-historical `decision` in the tree was a `*-spec.md`
file, and the two pages that genuinely decide something had to announce it in prose because the taxonomy had
no word for them.

`status` was not carrying information either. Every `wiki` was `current` and every `decision` was `accepted`,
one to one, so the field was a second spelling of `kind`.

## The four kinds

    wiki      describes what IS                        142
    decision  a choice, and what it rejected            22
    spec      the buildable shape of one architecture    4
              or implementation
    runbook   an operational procedure                   8

**wiki** — the reference layer. It answers *how does this work today*. A wiki page has no memory and does not
need one: when the world moves, the page is edited in place and the old text is gone. `status: current`, and
there is no other honest value — a wiki that is not current is a defect, not a state.

**decision** — the layer with a memory. It answers *why, and what we chose against*. It owes three things the
code cannot hold, and skill `documenting` states them: the alternative that was rejected and why, the number
rather than the adjective, and what would reopen it. `status: proposed | accepted | superseded`.

**spec** — the buildable shape. It answers *what has to be true for this to exist*, section by section, with
the counterexample each section owes before it lands. A spec names the source it specifies in `anchors:`, so
drift is loud: check 4b already refuses an anchor that stopped existing, and requiring the field is what gives
a spec one to refuse. Named `*-spec.md`, because the name and the kind are two spellings of one fact and the
drift this page fixes is exactly what happens when they are allowed to disagree.
`status: proposed | accepted | landed`.

**runbook** — an operational procedure someone follows under pressure. `status: current`, or it is a trap.

## How each kind is allowed to change

This is the half that makes the structure hold, and it is an ASYMMETRY rather than a policy:

    wiki      EDITED in place        the old sentence was a description, and it is now wrong
    runbook   EDITED in place        same
    spec      sections gain Landed   and what the section taught becomes a wiki page
    decision  SUPERSEDED, never edited once accepted

An accepted decision is not edited, because editing it destroys the only copy of the answer we used to give.
A reader who arrives at a reversed decision has to be able to LEAVE it, so `superseded-by:` is a link the gate
resolves rather than a sentence in the body. Until a decision is `accepted` it is `proposed` and may be
rewritten freely — a proposal is not yet a memory of anything.

The corollary is what skill `documenting` already warns about from the other side: *a change that reverses a
recorded decision updates the record.* Leaving the old one standing beside the new behaviour gives the next
reader two answers and no way to tell which is live. Superseding is how that is done without losing the first.

## What check 5 refuses

`scripts/check-docs.mjs`, on every `docs/**/*.md` including the index:

1. frontmatter exists and declares `kind` · `title` · `status` · `updated`;
2. `kind` is one of the four;
3. `status` is one the kind allows — a `wiki` may not claim `accepted`, a `decision` may not claim `current`;
4. `updated` is an ISO date;
5. `*-spec.md` ⟺ `kind: spec`, in both directions;
6. a `spec` declares `anchors:`;
7. `superseded` names a `superseded-by:` that resolves to a document in the tree — and nothing else may name
   one.

Each arm was driven red against this tree before it landed. Arms 5, 2 and 1 fired on the six real defects
above; 3, 4, 6 and 7 were driven by hand, because no document in the tree exercises them yet.

## What it cannot see, and does not try to

The gate checks the SHAPE of the declaration. It cannot tell a decision from a description — a page that
records only the current design passes every arm and answers nothing, which skill `documenting` names as the
failure the doc layer exists to prevent. It cannot tell that an `accepted` decision has been quietly edited
instead of superseded; git history can, and a reviewer reading a diff on a `kind: decision` page should ask.
It cannot tell a stale wiki page from a fresh one — `updated` is a date somebody typed.

What it does buy is that those questions are now ASKABLE. A reviewer who wants to know whether the decision
layer is being kept can list it (`grep -rl "^kind: decision" docs`), which was not a meaningful query before
this change, because the answer was four spec files.

## What was rejected

**A directory per kind** (`docs/decisions/`, `docs/specs/`, `docs/wiki/`). This is the obvious tidy and
`docs/architecture/docs-site.md` already rejected it once, against a counted sweep of the in-code references a
relocation would break — every rule's `paths:` glob, every `anchors:` entry, every backticked citation check 3
validates. Nothing about naming the kinds requires moving the files, and a taxonomy that costs a rename to
apply is one that stops being applied. The kind is frontmatter; placement stays where `docs-site.md` put it.

**Leaving `kind` unchecked and writing the convention down instead.** The convention WAS written down, in the
frontmatter of 176 files, and it drifted into four wrong labels, one invented word and one omission — with a
gate in the same script reading the frontmatter three lines away. Rule `ci` records the general form: a rule
its author broke while writing it is a note, not a rule.

**A free-form `status`.** Tempting, and it is how the field got to be redundant with `kind` in the first
place. Each kind's set is small and closed so that a status says something the kind does not.

**A fifth kind for design explorations** (the `design` singleton, and `parallel-evolution.md`). Both are
decisions: one says what the case space must support and names the axes the domain lacks, the other decides
what may cross a branch boundary and argues for leaving the rest alone. `proposed` is the state they were
reaching for, and it belongs to `decision` rather than to a kind of its own.

## What would reopen this

- **A document that is honestly none of the four.** The list is closed on purpose; a fifth kind is a decision
  that supersedes this one, not a value added to the map.
- **`proposed` decisions accumulating.** If the tree fills with proposals nobody accepts or rejects, the
  status is being used to avoid a decision rather than to stage one.
- **The first supersede going badly.** Arm 7 has never fired on a real reversal. If linking a successor turns
  out to be the wrong shape — a decision superseded by three pages, or by a code change with no page — this
  page is where that is recorded.
