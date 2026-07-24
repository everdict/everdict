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
