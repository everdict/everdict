import type { PermissionHook } from "@everdict/agent-runtime";
import type { AgentRegistry, TenantKeyStore } from "@everdict/application-control";
import type { AgentSessionRecord, AgentSpec, AgentTrigger } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { type ActivationEvent, AgentActivator, triggerMatches } from "./agent-activation.js";
import { AgentMailbox } from "./agent-mailbox.js";

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: "sentinel",
    version: "1.0.0",
    mcpServers: [],
    capabilities: [],
    disabledDefaults: [],
    triggers: [{ kinds: ["scorecard.completed"], filters: [] }],
    enabled: true,
    tags: [],
    ...over,
  };
}

function event(over: Partial<ActivationEvent> = {}): ActivationEvent {
  return {
    workspace: "acme",
    kind: "scorecard.completed",
    message: "Scorecard sc-1 succeeded",
    eventId: "ev-1",
    subject: { type: "scorecard", id: "sc-1" },
    payload: { passRate: 0.5 },
    ...over,
  };
}

function registryOf(theSpec: AgentSpec, createdBy: string | null = "alice"): AgentRegistry {
  return {
    register: async () => {},
    has: async () => true,
    get: async () => theSpec,
    versions: async () => [theSpec.version],
    ownVersions: async () => [theSpec.version],
    list: async () => [
      { id: theSpec.id, versions: [theSpec.version], owner: "acme", ...(createdBy ? { createdBy } : {}) },
    ],
    creatorOf: async () => createdBy ?? undefined,
    softDelete: async () => {},
  };
}

function keyStoreStub() {
  const revoked: string[] = [];
  const store = {
    revoked,
    async add() {},
    async resolveByHash() {
      return undefined;
    },
    async list() {
      return [];
    },
    async revoke(_tenant: string, id: string) {
      revoked.push(id);
      return true;
    },
  };
  return store as unknown as TenantKeyStore & { revoked: string[] };
}

function sessionsStub() {
  const created: AgentSessionRecord[] = [];
  const statuses: Array<{ id: string; status: string }> = [];
  return {
    created,
    statuses,
    async createSession(record: AgentSessionRecord) {
      created.push(record);
    },
    async getSession() {
      return undefined;
    },
    async getVisibleSession(_tenant: string, _subject: string, id: string) {
      return created.find((s) => s.id === id);
    },
    async listSessions() {
      return [];
    },
    async touchSession() {},
    async setSessionModel() {},
    async setSessionPermissionMode() {},
    async setSessionStatus(_tenant: string, id: string, status: string) {
      statuses.push({ id, status });
    },
    async hasTriggerSession(_tenant: string, agentId: string, eventId: string) {
      return created.some((s) => s.origin?.agentId === agentId && s.origin?.eventId === eventId);
    },
    async listRuns() {
      return created.filter((s) => s.origin !== undefined);
    },
    async deleteSession() {},
    async appendMessages() {},
    async listMessages() {
      return [];
    },
  };
}

function activator(opts: {
  registry: AgentRegistry;
  runTurn?: (sessionId: string, token: string, signal?: AbortSignal, permit?: PermissionHook) => Promise<void>;
  sessions?: ReturnType<typeof sessionsStub>;
  keyStore?: ReturnType<typeof keyStoreStub>;
  cooldownMs?: number;
}) {
  const sessions = opts.sessions ?? sessionsStub();
  const keyStore = opts.keyStore ?? keyStoreStub();
  const mailbox = new AgentMailbox();
  const runs: Array<{ sessionId: string; token: string }> = [];
  const instance = new AgentActivator({
    registry: opts.registry,
    keyStore,
    sessions,
    mailbox,
    runTurn:
      opts.runTurn ??
      (async (sessionId, token) => {
        runs.push({ sessionId, token });
      }),
    now: () => new Date().toISOString(),
    newId: (() => {
      let n = 0;
      return () => `s-${++n}`;
    })(),
    ...(opts.cooldownMs !== undefined ? { cooldownMs: opts.cooldownMs } : {}),
  });
  return { instance, sessions, keyStore, mailbox, runs };
}

