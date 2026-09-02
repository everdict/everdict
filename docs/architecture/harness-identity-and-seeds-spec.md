---
kind: decision
title: "Harness identity and seeds — forks are recorded, seeds hang off the version, lineage is one read, a seeded finding is a leak"
status: accepted
updated: 2026-09-02
anchors: [packages/contracts/src/harness/harness-template.ts, packages/contracts/src/knowledge/predicate.ts, packages/contracts/src/knowledge/knowledge-node.ts, packages/contracts/src/records/skill.ts, packages/contracts/src/records/knowledge-entry.ts, packages/application-control/src/evolution/campaign-service.ts]
---
# Harness identity and seeds — forks are recorded, seeds hang off the version, lineage is one read, a seeded finding is a leak

> **Status:** spec for Pillar 2 of `docs/architecture/evolution-program-gap-map.md` (gaps G2.1–G2.4). Nothing
> below is implemented. §2 and §4 land in ONE change or not at all: a seed that is part of the digest is a seed
> the leak rule can read, and a seed outside the digest is one the rule cannot.

## What holds, and what this spec must not restate

Instance versions are immutable; a version resolves (`resolveHarnessInstance`) to a document whose digest a
scorecard manifest seals (`packages/contracts/src/records/scorecard.ts`), so "which harness ran" is a
provable fact. Every register carries a `CapabilityOrigin` — channel, the intent it was born from, a note —
and the knowledge graph records `succeeds` (one id, version N to N−1) and `born_from` (a version to the
issue, scorecard or run that caused it) — `packages/contracts/src/knowledge/predicate.ts`;
`docs/architecture/evolution-lineage.md` Track A. `diff_harness_versions` names the slot that moved between
two versions. Skills are versioned records (`packages/contracts/src/records/skill.ts`); knowledge entries
are claims with `evidence` and a `supersedes` chain (`packages/contracts/src/records/knowledge-entry.ts`);
both carry `refs: KnowledgePin[]` — a claim's known-valid INTERVAL along an entity's version timeline
(`packages/contracts/src/knowledge/knowledge-node.ts`; `docs/architecture/knowledge-graph.md`).

## §1 — A fork is recorded where it happens (G2.1)

**The gap.** `succeeds` is same-id only. A harness that started as a copy of another — a Codex variant of the
Claude scaffold, a workspace's copy of a `_shared` template, a team's fork of another team's instance —
records nothing about where it came from. "Which harnesses descend from this one" is unanswerable, so a
regression found in the parent cannot be checked in its children, and an improvement adopted in a child
cannot be offered to its parent.

**Decision.** `lineage?: { forkedFrom: { id, version, specDigest } }` on `HarnessInstanceSpec` and on the
template shapes in `packages/contracts/src/harness/harness-template.ts`. Verified at register, not
annotated: the named version must resolve in this workspace or `_shared`, and its resolved document must
digest to the `specDigest` the fork claims — a fork that names bytes it did not come from is refused (409).
The register writes a `forked_from` edge (a new predicate beside `succeeds`) and the origin `note` names it.

**Rejected: deriving forks after the fact by digest similarity or by name.** That is provenance re-derived
from rendered output — rule `protocol` L3 — and it is wrong the first time two independent authors write
similar templates. A fork is a fact the forker knows at the moment of forking; record it there or nowhere.

**Counterexample (RED first).** Register B with `lineage.forkedFrom = A@1.0.0` carrying A's digest: the graph
holds `B@1.0.0 forked_from A@1.0.0`. Register C claiming to fork A with a digest A never had: refused, and no
edge exists. Today the field is unknown and both register cleanly with nothing recorded.

## §2 — Seeds hang off the harness version, and are part of its identity (G2.2)

> **Landed 2026-09-02.** `HarnessSeedsSchema` on the instance and on every resolved spec
> (`packages/contracts/src/harness/harness-spec.ts`, `packages/contracts/src/harness/harness-template.ts`) — so
> inside `specDigest` and the manifest seal; the digests a seed names are `skillSeedDigest` (a stamped skill
> version's instructions + files) and `knowledgeSeedDigest` (an entry's title + body) in
> `packages/domain/src/harness/harness-seeds.ts`, exposed on `GET /skills/:id/versions/:version` and
> `GET /knowledge/entries/:id` as `seedDigest`; the dispatch chain's `SeedingDispatcher`
> (`apps/api/src/core/execution/seeding-dispatcher.ts`) reads the bytes from the workspace's skill-version and
> knowledge-entry stores, refuses a mismatch (409) or a missing seed (404), and attaches them to the job as
> `seedFiles`; the runner writes them at `HARNESS_SEED_MOUNT` (`/everdict/seeds`) before the harness installs
> (`packages/application-execution/src/run-case.ts`); a command reaches the mount through `{{seeds}}`.
> Verification happens at DISPATCH, not at register: a version naming a stale digest registers and then refuses
> every run by name until a version naming the current digest is registered — visible, never silent.

