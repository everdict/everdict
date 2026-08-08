import type { AgentRegistry, TenantKeyStore } from "@everdict/application-control";
import type { AgentMessageRecord, AgentSessionRecord, AgentSpec } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type ActivationEvent, AgentActivator } from "./agent-activation.js";
import { AgentMailbox } from "./agent-mailbox.js";

// Trust suite (docs/trust-certification.md) — TRUST-16.
//
// The invariant: A RUN THAT STOPS WITHOUT COMPLETING IS SUSPENDED, AND RESUMABILITY IS ONLY CLAIMED WHEN A
// HANDOFF LANDED. A budget-exhausted activation settles session + ledger as `suspended` (never `completed` —
// the checkpoint's own words are "halted before reporting completion", and the lifecycle must not contradict
// them), and when the checkpoint publication FAILS the suspend fact says `handoff failed` instead of
// implying a resumable state that does not exist. Why a fake cannot prove it: the failure mode was the REAL
// settle path's branch structure (publishHalt best-effort + one completed-by-default branch) — a stubbed
// activator re-implements the branch it must certify, so the real AgentActivator runs with only its
// boundary I/O stubbed.
const describeTrust = process.env.EVERDICT_TRUST_SUITE === "1" ? describe : describe.skip;

const spec = (): AgentSpec => ({
  id: "sentinel",
  version: "1.0.0",
  mcpServers: [],
  capabilities: [],
  disabledDefaults: [],
  toolSecretBindings: {},
  triggers: [{ kinds: ["scorecard.completed"], filters: [] }],
  enabled: true,
  tags: [],
});
const event = (): ActivationEvent => ({
  workspace: "acme",
  kind: "scorecard.completed",
  message: "Scorecard sc-1 succeeded",
  eventId: "ev-1",
});
const registry: AgentRegistry = {
  register: async () => {},
  has: async () => true,
  get: async () => spec(),
  versions: async () => ["1.0.0"],
  ownVersions: async () => ["1.0.0"],
  list: async () => [{ id: "sentinel", versions: ["1.0.0"], owner: "acme", createdBy: "alice" }],
  creatorOf: async () => "alice",
  softDelete: async () => {},
};
const keyStore = {
  async add() {},
  async resolveByHash() {
    return undefined;
  },
  async list() {
    return [];
  },
  async revoke() {
    return true;
  },
} as unknown as TenantKeyStore;

function sessionsStub() {
  const created: AgentSessionRecord[] = [];
  const statuses: Array<{ id: string; status: string }> = [];
  const messages: AgentMessageRecord[] = [];
  return {
    statuses,
    async createSession(record: AgentSessionRecord) {
      created.push(record);
    },
    async getSession() {
      return undefined;
    },
    async getVisibleSession(_t: string, _s: string, id: string) {
      return created.find((s) => s.id === id);
    },
    async listSessions() {
      return [];
    },
    async touchSession() {},
    async setSessionModel() {},
    async setSessionPermissionMode() {},
    async setSessionMemory() {},
    async setSessionStatus(_t: string, id: string, status: string) {
      statuses.push({ id, status });
    },
    async setSessionRunId() {},
    async setSessionWakeIntent() {},
    async claimWakeIntent() {
      return false;
    },
    async listWaitingSessions() {
      return [];
    },
    async listExpiredWakeIntents() {
      return [];
    },
    async listOrphanedRuns() {
      return [];
    },
    async claimOrphanedRun() {
      return false;
    },
    async setSessionTeammate() {},
    async listTeammateSessions() {
      return [];
    },
    async setSessionPermissionRules() {},
    async setSessionPlan() {},
    async hasTriggerSession() {
      return false;
    },
    async findTriggerSession() {
      return undefined;
    },
    async listRuns() {
      return [];
    },
    async deleteSession() {},
    async appendMessages(records: AgentMessageRecord[]) {
      messages.push(...records);
    },
    async listMessages() {
      return messages;
    },
  };
}

function activator(opts: { publishCheckpoint?: () => Promise<void> }) {
  const sessions = sessionsStub();
  const reports: Array<{ kind: string; message?: string }> = [];
  const instance = new AgentActivator({
    registry,
    keyStore,
    sessions,
    mailbox: new AgentMailbox(),
    runTurn: async () => ({ stopReason: "budget_exhausted" }),
    reportRunEvent: async (input) => {
      reports.push({ kind: input.kind, ...(input.message ? { message: input.message } : {}) });
    },
    now: () => new Date().toISOString(),
    newId: (() => {
      let n = 0;
      return () => `s-${++n}`;
    })(),
    ...(opts.publishCheckpoint ? { publishCheckpoint: opts.publishCheckpoint } : {}),
  });
  return { instance, sessions, reports };
}

describeTrust("TRUST-16 — a budget halt suspends, and resumability is only claimed when a handoff landed", () => {
  it("budget_exhausted never settles as completed; the published handoff is claimed on the fact", async () => {
    const { instance, sessions, reports } = activator({ publishCheckpoint: async () => {} });
    await instance.onEvent(event());
    await instance.idle();
    expect(sessions.statuses.at(-1)?.status).toBe("suspended");
    const kinds = reports.map((r) => r.kind);
    expect(kinds).toContain("agent.run.suspended");
    expect(kinds).not.toContain("agent.run.completed");
    expect(reports.find((r) => r.kind === "agent.run.suspended")?.message).toContain("handoff published");
  });

  it("a FAILED checkpoint publication still suspends — and says the handoff failed, never implying one exists", async () => {
    const { instance, sessions, reports } = activator({
      publishCheckpoint: async () => {
        throw new Error("400 dangling evidence");
      },
    });
    await instance.onEvent(event());
    await instance.idle();
    expect(sessions.statuses.at(-1)?.status).toBe("suspended");
    const suspend = reports.find((r) => r.kind === "agent.run.suspended");
    expect(suspend?.message).toContain("handoff failed");
    expect(reports.map((r) => r.kind)).not.toContain("agent.run.failed"); // a bounded stop is not a failure
  });
});
