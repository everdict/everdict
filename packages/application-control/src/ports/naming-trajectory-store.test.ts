import type { TraceEvent, TraceSpan } from "@everdict/contracts";
import { eventsToSpans } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { NamingTrajectoryStore } from "./naming-trajectory-store.js";
import type { SealInput, TrajectoryListResult, TrajectoryMeta, TrajectoryStore } from "./trajectory-store.js";

// A store that records what it was handed — the decorator's whole job is what reaches this.
function recorder(): { seals: SealInput[]; store: TrajectoryStore } {
  const seals: SealInput[] = [];
  const store: TrajectoryStore = {
    async seal(input) {
      seals.push(input);
      return {
        runId: input.runId,
        tenant: input.tenant,
        source: input.source,
        eventCount: input.events?.length ?? input.spans?.length ?? 0,
        sealedAt: "2026-08-12T00:00:00.000Z",
        created: true,
      };
    },
    async planes() {
      return undefined;
    },
    async events() {
      return { kind: "absent" as const };
    },
    // This recorder holds nothing back, so "absent" is what the real store would answer for every id — a
    // double that invented a summary here would be more permissive than production.
    async usage() {
      return { kind: "absent" as const };
    },
    async list(): Promise<TrajectoryListResult> {
      return { items: [] as TrajectoryMeta[] };
    },
    async ingestedSince() {
      return { trajectories: 0, events: 0 };
    },
    async deleteOlderThan() {
      return 0;
    },
    // No offload in this fixture, so there is nothing to enumerate — the honest answer, not a stub.
    async payloadRefsOlderThan() {
      return [];
    },
  };
  return { seals, store };
}

// Deterministic span ids — assembly needs a minter, and a test asserting a name should not depend on entropy.
function spanIds(): () => string {
  let n = 0;
  return () => (++n).toString(16).padStart(16, "0");
}

const chatTurn: TraceEvent[] = [
  { t: 0, at: "2026-08-12T00:00:00.000Z", kind: "message", role: "user", text: "analyze the failing payment logs" },
  { t: 1, at: "2026-08-12T00:00:01.000Z", kind: "llm_call", model: "claude-opus-5" },
  { t: 2, at: "2026-08-12T00:00:02.000Z", kind: "message", role: "assistant", text: "three timeouts in checkout" },
];

describe("NamingTrajectoryStore — every sealed trajectory carries the line that tells it apart", () => {
  it("derives the preview from an events body, so a page of one agent's turns is no longer one repeated row", async () => {
    // Given two turns of the SAME agent — identical kind and label, the producer's name
    const { seals, store } = recorder();
    const naming = new NamingTrajectoryStore(store);
    const base = { tenant: "acme", source: "run" as const, kind: "agent", label: "default" };
    // When each is sealed with only its own transcript to tell them apart
    await naming.seal({ ...base, runId: "r-1", events: chatTurn });
    await naming.seal({
      ...base,
      runId: "r-2",
      events: [{ t: 0, kind: "message", role: "user", text: "draft the release notes" }],
    });
    // Then the ledger holds two different lines under one repeated label
    expect(seals.map((s) => s.preview)).toEqual(["analyze the failing payment logs", "draft the release notes"]);
    expect(seals.map((s) => s.label)).toEqual(["default", "default"]);
  });

  it("names a SPANS body the same way it names its event-sealed twin — spans are the record, events the projection", async () => {
    // Given the same turn sealed as spans (what a run's own recorded plane seals)
    const { seals, store } = recorder();
    const spans = eventsToSpans(chatTurn, { traceId: "0".repeat(32), agentName: "run", newSpanId: spanIds() });
    expect(spans).toBeDefined();
    await new NamingTrajectoryStore(store).seal({
      runId: "r-3",
      tenant: "acme",
      source: "run",
      spans: spans as TraceSpan[],
    });
    // Then the row reads the same as the events path — the two formats never disagree about the name
    expect(seals[0]?.preview).toBe("analyze the failing payment logs");
  });

  it("names an OTLP arrival, which has no run record to be named from", async () => {
    // Given spans as an exporter actually pushes them — a service's own record, no conversation in it at all
    const { seals, store } = recorder();
    const spans: TraceSpan[] = [
      {
        traceId: "1".repeat(32),
        spanId: "a".repeat(16),
        name: "checkout.submit",
        kind: "server",
        startedAt: "2026-08-12T00:00:00.000Z",
        endedAt: "2026-08-12T00:00:02.000Z",
        attributes: {},
      },
    ];
    await new NamingTrajectoryStore(store).seal({
      runId: "trace-abc",
      tenant: "acme",
      source: "otlp",
      spans,
    });
    // Then the row is named by what ran — the case mig 0124's run-ledger join could never reach
    expect(seals[0]?.preview).toBe("checkout.submit");
  });

  it("never overwrites a caller that named the evidence itself", async () => {
    // Given a caller that knows something the body does not say
    const { seals, store } = recorder();
    await new NamingTrajectoryStore(store).seal({
      runId: "r-4",
      tenant: "acme",
      source: "import",
      events: chatTurn,
      preview: "imported: travel-suite#case-03",
    });
    // Then its own line stands
    expect(seals[0]?.preview).toBe("imported: travel-suite#case-03");
  });

  it("seals a body with nothing to quote rather than inventing a name for it", async () => {
    // Given evidence carrying no phrase (placement marks only)
    const { seals, store } = recorder();
    await new NamingTrajectoryStore(store).seal({
      runId: "r-5",
      tenant: "acme",
      source: "run",
      events: [{ t: 0, at: "2026-08-12T00:00:00.000Z", kind: "infra", scope: "placement", message: "leased" }],
    });
    // Then absence is explicit — naming is a courtesy, retention is the contract
    expect(seals).toHaveLength(1);
    expect(seals[0]).not.toHaveProperty("preview");
  });

  it("forwards the browse filters instead of destructuring them away", async () => {
    // Given a reader asking for one family of evidence
    const calls: unknown[] = [];
    const { store } = recorder();
    const naming = new NamingTrajectoryStore({
      ...store,
      async list(tenant, opts) {
        calls.push({ tenant, opts });
        return { items: [] };
      },
    });
    // When the page is requested
    await naming.list("acme", { limit: 10, kind: "agent", viewer: "kim" });
    // Then the filter reaches the store — a dropped `kind` reads as "nothing of this kind exists"
    expect(calls[0]).toEqual({ tenant: "acme", opts: { limit: 10, kind: "agent", viewer: "kim" } });
  });
});
