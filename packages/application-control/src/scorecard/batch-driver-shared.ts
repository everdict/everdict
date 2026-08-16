import type { CaseJob, CaseResult } from "@everdict/contracts";
import type { CircuitBreaker } from "@everdict/domain";
import type { ScoringService } from "../execution/scoring-service.js";
import type { SpilloverOutcome } from "../ops/runtime-spillover.js";
import type { CaseOutcomeCommitter } from "./case-outcome-committer.js";
import type { RecoveryPlanner } from "./recovery-planner.js";
import type { ResilientCaseRunner } from "./resilient-case-runner.js";

// ── WHAT BOTH DRIVERS STAND ON ───────────────────────────────────────────────────────────────────────
//
// The plumbing a batch driver shares with the facade and with the other driver: the id/clock sources, the
// commit point, the per-case resilience machinery, and the handful of facade-owned probes that must answer
// identically on both paths (does this driver still hold the batch · what the shard history says · which
// envelope a fan-out child draws from · how a lost speculation branch is metered · whether the ledger and
// the receipts agree). Handed in as one bag, built once by `ScorecardBatchService`, so the two drivers
// cannot drift into two spellings of the same question — which is the defect class this whole area keeps
// producing when a fix reaches one driver and not the other.
export interface BatchDriverShared {
  newId: () => string;
  now: () => string;
  scoring: ScoringService;
  breaker: CircuitBreaker;
  // Cooperative-cancellation handles, keyed by batch id — owned by the facade because `stopInFlight` and
  // `supersedeInFlight` reach for them from outside any driver.
  inFlight: Map<string, AbortController>;
  // WHERE A CASE ENDS, for both drivers (arch-review 47 §4).
  commit: CaseOutcomeCommitter;
  // How one case physically runs (spillover · OOM boost · speculation) and how a re-dispatch opens its own
  // attempt — shared so the two drivers cannot mirror it "by construction" again.
  cases: ResilientCaseRunner;
  // WHAT A RE-DRIVE MUST NOT RUN AGAIN (arch-review 47 §4).
  recovery: RecoveryPlanner;
  // Does this driver still hold the batch? A write fenced on the epoch it began under.
  holdsBatch: (id: string, epoch: number) => Promise<boolean>;
  // Runtime speed signal from history — RELATIVE, not absolute (see the facade's own note).
  shardHistory: (
    tenant: string,
    harnessId: string,
    harnessVersion: string,
    targets: string[],
  ) => Promise<{ ratios: Map<string, number>; seedMedianSec?: number }>;
  // The delegated envelope every fan-out child draws from (§5.2, P4).
  childEnvelope: (record: { origin?: { causedByRunId?: string } }) => Promise<{ id: string } | undefined>;
  // A speculation loser still spent: metered, never scored (review 39 P0).
  meterLostAttempt: (tenant: string, outcome: SpilloverOutcome, caseId: string, id: string) => void;
  // …and a speculation branch that failed while its sibling answered the case terminalizes its own attempt.
  stampLostBranch: (lostJob: CaseJob, caseId: string) => void;
  // The ledger↔receipt disagreement, stated on the batch's own step timeline (review 39, Phase 1 parity).
  checkReceiptParity: (id: string, counted: CaseResult[]) => Promise<void>;
  // Filling the HOLE a child settled with no result left — never revising a published one (review 39 P1).
  writeBackResults: (
    id: string,
    caseToChild: Map<string, string>,
    results: CaseResult[],
    parentDriver?: { scorecardId: string; epoch: number },
  ) => Promise<void>;
}
