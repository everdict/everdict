# What the agent knows

An agent that starts a turn knowing nothing about your workspace will produce confident, generic work.
This page is about the layer that prevents that: what is in front of the agent before it reads your
message, and how it inherits what the workspace already learned.

## Three layers, assembled per turn

**1 — The operating contract.** A fixed system prompt: the role, the tool protocol, the workflow. This
is the agent's persona and it does not change per workspace.

**2 — Your workspace's layer.** `instructions`, the enabled tools, and the workspace's skills, appended
by the profile resolver. This is the CLAUDE.md of your agent — what your datasets mean, which
regressions matter, what your team calls things.

**3 — The environment block.** The concrete situation this turn runs in, appended at chat time:

```
## Environment
- Workspace: acme
- Model: claude-sonnet-5
- Date: 2026-08-11
- Task directory: tasks/cv_881 — this conversation's own area on the workspace filesystem.
  Write this task's outputs there; promote finished deliverables to the shared library.
- Web app: https://everdict.acme.internal — deep-link ONE entity as <web>/acme/<resource>/<id>,
  where <resource> is SINGULAR (scorecard · run · harness · dataset · judge · runtime · view ·
  schedule · issue · project · initiative). An issue is addressed by its identifier: …/issue/ENG-12.
```

Two details in there are load-bearing:

**The date is day-precision on purpose.** The environment block sits inside the system prompt, and the
system prompt is the provider's cache prefix. A millisecond timestamp would make every turn's prefix
byte-different and invalidate prompt caching on *every single call*. Day granularity is what the agent
actually needs, and the cache then survives until midnight instead of never.

**The web base URL is what lets the agent hand you real links** instead of bare ids. Without one
configured, it is instructed not to guess URLs — a fabricated link is worse than no link.

## Inheriting what the workspace already knows

This is the part most agent products do not have. Before working on a harness, dataset or scorecard,
the agent calls:

```json
{ "tool": "get_task_context",
  "refs": [
    { "type": "harness",   "key": "checkout-agent", "version": "2.1.0" },
    { "type": "scorecard", "key": "sc_91f2ab" }
  ] }
```

Those refs are **anchors** — the entities the task concerns. Back comes the graph's related facts, plus
the workspace's knowledge entries (claims, decisions, conventions) and skill candidates *about* those
anchors.

So an agent asked "why did retrieval regress on 2.1.0" starts with what your team already concluded
about 2.1.0, rather than re-deriving it from scratch and reaching a different answer.

## Time is a coordinate, not decay

Here is the idea worth understanding, because it is unusual and it changes what the answers mean.

**A claim pinned at `harness@2.1.0` stays true about 2.1.0 forever.** Knowledge does not rot; the
question is only whether what was known at one version extends to the version you are asking about.

So **the anchor's version IS the as-of coordinate.** Pass an old scorecard's `harness@2.1.0` and the
whole knowledge base is projected onto that point. Pass an anchor with no version and it projects onto
the present.

Every returned item carries where it sits relative to your coordinate:

- **`covers`** — confirmed at this coordinate. Use it.
- **`earlier`** — about an earlier point. Its validity here is *unknown*, which is not the same as
  wrong.
- **`later`** — from this coordinate's future. Often the eventual fix, which is exactly what you want
  when reading an old failure.
- **`general`** — a timeless claim about the family.

And separately, a **coverage** state against the entity's present: `current`, `behind`, `unverified`.

:::tip
`behind` means "as-of an earlier point; validity at the present is unknown" — never "wrong". The two
vocabularies are deliberately not merged because they answer different questions: coverage is for
listings and badges, anchor relation is for assembling context for one task.
:::

## Teaching the workspace

Context is only as good as what has been written down. Three ways knowledge gets in:

**Knowledge entries** — claims, decisions and conventions, stored in the
[filesystem](filesystem.md) as `knowledge/<id>.md`:

```bash
curl -XPUT localhost:8787/fs/file \
  -H 'content-type: application/json' -d '{
  "path": "knowledge/retrieval-suite.md",
  "content": "# retrieval-smoke\n\nCases tagged `long-context` are the ones customers hit.\nA regression there is P1; everything else can wait a cycle.\n"
}'
```

**Typed relationships** — the graph, over a closed predicate vocabulary:

```json
{ "tool": "relate_knowledge",
  "subject":   { "type": "scorecard", "key": "sc_91f2ab" },
  "predicate": "compared_to",
  "object":    { "type": "scorecard", "key": "sc_7c01" },
  "note": "the 2.1.0 → 2.2.0 comparison the retrieval decision rested on" }
```

Node types cover the whole product — `harness`, `dataset`, `scorecard`, `run`, `case`, `issue`,
`judge`, `runtime`, `skill`, `secret`, `model`, `team` and more — so the graph describes your actual
work rather than a parallel wiki.

**Annotations** — a note plus a confidence on an existing node, for the small observation that is not
worth a document.

## Attaching context by hand

In a conversation, `@`-reference an entity and its context is attached to that turn:

> Compare @scorecard/sc_91f2ab against @scorecard/sc_7c01 and tell me whether the retrieval fix held.

Useful when you know exactly what matters and do not want the agent to search for it.

## When this matters, and when it does not

It matters when the same questions recur — "did this regress before", "why is this case excluded",
"what did we decide about long-context" — and the answers live in people's heads. That is when an agent
without inherited context produces plausible work that contradicts last month's decision.

It does not matter much on day one. An empty knowledge base returns nothing, and the agent falls back
to reading your data directly, which is fine. The layer earns its keep as the workspace accumulates
decisions worth not re-litigating.

## See also

- [Workspace agents](agents.md) — the agent this context is assembled for
- [The workspace filesystem](filesystem.md) — where knowledge and skills live
- [`../../architecture/knowledge-graph.md`](../../architecture/knowledge-graph.md) — the design record
