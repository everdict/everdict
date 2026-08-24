import {
  type CaseResult,
  CaseResultSchema,
  type RuntimeWorkRef,
  UpstreamError,
  type VerifierInvocation,
  VerifierInvocationSchema,
} from "@everdict/contracts";
import { type VerifierReceipt, contentDigest, verifierReceiptOf } from "@everdict/domain";

// ── A TWO-PHASE CASE MAKES ITS FIRST PHASE DURABLE (arch-review 60 P0 follow-through) ────────────────
//
// A case with a private verifier is two units: the agent runs, then a SECOND container judges what it left.
// `withVerifierPass` held the agent's `CaseResult` in a local variable across the second dispatch, and the
// backend deletes the agent's Job in its own `finally` as soon as it has parsed that result. So between the
// two halves the agent's evidence existed in exactly one place — this process's memory — and a control plane
// that died there left a recovery with a live verifier Job and no execution to attach its verdict to.
//
// arch-review 60 stopped the worst of it: a recovered verdict is no longer settled AS the run's result, which
// was a verdict standing in for the execution it was about. What it could not do was recover the case, and
// the reason is stated in that commit — there was nothing to merge into.
//
// This is the missing half. The agent's result is STAGED as immutable bytes before the verifier is dispatched,
// keyed by the execution, so a recovery that adopts the verifier's verdict can read the agent's half back and
// finish the same merge the in-line path would have (rule `protocol` L4: a settlement references frozen
// payloads by key; L5: one wrapper shared by the request path and the reconciler).
//
// Best-effort by contract, and deliberately so. A staging failure must not fail a case that ran — it costs
// the RECOVERY, not the run, and the honest consequence of an absent stage is what the recovery already does
// with a verifier it cannot attribute: skip it. Refusing the case instead would trade a real result for a
// store hiccup.

// Derived from the execution, at both ends. The recovery site holds a `RuntimeWorkRef` and nothing else, so a
// key it cannot compute from that is a key it cannot use (rule `protocol` L3 — no re-derivation from
// rendered output; this is the same coordinate on both sides, not a parse of one).
// ── …AND WHICH ATTEMPT'S HALF IT IS (arch-review 61 P1-high) ────────────────────────────────────────
//
// The first version keyed on `(tenant, runId)` alone. `runId` is the LOGICAL execution — it is the same
// across a retry, a speculative second attempt and a re-lease — and an object store's write replaces what is
// at a key. So two attempts of one execution staged to the same object:
//
//     attempt A stages → K          verifier A dispatched
//     attempt B stages → K          (overwrites)      verifier B dispatched
//     crash · recovery adopts verifier A → reads K → merges A's VERDICT onto B's EVIDENCE
//
// The result carries B's trace and snapshot, A's `tests_pass`, and a receipt whose `workspaceDigest` is A's:
// a case that never happened, assembled from two that did, and no downstream reader can see the seam.
//
// The `workspaceDigest` is the discriminator that was already in hand — it is what the verifier judged and
// what its invocation carries, so keying on it means an attempt can only ever read back the half its own
// verdict is about. Content, not a counter: two attempts that genuinely produced the same tree are the same
// half, and there is nothing to tell apart.
// ── …AND WHICH PHYSICAL HALF, NOT MERELY WHICH TREE (arch-review 62 P1) ────────────────────────────
//
// Keying on the workspace closed the wrong-tree merge and left the wrong-EXECUTION one open. Two attempts of
// one case can leave byte-identical workspaces — a deterministic task, a re-lease, a speculative duplicate —
// and differ in trace, observation scores, runtime and image provenance, timing and retry history. Same key,
// so the later write replaced the earlier, and a recovery adopting the first attempt's verdict merged it onto
// the second attempt's evidence: a document assembled from two executions, describing neither, with the
// verdict's own `workspaceDigest` check passing because the trees really were the same.
//
// The RESULT digest is the physical discriminator, and it makes the object immutable as well as distinct —
// one key, one set of bytes, forever (rule `protocol` L4). The verifier carries it so the recovery addresses
// the exact half its verdict came from instead of whatever is at the tree's key now.
export function agentHalfKey(tenant: string, runId: string, agentResultDigest: string): string {
  return `agent-half/${tenant}/${runId}/${agentResultDigest}.json`;
}

// The digest of a staged half, computed at both ends by the same function over the same document — the
// coordinate itself, never a label beside it.
export function agentHalfDigest(result: CaseResult): string {
  return contentDigest(result);
}

