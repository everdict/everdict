import { BadRequestError, PaymentRequiredError, RateLimitError, type RunEnvelope } from "@everdict/contracts";
import type { EnvelopeStore } from "../ports/envelope-store.js";
import type { PlatformEventEmitter } from "../ports/platform-event-emitter.js";
import type { RunStore } from "../ports/run-store.js";

// The single admission gate's CAUSAL leg (execution-model §5.1): work that names a causer
// (origin.causedByRunId) answers two questions before it exists — is the causer's delegated envelope still
// good for it (402), and is the causal chain within the depth guard (429)? The eval path's tenant-level
// checks (BudgetTracker 402, Scheduler queue caps 429) stay where they are; this leg makes CAUSED demand
// draw from its causer instead of riding free on the tenant pool. Compute-blind demand, budget-bound spend.

// Fan-out guard: the maximum causal-chain depth (run caused by run caused by …). A loop or a runaway
// recursive automation walks into this long before it walks into money. Env-tunable, never per-request.
const MAX_CAUSAL_DEPTH = 8;

export interface AdmitCausedWorkDeps {
  runStore: RunStore;
  envelopes?: EnvelopeStore; // absent = envelopes unenforced (dev wiring) — depth guard still applies
  // E2 ops fact (event-plumbing.md §3, coverage wave 3): a 402 refusal emits budget.exceeded — the gate
  // already computed the refusal, so the fact costs nothing and is never inferred elsewhere.
  events?: PlatformEventEmitter;
  maxCausalDepth?: number;
}

// Admit `countRuns` new runs caused by `causedByRunId`. Returns the envelope the caused work must STAMP
// (children draw from it and settle against it) — undefined when the causer carries no envelope (no budget
// configured: the tenant budget still gates globally, exactly as before P4).
export async function admitCausedWork(
  deps: AdmitCausedWorkDeps,
  tenant: string,
  causedByRunId: string,
  countRuns: number,
): Promise<RunEnvelope | undefined> {
  const causer = await deps.runStore.get(causedByRunId);
  // A forged/foreign causer id is a bad request, never a silent pass — causation is an audited edge.
  if (!causer || causer.tenant !== tenant)
    throw new BadRequestError(
      "BAD_REQUEST",
      { causedByRunId },
      "origin.causedByRunId does not name a run in this workspace.",
    );

  // Depth guard (429): walk the chain toward the root. Each hop is one store read; the cap bounds the walk.
  const maxDepth = deps.maxCausalDepth ?? MAX_CAUSAL_DEPTH;
  let depth = 1;
  let cursor = causer;
  const seen = new Set<string>([causedByRunId]);
  while (cursor.origin?.causedByRunId !== undefined) {
    const parentId = cursor.origin.causedByRunId;
    if (seen.has(parentId)) break; // a cycle in stored data — the depth guard below already covers the abuse
    seen.add(parentId);
    depth += 1;
    if (depth >= maxDepth)
      throw new RateLimitError(
        "RATE_LIMITED",
        { causedByRunId, depth, maxDepth },
        `Causal chain too deep (${depth} >= ${maxDepth}) — refusing runaway recursive fan-out.`,
      );
    const parent = await deps.runStore.get(parentId);
    if (!parent) break;
    cursor = parent;
  }

  // Envelope headroom (402, O7 meter+headroom): the causer's envelope — its own delegated slice, or the one
  // it inherited. Caps live on the ROOT record (envelope.id names it); inherited stamps carry only {id}.
  const envelope = causer.envelope;
  if (!envelope) return undefined;
  const root = envelope.id === causer.id ? causer : await deps.runStore.get(envelope.id);
  const caps = root?.envelope;
  if (deps.envelopes && caps && (caps.capUsd !== undefined || caps.capRuns !== undefined)) {
    // A refusal is a state the workspace should SEE, not only an error the caller swallows: budget.exceeded
    // announces it on the log (subject = the delegating run whose envelope refused). Agent causers stamp the
    // loop guard's causedBy key so the exhausted agent never wakes itself on its own refusal.
    const refuse = (message: string, detail: Record<string, unknown>): never => {
      void deps.events?.emit({
        workspace: tenant,
        kind: "budget.exceeded",
        subject: { type: "run", id: envelope.id },
        payload: { ...detail, causedByRunId, refusedRuns: countRuns },
        ...(causer.kind === "agent" && causer.group?.id !== undefined
          ? { causedBy: `agent:${causer.harness.id}:${causer.group.id}` }
          : {}),
        message,
      });
      throw new PaymentRequiredError("BUDGET_EXCEEDED", detail, message);
    };
    const spend = await deps.envelopes.spend(envelope.id);
    if (caps.capUsd !== undefined && spend.usd >= caps.capUsd)
      refuse(
        `Agent envelope exhausted: $${spend.usd.toFixed(4)} of $${caps.capUsd} spent — the delegated budget refuses new work.`,
        { envelope: envelope.id, spentUsd: spend.usd, capUsd: caps.capUsd },
      );
    if (caps.capRuns !== undefined && spend.runs + countRuns > caps.capRuns)
      refuse(`Agent envelope run cap reached: ${spend.runs}+${countRuns} > ${caps.capRuns} caused runs.`, {
        envelope: envelope.id,
        admittedRuns: spend.runs,
        countRuns,
        capRuns: caps.capRuns,
      });
    await deps.envelopes.admit(envelope.id, tenant, countRuns);
  }
  return { id: envelope.id };
}
