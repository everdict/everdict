import type {
  AdoptionOperation,
  CampaignBuildRecord,
  CampaignBuildSetRecord,
  CampaignClose,
  CampaignRound,
  CampaignState,
  EvolutionCampaignRecord,
  HarnessSeeds,
  ReadResult,
} from "@everdict/contracts";
import type { HarnessSlot, SeedEvidence } from "@everdict/domain";
import type { OutboxEvent } from "./run-store.js";

// ── THE CAMPAIGN STORE (docs/architecture/evolution-lineage.md, Track D) ─────────────────────────────
//
// Guarded writes answer with a UNION, never a boolean (rule `protocol` L1/L2): appending a round races
// concurrent loops (the expected count is the CAS), and closing races a second settle — each refusal names
// what the caller does with it. Facts ride the same write via the E0 outbox `events` parameter, the same
// contract every aggregate store carries.

export interface CampaignSubjectRef {
  type: "agent" | "harness";
  id: string;
}

export type CampaignAppendOutcome =
  | { kind: "appended"; seq: number }
  | { kind: "conflict"; expected: number; actual: number } // another round landed first — re-read and retry
  | { kind: "terminal"; state: CampaignState } // the campaign already closed; nothing may be appended
  | { kind: "absent" };

export type CampaignCloseOutcome =
  | { kind: "closed" }
  | { kind: "already"; state: CampaignState } // first terminal wins; the second settle reads what won
  // A round landed after the settle's read — the gate's answer was computed over a shorter trace than the
  // one being closed, so the close is refused and the caller re-reads (every mutable input a decision rests
  // on is that decision's read-set; the rounds ARE the settle's input).
  | { kind: "conflict"; expected: number; actual: number }
  | { kind: "absent" };

export interface EvolutionCampaignStore {
  create(record: EvolutionCampaignRecord, events?: OutboxEvent[]): Promise<void>; // id collision → throw (ConflictError)
  get(tenant: string, id: string): Promise<EvolutionCampaignRecord | undefined>;
  // is built from what the caller may see rather than filtered after it (arch-review 76 P1-security).
  // `subject` narrows to one capability's campaigns — every version of it, every walk ever tried on it — the
  // memory a new campaign's first brief reads (docs/architecture/evolution-routing-spec.md §5). In the query too.
  list(tenant: string, subject?: CampaignSubjectRef): Promise<EvolutionCampaignRecord[]>;
  // Append-only, CAS on the current round count — contiguity of `seq` is the store's to enforce.
  appendRound(
    tenant: string,
    id: string,
    round: CampaignRound,
    expectedRounds: number,
    events?: OutboxEvent[],
  ): Promise<CampaignAppendOutcome>;
  // The one transition out of `open`. The terminal state and the close document land together or not at
  // all — and the CAS covers the ROUNDS COUNT as well as the state, because the gate answer being closed
  // was computed over exactly that trace.
  close(
    tenant: string,
    id: string,
    state: Exclude<CampaignState, "open">,
    close: CampaignClose,
    expectedRounds: number,
    events?: OutboxEvent[],
    // ── …AND THE DEBT THE CLOSE CREATES (arch-review 71 P0-evolution) ─────────────────────────────
    //
    // An adopted close authorizes a registry write that has not happened yet. Written HERE, in the same
    // transaction, so `adopted` and "somebody owes a registration" are one durable fact — a settle followed
    // by a crash leaves an operation somebody can re-drive instead of a campaign claiming adoption with no
    // capability anywhere.
    //
    // Absent on a halted close: nothing was authorized, so nothing is owed.
    adoption?: AdoptionOperation,
  ): Promise<CampaignCloseOutcome>;
}

