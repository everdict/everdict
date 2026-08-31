import { createHmac } from "node:crypto";
import { refuseUnsafeOutboundUrl } from "@everdict/contracts";
import type { PlatformEventRecord, SubscriptionRecord } from "@everdict/contracts";
import { eventSelectorMatches } from "@everdict/domain";
import type { SubscriptionStore } from "../ports/subscription-store.js";
import type { PlatformEventConsumer } from "./event-consumer-runner.js";

// The E3 reaction consumer — one durable cursor ("subscriptions:reactions") walks the log and fires the
// NON-AGENT reactions of every matching enabled subscription. Agent reactions are deliberately not handled
// here: waking an agent is the activation engine's job (apps/agent), which owns the loop guards and the
// per-agent serialization — a second waker would be a double-activation hazard.
//
// Delivery semantics ride the runner: at-least-once (a crash between webhook POST and cursor save
// redelivers), retries × dead-letter for a failing endpoint. Receivers must dedup by the event id we send
// (x-everdict-event) — the same contract every webhook platform states.

export interface SubscriptionReactionDeps {
  subscriptions: SubscriptionStore;
  fetchImpl?: typeof fetch;
  // T-d seam: start the durable multi-step executor for reaction.kind="workflow"
  // (`reaction:<eventId>:<subscriptionId>` — the deterministic id makes redelivery idempotent).
  // Absent (no Temporal configured) = the reaction is skipped VISIBLY, never half-run in-process.
  startReactionWorkflow?: (input: {
    eventId: string;
    tenant: string;
    subscriptionId: string;
    steps: Array<{ agentId: string; instruction?: string }>;
    // The fact as the chain's agents will read it — pointers only, exactly what the log holds.
    eventKind: string;
    message: string;
    payload?: Record<string, unknown>;
    subject?: { type: string; id: string };
  }) => Promise<void>;
  requestTimeoutMs?: number; // per-webhook POST budget (default 10s)
  now?: () => number; // cooldown clock (epoch ms)
}

export function signSubscriptionPayload(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

export function subscriptionReactionConsumer(deps: SubscriptionReactionDeps): PlatformEventConsumer {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? (() => Date.now());
  const lastFired = new Map<string, number>(); // subscription id → epoch ms (process-local pacing)

  const cooledDown = (subscription: SubscriptionRecord): boolean => {
    const cooldownSec = subscription.governance.cooldownSec;
    if (cooldownSec === undefined || cooldownSec <= 0) return true;
    const last = lastFired.get(subscription.id);
    return last === undefined || now() - last >= cooldownSec * 1000;
  };

  return {
    name: "subscriptions:reactions",
    async handle(event: PlatformEventRecord): Promise<void> {
      const subscriptions = await deps.subscriptions.listEnabled(event.tenant);
      for (const subscription of subscriptions) {
        if (subscription.reaction.kind === "agent") continue; // the activation engine's jurisdiction
        if (!eventSelectorMatches(subscription.selector, event)) continue;
        if (!cooledDown(subscription)) continue;
        if (subscription.reaction.kind === "webhook") {
          await deliverWebhook(fetchImpl, subscription.reaction, event, deps.requestTimeoutMs ?? 10_000);
        } else if (deps.startReactionWorkflow) {
          await deps.startReactionWorkflow({
            eventId: event.id,
            tenant: event.tenant,
            subscriptionId: subscription.id,
            steps: subscription.reaction.steps,
            eventKind: event.kind,
            message: event.message,
            ...(Object.keys(event.payload).length > 0 ? { payload: event.payload } : {}),
            subject: event.subject,
          });
        } else {
          // No executor wired (Temporal absent) — skip visibly; a durable chain must not degrade to a
          // half-run in-process imitation.
          console.error(
            `[events] subscription ${subscription.id} wants a reaction workflow but no executor is configured (EVERDICT_TEMPORAL_ADDRESS).`,
          );
          continue;
        }
        lastFired.set(subscription.id, now());
      }
    },
  };
}

async function deliverWebhook(
  fetchImpl: typeof fetch,
  reaction: { url: string; secret?: string },
  event: PlatformEventRecord,
  timeoutMs: number,
): Promise<void> {
  // The fact as the receiver sees it — pointers only, exactly what the log holds (never full documents).
  const body = JSON.stringify({
    id: event.id,
    kind: event.kind,
    tenant: event.tenant,
    subject: event.subject,
    payload: event.payload,
    message: event.message,
    createdAt: event.createdAt,
  });
  // ── THE SAME QUESTION THE RUN WEBHOOK ASKS (arch-review 124) ─────────────────────────────────────
  //
  // `reaction.url` is member-authored (`agents:write`) and this delivery fires on EVERY matching event, so
  // an unguarded destination is a repeating, event-triggered dial from the control plane's network position.
  // The run-webhook lane has judged its destination since arch-review 36; this lane is its sibling and did
  // not, because the decision lived inside that consumer instead of where both of them look.
  //
  // Refused LOUDLY, like the sibling: a throw is dead-lettered with the failing endpoint recorded, and a
  // reaction that silently never fires is the failure this whole feature exists to remove.
  const target = refuseUnsafeOutboundUrl(reaction.url, "subscription webhook");
  const res = await fetchImpl(target, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-everdict-event": event.id,
      "x-everdict-kind": event.kind,
      ...(reaction.secret !== undefined
        ? { "x-everdict-signature": signSubscriptionPayload(reaction.secret, body) }
        : {}),
    },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Non-2xx throws so the runner's retry → dead-letter path records the failing endpoint honestly.
  if (!res.ok) throw new Error(`webhook ${reaction.url} answered ${res.status}`);
}
