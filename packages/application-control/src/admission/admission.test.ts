import type { RunRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import type { EnvelopeSpend, EnvelopeStore } from "../ports/envelope-store.js";
import type { RunStore } from "../ports/run-store.js";
import { admitCausedWork } from "./admission.js";

// Minimal in-memory doubles — the gate only reads get() and the spend row.
function runStoreOf(records: RunRecord[]): RunStore {
  const byId = new Map(records.map((r) => [r.id, r]));
  return {
    async get(id: string) {
      return byId.get(id);
    },
  } as unknown as RunStore;
}

function envelopesOf(initial: Record<string, EnvelopeSpend>) {
  const rows = new Map(Object.entries(initial));
  const admits: Array<{ id: string; runs: number }> = [];
  const store: EnvelopeStore = {
    async admit(id, _tenant, runs) {
      admits.push({ id, runs });
      const cur = rows.get(id) ?? { usd: 0, runs: 0 };
      rows.set(id, { ...cur, runs: cur.runs + runs });
    },
    async settle(id, _tenant, usd) {
      const cur = rows.get(id) ?? { usd: 0, runs: 0 };
      rows.set(id, { ...cur, usd: cur.usd + usd });
    },
    async spend(id) {
      return rows.get(id) ?? { usd: 0, runs: 0 };
    },
  };
  return { store, admits };
}

const agentRun = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: "run-agent",
  tenant: "acme",
  harness: { id: "sentinel", version: "1.0.0" },
  caseId: "ev-1",
  status: "running",
  kind: "agent",
  envelope: { id: "run-agent", capUsd: 1, capRuns: 10 },
  createdAt: "t",
  updatedAt: "t",
  ...over,
});

describe("admitCausedWork — the admission gate's causal leg (§5.1)", () => {
  it("admits within headroom and returns the envelope stamp; counts the caused runs", async () => {
    const { store, admits } = envelopesOf({ "run-agent": { usd: 0.4, runs: 2 } });
    const envelope = await admitCausedWork(
      { runStore: runStoreOf([agentRun()]), envelopes: store },
      "acme",
      "run-agent",
      3,
    );
    expect(envelope).toEqual({ id: "run-agent" }); // children stamp only the id — caps live on the root record
    expect(admits).toEqual([{ id: "run-agent", runs: 3 }]);
  });

  it("refuses at 402 once the delegated slice is spent — never silently", async () => {
    const { store } = envelopesOf({ "run-agent": { usd: 1.0, runs: 2 } });
    await expect(
      admitCausedWork({ runStore: runStoreOf([agentRun()]), envelopes: store }, "acme", "run-agent", 1),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED", status: 402 });
  });

  it("a 402 refusal emits budget.exceeded (E2 ops fact) with the loop guard's causedBy — never silently", async () => {
    const emitted: Array<{ kind: string; subject: { type: string; id: string }; causedBy?: string }> = [];
    const events = {
      async emit(input: { kind: string; subject: { type: string; id: string }; causedBy?: string }) {
        emitted.push({
          kind: input.kind,
          subject: input.subject,
          ...(input.causedBy ? { causedBy: input.causedBy } : {}),
        });
        return undefined;
      },
    };
    const { store } = envelopesOf({ "run-agent": { usd: 1.0, runs: 2 } });
    await expect(
      admitCausedWork(
        { runStore: runStoreOf([agentRun({ group: { id: "sess-1", role: "turn" } })]), envelopes: store, events },
        "acme",
        "run-agent",
        1,
      ),
    ).rejects.toMatchObject({ status: 402 });
    expect(emitted).toEqual([
      {
        kind: "budget.exceeded",
        subject: { type: "run", id: "run-agent" }, // the delegating run whose envelope refused
        causedBy: "agent:sentinel:sess-1", // the exhausted agent never wakes itself on its own refusal
      },
    ]);
    // A successful admission emits nothing.
    const roomy = envelopesOf({ "run-agent": { usd: 0, runs: 0 } });
    await admitCausedWork(
      { runStore: runStoreOf([agentRun({ group: { id: "sess-1", role: "turn" } })]), envelopes: roomy.store, events },
      "acme",
      "run-agent",
      1,
    );
    expect(emitted).toHaveLength(1);
  });

  it("refuses at 402 when the run cap cannot fit the requested fan-out (capRuns = the fan-out bound)", async () => {
    const { store } = envelopesOf({ "run-agent": { usd: 0, runs: 8 } });
    await expect(
      admitCausedWork({ runStore: runStoreOf([agentRun()]), envelopes: store }, "acme", "run-agent", 3),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("an INHERITED envelope draws from the root: a caused run's own children still hit the root's cap", async () => {
    const child = agentRun({
      id: "run-child",
      kind: "eval",
      origin: { cause: "run", causedByRunId: "run-agent" },
      envelope: { id: "run-agent" }, // inherited stamp — no caps of its own
    });
    const { store } = envelopesOf({ "run-agent": { usd: 1.0, runs: 0 } });
    await expect(
      admitCausedWork({ runStore: runStoreOf([agentRun(), child]), envelopes: store }, "acme", "run-child", 1),
    ).rejects.toMatchObject({ code: "BUDGET_EXCEEDED" });
  });

  it("guards causal depth at 429 — runaway recursive fan-out stops structurally, before money", async () => {
    // A chain of runs each caused by the previous: r0 ← r1 ← … ← r9.
    const chain: RunRecord[] = [];
    for (let i = 0; i < 10; i++) {
      chain.push(
        agentRun({
          id: `r${i}`,
          envelope: undefined,
          ...(i > 0 ? { origin: { cause: "run", causedByRunId: `r${i - 1}` } } : {}),
        }),
      );
    }
    await expect(admitCausedWork({ runStore: runStoreOf(chain) }, "acme", "r9", 1)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
    });
  });

  it("rejects a forged/foreign causer id (400) and passes envelope-less causers through unbounded", async () => {
    await expect(admitCausedWork({ runStore: runStoreOf([]) }, "acme", "ghost", 1)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      admitCausedWork({ runStore: runStoreOf([agentRun({ tenant: "rival" })]) }, "acme", "run-agent", 1),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const unbudgeted = await admitCausedWork(
      { runStore: runStoreOf([agentRun({ envelope: undefined })]) },
      "acme",
      "run-agent",
      5,
    );
    expect(unbudgeted).toBeUndefined(); // no envelope = the tenant budget still gates globally, as before P4
  });
});