// ── WHO MAY SPEND AN AUTHORIZATION, AND WHETHER IT IS STILL UNSPENT (arch-review 71 P0-evolution) ──
//
// The registry effect presents a proof; this is what checks it against what the campaign actually recorded.
// Separate from the campaign store because the CONSUMER is the registry write, not the campaign — and a
// capability the consumer cannot reach is the shape this whole review series keeps finding.
export interface AdoptionOperationStore {
  // The operation this proof claims to spend, or undefined when no such authorization exists. The caller
  // compares the proof it was HANDED against the one recorded — an equal-looking proof is not the same
  // proof, and only the stored one is authority.
  forCampaign(tenant: string, campaignId: string): Promise<AdoptionOperation | undefined>;
  // Spend it. Conditional on the operation still being `decided` and on the proof matching, so two writes
  // presenting one authorization cannot both succeed. Returns what happened rather than void: a decision
  // rests on this (rule `protocol` L1).
  // `events` rides the SAME write as the transition (the E0 outbox contract every aggregate store carries):
  // a fact for a spend that lost its race must not exist, and a landed one's fact must (rule `events`).
  markRegistered(
    tenant: string,
    campaignId: string,
    proofDigest: string,
    registeredVersion: string,
    events?: OutboxEvent[],
  ): Promise<"registered" | "already_registered" | "no_such_operation" | "proof_mismatch">;
  // ── …AND WHETHER THE INTENT IT SERVED IS SETTLED (arch-review 73) ────────────────────────────────
  //
  // The operations an ISSUE authorized. `completed` is the state that says the adoption's reason — the issue
  // the campaign was opened against — has itself been closed on the evidence this adoption proved; without
  // this read nothing could join a resolution back to the authorization it discharges, and the third state
  // had no writer at all.
  //
  // Plural because an issue can carry more than one campaign over its life (a second attempt after a halt),
  // and each has its own authorization.
  forIssue(tenant: string, issueId: string): Promise<AdoptionOperation[]>;
  // Discharge it. Conditional on the operation being `registered` — an adoption whose registry write never
  // landed has no intent to settle — and on the proof still being the recorded one. Answers what happened
  // rather than void: an at-least-once redelivery must be able to tell "I completed it" from "it already
  // was" without either being an error (rule `protocol` L1).
  markCompleted(
    tenant: string,
    campaignId: string,
    proofDigest: string,
    events?: OutboxEvent[],
  ): Promise<"completed" | "already_completed" | "not_registered" | "no_such_operation" | "proof_mismatch">;
  // ── THE WORKLIST FOR AN ADOPTION THAT REGISTERED AND NEVER DISCHARGED (arch-review 115) ───────────
  //
  // Two happy paths join registration to the issue's resolution — the issue event when the issue settles
  // last, an inline read when it settled first — and neither of them OWNS the debt when something goes
  // wrong. The inline read swallows a failure under a comment saying the operation "stays owed, which the
  // reconciler and any later issue event both still converge on"; there was no reconciler, and a later
  // event only exists if the issue has not already closed. `adopt` retried on a `registered` operation
  // returns `already_adopted` without re-attempting the join, and a concurrent adopter that wins the
  // registration and dies before the join leaves the same state behind.
  //
  // So an operation can sit `registered` forever with its issue done on the exact proving scorecard. The
  // durable owner is a sweep, and this is its worklist — deployment-wide, oldest first, offering candidates
  // only. Nothing here decides anything: the reconciler re-reads the issue and `markCompleted` remains the
  // conditional write that answers (rule `protocol` L5 — a debt owns its worklist).
  //
  // ⚠️ An E1 consumer is NOT that owner on its own. This deployment's runner retries a throwing handler
  // three times inside one delivery and then DEAD-LETTERS, advancing the cursor — so an outage outlasting
  // three immediate attempts loses the join. The consumer buys latency; this buys convergence.
  // ── THE CODE DEBT, PAID (docs/architecture/code-evolution-loop.md, D5) ───────────────────────────
  //
  // The merge effect landed and this records it — conditional on the operation still owing code (`code.state
  // = 'owed'`), on the bytes being registered already (an adoption whose registry write never landed has no
  // code to promote), and on the proof being the recorded one. Answers what happened rather than void: an
  // at-least-once retry must tell "I paid it" from "it was already paid" without either being an error (L1).
  markMerged(
    tenant: string,
    campaignId: string,
    proofDigest: string,
    merged: { sha: string; at: string },
    events?: OutboxEvent[],
  ): Promise<"merged" | "already_merged" | "no_code_debt" | "not_registered" | "no_such_operation" | "proof_mismatch">;
  registeredOlderThan(olderThan: string, limit: number): Promise<AdoptionOperation[]>;
  // ── …AND A TURN FOR EACH OF THEM (arch-review 120) ───────────────────────────────────────────────
  //
  // The worklist above is oldest-first, and nothing the reconciler does to a row it CANNOT complete moves
  // its age. So a hundred operations whose issue is still open — or whose issue was deleted, which never
  // resolves — hold the head of that list on every sweep and a newer completable one is never read.
  //
  //     a periodic owner exists   ≠   every debt receives a turn
  //
  // This is what an examination that could not finish writes back: when to look again, and why it is
  // waiting. `orphaned` is pushed far out rather than terminalized — "cannot find out" is an escalation
  // field, never a terminal that removes the debt from view (L5).
  //
  // Returns whether a row was moved: a scheduler that cannot say it rescheduled is one that can starve
  // silently, which is the defect this exists for.
  deferCompletion(input: {
    tenant: string;
    campaignId: string;
    outcome: "open" | "unknown" | "orphaned";
    nextAttemptAt: string;
  }): Promise<boolean>;
}

