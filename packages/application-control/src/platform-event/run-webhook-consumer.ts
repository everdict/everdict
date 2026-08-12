import type { PlatformEventRecord } from "@everdict/contracts";
import type { RunStore } from "../ports/run-store.js";
import type { PlatformEventConsumer } from "./event-consumer-runner.js";

// ── A COMPLETION CALLBACK IS A SETTLEMENT'S EFFECT, NOT A SETTLING PROCESS'S ─────────────────────────
//
// The run webhook used to be POSTed inline by whichever process happened to finish the run, from a URL that
// existed only in the submit request. Three things followed from that, and all three are the same mistake:
//
//   · a driver whose terminal write was REFUSED still called back, announcing either the winner's outcome a
//     second time or a run that was still going as though it were done;
//   · a control plane that restarted between dispatch and settlement dropped the callback silently, because
//     the only copy of the URL went with the process;
//   · a replica taken over by another could not hand it on — the replacement, the one that would actually
//     settle the run, had never seen it.
//
// The URL is now on the record (mig 0171) and delivery hangs off the terminal FACT, which the settlement
// wrote in its own transaction. So the callback exists exactly when the settlement exists: a refused write
// inserts no fact and therefore calls nobody, and a fact that was written is delivered by whatever process
// is walking the log afterwards — including one that boots later.
//
// Delivery semantics ride the runner, like every other consumer: at-least-once with retries and a dead
// letter. Receivers dedup by `x-everdict-event`, which is the contract every webhook platform states.

export interface RunWebhookDeps {
  runs: RunStore;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number; // per-POST budget (default 10s)
}

// The terminal facts a standalone run emits. A batch's children emit none (`terminalRunFacts` returns [] for
// a child), which is the right scope: a scorecard's callback is the scorecard's, not each case's.
const TERMINAL_RUN_KINDS = ["run.completed", "run.failed"];

export function runWebhookConsumer(deps: RunWebhookDeps): PlatformEventConsumer {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.requestTimeoutMs ?? 10_000;
  return {
    name: "runs:completion-webhook",
    kinds: TERMINAL_RUN_KINDS,
    async handle(event: PlatformEventRecord): Promise<void> {
      if (event.subject?.type !== "run" || !event.subject.id) return;
      const record = await deps.runs.get(event.subject.id);
      // No URL is the ordinary case — almost every run is submitted without one.
      if (!record?.webhookUrl) return;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetchImpl(record.webhookUrl, {
          method: "POST",
          headers: { "content-type": "application/json", "x-everdict-event": event.id },
          body: JSON.stringify(record),
          signal: controller.signal,
        });
        // A non-2xx is a FAILED delivery, so the runner retries and eventually dead-letters it. Swallowing it
        // would turn "your endpoint is down" into "we told you", which is the shape of silence this platform
        // spends its effort refusing everywhere else.
        if (!res.ok) throw new Error(`run webhook ${record.webhookUrl} answered ${res.status}`);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
