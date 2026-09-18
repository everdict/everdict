import type { AgentSessionStore } from "@everdict/application-control";
import { InMemoryAgentSessionStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { AgentMailbox, mailboxDrainInput, renderEnvelope } from "./agent-mailbox.js";

const at = () => new Date().toISOString();
const mailboxOver = (store: InMemoryAgentSessionStore) => new AgentMailbox(store, at);
const fresh = () => mailboxOver(new InMemoryAgentSessionStore());

// The drain's value, or a failure that names which case came back instead — so a test can never assert
// `[]` against a read that did not happen.
async function drained(mailbox: AgentMailbox, workspace: string, sessionId: string): Promise<string[]> {
  const result = await mailbox.drain(workspace, sessionId);
  if (result.kind !== "read") throw new Error(`expected a drained mailbox, got ${result.kind}`);
  return result.value.map((message) => (typeof message.content === "string" ? message.content : ""));
}

describe("AgentMailbox", () => {
  it("queues a user message and drains it verbatim (FIFO, then empty)", async () => {
    const m = fresh();
    await m.enqueueUser("acme", "s1", "first");
    await m.enqueueUser("acme", "s1", "second");
    expect(await drained(m, "acme", "s1")).toEqual(["first", "second"]);
    expect(await drained(m, "acme", "s1")).toEqual([]);
  });

  it("renders attribution by source — teammate and event messages are labelled", async () => {
    const m = fresh();
    await m.enqueueUser("acme", "s1", "do X");
    await m.enqueue("acme", "s1", { from: "agent", sender: "researcher", content: "found the regression" });
    await m.enqueue("acme", "s1", { from: "event", sender: "scorecard sc_123", content: "completed with 2 failures" });
    const messages = await drained(m, "acme", "s1");
    expect(messages[0]).toBe("do X");
    expect(messages[1]).toContain("[Message from teammate researcher]");
    expect(messages[1]).toContain("found the regression");
    expect(messages[2]).toContain("[Everdict event — scorecard sc_123]");
  });

  it("renders an event with no sender and a teammate with no name gracefully", () => {
    expect(renderEnvelope({ from: "event", content: "queue backed up" }).content).toBe(
      "[Everdict event]\nqueue backed up",
    );
    expect(renderEnvelope({ from: "agent", content: "hi" }).content).toContain("[Message from teammate another agent]");
  });

  it("clear takes the undrained envelopes so a stopped turn cannot leak them into a later one", async () => {
    // Given: a redirect queued into a turn the member then stops before the loop reaches its next boundary.
    const m = fresh();
    await m.enqueueUser("acme", "s1", "actually, check the other dataset");
    await m.enqueue("acme", "s1", { from: "event", sender: "scorecard sc_1", content: "completed" });

    // When: the stop clears the mailbox.
    const dropped = await m.clear("acme", "s1");

    // Then: the caller gets the envelopes back (so the member's own words can return to the composer) and the
    // NEXT turn drains nothing — an undrained message would otherwise prepend itself to an unrelated answer.
    if (dropped.kind !== "read") throw new Error(`expected the clear to read, got ${dropped.kind}`);
    expect(dropped.value.map((e) => e.content)).toEqual(["actually, check the other dataset", "completed"]);
    expect(dropped.value[0]?.from).toBe("user");
    expect(await drained(m, "acme", "s1")).toEqual([]);
  });

  it("isolates mailboxes by workspace and session", async () => {
    const m = fresh();
    await m.enqueueUser("acme", "s1", "acme-s1");
    await m.enqueueUser("acme", "s2", "acme-s2");
    await m.enqueueUser("other", "s1", "other-s1");
    expect(await drained(m, "acme", "s1")).toEqual(["acme-s1"]);
    expect(await drained(m, "acme", "s2")).toEqual(["acme-s2"]);
    expect(await drained(m, "other", "s1")).toEqual(["other-s1"]);
  });

  // ── THE COUNTEREXAMPLE FOR DEFAUL-37 ───────────────────────────────────────────────────────────────
  //
  // The issue's own disproof: "Send a steering message, restart the agent service before it is drained, and
  // have the worker receive it. If the message is gone, or arrives out of order relative to one sent after
  // it, this is not done."
  //
  // A restart is modelled as a SECOND AgentMailbox over the same store, which is exactly what the process
  // does on boot — the store is the durable half, the mailbox object is the volatile one. Seen RED on the
  // pre-change substrate (a `Map` per instance) with: "expected [] to deeply equal [ 'do X', 'then Y' ]" —
  // the message is gone, which is the invariant this test pins.
  it("a message queued before a restart is delivered after it, in the order it was sent", async () => {
    const store = new InMemoryAgentSessionStore();

    // Given: a supervisor steers a running teammate twice, holding the first receipt before sending the
    // second — which is what makes "do X, then Y" an ordering guarantee rather than a race.
    const before = mailboxOver(store);
    const first = await before.enqueueUser("acme", "tm1", "do X");
    const second = await before.enqueueUser("acme", "tm1", "then Y");
    expect(second.seq).toBeGreaterThan(first.seq);

    // When: the agent service restarts before the turn reaches a boundary. Nothing re-sends.
    const after = mailboxOver(store);

    // Then: the worker receives both, in order.
    expect(await drained(after, "acme", "tm1")).toEqual(["do X", "then Y"]);
    // And the boot read is what would have WOKEN it — durability nobody reads is a table.
    expect(await after.queuedSessions()).toEqual([]);
  });

  it("the boot read names the sessions that came back holding unread instructions", async () => {
    const store = new InMemoryAgentSessionStore();
    const before = mailboxOver(store);
    await before.enqueueUser("acme", "tm1", "do X");
    await before.enqueue("acme", "tm1", { from: "event", sender: "sc_1", content: "regressed" });
    await before.enqueueUser("other", "tm9", "unrelated workspace");
    // A session whose instruction WAS delivered is not waiting for anything.
    await before.enqueueUser("acme", "tm2", "already absorbed");
    await before.drain("acme", "tm2");

    const queued = await mailboxOver(store).queuedSessions();
    expect(queued).toHaveLength(2);
    expect(queued).toContainEqual({ tenant: "acme", sessionId: "tm1", queued: 2 });
    expect(queued).toContainEqual({ tenant: "other", sessionId: "tm9", queued: 1 });
  });

  it("a claimed message is taken exactly once — two drains racing a boundary cannot both absorb it", async () => {
    const store = new InMemoryAgentSessionStore();
    const m = mailboxOver(store);
    await m.enqueueUser("acme", "s1", "only once");
    const [a, b] = await Promise.all([m.drain("acme", "s1"), m.drain("acme", "s1")]);
    if (a.kind !== "read" || b.kind !== "read") throw new Error("both drains must read");
    expect(a.value.length + b.value.length).toBe(1);
  });

  // ── AN UNREADABLE LOG IS NOT AN EMPTY ONE (protocol L2) ────────────────────────────────────────────
  describe("when the steering log cannot be read", () => {
    const unreadable = (): AgentMailbox => {
      const store: Pick<AgentSessionStore, "appendInbox" | "claimInbox" | "discardInbox" | "listQueuedInboxSessions"> =
        {
          appendInbox: async () => {
            throw new Error("connection terminated unexpectedly");
          },
          claimInbox: async () => {
            throw new Error("connection terminated unexpectedly");
          },
          discardInbox: async () => {
            throw new Error("connection terminated unexpectedly");
          },
          listQueuedInboxSessions: async () => {
            throw new Error("connection terminated unexpectedly");
          },
        };
      return new AgentMailbox(store, at);
    };

    it("the drain answers `unknown` rather than an empty mailbox", async () => {
      const result = await unreadable().drain("acme", "s1");
      expect(result.kind).toBe("unknown");
      // The reason is an operator diagnostic, never control — but it must say which read failed.
      if (result.kind === "unknown") expect(result.reason).toContain("draining the steering log");
    });

    it("the drainInput seam aborts the turn instead of reporting silence", async () => {
      const aborted: string[] = [];
      const seam = mailboxDrainInput(unreadable(), "acme", "s1", (reason) => aborted.push(reason));
      expect(await seam()).toEqual([]);
      // The abort is the whole point: an agent that cannot hear its supervisor must stop, not continue on the
      // last thing it heard. An empty return with NO abort is the defect this pins.
      expect(aborted).toHaveLength(1);
      expect(aborted[0]).toContain("draining the steering log");
    });

    it("an enqueue that could not be stored refuses rather than reporting the message queued", async () => {
      await expect(unreadable().enqueueUser("acme", "s1", "do X")).rejects.toThrow(/connection terminated/);
    });
  });
});
