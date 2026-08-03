import type { AgentSessionRecord, AgentWakeIntent } from "@everdict/contracts";
import { InMemoryAgentSessionStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import type { ChatDeps } from "./chat.js";
import { buildWakeResumer, wakeIntentMatches } from "./wake-resume.js";

const WORKSPACE = "acme";

function intent(overrides: Partial<AgentWakeIntent> = {}): AgentWakeIntent {
  return {
    kinds: ["scorecard.completed", "scorecard.failed"],
    filters: [{ field: "id", op: "eq", value: "sc1" }],
    note: "watching scorecard sc1 to report its pass rate",
    deadlineAt: "2026-08-03T12:00:00.000Z",
    createdAt: "2026-08-03T11:00:00.000Z",
    ...overrides,
  };
}

async function seed(
  sessions: InMemoryAgentSessionStore,
  id: string,
  wakeIntent?: AgentWakeIntent,
): Promise<AgentSessionRecord> {
  const record: AgentSessionRecord = {
    id,
    tenant: WORKSPACE,
    owner: "member-1",
    title: "batch watch",
    createdAt: "2026-08-03T11:00:00.000Z",
    updatedAt: "2026-08-03T11:00:00.000Z",
    ...(wakeIntent ? { wakeIntent } : {}),
  };
  await sessions.createSession(record);
  return record;
}

// The store is the real in-memory one (the claim's atomicity is part of what we assert); the token mint and the
// turn are fakes, since this suite is about WHICH conversations get resumed, not what the model then says.
function resumer(sessions: InMemoryAgentSessionStore, opts: { isLive?: boolean } = {}) {
  const turns: { sessionId: string; prompt: string }[] = [];
  const revoked: string[] = [];
  const keyStore = {
    // issueAgentToken mints the plaintext itself and stores its hash — the fake only has to accept the row.
    add: async () => {},
    revoke: async (_tenant: string, id: string) => {
      revoked.push(id);
    },
  };
  const built = buildWakeResumer({
    chat: { sessions, now: () => "2026-08-03T12:30:00.000Z" } as unknown as ChatDeps,
    authenticate: async () => ({ workspace: WORKSPACE, subject: "member-1", roles: ["member"], via: "agent" }),
    keyStore: keyStore as never,
    ...(opts.isLive === true ? { isLive: () => true } : {}),
    runTurn: async (session, prompt) => {
      turns.push({ sessionId: session.id, prompt });
    },
  });
  return { built, turns, revoked };
}

describe("wakeIntentMatches", () => {
  it("selects the event the agent parked on and rejects a sibling of the same kind", () => {
    expect(
      wakeIntentMatches(intent(), {
        workspace: WORKSPACE,
        kind: "scorecard.completed",
        message: "done",
        payload: { id: "sc1" },
      }),
    ).toBe(true);
    // Same kind, different scorecard — waking here would report on somebody else's batch.
    expect(
      wakeIntentMatches(intent(), {
        workspace: WORKSPACE,
        kind: "scorecard.completed",
        message: "done",
        payload: { id: "sc2" },
      }),
    ).toBe(false);
    // A kind the agent did not ask for.
    expect(
      wakeIntentMatches(intent(), {
        workspace: WORKSPACE,
        kind: "run.completed",
        message: "done",
        payload: { id: "sc1" },
      }),
    ).toBe(false);
  });
});

describe("buildWakeResumer.onEvent", () => {
  it("resumes the parked conversation and disarms its intent", async () => {
    const sessions = new InMemoryAgentSessionStore();
    await seed(sessions, "s1", intent());
    const { built, turns, revoked } = resumer(sessions);

    const resumed = await built.onEvent({
      workspace: WORKSPACE,
      kind: "scorecard.completed",
      message: "scorecard sc1 completed",
      payload: { id: "sc1" },
    });

    expect(resumed).toBe(1);
    expect(turns).toHaveLength(1);
    expect(turns[0]?.sessionId).toBe("s1");
    // The resumed turn is told what landed AND why it was waiting — the note is context the next turn needs.
    expect(turns[0]?.prompt).toContain("scorecard sc1 completed");
    expect(turns[0]?.prompt).toContain("watching scorecard sc1 to report its pass rate");
    // Disarmed: the conversation is no longer waiting unless the turn itself waits again.
    expect(await sessions.listWaitingSessions(WORKSPACE)).toHaveLength(0);
    // The one-shot execution credential does not outlive the turn.
    expect(revoked).toHaveLength(1);
  });

  it("leaves a conversation parked when the event is not the one it waits for", async () => {
    const sessions = new InMemoryAgentSessionStore();
    await seed(sessions, "s1", intent());
    const { built, turns } = resumer(sessions);

    const resumed = await built.onEvent({
      workspace: WORKSPACE,
      kind: "scorecard.completed",
      message: "a different batch finished",
      payload: { id: "sc2" },
    });

    expect(resumed).toBe(0);
    expect(turns).toHaveLength(0);
    expect(await sessions.listWaitingSessions(WORKSPACE)).toHaveLength(1);
  });

  it("resumes only once when two events for the same wait land back to back", async () => {
    const sessions = new InMemoryAgentSessionStore();
    await seed(sessions, "s1", intent());
    const { built, turns } = resumer(sessions);
    const event = {
      workspace: WORKSPACE,
      kind: "scorecard.completed" as const,
      message: "scorecard sc1 completed",
      payload: { id: "sc1" },
    };

    const [first, second] = [await built.onEvent(event), await built.onEvent(event)];

    // The intent is a one-shot claim: the second delivery finds nothing to claim.
    expect(first).toBe(1);
    expect(second).toBe(0);
    expect(turns).toHaveLength(1);
  });

  it("skips a conversation whose turn is already in flight, leaving it armed", async () => {
    const sessions = new InMemoryAgentSessionStore();
    await seed(sessions, "s1", intent());
    const { built, turns } = resumer(sessions, { isLive: true });

    const resumed = await built.onEvent({
      workspace: WORKSPACE,
      kind: "scorecard.completed",
      message: "scorecard sc1 completed",
      payload: { id: "sc1" },
    });

    expect(resumed).toBe(0);
    expect(turns).toHaveLength(0);
    // Still parked — the running turn will re-park or clear it, and the deadline sweep is the backstop.
    expect(await sessions.listWaitingSessions(WORKSPACE)).toHaveLength(1);
  });
});

describe("buildWakeResumer.sweep", () => {
  it("resumes a wait whose deadline passed with no event — silence must not strand a watcher", async () => {
    const sessions = new InMemoryAgentSessionStore();
    await seed(sessions, "s1", intent({ deadlineAt: "2026-08-03T12:00:00.000Z" }));
    await seed(sessions, "s2", intent({ deadlineAt: "2026-08-03T23:00:00.000Z" })); // not due yet
    const { built, turns } = resumer(sessions);

    const resumed = await built.sweep("2026-08-03T12:30:00.000Z");

    expect(resumed).toBe(1);
    expect(turns[0]?.sessionId).toBe("s1");
    // The deadline wake tells the agent nothing arrived, so it checks state instead of assuming an outcome.
    expect(turns[0]?.prompt).toContain("never reported in");
    const stillWaiting = await sessions.listWaitingSessions(WORKSPACE);
    expect(stillWaiting.map((s) => s.id)).toEqual(["s2"]);
  });
});
