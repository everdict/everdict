import {
  type CaseResult,
  CaseResultSchema,
  type RuntimeWorkRef,
  type Score,
  UpstreamError,
  type VerifierInvocation,
  VerifierInvocationSchema,
  storedExecutionId,
} from "@everdict/contracts";
import { type VerifierReceipt, contentDigest, verifierReceiptOf } from "@everdict/domain";
import type { IntermediateCleanupStore } from "../ports/intermediate-cleanup-store.js";

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
  return contentDigest(canonicalAgentHalf(result));
}

// ── ONE CANONICAL FORM FOR THE WRITE, THE READ AND THE DIGEST (arch-review 67 P1-adapter) ──────────
//
// The digest was taken over the RAW producer object while the recovery re-derives it after
// `CaseResultSchema.parse` — and the schema normalizes (a measured score gains its `status`, defaults land).
// Most lanes happen to parse on the way through, but `LocalBackend` returns `runCaseJob`'s result straight
// from `runCase`, so a producer whose literal differs from its parsed form stages under a key its own read
// then refuses. The half is durable, addressed, and unreadable by the only code that looks for it.
//
// This is the same lesson `caseResultDigest` already learned (`case-result-digest.ts`: a raw digest tells the
// producer literal from the jsonb round-trip apart, and the fail-closed gate then refuses every Pg-backed
// batch). Parse first, everywhere, including the BYTES that get written — otherwise the object and its own
// key disagree.
export function canonicalAgentHalf(result: CaseResult): CaseResult {
  return CaseResultSchema.parse(result);
}