describe("triggerMatches", () => {
  const trigger: AgentTrigger = {
    kinds: ["scorecard.completed"],
    filters: [{ field: "passRate", op: "lt", value: 1 }],
  };

  it("matches on a listed kind when every payload filter passes", () => {
    expect(triggerMatches(trigger, event({ payload: { passRate: 0.5 } }))).toBe(true);
    expect(triggerMatches(trigger, event({ payload: { passRate: 1 } }))).toBe(false);
    expect(triggerMatches(trigger, event({ kind: "scorecard.submitted" }))).toBe(false);
    // A missing numeric field never matches a numeric comparison.
    expect(triggerMatches(trigger, event({ payload: {} }))).toBe(false);
  });

  it("supports eq/exists filters", () => {
    const byOrigin: AgentTrigger = {
      kinds: ["scorecard.submitted"],
      filters: [{ field: "origin", op: "eq", value: "schedule" }],
    };
    expect(triggerMatches(byOrigin, event({ kind: "scorecard.submitted", payload: { origin: "schedule" } }))).toBe(
      true,
    );
    expect(triggerMatches(byOrigin, event({ kind: "scorecard.submitted", payload: { origin: "api" } }))).toBe(false);
  });
});

describe("AgentActivator", () => {
  it("activates an enabled matching agent: trigger-origin session, event in the mailbox, one-shot token revoked", async () => {
    // Given an enabled agent whose trigger matches
    const { instance, sessions, keyStore, runs } = activator({ registry: registryOf(spec()) });

    // When the event arrives
    const activated = await instance.onEvent(event());
    await instance.idle();

    // Then one run happened, with a trigger-origin session acting as the creator
    expect(activated).toBe(1);
    expect(runs).toHaveLength(1);
    expect(sessions.created[0]).toMatchObject({
      owner: "alice",
      origin: { type: "trigger", agentId: "sentinel", agentVersion: "1.0.0", eventId: "ev-1" },
      status: "running",
    });
    expect(sessions.statuses).toEqual([{ id: "s-1", status: "completed" }]);
    expect(keyStore.revoked).toHaveLength(1); // credential dies with the run
  });

  it("deduplicates durably — the same event never runs the same agent twice (at-least-once safe)", async () => {
    const { instance, runs } = activator({ registry: registryOf(spec()), cooldownMs: 0 });
    await instance.onEvent(event());
    await instance.idle();
    const second = await instance.onEvent(event());
    await instance.idle();
    expect(second).toBe(0);
    expect(runs).toHaveLength(1);
  });

  it("skips disabled agents, self-caused events, and agents without a creator to act as", async () => {
    const disabled = activator({ registry: registryOf(spec({ enabled: false })) });
    expect(await disabled.instance.onEvent(event())).toBe(0);

    const selfCaused = activator({ registry: registryOf(spec()) });
    expect(await selfCaused.instance.onEvent(event({ causedBy: "agent:sentinel:s-9" }))).toBe(0);

    const creatorless = activator({ registry: registryOf(spec(), null) });
    expect(await creatorless.instance.onEvent(event())).toBe(0);
  });

  it("marks the run failed (and still revokes the token) when the turn throws", async () => {
    const { instance, sessions, keyStore } = activator({
      registry: registryOf(spec()),
      runTurn: async () => {
        throw new Error("model down");
      },
    });
    await instance.onEvent(event());
    await instance.idle();
    expect(sessions.statuses).toEqual([{ id: "s-1", status: "failed" }]);
    expect(keyStore.revoked).toHaveLength(1);
  });

  it("parks a default-mode mutation for member approval (awaiting_approval → running) and honors the decision", async () => {
    // Given a default-mode agent whose turn attempts one mutation
    const approvals: string[] = [];
    const sessions = sessionsStub();
    const registry = registryOf(spec({ permissionMode: "default" }));
    const mailbox = new AgentMailbox();
    const keyStore = keyStoreStub();
    const instance = new AgentActivator({
      registry,
      keyStore,
      sessions,
      mailbox,
      runTurn: async (_sessionId, _token, _signal, permit) => {
        const decision = await permit?.({ name: "create_dataset", isReadOnly: false, input: {} });
        approvals.push(`create_dataset:${decision}`);
      },
      waitApproval: async (_sessionId, request) => {
        approvals.push(`asked:${request.name}`);
        return "allow";
      },
      now: () => new Date().toISOString(),
      newId: (() => {
        let n = 0;
        return () => `s-${++n}`;
      })(),
    });

    // When the event activates it
    await instance.onEvent(event());
    await instance.idle();

    // Then the mutation parked, the member decision applied, and the run passed through awaiting_approval
    expect(approvals).toEqual(["asked:create_dataset", "create_dataset:allow"]);
    expect(sessions.statuses.map((s) => s.status)).toEqual(["awaiting_approval", "running", "completed"]);
  });

  it("auto mode allows routine mutations without parking but fails CLOSED (deny) when nobody can approve a guarded one", async () => {
    const decisions: Array<string | undefined> = [];
    const base = {
      sessions: sessionsStub(),
      keyStore: keyStoreStub(),
      mailbox: new AgentMailbox(),
      now: () => new Date().toISOString(),
    };
    const instance = new AgentActivator({
      ...base,
      registry: registryOf(spec({ permissionMode: "auto" })),
      // waitApproval NOT wired — a guarded ask has nobody to approve it
      runTurn: async (_sessionId, _token, _signal, permit) => {
        decisions.push(await permit?.({ name: "create_dataset", isReadOnly: false, input: {} }));
        decisions.push(await permit?.({ name: "delete_dataset", isReadOnly: false, input: {} }));
      },
      newId: (() => {
        let n = 0;
        return () => `s-${++n}`;
      })(),
    });
    await instance.onEvent(event());
    await instance.idle();
    expect(decisions).toEqual(["allow", "deny"]);
  });

  it("applies the per-(agent, kind) cooldown to distinct events", async () => {
    const { instance, runs } = activator({ registry: registryOf(spec()), cooldownMs: 60_000 });
    await instance.onEvent(event({ eventId: "ev-1" }));
    const second = await instance.onEvent(event({ eventId: "ev-2" }));
    await instance.idle();
    expect(second).toBe(0);
    expect(runs).toHaveLength(1);
  });
});

