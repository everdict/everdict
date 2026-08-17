---
paths: "packages/{contracts,domain,application-control,application-execution,backends,db,storage,registry,orchestrator,job-runner,self-hosted-runner}/**,apps/api/**"
---
# Protocol rules (push) — an identity is AUTHORITY, not annotation

Five laws. Each one was paid for by a shipped defect, and each defect was written by someone who had
already added the right noun — and then let the next step run without it. The case law (file, line, and the
wrong reasoning verbatim) is in skill `protocol`; read it before designing a new effect path.

The failure this rule exists to stop is NOT "a missing type". It is a correct type whose value is optional,
swallowed, re-derived, or advisory at the one seam where the next effect begins.

## L1 — Authority before effect
No external effect (cluster submit, sink call, spend, publish) until a store has **RETURNED PROOF** that the
effect's identity is durable.
- Computing a name is not reserving it. `UPDATE` returning is not a row changed. A callback resolving is not
  anything persisted.
- **A persistence hook that no-ops when its id is missing LIES to its caller.** `if (!store || id === undefined) return;`
  inside a pre-effect hook reports success and the effect proceeds unrecorded. A caller that cannot record
  where the work will be must not get the work — refuse the dispatch.
- The shape that cannot be misused: the store returns a proof object and the effecting API **requires it as a
  parameter** — `submit(job, intent: PersistedWorkIntent)`, never `submit(job)` beside an optional
  `onReserved`. An optional hook is a request; a required parameter is a protocol.
- Every mutating store method a decision rests on returns evidence it happened (`… RETURNING`, affected-row
  count, the written row) — never `Promise<void>`. Zero rows updated is a THROW, not a success.
- Order is part of the contract: lifecycle flips (`running`) come after the reservation is durable, never
  before it.

## L2 — Unknown is unignorable
A read that failed is not an empty set, not `undefined`, and not "absent".
- Three-valued union (`ReadResult<T>` = `read | absent | unknown`, `@everdict/contracts`), consumed by an
  **exhaustive switch**. Banned: `.catch(() => [])`, `.catch(() => undefined)`, `.catch(() => ({}))` on any
  read a decision rests on; `?? []` after an awaited catch.
- **`{ value?: T; ok: boolean }` is banned.** A caller can consume the value and never look at the flag — and
  did, for a whole review cycle, while the flag's own comment explained why it mattered. A union cannot be
  misread; a companion boolean can.
- The three forbidden collapses, by consequence: a teardown that widens because it read nothing; an evidence
  read that falls back to the writer's clock; a fold over zero answers that certifies live work is gone.
- **A scanner with an allowlist is a design admission, not a solution.** Every allowlist entry is a place the
  type failed to say it. Prefer the union that makes the line unrepresentable; if you must allowlist, the
  entry states *why this caller does not decide* — and "re-dispatch only costs compute" is NOT a reason
  (a second physical attempt spends money, writes competing evidence, and re-fires external side effects).

## L3 — Provenance is born at the source
Identity is recorded where it is produced. Never re-derive it downstream from rendered output.
- Banned re-derivations: metric name → judge id; latest row → winner; timestamp → canonical attempt; current
  carrier → an older settlement's payload; log text → outcome.
- Receipts are minted at the invocation/commit point and carry the coordinate the emitter carries, so the
  join key is the same object on both sides.
- **A predicate written twice has already diverged.** One owner, exported, imported. Before writing a
  string-splitting or classifying helper, grep for the concept — the correct version usually exists.
- Provenance states COVERAGE, not merely presence: `expected` vs `recorded` units, and `complete`. An empty
  receipt vector is not proof of authorship; a consumer that only asks `kind === "recorded"` accepts zero.

## L4 — A settlement owns immutable bytes
Everything a decision references has that decision's identity.
- A settlement stages its payload as an **immutable object (key + digest)** and the operation carries the key.
  It never re-reads "the record's current results" at drain time — a legitimate re-score then makes the older
  owed effect permanently impossible.
- A mutable "current" alias is a **monotonic projection with a revision guard**, never an ordinary effect of an
  independent operation. Two independent operations completing out of order must not move `current` backwards.
- An at-least-once external effect carries an **idempotency key in the PUBLIC contract**, typed all the way to
  the adapter, and the adapter derives deterministic external ids from it. A key that dies at a composition
  seam is worse than no key: the comment at the source says it travelled.
- A lease held across an external call is renewed while the call runs, or the lease is not a fence.

## L5 — Completion is verified zero
"The delete was accepted" is not "it is gone". "The lease was signalled" is not "it was revoked". "Terminal
child rows" is not "the container exited".
- Completion is a READ-BACK of zero: active managed work, live leases, queued intents, running workflows,
  non-terminal children, **and zero unknown reads**.
- **One verifier, one durable wrapper**, shared by the request path AND the reconciler. A sweep that calls the
  teardown directly and records a bare failure is a second protocol, and the two drift.
- "We could not find out" is an ESCALATION FIELD (attempts, backoff, operator alert) — never a terminal state
  that removes the debt from the sweep. Terminal means verified.

## Definition of done for a protocol change
1. The counterexample exists and was seen RED **for the stated reason** (see rule `testing`).
2. `pnpm protocol-mutations` neutralizes the new protocol in the production file and the owning suite goes RED.
   A mutation whose target line no longer exists FAILS — a deleted subject never silently stops being tested.
3. The escape hatch is deleted in the same change: the optional hook, the `void` writer, the boolean+optional
   pair, the allowlist entry. A migration that leaves both shapes alive asks every future caller to pick, and
   the call site never shows which one is safe.
