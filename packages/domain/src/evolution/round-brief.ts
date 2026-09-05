import type { DelegationBrief, DelegationReference, RoundEvidence, StoredCampaignFrame } from "@everdict/contracts";

// ── THE ROUND'S DELEGATION BRIEF, AUTHORED BY THE PLATFORM ────────────────────────────────────────
//
// A campaign round is a hypothesis somebody else executes: a coding agent in a sandbox, another agent
// environment, a member at a keyboard. Everything that handoff needs already existed as two separate things —
// `DelegationBrief` (goal · references · constraints · doneWhen, materialized into the delegate's working
// directory) and `RoundEvidence` (the platform's own account of what the last round measured, per case, with
// the slot each failure points at) — and NOTHING connected them. `logRound` reads `delegationRunId` only to
// check the session's TTL and spend, so a round could name a session briefed with nothing at all, or briefed
// about something else. The skill's `references/round-brief.md` says exactly what to write; a skill is advice,
// and advice at the seam where the next effect begins is the annotation failure rule `protocol` is about.
//
// So the brief is DERIVED here, once, from the frozen frame and the last round's evidence. That makes the
// handoff a contract instead of prose: an agent reads it and passes it straight to `create_sandbox`, and the
// delegate is judged on criteria it was actually given.
//
// ── WHAT THIS FUNCTION MAY NOT SAY, AND WHY THAT IS THE WHOLE POINT ───────────────────────────────
//
// The frame already declares the boundary: `targets` are "scenario ids the loop is briefed on and optimizes
// against", and held-out scenarios are the population that says whether the change GENERALIZED. A brief naming
// a held-out case has aimed the delegate at the generalization population, and the campaign's own evidence
// stops meaning anything — silently, because the round still runs and still scores.
//
// Three exclusions, enforced by construction rather than by a reviewer noticing:
//   ① HELD-OUT IDS NEVER APPEAR. Only `frame.targets` are named, and only their traces are handed over.
//   ② NO SCORES. No rates, deltas or p-values: a delegate that can see the number optimizes the number, which
//      is aiming at the exam by a different route.
//   ③ NO JUDGE RATIONALE. A judge's structured diagnosis contributes its KIND and its LOCUS — the mechanism
//      and where it lives, which is what routing exists to produce — and never its free-text notes.
//      `RoundEvidence`'s own comment states this rule; here is where it becomes true.
//
// This is the oracle rule and it is measured, not aesthetic: WikiSkill (arXiv 2608.27454) gave the same
// knowledge to the proposer for +15.0 and then also to the executing agent, and it went DOWN 2.8.

export interface CampaignRoundBriefInput {
  campaignId: string;
  // The round about to be authored (1-based). Round 1 has no predecessor, so it has no evidence.
  seq: number;
  frame: Pick<
    StoredCampaignFrame,
    "subject" | "scenarios" | "targets" | "trialsPerCase" | "judges" | "oracleScope" | "significance"
  >;
  // The issue the campaign was opened against — the "why", and the one reference a delegate can read for itself.
  issueId?: string;
  // The PREVIOUS round's evidence. Absent before the first round has been logged.
  evidence?: RoundEvidence;
  // What earlier rounds established about the MECHANISM (each round's `learned`, oldest first). Driver-authored
  // advice by contract; it shapes the proposal and decides nothing, which is exactly what a brief is for.
  learned?: readonly string[];
  // ── …AND WHAT EARLIER WALKS ESTABLISHED (the `continues` chain, and the campaigns a round named) ──
  //
  // `continues` exists so a walk can keep going after an adoption, and the brief was built from THIS
  // campaign's rounds alone — so everything a five-round predecessor learned was dropped at the campaign
  // boundary, and the delegate was handed the search to redo. `informedBy` had the same hole from the other
  // side: a round names the campaigns whose findings shaped it, and nothing anywhere read the field.
  //
  // The POINTERS are the driver's and the FINDINGS are the platform's read of what those walks recorded
  // (rule `protocol` L3). Kept labelled by source, because a delegate must be able to tell what this walk
  // established from what it was told.
  inherited?: ReadonlyArray<{ campaignId: string; findings: readonly string[] }>;
  // Why there is no `evidence` even though rounds have run — a legacy round that sealed none, a store that
  // could not serve it. Stated in the brief rather than swallowed: a delegate handed no traces reads that as
  // "there is nothing to look at", and "we could not find out" is not "there is nothing" (rule `protocol` L2).
  evidenceUnavailable?: string;
}

