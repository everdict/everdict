import type { AgentMessageRecord, AgentSessionRecord } from "@everdict/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { InMemoryAgentSessionStore } from "./agent-session-store.js";

function session(over: Partial<AgentSessionRecord>): AgentSessionRecord {
  return {
    id: "s1",
    tenant: "acme",
    owner: "alice",
    title: "Untitled",
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

function message(over: Partial<AgentMessageRecord>): AgentMessageRecord {
  return {
    id: "m1",
    tenant: "acme",
    sessionId: "s1",
    seq: 0,
    role: "user",
    content: "hi",
    createdAt: "2026-07-01T00:00:00.000Z",
    ...over,
  };
}

describe("InMemoryAgentSessionStore", () => {
  let store: InMemoryAgentSessionStore;
  beforeEach(() => {
    store = new InMemoryAgentSessionStore();
  });

  it("lists only the owner's own sessions, newest first", async () => {
    await store.createSession(session({ id: "a", owner: "alice", updatedAt: "2026-07-01T00:00:00.000Z" }));
    await store.createSession(session({ id: "b", owner: "alice", updatedAt: "2026-07-03T00:00:00.000Z" }));
    await store.createSession(session({ id: "c", owner: "bob", updatedAt: "2026-07-05T00:00:00.000Z" }));

    const alice = await store.listSessions("acme", "alice");
    expect(alice.map((s) => s.id)).toEqual(["b", "a"]);
    // bob's session is invisible to alice even though it is newer
    expect(alice.some((s) => s.id === "c")).toBe(false);
  });

  it("does not return another workspace's session on get", async () => {
    await store.createSession(session({ id: "a", tenant: "acme", owner: "alice" }));
    expect(await store.getSession("other", "alice", "a")).toBeUndefined();
    expect(await store.getSession("acme", "bob", "a")).toBeUndefined();
    expect(await store.getSession("acme", "alice", "a")).toBeDefined();
  });

  it("getVisibleSession returns a workspace-visible session to any member but keeps private ones owner-only", async () => {
    await store.createSession(session({ id: "shared", owner: "alice", visibility: "workspace" }));
    await store.createSession(session({ id: "personal", owner: "alice" }));
    // another member sees the workspace-visible session, not the private one
    expect((await store.getVisibleSession("acme", "bob", "shared"))?.id).toBe("shared");
    expect(await store.getVisibleSession("acme", "bob", "personal")).toBeUndefined();
    // the owner path behaves like getSession
    expect((await store.getVisibleSession("acme", "alice", "personal"))?.id).toBe("personal");
    // another workspace never sees it
    expect(await store.getVisibleSession("other", "bob", "shared")).toBeUndefined();
  });

  it("touchSession bumps updatedAt and can set the title", async () => {
    await store.createSession(session({ id: "a", title: "Untitled" }));
    await store.touchSession("acme", "a", "2026-07-09T00:00:00.000Z", "Summarize failures");
    const s = await store.getSession("acme", "alice", "a");
    expect(s?.updatedAt).toBe("2026-07-09T00:00:00.000Z");
    expect(s?.title).toBe("Summarize failures");
  });

  it("setSessionModel pins the conversation's model and clearing it removes the override", async () => {
    await store.createSession(session({ id: "a", owner: "alice" }));
    await store.setSessionModel("acme", "a", "gpt-5-mini", "2026-07-10T00:00:00.000Z");
    let s = await store.getSession("acme", "alice", "a");
    expect(s?.model).toBe("gpt-5-mini");
    expect(s?.updatedAt).toBe("2026-07-10T00:00:00.000Z");
    // null clears the override → falls back to the workspace/server default
    await store.setSessionModel("acme", "a", null, "2026-07-11T00:00:00.000Z");
    s = await store.getSession("acme", "alice", "a");
    expect(s?.model).toBeUndefined();
    expect(s?.updatedAt).toBe("2026-07-11T00:00:00.000Z");
  });

  it("persists the model chosen at session creation", async () => {
    await store.createSession(session({ id: "a", owner: "alice", model: "claude-sonnet" }));
    const s = await store.getSession("acme", "alice", "a");
    expect(s?.model).toBe("claude-sonnet");
  });

  it("setSessionPermissionMode sets the standing mode and clearing it falls back to default (ask)", async () => {
    await store.createSession(session({ id: "a", owner: "alice" }));
    await store.setSessionPermissionMode("acme", "a", "auto", "2026-07-27T00:00:00.000Z");
    let s = await store.getSession("acme", "alice", "a");
    expect(s?.permissionMode).toBe("auto");
    expect(s?.updatedAt).toBe("2026-07-27T00:00:00.000Z");
    // null clears the standing mode → "default" (ask for every mutation)
    await store.setSessionPermissionMode("acme", "a", null, "2026-07-28T00:00:00.000Z");
    s = await store.getSession("acme", "alice", "a");
    expect(s?.permissionMode).toBeUndefined();
    expect(s?.updatedAt).toBe("2026-07-28T00:00:00.000Z");
  });

  it("returns messages seq-ascending and honors sinceSeq for polling", async () => {
    await store.appendMessages([
      message({ id: "m0", seq: 0, role: "user", content: "hi" }),
      message({ id: "m1", seq: 1, role: "assistant", content: "hello" }),
      message({ id: "m2", seq: 2, role: "user", content: "more" }),
    ]);
    const all = await store.listMessages("acme", "s1");
    expect(all.map((m) => m.seq)).toEqual([0, 1, 2]);
    const since = await store.listMessages("acme", "s1", 1);
    expect(since.map((m) => m.id)).toEqual(["m2"]);
  });

  it("round-trips an assistant turn's reasoning text", async () => {
    await store.appendMessages([
      message({ id: "m0", seq: 0, role: "assistant", content: "Answer", reasoning: "First I weighed the options." }),
    ]);
    const [m] = await store.listMessages("acme", "s1");
    expect(m?.reasoning).toBe("First I weighed the options.");
  });

  it("deleteSession removes the session and its transcript together", async () => {
    await store.createSession(session({ id: "s1", owner: "alice" }));
    await store.appendMessages([message({ id: "m0", sessionId: "s1", seq: 0 })]);
    await store.deleteSession("acme", "alice", "s1");
    expect(await store.getSession("acme", "alice", "s1")).toBeUndefined();
    expect(await store.listMessages("acme", "s1")).toHaveLength(0);
  });

  it("does not delete a session owned by someone else", async () => {
    await store.createSession(session({ id: "s1", owner: "alice" }));
    await store.deleteSession("acme", "bob", "s1");
    expect(await store.getSession("acme", "alice", "s1")).toBeDefined();
  });
});

describe("session running memory", () => {
  it("setSessionMemory persists the digest + covered seq and only ever rolls forward on later folds", async () => {
    const store = new InMemoryAgentSessionStore();
    await store.createSession(session({ id: "s1", owner: "alice" }));
    await store.setSessionMemory("acme", "s1", "digest v1", 9, "2026-07-31T01:00:00.000Z");
    let s = await store.getSession("acme", "alice", "s1");
    expect(s?.memory).toBe("digest v1");
    expect(s?.memoryThroughSeq).toBe(9);
    expect(s?.updatedAt).toBe("2026-07-31T01:00:00.000Z");
    // A later fold replaces the digest and advances the covered seq.
    await store.setSessionMemory("acme", "s1", "digest v2", 24, "2026-07-31T02:00:00.000Z");
    s = await store.getSession("acme", "alice", "s1");
    expect(s?.memory).toBe("digest v2");
    expect(s?.memoryThroughSeq).toBe(24);
  });
});

describe("orphaned-run reaping (LESSON 059 P0 crash reconcile)", () => {
  const BOOT = "2026-08-07T12:00:00.000Z";
  let store: InMemoryAgentSessionStore;
  beforeEach(() => {
    store = new InMemoryAgentSessionStore();
  });

  it("lists only runs stranded in 'running' from BEFORE the boot instant, oldest first", async () => {
    await store.createSession(session({ id: "old", status: "running", updatedAt: "2026-08-07T11:00:00.000Z" }));
    await store.createSession(session({ id: "older", status: "running", updatedAt: "2026-08-07T10:00:00.000Z" }));
    // fresh = owned by the live process; parked = the durable approval path owns it; settled = already handled
    await store.createSession(session({ id: "fresh", status: "running", updatedAt: "2026-08-07T12:30:00.000Z" }));
    await store.createSession(
      session({ id: "parked", status: "awaiting_approval", updatedAt: "2026-08-07T11:00:00.000Z" }),
    );
    await store.createSession(session({ id: "settled", status: "completed", updatedAt: "2026-08-07T11:00:00.000Z" }));

    const orphans = await store.listOrphanedRuns(BOOT);
    expect(orphans.map((s) => s.id)).toEqual(["older", "old"]);
  });

  it("claimOrphanedRun settles a stranded run exactly once and refuses fresh or already-settled runs", async () => {
    await store.createSession(session({ id: "orphan", status: "running", updatedAt: "2026-08-07T11:00:00.000Z" }));
    await store.createSession(session({ id: "fresh", status: "running", updatedAt: "2026-08-07T12:30:00.000Z" }));

    // The first claim wins and settles the row as failed (the fail-closed baseline before any resume).
    expect(await store.claimOrphanedRun("acme", "orphan", BOOT, "2026-08-07T12:00:01.000Z")).toBe(true);
    expect((await store.getSession("acme", "alice", "orphan"))?.status).toBe("failed");
    // A second claimer loses — concurrent sweepers settle it exactly once.
    expect(await store.claimOrphanedRun("acme", "orphan", BOOT, "2026-08-07T12:00:02.000Z")).toBe(false);
    // A run the live process owns (updatedAt after boot) can never be claimed.
    expect(await store.claimOrphanedRun("acme", "fresh", BOOT, "2026-08-07T12:00:03.000Z")).toBe(false);
    expect((await store.getSession("acme", "alice", "fresh"))?.status).toBe("running");
  });
});
