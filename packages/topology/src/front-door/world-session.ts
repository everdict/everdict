import type { OpenedWorld, WorldSessionProvider } from "@everdict/application-control";
import type { SessionAcquire, TargetAcquire } from "@everdict/contracts";
import { type AcquireRequestFn, fetchAcquire, serviceAcquirer } from "./target-acquirer.js";

// ── OPENING AN ENVIRONMENT'S WORLD THROUGH ITS SESSION API (world-and-engagement-model.md) ───────────
//
// The mechanism already existed for a browser TARGET: ask a service for a session, map the response's fields
// onto wiring variables, close it after. This is the same acquirer with the environment's own endpoint
// standing in for a topology service — which is the whole reason the environment declares one: there is no
// topology here, only a world the workspace hosts and hands out sessions to.
//
// The `release` this returns says WHAT HAPPENED rather than throwing: the case is over by the time it runs,
// and turning a courtesy's failure into the case's failure would report an agent as having failed a task it
// completed. The session service is the lifetime's owner; this asks it to close early.
export function sessionWorldProvider(request: AcquireRequestFn = fetchAcquire): WorldSessionProvider {
  return {
    async open({
      endpoint,
      acquire,
      runId,
    }: { endpoint: string; acquire: SessionAcquire; runId: string }): Promise<OpenedWorld> {
      // The acquirer speaks the topology's shape (a named service resolved through an endpoints map); an
      // environment names its endpoint directly, so the service name is a local label for exactly one entry.
      const service = "world";
      const asTarget: Extract<TargetAcquire, { mode: "service" }> = {
        mode: "service",
        service,
        open: acquire.open,
        coordinates: acquire.coordinates,
        ...(acquire.close !== undefined ? { close: acquire.close } : {}),
      };
      const handle = await serviceAcquirer(asTarget, request).acquire({
        // No `spec`: that field is the harness TOPOLOGY the provision lane brings a browser up inside, and an
        // environment opening its own world has none. The session lane never reads it.
        runId,
        endpoints: { [service]: endpoint },
        wiring: { run_id: runId },
      });
      return {
        wiring: handle.wiring,
        release: async () => {
          try {
            await handle.dispose();
            return { kind: "closed" as const };
          } catch (err) {
            return { kind: "not_closed" as const, reason: err instanceof Error ? err.message : String(err) };
          }
        },
      };
    },
  };
}

// Re-exported for the composition root, which builds this beside the other acquirers.
export type { SessionAcquire };
