import type { PermissionHook } from "@everdict/agent-runtime";
import type { AgentRegistry, TenantKeyStore } from "@everdict/application-control";
import type {
  AgentMessageRecord,
  AgentSessionRecord,
  AgentSpec,
  AgentTrigger,
  SubscriptionRecord,
  TraceEvent,
} from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import {
  type ActivationEvent,
  AgentActivator,
  type TurnOutcome,
  renderActivationPrompt,
  triggerMatches,
} from "./agent-activation.js";
import { AgentMailbox } from "./agent-mailbox.js";
import type { AgentTurnUsage } from "./run-trace.js";

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return {
    id: "sentinel",
    version: "1.0.0",
    mcpServers: [],
    capabilities: [],
    disabledDefaults: [],
    toolSecretBindings: {},
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
  const messages: AgentMessageRecord[] = [];
  return {
    created,
    statuses,
    messages,
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
    async setSessionMemory() {},
    async setSessionStatus(_tenant: string, id: string, status: string) {
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
    async hasTriggerSession(_tenant: string, agentId: string, eventId: string) {
      return created.some((s) => s.origin?.agentId === agentId && s.origin?.eventId === eventId);
    },
    async findTriggerSession(_tenant: string, agentId: string, eventId: string) {
      return created.find((s) => s.origin?.agentId === agentId && s.origin?.eventId === eventId);
    },
    async listRuns() {
      return created.filter((s) => s.origin !== undefined);
    },
    async deleteSession() {},
    async appendMessages(records: AgentMessageRecord[]) {
      messages.push(...records);
    },
    async listMessages(_tenant: string, sessionId: string, sinceSeq?: number) {
      return messages.filter((m) => m.sessionId === sessionId && (sinceSeq === undefined || m.seq > sinceSeq));
    },
  };
}

function activator(opts: {
  registry: AgentRegistry;
  runTurn?: (
    sessionId: string,
    token: string,
    signal?: AbortSignal,
    permit?: PermissionHook,
  ) => Promise<TurnOutcome | undefined>;
  sessions?: ReturnType<typeof sessionsStub>;
  keyStore?: ReturnType<typeof keyStoreStub>;
  cooldownMs?: number;
  subscriptions?: SubscriptionRecord[];
  admitRun?: (workspace: string) => Promise<{ admitted: boolean; reason?: string }>;
}) {
  const sessions = opts.sessions ?? sessionsStub();
  const keyStore = opts.keyStore ?? keyStoreStub();
  const mailbox = new AgentMailbox();
  const runs: Array<{ sessionId: string; token: string }> = [];
  const reports: Array<{ kind: string; runId?: string; trace?: TraceEvent[] }> = [];
  const instance = new AgentActivator({
    registry: opts.registry,
    keyStore,
    sessions,
    mailbox,
    runTurn:
      opts.runTurn ??
      (async (sessionId, token) => {
        runs.push({ sessionId, token });
        return undefined;
      }),
    reportRunEvent: async (input) => {
      reports.push({
        kind: input.kind,
        ...(input.runId ? { runId: input.runId } : {}),
        ...(input.trace ? { trace: input.trace } : {}),
      });
    },
    now: () => new Date().toISOString(),
    newId: (() => {
      let n = 0;
      return () => `s-${++n}`;
    })(),
    ...(opts.cooldownMs !== undefined ? { cooldownMs: opts.cooldownMs } : {}),
    ...(opts.subscriptions !== undefined
      ? { subscriptions: { listEnabled: async () => opts.subscriptions ?? [] } }
      : {}),
    ...(opts.admitRun !== undefined ? { admitRun: opts.admitRun } : {}),
  });
  return { instance, sessions, keyStore, mailbox, runs, reports };
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

describe("renderActivationPrompt", () => {
  it("tells an agent woken by a comment to reply INSIDE that thread, with the parent id the fact carries", () => {
    // Given the fact for a top-level comment on an issue…
    const prompt = renderActivationPrompt(
      { task: "watch the tracker" },
      event({
        kind: "comment.created",
        subject: { type: "issue", id: "ENG-12" },
        payload: { commentId: "cmt-1" },
        message: "New comment on issue ENG-12: @sentinel what regressed?",
      }),
    );
    // …Then the reply is anchored on that comment instead of becoming a second top-level thread.
    expect(prompt).toContain('parent_id "cmt-1"');
    expect(prompt).toContain("issue");
  });

  it("anchors on the PARENT when the fact is about a reply (only a top-level comment can be a parent)", () => {
    const prompt = renderActivationPrompt(
      { task: "watch the tracker" },
      event({ kind: "comment.created", payload: { commentId: "cmt-2", parentId: "cmt-1" } }),
    );
    expect(prompt).toContain('parent_id "cmt-1"');
  });

  it("says nothing about threading for a fact that is not a comment", () => {
    expect(renderActivationPrompt({ task: "watch scorecards" }, event())).not.toContain("parent_id");
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

  it("the terminal report carries the turn transcript projected as TraceEvent — the run's trajectory (O2)", async () => {
    const sessions = sessionsStub();
    const { instance, reports } = activator({
      registry: registryOf(spec()),
      sessions,
      runTurn: async (sessionId) => {
        // The turn machinery persists the transcript rows — the wrapper projects them at settle.
        await sessions.appendMessages([
          {
            id: "m-0",
            tenant: "acme",
            sessionId,
            seq: 0,
            role: "user",
            content: "[scorecard.completed] Scorecard sc-1 succeeded",
            createdAt: "t0",
          },
          {
            id: "m-1",
            tenant: "acme",
            sessionId,
            seq: 1,
            role: "assistant",
            content: "Checked the regression.",
            toolCalls: [{ id: "call-1", name: "get_scorecard", arguments: '{"id":"sc-1"}' }],
            createdAt: "t1",
          },
          {
            id: "m-2",
            tenant: "acme",
            sessionId,
            seq: 2,
            role: "tool",
            content: "ok",
            toolCallId: "call-1",
            createdAt: "t2",
          },
        ]);
        // What the turn spent — the loop's counters, handed back so the projection can close the stream
        // with the model call the transcript itself never records. (This turn recorded no spans, so the
        // report falls back to the transcript projection — the N6 path is covered separately below.)
        return { usage: { model: "claude-sonnet-5", inputTokens: 120, outputTokens: 40 } };
      },
    });

    await instance.onEvent(event());
    await instance.idle();

    const terminal = reports.find((r) => r.kind === "agent.run.completed");
    expect(terminal?.runId).toBe("s-2"); // the activation minted session s-1, run s-2
    // This fixture's rows carry no datable createdAt, so the projection keeps its step-index fallback (`t` is
    // an order, not a clock). A row's own tool calls share its step — they happened at the same instant — and
    // the call carries the span id its result hangs under.
    expect(terminal?.trace).toEqual([
      { t: 0, kind: "message", role: "user", text: "[scorecard.completed] Scorecard sc-1 succeeded" },
      { t: 1, kind: "message", role: "assistant", text: "Checked the regression." },
      { t: 1, kind: "tool_call", id: "call-1", name: "get_scorecard", args: { id: "sc-1" }, spanId: "call-1" },
      { t: 2, kind: "tool_result", id: "call-1", ok: true, output: "ok", parentId: "call-1" },
      // The turn's model call closes the evidence. Without it the trajectory claims the agent typed and used
      // tools but never called a model, and usage (derived from llm_call costs) reads zero for a run that
      // spent money. `usd` is 0 on the wire on purpose — the control plane prices it at seal.
      {
        t: 3,
        kind: "llm_call",
        model: "claude-sonnet-5",
        cost: { inputTokens: 120, outputTokens: 40, usd: 0 },
      },
    ]);
    // started stays a light lifecycle ping — the transcript rides only the terminal report.
    expect(reports.find((r) => r.kind === "agent.run.started")?.trace).toBeUndefined();
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
        return undefined;
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
        return undefined;
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
        return undefined;
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

describe("AgentActivator.resumeInterrupted — the P0 restart-recovery leg", () => {
  const strandedSession = (): AgentSessionRecord =>
    ({
      id: "sess-9",
      tenant: "acme",
      owner: "alice",
      title: "sentinel — scorecard.completed",
      visibility: "workspace",
      origin: {
        type: "trigger",
        agentId: "sentinel",
        agentVersion: "1.0.0",
        eventId: "ev-9",
        eventKind: "scorecard.completed",
      },
      status: "failed", // the orphan sweep already claimed (settled) the row — the resume flips it back
      createdAt: "2026-07-30T00:00:00.000Z",
      updatedAt: "2026-07-30T00:00:00.000Z",
    }) as AgentSessionRecord;

  it("continues the SAME session with a recovery notice instead of re-activating a duplicate", async () => {
    const sessions = sessionsStub();
    sessions.created.push(strandedSession());
    const { instance, mailbox, runs } = activator({ registry: registryOf(spec()), sessions });

    const res = await instance.resumeInterrupted({ workspace: "acme", sessionId: "sess-9" });
    expect(res).toEqual({ resumed: true });
    await instance.idle();

    // One continuation turn ran on the ORIGINAL session — the transcript is the durable state.
    expect(runs).toHaveLength(1);
    expect(runs[0]?.sessionId).toBe("sess-9");
    // The turn woke up to the recovery notice (verify-before-repeating discipline included).
    const drained = mailbox.drain("acme", "sess-9");
    expect(drained.some((m) => typeof m.content === "string" && m.content.includes("[restart recovery]"))).toBe(true);
    // Recovery by resumption keeps the durable dedup honest: the (agent, event) pair still reads as handled,
    // so a reconcile re-feed of the same event can never double-run it.
    expect(await sessions.hasTriggerSession("acme", "sentinel", "ev-9")).toBe(true);
    // The session went back through the real lifecycle: running → completed.
    expect(sessions.statuses.map((x) => x.status)).toEqual(["running", "completed"]);
  });

  it("refuses what cannot resume, so the sweep's fail-closed settle stands", async () => {
    const sessions = sessionsStub();
    sessions.created.push({ ...strandedSession(), id: "chat-9", origin: undefined } as AgentSessionRecord);
    const { instance } = activator({ registry: registryOf(spec()), sessions });
    expect(await instance.resumeInterrupted({ workspace: "acme", sessionId: "ghost" })).toEqual({
      resumed: false,
      reason: "session not found",
    });
    expect(await instance.resumeInterrupted({ workspace: "acme", sessionId: "chat-9" })).toEqual({
      resumed: false,
      reason: "not a resumable trigger run",
    });
  });
});

describe("subscription-driven activation (E3 — reaction.kind=agent)", () => {
  const rule = (over: Partial<SubscriptionRecord> = {}): SubscriptionRecord => ({
    id: "sub-1",
    tenant: "acme",
    name: "wake sentinel",
    selector: { kinds: ["run.failed"], filters: [] },
    reaction: { kind: "agent", agentId: "sentinel" },
    governance: { enabled: true },
    createdBy: "alice",
    createdAt: "2026-07-30T00:00:00.000Z",
    updatedAt: "2026-07-30T00:00:00.000Z",
    ...over,
  });

  it("a matching subscription wakes its target agent even when the agent's own triggers do not match", async () => {
    // The spec subscribes to scorecard.completed only — run.failed reaches it purely through the rule.
    const { instance, sessions } = activator({
      registry: registryOf(spec()),
      subscriptions: [rule()],
    });
    const activated = await instance.onEvent(event({ kind: "run.failed", eventId: "ev-rf" }));
    await instance.idle();
    expect(activated).toBe(1);
    expect(sessions.created).toHaveLength(1);
    expect(sessions.created[0]?.origin).toMatchObject({ type: "trigger", agentId: "sentinel", eventId: "ev-rf" });
  });

  it("an agent whose own trigger already fired is not woken twice by a subscription on the same event", async () => {
    const { instance, sessions } = activator({
      registry: registryOf(spec()),
      subscriptions: [rule({ selector: { kinds: ["scorecard.completed"], filters: [] } })],
    });
    const activated = await instance.onEvent(event()); // matches BOTH the spec trigger and the rule
    await instance.idle();
    expect(activated).toBe(1);
    expect(sessions.created).toHaveLength(1);
  });

  it("honors the rule's own cooldownSec and skips a disabled target agent", async () => {
    const sessions = sessionsStub();
    const { instance } = activator({
      registry: registryOf(spec()),
      sessions,
      subscriptions: [rule({ governance: { enabled: true, cooldownSec: 3600 } })],
    });
    expect(await instance.onEvent(event({ kind: "run.failed", eventId: "e1" }))).toBe(1);
    expect(await instance.onEvent(event({ kind: "run.failed", eventId: "e2" }))).toBe(0); // paced by the rule
    await instance.idle();

    const disabled = activator({
      registry: registryOf(spec({ enabled: false, triggers: [] })),
      subscriptions: [rule()],
    });
    expect(await disabled.instance.onEvent(event({ kind: "run.failed" }))).toBe(0);
  });

  it("keeps loop guard #1: a fact caused by the target agent's own run never re-wakes it", async () => {
    const { instance } = activator({
      registry: registryOf(spec()),
      subscriptions: [rule()],
    });
    const activated = await instance.onEvent(event({ kind: "run.failed", causedBy: "agent:sentinel:some-session" }));
    expect(activated).toBe(0);
  });
});

describe("activateDirect — the T-d reaction step entry", () => {
  it("starts one run for the step key, and a retry hands back the EXISTING session instead of a second run", async () => {
    const sessions = sessionsStub();
    const { instance } = activator({ registry: registryOf(spec()), sessions });
    const first = await instance.activateDirect({
      workspace: "acme",
      agentId: "sentinel",
      eventId: "ev-9#s0",
      eventKind: "scorecard.completed",
      message: "Scorecard sc-9 regressed",
    });
    await instance.idle();
    expect(first).toMatchObject({ started: true });
    expect(sessions.created).toHaveLength(1);
    expect(sessions.created[0]?.origin).toMatchObject({ agentId: "sentinel", eventId: "ev-9#s0" });

    const retry = await instance.activateDirect({
      workspace: "acme",
      agentId: "sentinel",
      eventId: "ev-9#s0",
      eventKind: "scorecard.completed",
      message: "Scorecard sc-9 regressed",
    });
    expect(retry).toMatchObject({ started: false, sessionId: sessions.created[0]?.id });
    expect(sessions.created).toHaveLength(1); // never a duplicate run
  });

  it("answers {skipped} for a disabled or creator-less target, and the step instruction rides into the mailbox", async () => {
    const disabled = activator({ registry: registryOf(spec({ enabled: false })) });
    expect(
      await disabled.instance.activateDirect({
        workspace: "acme",
        agentId: "sentinel",
        eventId: "e#s0",
        eventKind: "run.failed",
        message: "m",
      }),
    ).toMatchObject({ skipped: expect.stringContaining("disabled") });

    const orphan = activator({ registry: registryOf(spec(), null) });
    expect(
      await orphan.instance.activateDirect({
        workspace: "acme",
        agentId: "sentinel",
        eventId: "e#s0",
        eventKind: "run.failed",
        message: "m",
      }),
    ).toMatchObject({ skipped: expect.stringContaining("creator") });

    const sessions = sessionsStub();
    const { instance, mailbox } = activator({ registry: registryOf(spec()), sessions });
    const seen: string[] = [];
    const started = await instance.activateDirect({
      workspace: "acme",
      agentId: "sentinel",
      eventId: "e#s1",
      eventKind: "run.failed",
      message: "the fact",
      instruction: "Re-run the smoke scorecard and open a fix PR if it still regresses.",
    });
    await instance.idle();
    expect(started).toMatchObject({ started: true });
    const sessionId = "sessionId" in started ? started.sessionId : "";
    for (const m of mailbox.drain("acme", sessionId)) if (typeof m.content === "string") seen.push(m.content);
    expect(seen.some((c) => c.includes("[reaction step] Re-run the smoke scorecard"))).toBe(true);
  });
});

describe("activation admission (§5.1 — every launch path asks the tenant budget)", () => {
  const denied = async () => ({ admitted: false, reason: "cost budget exceeded" });

  it("a 402 refusal skips the spec-trigger activation visibly (no session, no run)", async () => {
    const { instance, sessions } = activator({ registry: registryOf(spec()), admitRun: denied });
    expect(await instance.onEvent(event())).toBe(0);
    await instance.idle();
    expect(sessions.created).toHaveLength(0);
  });

  it("a 402 refusal answers a reaction step with {skipped} — the chain stops instead of retrying forever", async () => {
    const { instance } = activator({ registry: registryOf(spec()), admitRun: denied });
    const result = await instance.activateDirect({
      workspace: "acme",
      agentId: "sentinel",
      eventId: "ev-b#s0",
      eventKind: "scorecard.completed",
      message: "m",
    });
    expect(result).toMatchObject({ skipped: expect.stringContaining("402") });
  });

  it("an admitted ask launches exactly as before (the gate is invisible on the pass path)", async () => {
    const asks: string[] = [];
    const { instance, sessions } = activator({
      registry: registryOf(spec()),
      admitRun: async (workspace) => {
        asks.push(workspace);
        return { admitted: true };
      },
    });
    expect(await instance.onEvent(event())).toBe(1);
    await instance.idle();
    expect(asks).toEqual(["acme"]);
    expect(sessions.created).toHaveLength(1);
  });
});