**The gap.** The program says a harness version SHIPS with its skill seeds and wiki seeds. Today a skill or
a knowledge entry can be pinned ABOUT a harness version (`KnowledgePin`), which is a claim about an interval
of validity — it can be added after the version exists and it changes nothing about what runs. No field on
the instance names its seeds, so they are outside `specDigest`, outside the manifest seal, and nothing
materializes them into the sandbox: two runs of "the same version" can run with different skills, and a
scorecard cannot say which.

**Decision.** `seeds?: { skills: [{ id, version, digest }], knowledge: [{ id, revision, digest }] }` on
`HarnessInstanceSpec`, carried onto the resolved document by `resolveHarnessInstance` — so it is inside
`specDigest`, inside the manifest seal, and a seed change is a new version on the same axis a pin change is.
`digest` is the digest of the skill body / knowledge body at the named version, which the workspace
filesystem already holds as an attributed revision (`docs/architecture/workspace-filesystem.md`). The
job-runner materializes seeds before the harness starts, at a fixed mount every recipe can rely on:
`/everdict/seeds/skills/<id>/SKILL.md` (plus its `files/`) and `/everdict/seeds/knowledge/<id>.md`, read from
the revision the digest names and refused when the bytes do not digest to it (rule `protocol` L4 — a
settlement owns immutable bytes; a seed whose content moved under a fixed version is not that version).
`diff_harness_versions` gains a `seeds` slot. A `command` template reaches the mount through a `{{seeds}}`
token or its `env`.

**Rejected (a): seeds as `KnowledgePin`s on the skill or knowledge record.** A pin is a claim ABOUT a
version's timeline, authored on the knowledge side, mutable after the fact; a shipping manifest is a fact
about the version, authored with it, frozen. One field cannot be both without one meaning being wrong.

**Rejected (b): seeds as a value in `pins`.** `pins` is `slot → string`. A seed set is structured and
plural; encoding it into a string invents a grammar nothing validates and the digest still would not cover
the bodies.

**Counterexample (RED first).** Two instance versions identical except for `seeds` resolve to different
`specDigest`s (today the field is stripped and they are equal). A run of a version whose seed digest does not
match the filesystem revision is refused at materialization with the id and both digests named.

## §3 — Lineage is one read (G2.3)

**The gap.** "Where did this version come from, what changed, what did it ship with" takes three reads —
the registry record's origin, `diff_harness_versions`, the knowledge graph's edges — and nothing composes
them. An agent deciding what to change next pays three round trips and reconciles them itself.

**Decision.** `GET /harnesses/:id/lineage` and the MCP tool beside it (BFF↔MCP parity is structural, rule
`api-layer`): per version, its origin, its `succeeds` / `forked_from` edges, the diff against its predecessor
(slots moved, `seeds` included), and the campaigns that adopted it (`born_from` an issue or scorecard). One
service function; two transports; no new store — a projection over the reads that exist.

**Counterexample.** A version registered by an adopted campaign shows, in one response, the campaign, the
round and the scorecard that proved it, the slot the round moved, and the version it succeeds.

## §4 — A seed born from the exam is a leak, and the round refuses it (G2.4)

**The gap.** The evolve skill's rule — the candidate never receives the findings — is measured (WikiSkill,
arXiv 2608.27454: the same knowledge given to the proposer, +15.0; given also to the executing agent, −2.8)
and unenforced. Once §2 exists a candidate can ship a knowledge seed whose `evidence` names THIS campaign's
scorecard, or a skill whose `refs` pin one: the exam's answers, mounted into the thing being examined.

**Decision.** `CampaignService.logRound` reads the candidate's resolved `seeds`, then each seeded knowledge
entry's `evidence` and each seeded skill's `refs` (a REQUIRED dependency answering `ReadResult`; `unknown`
is "unverifiable", never "clean" — rule `protocol` L2). A seed whose evidence names a scorecard over any of
the frame's held-out scenarios makes the round `comparable: false` — "the candidate was seeded with the
exam's findings" — with the offending seed ids on the verdict as `seedLeak`, beside `oracleTouched`. Same
door, same treatment as a candidate that edited the dataset: the exam moved into the candidate instead of the
candidate moving into the exam.

**Rejected: refusing at register.** A seed is not a leak in itself; it is a leak relative to a FRAME. The
same knowledge entry is a legitimate seed for a harness evaluated on a different dataset. The refusal belongs
to the function whose answer it changes — the round — not to the door that stores the version.

**Counterexample (RED first).** A candidate seeded with a knowledge entry whose `evidence` names the frame's
baseline scorecard logs as a comparable win today. After the change it logs `comparable: false` with the
entry id in `seedLeak`; the same candidate under a frame over a different dataset stays comparable.

## What would reopen this

- A seed kind that is not a file (a vector index, a fine-tuned adapter). §2 assumes bytes at a revision;
  a seed that is a model weight is a pin (an image or a digest-addressed artifact), and belongs in `pins`.
- Evidence that transitive leakage matters — a seed whose evidence names a scorecard over a dataset that
  SHARES cases with the frame's, under another dataset id. §4 keys on scenario ids; if datasets share cases
  by content and not by id, the predicate has to key on the sealed per-case digests instead.
