import { describe, expect, it } from "vitest";
import { InputQueue } from "./input-queue.js";

describe("InputQueue", () => {
  it("queues a user message and drains it once (FIFO, then empty)", () => {
    const q = new InputQueue();
    q.enqueue("acme", "s1", "first");
    q.enqueue("acme", "s1", "second");
    const drained = q.drain("acme", "s1");
    expect(drained.map((m) => m.content)).toEqual(["first", "second"]);
    expect(drained.every((m) => m.role === "user")).toBe(true);
    // A second drain is empty — messages are consumed, not replayed.
    expect(q.drain("acme", "s1")).toEqual([]);
  });

  it("isolates queues by workspace and session", () => {
    const q = new InputQueue();
    q.enqueue("acme", "s1", "acme-s1");
    q.enqueue("acme", "s2", "acme-s2");
    q.enqueue("other", "s1", "other-s1");
    expect(q.drain("acme", "s1").map((m) => m.content)).toEqual(["acme-s1"]);
    expect(q.drain("acme", "s2").map((m) => m.content)).toEqual(["acme-s2"]);
    expect(q.drain("other", "s1").map((m) => m.content)).toEqual(["other-s1"]);
  });

  it("drains empty for a session with nothing queued", () => {
    const q = new InputQueue();
    expect(q.drain("acme", "unknown")).toEqual([]);
  });
});