// ── THE BRIEFABLE SET IS DERIVED, NEVER TRUSTED ──────────────────────────────────────────────────
//
// `frame.targets` is the right list and it is not a safe one. `campaignFrameDefects` refuses a target that is
// also held-out — at CREATION, which is where that rule belongs — and `StoredCampaignFrameSchema` is the bare
// shape with no refinement, because a policy applied at decode time is a data outage. So a campaign opened
// before that rule existed can hold a target flagged held-out, and a renderer that trusts `targets` names it.
//
// The exclusion is therefore computed from the SCENARIOS, which carry the flag, and a disagreement resolves
// toward silence: a case that is held-out anywhere is briefable nowhere.
// ── A FINDING IS PROSE, AND PROSE CAN NAME A HELD-OUT CASE ───────────────────────────────────────────
//
// Every structured field in this brief excludes the held-out set by construction — `briefableTargets`
// filters the targets, and the evidence read filters `unflipped`. `learned` is the one FREE-TEXT channel,
// authored by a driver who was looking at the whole round, and it went to the delegate verbatim. So the
// exclusion held everywhere except the field most likely to say "case 30930 fails because…".
//
// It matters more now than it did: inherited findings are a SECOND free-text channel, carrying prose a
// DIFFERENT campaign's driver wrote, under a frame whose held-out set that driver never saw.
//
// Word-boundary, because case ids are short (`s2`, `15380`) and substring matching would redact the middle
// of ordinary words. The marker is visible on purpose: a delegate reading `[held-out]` knows something was
// withheld, where a silently deleted id reads as a finding about nothing.
function redactHeldOut(text: string, heldOut: readonly string[]): string {
  let out = text;
  for (const id of heldOut) {
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`(^|[^\\w-])${escaped}(?![\\w-])`, "g"), "$1[held-out]");
  }
  return out;
}

function heldOutIds(frame: CampaignRoundBriefInput["frame"]): string[] {
  return frame.scenarios.filter((sc) => sc.heldOut === true).map((sc) => sc.id);
}

function briefableTargets(frame: CampaignRoundBriefInput["frame"]): string[] {
  const heldOut = new Set(frame.scenarios.filter((sc) => sc.heldOut === true).map((sc) => sc.id));
  return frame.targets.filter((id) => !heldOut.has(id));
}

// A trace reference is a RUN, and only for a target that has not been flipped yet: handing over the trace of a
// case that already passes spends the delegate's context on work that is done.
function targetTraces(frame: CampaignRoundBriefInput["frame"], evidence: RoundEvidence): DelegationReference[] {
  const targets = new Set(briefableTargets(frame));
  const refs: DelegationReference[] = [];
  for (const c of evidence.cases) {
    if (!targets.has(c.caseId) || c.verdict === "improved") continue;
    // The mechanism, in the platform's vocabulary: the diagnosis KIND and where it lives. Never the note.
    const mechanism = c.diagnoses
      .map((d) => [d.kind, d.locus?.service, d.locus?.tool, d.locus?.phase].filter((x) => x !== undefined).join("/"))
      .filter((s) => s !== "");
    const slot = c.attribution?.kind === "measured" ? c.attribution.slot : undefined;
    const because = [
      `case '${c.caseId}' still fails on the candidate`,
      ...(mechanism.length > 0 ? [`diagnosed ${[...new Set(mechanism)].join(", ")}`] : []),
      ...(slot !== undefined ? [`attributed to slot '${slot}'`] : []),
    ].join("; ");
    for (const t of c.traces) {
      if (t.side !== "candidate") continue;
      refs.push({ type: "run", id: t.runId, note: because });
      break; // one trace per case: a second trial of the same failure is the same evidence twice
    }
  }
  return refs;
}