export interface AgentHalfStore {
  put(key: string, data: Uint8Array, contentType: string): Promise<string>;
  get(key: string): Promise<Uint8Array | undefined>;
  // ── AND THE WINDOW HAS AN OWNER THAT ENDS IT (arch-review 62 follow-through) ──────────────────────
  //
  // This port was put/get, so every private-verifier case left a full intermediate `CaseResult` — trace,
  // workspace snapshot and all — in object storage forever. Nothing referenced it, nothing swept it, and it
  // duplicates evidence the case already carries.
  //
  // The half exists for exactly one window: from the moment the agent's container is reaped to the moment
  // its verdict is merged. Both ends of that window are code in this package, so the window has an owner —
  // and a capability the owner is not given is a retention policy it cannot apply.
  remove(key: string): Promise<void>;
}

// Best-effort by contract, like the staging itself. A half that outlives its window costs storage; a case
// that failed because a delete did not answer costs a verdict, which is the trade this file already made
// once in the other direction.
export async function discardAgentHalf(store: AgentHalfStore | undefined, key: string): Promise<void> {
  await store?.remove(key).catch(() => undefined);
}

// ── THE WINDOW HAS ONE OWNER, AND EVERY SETTLEMENT IS IT (arch-review 64 P1-high) ───────────────────
//
// `discardAgentHalf` had exactly ONE production caller — the standalone recovery — while `recoverVerifiedCase`
// carried the comment "the settlement owns the discard — see `discardAgentHalf`'s callers". Its callers did
// not keep that promise: the normal in-line settlement, the batch committer and the batch recovery never
// discarded anything. So every normally-completed private-verifier case left a full intermediate `CaseResult`
// — trace, workspace snapshot, observation scores, runtime provenance — in object storage forever. That is a
// RETENTION and disclosure problem, not only a leak: it duplicates the case's own evidence under a key
// nothing references and nothing sweeps.
//
// Both intermediates, because there are two of them now (the verdict is staged as well), and one coordinate,
// because both are keyed by the half this case was judged from.
export async function discardIntermediates(
  store: AgentHalfStore | undefined,
  verdicts: AgentHalfStore | undefined,
  tenant: string,
  runId: string,
  agentResultDigest: string,
): Promise<void> {
  await discardAgentHalf(store, agentHalfKey(tenant, runId, agentResultDigest));
  await discardAgentHalf(verdicts, verifierVerdictKey(tenant, runId, agentResultDigest));
}

// WHICH half a settled case was judged from, read off the receipt it settled with. `undefined` for a case
// with no judging half — there is nothing staged and nothing to discard — and for a receipt whose lane could
// not name its handle, where guessing a key would delete somebody else's bytes.
export function stagedHalfDigestOf(result: CaseResult): string | undefined {
  return result.verifier?.work?.verifier?.agentResultDigest;
}

export async function stageAgentHalf(
  store: AgentHalfStore | undefined,
  tenant: string,
  runId: string,
  result: CaseResult,
): Promise<void> {
  if (!store) return;
  // The SAME digest the verifier will carry, over the SAME document, by the same function.
  const key = agentHalfKey(tenant, runId, agentHalfDigest(result));
  await store
    .put(key, new TextEncoder().encode(JSON.stringify(result)), "application/json")
    .then(() => undefined)
    // Swallowed HERE and nowhere else: this is the one call whose failure genuinely costs nothing the case
    // needs, and the comment above says what it does cost. Every other read in this file answers three ways.
    .catch(() => undefined);
}

// ── AND THE SECOND HALF, WHICH WAS NEVER STAGED AT ALL (arch-review 64 P0) ──────────────────────────
//
// The agent's half became durable and the VERDICT did not. A verifier container is reclaimed by its lane as
// soon as the logs are parsed, and from that moment the `VerifierInvocation` — the scores, the image
// provenance, the canonical work handle, the digests — lived in exactly one place: this process's memory,
// until the canonical settlement. A crash in that window left:
//
//     agent half        staged
//     verifier Job      deleted
//     verdict bytes     nowhere
//
// and the recovery, finding the verifier's object absent, re-ran the WHOLE case. A constitutional decision
// that had already been computed was tied to the lifetime of the process that computed it.
//
// The attempt row is not verdict storage either: it can say `verdict_produced` while the only copy of the
// verdict is gone. The row records that a phase happened; these bytes are the phase.
//
// Keyed by the same coordinate the agent's half uses — `(tenant, runId, agentResultDigest)` — because that is
// what a recovery holds when it finds the verifier handle: `work.verifier.agentResultDigest`. One half, one
// verdict about it, one key (rule `protocol` L4: a settlement references frozen payloads by key).
export function verifierVerdictKey(tenant: string, runId: string, agentResultDigest: string): string {
  return `verifier-verdict/${tenant}/${runId}/${agentResultDigest}.json`;
}