describe("AgentActivator.resumeApproval — the A6 resume leg", () => {
  const parkedSession = (): AgentSessionRecord =>
    ({
      id: "sess-1",
      tenant: "acme",
      owner: "alice",
      title: "sentinel — scorecard.completed",
      visibility: "workspace",
      origin: { type: "trigger", agentId: "sentinel", agentVersion: "1.0.0", eventKind: "scorecard.completed" },
      status: "awaiting_approval",
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    }) as AgentSessionRecord;

  it("runs ONE continuation turn seeded with the decision — the parked tool is pre-approved exactly once", async () => {
    const seen: string[] = [];
    const sessions = sessionsStub();
    sessions.created.push(parkedSession()); // the run died with a restart — only the record remains
    const { instance } = activator({
      registry: registryOf(spec({ permissionMode: "default" })),
      sessions,
      // Exercise the permit like the loop would: re-ask the parked tool twice. No waitApproval is wired,
      // so anything past the one-shot pre-approval fails CLOSED (deny) — never silently allow.
      runTurn: async (_sessionId, _token, _signal, permit) => {
        if (!permit) throw new Error("permit expected under default mode");
        seen.push(await permit({ name: "write_file", isReadOnly: false, input: {} }));
        seen.push(await permit({ name: "write_file", isReadOnly: false, input: {} }));
      },
    });
    const res = await instance.resumeApproval({
      workspace: "acme",
      sessionId: "sess-1",
      decision: "allow",
      request: { name: "write_file", input: { path: "a.txt" } },
      decidedBy: "bob",
    });
    expect(res).toEqual({ resumed: true });
    await instance.idle();
    expect(seen).toEqual(["allow", "deny"]); // one-shot pre-approval; the second identical ask parks/denies
    expect(sessions.statuses.map((x) => x.status)).toEqual(["running", "completed"]);
  });

  it("refuses what cannot resume: a missing session, and a non-trigger session", async () => {
    const sessions = sessionsStub();
    sessions.created.push({ ...parkedSession(), id: "chat-1", origin: undefined } as AgentSessionRecord);
    const { instance } = activator({ registry: registryOf(spec()), sessions });
    expect(
      await instance.resumeApproval({
        workspace: "acme",
        sessionId: "ghost",
        decision: "allow",
        request: { name: "write_file" },
      }),
    ).toEqual({ resumed: false, reason: "session not found" });
    expect(
      await instance.resumeApproval({
        workspace: "acme",
        sessionId: "chat-1",
        decision: "deny",
        request: { name: "write_file" },
      }),
    ).toEqual({ resumed: false, reason: "not a resumable trigger run" });
  });
});
