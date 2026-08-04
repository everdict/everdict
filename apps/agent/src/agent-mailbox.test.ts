import { describe, expect, it } from "vitest";
import { AgentMailbox, renderEnvelope } from "./agent-mailbox.js";

describe("AgentMailbox", () => {
  it("queues a user message and drains it verbatim (FIFO, then empty)", () => {
    const m = new AgentMailbox();
    m.enqueueUser("acme", "s1", "first");
    m.enqueueUser("acme", "s1", "second");
    const drained = m.drain("acme", "s1");
    expect(drained.map((x) => x.content)).toEqual(["first", "second"]);
    expect(drained.every((x) => x.role === "user")).toBe(true);
    expect(m.drain("acme", "s1")).toEqual([]);
  });

  it("renders attribution by source — teammate and event messages are labelled", () => {
    const m = new AgentMailbox();
    m.enqueueUser("acme", "s1", "do X");
    m.enqueue("acme", "s1", { from: "agent", sender: "researcher", content: "found the regression" });
    m.enqueue("acme", "s1", { from: "event", sender: "scorecard sc_123", content: "completed with 2 failures" });
    const drained = m.drain("acme", "s1");
    expect(drained[0]?.content).toBe("do X");
    expect(drained[1]?.content).toContain("[Message from teammate researcher]");
    expect(drained[1]?.content).toContain("found the regression");
    expect(drained[2]?.content).toContain("[Everdict event — scorecard sc_123]");
  });

  it("renders an event with no sender and a teammate with no name gracefully", () => {
    expect(renderEnvelope({ from: "event", content: "queue backed up" }).content).toBe(
      "[Everdict event]\nqueue backed up",
    );
    expect(renderEnvelope({ from: "agent", content: "hi" }).content).toContain("[Message from teammate another agent]");
  });

  it("clear takes the undrained envelopes so a stopped turn cannot leak them into a later one", () => {
    // Given: a redirect queued into a turn the member then stops before the loop reaches its next boundary.
    const m = new AgentMailbox();
    m.enqueueUser("acme", "s1", "actually, check the other dataset");
    m.enqueue("acme", "s1", { from: "event", sender: "scorecard sc_1", content: "completed" });

    // When: the stop clears the mailbox.
    const dropped = m.clear("acme", "s1");

    // Then: the caller gets the envelopes back (so the member's own words can return to the composer) and the
    // NEXT turn drains nothing — an undrained message would otherwise prepend itself to an unrelated answer.
    expect(dropped.map((e) => e.content)).toEqual(["actually, check the other dataset", "completed"]);
    expect(dropped[0]?.from).toBe("user");
    expect(m.drain("acme", "s1")).toEqual([]);
  });

  it("isolates mailboxes by workspace and session", () => {
    const m = new AgentMailbox();
    m.enqueueUser("acme", "s1", "acme-s1");
    m.enqueueUser("acme", "s2", "acme-s2");
    m.enqueueUser("other", "s1", "other-s1");
    expect(m.drain("acme", "s1").map((x) => x.content)).toEqual(["acme-s1"]);
    expect(m.drain("acme", "s2").map((x) => x.content)).toEqual(["acme-s2"]);
    expect(m.drain("other", "s1").map((x) => x.content)).toEqual(["other-s1"]);
  });
});