// Best-effort, for the reason `stageAgentHalf` is: a staging failure must not fail a verdict that exists. It
// costs the RECOVERY, not the run.
//
// ⚠️ WHAT THIS DOES NOT CLOSE, stated rather than implied. Both lanes reclaim the verifier's object inside
// their own dispatch — the Nomad one inside the shared `dispatch` it delegates to — so this write happens
// just AFTER the container is gone rather than just before. It closes the window that spans the deferred
// collection, the registered judges, the evidence assembly and the settlement, which is the window measured
// in seconds; it leaves the one between the lane's reclaim and this call, which is a function return with no
// I/O in it. Making the lane await a durable verdict before reclaiming needs a hook the Nomad path cannot
// currently offer, and claiming the stronger property without the mechanism is the failure rule `protocol`
// names in the time-based-lease law.
export async function stageVerifierVerdict(
  store: AgentHalfStore | undefined,
  tenant: string,
  runId: string,
  agentResultDigest: string,
  invocation: VerifierInvocation,
): Promise<void> {
  if (!store) return;
  await store
    .put(
      verifierVerdictKey(tenant, runId, agentResultDigest),
      new TextEncoder().encode(JSON.stringify(invocation)),
      "application/json",
    )
    .then(() => undefined)
    .catch(() => undefined);
}

// Three answers, for the reason `readAgentHalf` has three: a verdict that was never staged is the ordinary
// reason a recovery cannot finish a two-phase case, and a store that would not say must not read as one.
export type StagedVerdict =
  | { kind: "read"; invocation: VerifierInvocation }
  | { kind: "absent" }
  | { kind: "unknown"; reason: string };