export function campaignRoundBrief(input: CampaignRoundBriefInput): DelegationBrief {
  const { frame, evidence } = input;
  const subject = `${frame.subject.type} '${frame.subject.id}' (baseline ${frame.subject.baselineVersion})`;
  const targets = briefableTargets(frame);

  // ── goal — the behaviour to change, named by the cases that show it ──────────────────────────────
  //
  // Never "make the eval pass": that aims the delegate at the exam, and the exam is what decides. The cases are
  // named because they are the evidence; what must become true is stated as a condition on the SUBJECT.
  const goal =
    targets.length > 0
      ? `Change ${subject} so that these cases succeed: ${targets.join(", ")}. Find the mechanism that makes them fail and change THAT — do not tune for the evaluation, and do not change the evaluation.`
      : `Change ${subject} so that it succeeds on more of this campaign's scenarios. Find a mechanism that is failing and change THAT — do not tune for the evaluation, and do not change the evaluation.`;

  // ── context — which round, and what is already known ─────────────────────────────────────────────
  const context: string[] = [
    input.seq === 1
      ? `Round 1 of campaign '${input.campaignId}'. Nothing has been tried yet.`
      : `Round ${input.seq} of campaign '${input.campaignId}'. ${input.seq - 1} round(s) have run.`,
  ];
  const withheld = heldOutIds(frame);
  const learned = (input.learned ?? []).filter((l) => l.trim() !== "").map((l) => redactHeldOut(l.trim(), withheld));
  if (learned.length > 0)
    context.push(
      "",
      "What earlier rounds established about the mechanism (findings, not scores — they may be wrong):",
      ...learned.map((l, i) => `${i + 1}. ${l}`),
    );
  // Inherited findings come AFTER this walk's own: the delegate reads what this campaign established first,
  // and what it was told second. Every line goes through the same held-out redaction as the rest of the
  // brief — inheritance is a new path to the subject, and the oracle rule is about what reaches the subject,
  // not about which function put it there.
  const inherited = (input.inherited ?? [])
    .map((source) => ({
      campaignId: source.campaignId,
      findings: source.findings.filter((f) => f.trim() !== "").map((f) => redactHeldOut(f.trim(), withheld)),
    }))
    .filter((source) => source.findings.length > 0);
  if (inherited.length > 0) {
    context.push("", "What EARLIER WALKS established (inherited — a different campaign's findings, not this one's):");
    for (const source of inherited)
      for (const finding of source.findings) context.push(`· [${source.campaignId}] ${finding}`);
  }
  if (evidence !== undefined && targets.length > 0) {
    const briefable = new Set(targets);
    const unflipped = (evidence.aggregate.targets?.unflipped ?? []).filter((id) => briefable.has(id));
    if (unflipped.length > 0)
      context.push("", `Still failing after the last round: ${unflipped.join(", ")}. Their traces are below.`);
  }
  if (input.evidenceUnavailable !== undefined && input.seq > 1)
    context.push(
      "",
      `⚠️ The last round's evidence could not be read (${input.evidenceUnavailable}), so this brief carries no traces. That is a gap in the handoff, not a sign that the last round left nothing to look at — ask for the traces before assuming there are none.`,
    );
  context.push(
    "",
    "You cannot run this campaign's evaluation and you must not try to. It runs after you finish, on scenarios " +
      "you have not been shown, and a candidate that was shaped to fit it proves nothing.",
  );

  // ── references — the evidence, each with the reason it is here ───────────────────────────────────
  const references: DelegationReference[] = [];
  if (input.issueId !== undefined)
    references.push({ type: "issue", id: input.issueId, note: "the problem this campaign exists to resolve" });
  if (frame.subject.type === "harness" || frame.subject.type === "environment")
    references.push({
      type: frame.subject.type === "harness" ? "harness" : "environment",
      id: frame.subject.id,
      version: frame.subject.baselineVersion,
      note: "the baseline — what you are changing, and what the candidate is measured against",
    });
  if (evidence !== undefined) {
    references.push({
      type: "scorecard",
      id: evidence.candidate.scorecardId,
      note: "the last round's candidate batch — the run this brief's traces come from",
    });
    references.push(...targetTraces(frame, evidence));
  }

  // ── constraints — what must not change, each with its reason ─────────────────────────────────────
  const constraints: string[] = [];
  if (frame.oracleScope.length > 0)
    constraints.push(
      `Do not change anything matching: ${frame.oracleScope.join(", ")}. These are the exam — the dataset, the rubrics, the graders' tests. A candidate that changed its exam is not a candidate: the round is discarded whatever it scores.`,
    );
  else
    constraints.push(
      "This campaign declared no oracle scope, so nothing mechanically checks that the exam was left alone. Do " +
        "not modify datasets, judge rubrics or grader tests — a change there invalidates the round and there is " +
        "no gate here to catch it for you.",
    );
  constraints.push(
    "ONE lever. A change that moves two mechanisms cannot be attributed to either, and the next round has to " +
      "undo half of it to find out which one worked.",
    "The candidate must differ from the baseline in BYTES, not only in label: a round whose two sides resolve " +
      "to the same spec digest is refused as having no treatment to measure.",
  );

  // ── doneWhen — the checks the DELEGATOR will run, and the delegate can run too ───────────────────
  //
  // Deliberately not the scorecard. The delegate cannot run it, and a finish line it cannot check is not a
  // finish line — it is a wish. Everything here is verifiable inside the sandbox, which is what makes this
  // handoff delegatable to an agent that never talks to Everdict.
  const doneWhen: string[] = [];
  if (frame.oracleScope.length > 0)
    doneWhen.push(`The diff against the default branch touches none of: ${frame.oracleScope.join(", ")}.`);
  doneWhen.push(
    "The repository's own build and tests pass — that is the finish line, not the evaluation.",
    "The diff is one lever, and you can say in one sentence which mechanism it changes.",
    `The candidate is registered as a new version of ${frame.subject.id}, and its resolved spec differs from ${frame.subject.baselineVersion}.`,
  );

  return { goal, context: context.join("\n"), references, constraints, doneWhen };
}
