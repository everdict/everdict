import type { TraceEvent } from "@everdict/contracts";

// ── THE JUDGE'S EXECUTION, IN THE VOCABULARY THE MEASUREMENT PLANE CANNOT MISREAD (report 1.1) ───────
//
// A judge's own calls become `span` events on the judged case's trace — named under the judge, carrying the
// model/usage/latency as ATTRIBUTES. Deliberately never `llm_call`: the cost/steps graders read that kind,
// so a judge's tokens recorded as one would bill the judged agent for the judgment. And deliberately
// re-timed by the CALLER to the trace's last instant, so the latency grader (which reads first/last `t`
// regardless of kind) measures the same execution before and after the judgment's evidence is attached.
// ── THE INVERSE: WHAT A JUDGE IS ALLOWED TO SEE (arch-review 41 P0-verdict) ──────────────────────────
//
// The spans minted above are retained on the judged case's trace as EVIDENCE OF THE JUDGMENT — but they
// must never become evidence FOR the next judgment. A re-score rebuilds its grading context from the
// stored trace, so without this projection revision 2's judge reads revision 1's verdict text as if the
// agent had said it (anchoring / self-confirmation across the time axis). Co-located with the minter so
// the `judge:<id>:` naming convention and its filter can never drift apart. Every construction of a
// judge/grader input from a stored trace MUST go through this — the infra plane is execution machinery,
// the judge:* plane is prior judgment; neither is the agent's own work.
export function executionEvidenceTrace(trace: TraceEvent[]): TraceEvent[] {
  return trace.filter((e) => e.kind !== "infra" && !(e.kind === "span" && e.name.startsWith("judge:")));
}

// ── THE EVIDENCE PLANE'S NAME: WHICH INVOCATION PRODUCED IT (arch-review 51 Track C) ─────────────────
//
// A judge's own execution seals as its own plane on the judged case's trajectory, and the ledger keeps the
// FIRST seal per (runId, emitter) — so the emitter IS the identity of the execution that evidence describes.
// Naming a plane after the JUDGE alone lost every re-score's evidence (arch-review 41 P0-audit). Naming it
// after the judge and the PASS still loses every retry WITHIN a pass, and that one is worse: the score plane
// arbitrates retries per (case, judge) on the judgment CLAIM, so invocation 2 can win the score while
// invocation 1's seal — written first, refused for nobody — stays the evidence. Score and evidence then
// describe two different physical judge executions and nothing in the record can say which is which.
//
// GRAMMAR — each part narrows the one before it, and each is minted ONLY here:
//
//   judge:<judgeId>                            no pass identity — the initial batch's judging, one shot
//                                              per case, so the judge id alone is the invocation.
//   judge:<judgeId>#<passId>                   a pass with no invocation ordinals: the IN-PROCESS pass
//                                              judges the whole plane in ONE `applyJudges` call and has no
//                                              per-case retry seam (`ScorecardScoreService.track`); a
//                                              takeover mints a NEW passId, so the pass id alone separates
//                                              every invocation that path can produce.
//   judge:<judgeId>#<passId>.<gen>.<attempt>   ONE Temporal invocation of (pass, case, judge) — the claim
//                                              the stage arbitrates on (`JudgmentClaim`, mig 0158/0159).
//
// Reading it back: `passId` is an opaque minted id, so the ordinals are recovered right-anchored
// (`/\.(\d+)\.(\d+)$/` after the first `#`) — no reader needs that today, and one that does belongs HERE
// beside the minter rather than re-deriving the grammar at its own call site.
export interface JudgeEvidenceScope {
  passId: string;
  // The pass-global (generation, attempt) ordinal this invocation holds. Absent = the pass has no
  // per-invocation identity to state (the in-process pass — see the grammar above).
  claim?: { generation: number; attempt: number };
}

export function judgeEvidenceEmitter(judgeId: string, scope?: JudgeEvidenceScope): string {
  if (scope === undefined) return `judge:${judgeId}`;
  const { passId, claim } = scope;
  if (claim === undefined) return `judge:${judgeId}#${passId}`;
  return `judge:${judgeId}#${passId}.${claim.generation}.${claim.attempt}`;
}

export function judgeExecutionSpans(judgeId: string, events: TraceEvent[]): TraceEvent[] {
  const spans: TraceEvent[] = [];
  for (const e of events) {
    if (e.kind === "llm_call") {
      spans.push({
        t: e.t,
        kind: "span",
        name: `judge:${judgeId}:llm_call`,
        attributes: {
          model: e.model,
          ...(e.cost ? { inputTokens: e.cost.inputTokens, outputTokens: e.cost.outputTokens, usd: e.cost.usd } : {}),
          ...(e.latencyMs !== undefined ? { latencyMs: e.latencyMs } : {}),
        },
        ...(e.durationMs !== undefined ? { durationMs: e.durationMs } : {}),
      });
    } else if (e.kind === "message" && e.role === "assistant") {
      // The verdict text — what the judge actually said, truncated so a chatty judge cannot bloat the row.
      spans.push({
        t: e.t,
        kind: "span",
        name: `judge:${judgeId}:verdict`,
        attributes: { text: e.text.slice(0, 4_000) },
      });
    } else if (e.kind === "span") {
      // A dispatched judge's own structural spans keep their shape, renamed under the judge so they can
      // never satisfy another judge's declared `requires: [{kind:"span", name}]` by accident.
      spans.push({ ...e, name: `judge:${judgeId}:${e.name}` });
    }
    // Everything else (tool_call/log/error/infra of a dispatched judge's harness run) stays in the judge's
    // own sealed trajectory — the case's trace carries the judgment's essentials, not its transcript.
  }
  return spans;
}