// ── WHAT A CANDIDATE'S SEEDS WERE BORN FROM (docs/architecture/harness-identity-and-seeds-spec.md §4) ──
//
// The round asks two things of the candidate version: which seeds it ships with (the resolved spec's `seeds`),
// and which scorecards those seeds' evidence names, with the cases each scorecard covered. Both are READS a
// decision rests on, so both answer `ReadResult` — `unknown` makes the round unverifiable, never clean (L2).
export interface SeedProvenanceReader {
  seedsOf(tenant: string, harness: { id: string; version: string }): Promise<ReadResult<HarnessSeeds | undefined>>;
  evidenceOf(tenant: string, seeds: HarnessSeeds): Promise<ReadResult<SeedEvidence[]>>;
}

// ── THE CANDIDATE'S SHAPE — ITS SLOTS (docs/architecture/evolution-routing-spec.md §2) ───────────────
//
// What a failing case is attributed AGAINST: the candidate version's slots, each with the service it runs and the
// tools it declares it owns. Read from the resolved spec; `unknown` leaves every case unattributed with the
// reason — attribution is advice for the brief, so an unreadable shape does not refuse the round.
export interface HarnessShapeReader {
  slotsOf(tenant: string, harness: { id: string; version: string }): Promise<ReadResult<HarnessSlot[]>>;
}

// ── THE ROUND'S EVIDENCE, AS IMMUTABLE BYTES (docs/architecture/benchmark-evidence-spec.md §3) ───────
//
// A round references what it saw by key + digest (L4). The key is content-addressed (the digest is in it), so
// `put` is insert-once: a second put of the same key is the same bytes and answers `exists`, never an
// overwrite. A store failure THROWS — an outage is not an absence, and the round is refused rather than logged
// without its evidence.
export interface CampaignEvidenceStore {
  put(tenant: string, key: string, document: unknown): Promise<"stored" | "exists">;
  get(tenant: string, key: string): Promise<unknown | undefined>;
}

// ── THE CANDIDATES A CAMPAIGN BUILT (docs/architecture/code-evolution-loop.md, D2) ───────────────────
//
// Everdict's own record of turning a commit into a candidate image: born `building` when the build session
// starts, settled `built` (image, digest, minted version, receipt) or `failed` (the reason) by the build
// itself. The settle writes are CONDITIONAL on `building` and answer what happened — a build that lost a race
// with its own retry, or was already settled, must not be recorded twice (rule `protocol` L1).
export interface CampaignBuildStore {
  create(record: CampaignBuildRecord, events?: OutboxEvent[]): Promise<void>;
  get(tenant: string, id: string): Promise<CampaignBuildRecord | undefined>;
  forCampaign(tenant: string, campaignId: string): Promise<CampaignBuildRecord[]>;
  // `candidateVersion` is absent for a set member: the SET mints (evolution-routing-spec.md §4).
  complete(
    tenant: string,
    id: string,
    result: {
      sha: string;
      image: NonNullable<CampaignBuildRecord["image"]>;
      candidateVersion?: string;
      receipt: NonNullable<CampaignBuildRecord["receipt"]>;
      at: string;
    },
    events?: OutboxEvent[],
  ): Promise<"completed" | "not_building" | "absent">;
  // ── THE BUILD SET (evolution-routing-spec.md §4) ─────────────────────────────────────────────────
  //
  // `claimMint` is the authority the mint rests on: conditional on `building`, it answers who may mint — exactly
  // one caller, once. `settleSet` records the outcome: `minted` only from `minting` (the claimer's), `failed` from
  // `building` or `minting`. Both answer what happened rather than void (L1).
  createSet(record: CampaignBuildSetRecord, events?: OutboxEvent[]): Promise<void>;
  getSet(tenant: string, id: string): Promise<CampaignBuildSetRecord | undefined>;
  setsForCampaign(tenant: string, campaignId: string): Promise<CampaignBuildSetRecord[]>;
  claimMint(
    tenant: string,
    setId: string,
    at: string,
  ): Promise<"claimed" | "already_claimed" | "not_building" | "absent">;
  settleSet(
    tenant: string,
    setId: string,
    outcome:
      | { state: "minted"; candidateVersion: string; images: Record<string, string>; sha: string; at: string }
      | { state: "failed"; error: string; at: string },
    events?: OutboxEvent[],
  ): Promise<"settled" | "not_settleable" | "absent">;
  fail(
    tenant: string,
    id: string,
    failure: { error: string; sha?: string; at: string },
    events?: OutboxEvent[],
  ): Promise<"failed" | "not_building" | "absent">;
}