export interface AgentHalfStore {
  // `immutable` says this key encodes its own content, so a second write of the same key is either the same
  // bytes (converge) or somebody else's (refuse). An adapter that cannot express the condition ignores it —
  // the READ-side digest check is what makes the property enforceable everywhere (arch-review 66).
  // `immutable` says this key encodes its own content, so a second write of the same key is either the same
  // bytes (converge) or somebody else's (refuse). `digest` is what an adapter compares to tell those apart —
  // an address that encodes content is not content authentication until somebody checks (arch-review 67).
  put(
    key: string,
    data: Uint8Array,
    contentType: string,
    opts?: { immutable?: boolean; digest?: string },
  ): Promise<string>;
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

// ── THE WINDOW HAS ONE OWNER, AND IT IS A LEDGER (arch-review 64 P1-high → 66) ─────────────────────
//
// `discardIntermediates` and `stagedIntermediatesOf` used to live here: the settlement dug the cleanup
// coordinate out of the RESULT and deleted the objects inline. Two waves of repair to that shape — first
// moving the coordinate off the receipt onto the document, then carrying it on every ending — and both were
// fixing the address rather than the owner.
//
// The debt is a ROW now (`IntermediateCleanupStore`), written by the staging above before the bytes exist
// and discharged by `dischargeIntermediates` at the canonical settlement. That closes what neither previous
// version could: a crash between the commit and the delete, a delete that failed, a transient refusal
// retried under a new digest, and a runner naming somebody else's objects on a document nobody validated
// as platform state.
//
// `discardAgentHalf` stays: it is the one-key primitive the discharge and the tests both spend.

// ── WHAT A STAGE ACTUALLY DID, BECAUSE ITS CALLER RECLAIMS A CONTAINER (arch-review 70 P0) ────────
//
// This answered `void` and swallowed its own write, so `stagedEarly = true` proved the FUNCTION had been
// called and nothing about whether the bytes exist. The verdict's stage has answered a union since
// arch-review 67 — 120 lines down this same file — and the agent half was left as it was: the sibling-lane
// shape at the shortest distance this series has found it (rule `protocol`, "a callback that ran is not
// bytes that landed").
//
// Same two arms as `VerdictStageOutcome`, and for the same reason: `absent` is the honest answer for a
// deployment with no store or a document this schema cannot parse, and a FAILURE is not an arm — it
// propagates, because the caller's next act is destroying the only other copy and only the caller knows what
// that costs here.
export type AgentHalfStageOutcome =
  | { kind: "staged"; ref: { key: string; digest: string } }
  | { kind: "absent"; reason: string };

export async function stageAgentHalf(
  store: AgentHalfStore | undefined,
  tenant: string,
  runId: string,
  result: CaseResult,
  // ── AND THE DEBT, RECORDED BEFORE THE BYTES (arch-review 66 P1-high) ──────────────────────────────
  //
  // The cleanup coordinate used to ride the CaseResult, which made it visible to a runner and made the
  // recovered document differ from the normal one. It is a ledger row now, written first: an object whose
  // removal nothing owns is exactly the leak this staging created.
  cleanup?: IntermediateCleanupStore,
): Promise<AgentHalfStageOutcome> {
  if (!store) return { kind: "absent", reason: "no agent-half store" };
  // The SAME digest the verifier will carry, over the SAME document, by the same function.
  // Canonicalized ONCE: the bytes written, the key they are written under and the digest a recovery
  // re-derives all come from this one value.
  //
  // ⚠️ A RESULT THIS SCHEMA CANNOT PARSE IS NOT STAGED, and does not fail the case. Staging is best-effort by
  // contract (see the swallow below), and the parse is now part of it — so a document the READ could never
  // validate anyway is simply not written, rather than throwing out of a helper whose failure was never
  // allowed to cost a verdict. Absent is exactly what the recovery already handles.
  const canonical = ((): CaseResult | undefined => {
    try {
      return canonicalAgentHalf(result);
    } catch {
      return undefined;
    }
  })();
  if (!canonical) return { kind: "absent", reason: "this result does not validate as a CaseResult" };
  const digest = contentDigest(canonical);
  const key = agentHalfKey(tenant, runId, digest);
  // Owed FIRST. A debt recorded for bytes that then failed to write costs one wasted delete attempt; bytes
  // written with no debt recorded are a leak forever, and only one of those is recoverable.
  await cleanup?.owe({ tenant, executionId: storedExecutionId(runId), refs: [{ key, digest }] });
  // NOT SWALLOWED (arch-review 70). A store that throws throws, and `withVerifierPass` decides what the loss
  // costs — which is the RECOVERY under `best_effort` and the CASE under `required`. Deciding it here made
  // the two indistinguishable to every caller, and made `stagedEarly` a lie.
  await store.put(key, new TextEncoder().encode(JSON.stringify(canonical)), "application/json", {
    immutable: true,
    digest,
  });
  // Confirmed AFTER the write, so a sweep can tell an object that exists from one whose put never landed.
  await cleanup?.confirm({ tenant, executionId: storedExecutionId(runId), keys: [key] });
  return { kind: "staged", ref: { key, digest } };
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
// ── WHAT THE STAGE PROVES, AND WHAT IT REFUSES TO PRETEND (arch-review 65 P0-lifecycle) ────────────
//
// This returned `void` and swallowed its own failure, and `verdict_produced` was stamped either way. So the
// row could assert "recoverable verdict bytes exist" over a deleted container and an empty store. The state's
// whole meaning is that claim; a write that cannot prove it must not produce it.
//
// It no longer SWALLOWS. The `.catch(() => undefined)` made a store outage indistinguishable from a
// deployment that stages nothing, and the caller could not tell the two apart to say anything true about
// either. A store that throws now throws; `verifierOperation` decides what that costs, and what it costs is
// the RECOVERY rather than the verdict — which is the trade this file has always made, stated at the site
// that makes it instead of hidden here.
//
// ⚠️ IT DOES NOT RETURN A REF. The first draft returned `{key, digest}` as a durability proof, and nothing
// consumed it — `noUnusedLocals` said so in the same wave that added the check. A proof nobody reads is the
// hypothetical surface rule `api-layer` forbids; if a reader ever needs to know whether a verdict is
// recoverable, it asks the store, which is where the answer actually lives.
//
// ── …AND THE KEY NAMES WHICH VERIFIER PRODUCED IT (arch-review 65 P1) ─────────────────────────────
//
// Keyed by `(tenant, runId, agentResultDigest)` alone, two verifier attempts judging the same agent half —
// a deterministic task, a re-lease, a speculative duplicate — wrote to ONE key, and `put` is not a
// conditional create. Recovering verifier A could read verifier B's verdict. That is the hazard
// `agentHalfKey`'s own history is a record of, one document over: a key built from what two attempts SHARE
// means the later write destroys the earlier.
//
// The verifier attempt is the discriminator, and the recovery holds it on the handle it is recovering from.
// ── THE ADDRESS IS ATTEMPT-SCOPED, AND THE CONFLICT IS VERIFIED (arch-review 67 P1-provenance) ────
//
// The four axes here answer "whose object is this" — tenant, run, which half was judged, which verifier
// judged it. None of them is a digest of the VERDICT, so two different verdicts under one attempt
// coordinate are the same address; combined with a conditional create that read 412 as "already there", the
// normal path could hold V2 while a restart read V1 — same execution, two answers, every coordinate check
// passing because they agree on everything except the scores.
//
// ⚠️ AND THE VERDICT'S DIGEST CANNOT GO IN THE KEY, which is why this is not the agent half's fix. A
// recovery addresses the half by a digest the verifier's handle carries; it has no such coordinate for the
// verdict — the verdict is what it is trying to find. An address the reader cannot construct is not an
// address.
//
// So the write carries the digest and the ADAPTER verifies on conflict: a 412 is idempotent success only
// when the bytes already there hash to the same thing (see `S3ArtifactStore.put`). The address stays
// constructible and the collision stops being silent.
export function verifierVerdictKey(
  tenant: string,
  runId: string,
  agentResultDigest: string,
  verifierAttemptId: string,
): string {
  return `verifier-verdict/${tenant}/${runId}/${agentResultDigest}/${verifierAttemptId}.json`;
}

// What a durability write actually did. `staged` carries the ref a recovery would find it by; `absent` says
// nothing was written and does not pretend the case is any worse for it. A FAILURE is not an arm here — it
// propagates, because the caller's next act is destroying the only other copy and it must decide.
export type VerdictStageOutcome =
  | { kind: "staged"; ref: { key: string; digest: string } }
  | { kind: "absent"; reason: string };

export async function stageVerifierVerdict(
  store: AgentHalfStore | undefined,
  at: {
    tenant: string;
    runId: string;
    agentResultDigest?: string;
    verifierAttemptId: string;
    invocation: VerifierInvocation;
    cleanup?: IntermediateCleanupStore;
  },
): Promise<VerdictStageOutcome> {
  // No store, or a job that never staged an agent half to be about: nothing to key this verdict by, and a
  // key invented here would address bytes no recovery can find.
  // ── IT RETURNS A PROOF, BECAUSE ITS CALLER DESTROYS THE OTHER COPY (arch-review 67 P0-lifecycle) ──
  //
  // This answered `void`, and `verifierOperation`'s acknowledgement wrapped it in `.catch(() => undefined)`
  // and then reported success. So a verdict store that threw produced a successful acknowledgement, the
  // lane deleted its Job, and a crash before settlement lost a constitutional decision with the container
  // that could have re-produced it already gone. The ORDERING was right and the guarantee was empty — which
  // is `Promise<void>` on a write a decision rests on (rule `protocol` L1), one wave after the fix that
  // made the ordering correct.
  //
  // `absent` is the honest answer for a deployment with no verdict store or a job that staged no half:
  // nothing was written and nothing pretends otherwise.
  if (!store || at.agentResultDigest === undefined)
    return { kind: "absent", reason: store ? "this job staged no agent half to key a verdict by" : "no verdict store" };
  const digest = contentDigest(at.invocation);
  const key = verifierVerdictKey(at.tenant, at.runId, at.agentResultDigest, at.verifierAttemptId);
  const bytes = new TextEncoder().encode(JSON.stringify(at.invocation));
  // …and its debt, for the same reason and before the same write (arch-review 66 P1-high).
  await at.cleanup?.owe({ tenant: at.tenant, executionId: storedExecutionId(at.runId), refs: [{ key, digest }] });
  await store.put(key, bytes, "application/json", { immutable: true, digest });
  await at.cleanup?.confirm({ tenant: at.tenant, executionId: storedExecutionId(at.runId), keys: [key] });
  return { kind: "staged", ref: { key, digest } };
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
  // WHICH verifier's verdict — the attempt on the handle this recovery is recovering from. Without it two
  // verifier attempts of one agent half read the same key and the later write wins (arch-review 65 P1).
  verifierAttemptId: string,
): Promise<StagedVerdict> {
  if (!store) return { kind: "absent" };
  let bytes: Uint8Array | undefined;
  try {
    bytes = await store.get(verifierVerdictKey(tenant, runId, agentResultDigest, verifierAttemptId));
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
    const result = CaseResultSchema.parse(JSON.parse(new TextDecoder().decode(bytes)));
    // ── AND THE BYTES ARE RE-DERIVED AGAINST THE ADDRESS (arch-review 66 P1-provenance) ─────────────
    //
    // The key CONTAINS the result digest, which reads like content addressing and is not: nothing hashed
    // what came back. The S3 adapter writes with a plain `PutObject` — no conditional create, no stored
    // digest, same key overwrites — so any schema-valid `CaseResult` sitting at that address was merged as
    // though it were the one the digest names. A verdict would then be attached to a document with the same
    // workspace snapshot but a different trace, different scores and different runtime provenance, and the
    // `workspaceDigest` check downstream would pass because the trees really were the same.
    //
    // A digest in a key is a naming convention until somebody re-derives it. `unknown`, never `absent`:
    // something IS there and we could not trust it.
    const actual = agentHalfDigest(result);
    if (actual !== agentResultDigest)
      return {
        kind: "unknown",
        reason: `the bytes staged at this coordinate hash to ${actual}, not the ${agentResultDigest} its key names`,
      };
    return { kind: "read", result };
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
// ── TWO CONTRIBUTORS CANNOT BE ONE COORDINATE (arch-review 65 P0-verifier) ─────────────────────────
//
// A private-verifier case is TWO physical executions, and both recovery owners carried one `RuntimeWorkRef`
// to the settlement — the VERIFIER's, because that is the handle the merge was reached through. That single
// ref became `service.resume(…, adoptedFrom.attemptId)` and `receipt.attemptId`, so a recovered case could
// settle with the run `succeeded`, the verifier attempt `committed`, and the AGENT attempt still `executing`.
//
// Worse than an untidy row: `CaseCommitReceipt.attemptId` is the coordinate the trajectory reader uses to
// choose an evidence plane, so a recovered case could point replay at the verifier's plane instead of the
// agent's — the wrong container's output, presented as the case's evidence.
//
// ⚠️ THE COMMENT DEFENDING IT WAS MINE AND IT WAS WRONG: "the agent's was committed before its half was
// staged". In the standalone lane the agent attempt is stamped BY the run settlement, which happens after
// this whole pass — so nothing had committed it. The comment-is-a-claim law, in a comment I wrote.
//
// Named explicitly, so a settlement cannot spend one where it means the other.
export interface ContributingAttempts {
  // The EXECUTION attempt — the agent's. This is what a receipt's `attemptId` means and what a trajectory
  // read resolves against.
  agent?: string;
  // …and the judging half, when there was one.
  verifier?: string;
}

export type RecoveredCase =
  | { kind: "merged"; result: CaseResult; attempts: ContributingAttempts }
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
  const verifierAttemptId = work.attemptId;
  if (digest === undefined || verifierAttemptId === undefined) return { kind: "absent" };
  const staged = await readVerifierVerdict(verdicts, tenant, runId, digest, verifierAttemptId);
  if (staged.kind !== "read") return staged;
  // ── THE BYTES ARE CHECKED AGAINST THE HANDLE, NOT TRUSTED (arch-review 65 P0) ──────────────────────
  //
  // Live adoption joins the canonical handle onto the invocation and re-presents the coordinates it holds;
  // the staged path read the object and merged whatever was in it. Two protocols for one question, and only
  // one of them verified. These bytes crossed a restart and an object store — the key is addressed, not
  // authenticated — so the handle this recovery is acting on is what they have to agree with.
  //
  // A disagreement is `unknown`, never `absent`: something IS there and we could not use it, which is the
  // third answer this whole file exists to keep (rule `protocol` L2). Reading it as "nothing staged" would
  // re-drive a case whose verdict is sitting right there under a coordinate we mistrust.
  const v = staged.invocation;
  // ── ABSENT IS NOT "MATCHES" (arch-review 66 P1-provenance) ────────────────────────────────────────
  //
  // Every clause here was "present AND different → refuse", which accepts a document that simply OMITS the
  // field — the easiest thing for a wrong or forged artifact to do, and `VerifierInvocationSchema` makes
  // `work` and `agentAttemptId` optional so omitting them parses cleanly. A staged verdict with no `work` at
  // all matched any handle, merged, and rode into the case with `complete: false` — a label, while its
  // scores decided the verdict anyway.
  //
  // A DURABLE artifact carries its full coordinate or it is not usable. This is stricter than the live
  // adoption path deliberately: a live object is one the lane just answered from, and these bytes crossed an
  // object store nothing authenticates.
  const stagedWork = v.work;
  // ── ABSENT IS NOT "MATCHES" (arch-review 66 P1-provenance) ────────────────────────────────────────
  //
  // Every clause used to read "present AND different → refuse", which ACCEPTS a document that simply omits
  // the field — and `VerifierInvocationSchema` makes `work` and `agentAttemptId` optional, so omitting them
  // parses cleanly. A staged verdict with no `work` at all therefore matched any handle, merged, and rode
  // into the case with `complete: false` — a label, while its scores decided the verdict.
  //
  // Written as a straight comparison instead: an absent coordinate is unequal to the one we hold, so it
  // refuses by the same clause that catches a wrong one. Stricter than the LIVE adoption path deliberately —
  // a live object is one the lane just answered from, and these bytes crossed a store nothing authenticates.
  const mismatch =
    stagedWork?.attemptId !== verifierAttemptId ||
    stagedWork.externalJobId !== work.externalJobId ||
    v.planDigest === undefined ||
    v.workspaceDigest === undefined ||
    (work.verifier?.planDigest !== undefined && v.planDigest !== work.verifier.planDigest) ||
    (work.verifier?.workspaceDigest !== undefined && v.workspaceDigest !== work.verifier.workspaceDigest) ||
    (work.verifier?.agentAttemptId !== undefined && v.agentAttemptId !== work.verifier.agentAttemptId);
  if (mismatch)
    return {
      kind: "unknown",
      reason: `the staged verdict at this coordinate does not name the execution this handle is recovering (attempt ${stagedWork?.attemptId ?? "absent"} vs ${verifierAttemptId})`,
    };
  return await recoverVerifiedCase(store, tenant, runId, work, v);
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
  return {
    kind: "merged",
    result: mergeVerifierPass(half.result, invocation),
    // Both halves, from the coordinates this recovery actually holds: the verifier's own handle, and the
    // agent execution the verdict names as the one it judged.
    attempts: {
      ...(work.verifier?.agentAttemptId !== undefined ? { agent: work.verifier.agentAttemptId } : {}),
      ...(invocation.agentAttemptId !== undefined ? { agent: invocation.agentAttemptId } : {}),
      ...(work.attemptId !== undefined ? { verifier: work.attemptId } : {}),
    },
  };
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
  // ── AN INCOMPLETE RECEIPT DOES NOT DECIDE THE CASE (arch-review 66 P1-provenance) ────────────────
  //
  // `complete: false` means the receipt cannot say which container produced this verdict, against which
  // workspace, under which resolved image — and the scores rode into the case ANYWAY. The evidence
  // projection marked the case `judgment: partial`, which is a label on a decision that had already been
  // made: `tests_pass` is a RESERVED authority metric, so an unattributable verdict was still deciding
  // whether the case passed.
  //
  // That is the annotation failure this whole file is a history of, one level up. The policy is stated here
  // rather than implied, and it is fail-CLOSED: the scores are recorded `unmeasured` with the receipt
  // attached, so the case reads as "this was not judged" — which is true — instead of as a pass or a fail
  // nobody can attribute. A number the platform cannot vouch for must not reach a mean, a gate or a diff.
  const usable = receipt.complete === true;
  const scores = usable
    ? receipt.scores
    : receipt.scores.map(
        (score) =>
          ({
            graderId: score.graderId,
            metric: score.metric,
            status: "unmeasured",
            reason: "contract_violation",
            retryable: false,
            detail:
              "this verdict's receipt could not name the execution that produced it, so its score is not attributable",
          }) as Score,
      );
  return { ...result, scores: [...(result.scores ?? []), ...scores], verifier: receipt };
}