export async function readVerifierVerdict(
  store: AgentHalfStore | undefined,
  tenant: string,
  runId: string,
  agentResultDigest: string,
): Promise<StagedVerdict> {
  if (!store) return { kind: "absent" };
  let bytes: Uint8Array | undefined;
  try {
    bytes = await store.get(verifierVerdictKey(tenant, runId, agentResultDigest));
  } catch (err) {
    return { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
  if (bytes === undefined) return { kind: "absent" };
  try {
    // Through the CONTRACT, like the half: these bytes crossed a restart, and a shape this version cannot
    // validate is `unknown` — something IS there and we could not use it.
    return { kind: "read", invocation: VerifierInvocationSchema.parse(JSON.parse(new TextDecoder().decode(bytes))) };
  } catch (err) {
    return { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
}

// Three answers, not two (rule `protocol` L2). `absent` is a case that never staged — an older writer, a
// deployment with no artifact store, a staging failure — and it is the ordinary reason a recovery cannot
// merge. `unknown` is a store that would not say, which must not be read as "there is no agent half": that
// would settle a case on the verifier's document alone, which is the defect this whole file follows from.
export type StagedAgentHalf =
  | { kind: "read"; result: CaseResult }
  | { kind: "absent" }
  | { kind: "unknown"; reason: string };

export async function readAgentHalf(
  store: AgentHalfStore | undefined,
  tenant: string,
  runId: string,
  // WHICH half — the result digest the verifier's handle carries. A read keyed by anything the two attempts
  // share is a read that takes whichever of them wrote last.
  agentResultDigest: string,
): Promise<StagedAgentHalf> {
  if (!store) return { kind: "absent" };
  let bytes: Uint8Array | undefined;
  try {
    bytes = await store.get(agentHalfKey(tenant, runId, agentResultDigest));
  } catch (err) {
    return { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
  if (bytes === undefined) return { kind: "absent" };
  try {
    // Parsed through the CONTRACT, not cast: these bytes crossed a process boundary and a restart, and a
    // shape that no longer validates is a stage this version cannot honour — which is `unknown`, because
    // something IS there and we could not use it.
    return { kind: "read", result: CaseResultSchema.parse(JSON.parse(new TextDecoder().decode(bytes))) };
  } catch (err) {
    return { kind: "unknown", reason: err instanceof Error ? err.message : String(err) };
  }
}

// ── AND THE LOOKUP, ONCE TOO (arch-review 62 P1) ─────────────────────────────────────────────────────
//
// `mergeVerifierPass` was shared and the way you REACH it was not: the standalone recovery read a staged half
// and merged, while the batch's `RecoveryPlanner` handled only `stage === "case"` and let a completed
// verifier fall through to a full re-drive. Same two-phase protocol, two recovery owners, two behaviours —
// safer than producing a wrong verdict, and still a case re-run at full cost because the code that knew how
// to finish it lived somewhere else.
//
// One entry point for "I adopted a verdict; give me the case it completes", so a lane that learns the
// protocol learns all of it. Three answers, for the reason `readAgentHalf` has three.
export type RecoveredCase =
  | { kind: "merged"; result: CaseResult }
  | { kind: "absent" } // nothing staged — an older writer, no artifact store, a staging failure: re-drive
  | { kind: "unknown"; reason: string }; // the store would not say — decide nothing, come back

// ── …AND FROM THE STAGE, WHEN THE CONTAINER IS ALREADY GONE (arch-review 64 P0) ─────────────────────
//
// `recoverVerifiedCase` needs an invocation, and a recovery only HAS one when adoption could still read the
// verifier's object. The container is reclaimed the moment its logs are parsed, so the ordinary shape of this
// crash is: the verdict was produced, its Job is absent, and adoption answers `absent` — which routed the
// case to a full re-drive of BOTH containers over a judgement that had already been computed.
//
// Same merge, same coordinate, sourced from the stage instead of from a live object. `absent` here is the
// honest "nothing to recover" that re-drives; `unknown` decides nothing, exactly as it does everywhere else.
export async function recoverStagedVerdict(
  store: AgentHalfStore | undefined,
  verdicts: AgentHalfStore | undefined,
  tenant: string,
  runId: string,
  work: RuntimeWorkRef,
): Promise<RecoveredCase> {
  const digest = work.verifier?.agentResultDigest;
  if (digest === undefined) return { kind: "absent" };
  const staged = await readVerifierVerdict(verdicts, tenant, runId, digest);
  if (staged.kind !== "read") return staged;
  return await recoverVerifiedCase(store, tenant, runId, work, staged.invocation);
}

export async function recoverVerifiedCase(
  store: AgentHalfStore | undefined,
  tenant: string,
  runId: string,
  // The handle this verdict was adopted from: it carries WHICH physical half the verifier judged. A verdict
  // whose handle cannot name one is not merged against a guess — that is the defect this coordinate closes.
  work: RuntimeWorkRef,
  invocation: VerifierInvocation,
): Promise<RecoveredCase> {
  const digest = work.verifier?.agentResultDigest;
  if (digest === undefined) return { kind: "absent" };
  const half = await readAgentHalf(store, tenant, runId, digest);
  if (half.kind !== "read") return half;
  // …and the half STAYS. Its window ends at the canonical settlement, not at the merge that reads it: after
  // this the case still completes (deferred collection, observation grading, evidence) and then settles, and
  // a crash anywhere in there is precisely what the half exists to survive. Discarding here left a window in
  // which the verifier's container, the agent's container AND the staged half were all gone (arch-review 63
  // P0). The settlement owns the discard — see `discardAgentHalf`'s callers.
  return { kind: "merged", result: mergeVerifierPass(half.result, invocation) };
}

// ── THE MERGE, ONCE (rule `protocol` L5) ─────────────────────────────────────────────────────────────
//
// The in-line path and the recovery must produce the SAME case result from the same two halves, or a case
// recovered after a crash is a different document than one that finished normally — and the difference would
// be invisible, because both are `CaseResult`s. One function, called by both.
export function mergeVerifierPass(result: CaseResult, invocation: VerifierInvocation): CaseResult {
  // …and the two halves are ABOUT THE SAME TREE (arch-review 61 P1-high). The key already keeps a recovery
  // from reading another attempt's half, and this is the check that does not depend on the key being right:
  // a verdict is a statement about a workspace, and attaching it to a different one produces a case that
  // never happened out of two that did. Refused, never merged — rule `protocol` L3, identity is not a label
  // you may re-attach.
  const staged = contentDigest(result.snapshot);
  if (staged !== invocation.workspaceDigest)
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { staged, judged: invocation.workspaceDigest },
      "this verdict was produced against a different workspace than the agent half it would be merged into.",
    );
  const receipt: VerifierReceipt = verifierReceiptOf(invocation);
  return { ...result, scores: [...(result.scores ?? []), ...receipt.scores], verifier: receipt };
}
