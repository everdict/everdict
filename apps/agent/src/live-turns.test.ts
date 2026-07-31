import { describe, expect, it } from "vitest";
import { LiveTurnRegistry } from "./live-turns.js";

describe("LiveTurnRegistry", () => {
  it("begin claims the session slot once — a concurrent begin returns null (the 409 guard)", () => {
    const reg = new LiveTurnRegistry();
    const first = reg.begin("acme", "s1");
    expect(first).not.toBeNull();
    expect(reg.begin("acme", "s1")).toBeNull();
    // Another session and another workspace are independent slots.
    expect(reg.begin("acme", "s2")).not.toBeNull();
    expect(reg.begin("globex", "s1")).not.toBeNull();
    reg.end("acme", "s1");
    expect(reg.begin("acme", "s1")).not.toBeNull();
  });

  it("detaching a subscriber does not abort the turn — only stop() does", () => {
    const reg = new LiveTurnRegistry();
    const controller = reg.begin("acme", "s1");
    if (!controller) throw new Error("expected a claimed turn");
    const detach = reg.attach("acme", "s1", () => {});
    detach?.();
    expect(controller.signal.aborted).toBe(false);
    expect(reg.isLive("acme", "s1")).toBe(true);
    expect(reg.stop("acme", "s1")).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    // Nothing live → stop reports false (the route 404s).
    reg.end("acme", "s1");
    expect(reg.stop("acme", "s1")).toBe(false);
  });

  it("broadcast fans events to subscribers and accumulates the in-flight bubble for late attachers", () => {
    const reg = new LiveTurnRegistry();
    reg.begin("acme", "s1");
    const seen: [string, unknown][] = [];
    reg.attach("acme", "s1", (event, data) => seen.push([event, data]));
    reg.broadcast("acme", "s1", "reasoning", { text: "hmm " });
    reg.broadcast("acme", "s1", "delta", { text: "Hello" });
    reg.broadcast("acme", "s1", "delta", { text: ", world" });
    expect(seen.map(([e]) => e)).toEqual(["reasoning", "delta", "delta"]);
    expect(reg.snapshot("acme", "s1")).toMatchObject({ streamingText: "Hello, world", streamingReasoning: "hmm " });
  });

  it("a persisted assistant record retires the in-flight buffers (the web's own retire rule)", () => {
    const reg = new LiveTurnRegistry();
    reg.begin("acme", "s1");
    reg.broadcast("acme", "s1", "reasoning", { text: "thinking" });
    reg.broadcast("acme", "s1", "delta", { text: "partial" });
    // A tool-only assistant record (empty content) retires reasoning but keeps the text bubble growing.
    reg.broadcast("acme", "s1", "message", { role: "assistant", content: "" });
    expect(reg.snapshot("acme", "s1")).toMatchObject({ streamingText: "partial", streamingReasoning: "" });
    // The finalized answer record retires the text bubble too.
    reg.broadcast("acme", "s1", "message", { role: "assistant", content: "final answer" });
    expect(reg.snapshot("acme", "s1")).toMatchObject({ streamingText: "", streamingReasoning: "" });
  });

  it("a plan ask parks in the snapshot until the loop reports it presented (re-attach replay)", () => {
    const reg = new LiveTurnRegistry();
    reg.begin("acme", "s1");
    reg.broadcast("acme", "s1", "plan", { requestId: "r1", plan: "1. do the thing" });
    expect(reg.snapshot("acme", "s1")?.pendingPlan).toEqual({ requestId: "r1", plan: "1. do the thing" });
    reg.broadcast("acme", "s1", "plan_presented", { plan: "1. do the thing" });
    expect(reg.snapshot("acme", "s1")?.pendingPlan).toBeUndefined();
  });

  it("a throwing subscriber is dropped without breaking the fan-out for the rest", () => {
    const reg = new LiveTurnRegistry();
    reg.begin("acme", "s1");
    let healthySeen = 0;
    reg.attach("acme", "s1", () => {
      throw new Error("dead socket");
    });
    reg.attach("acme", "s1", () => {
      healthySeen += 1;
    });
    reg.broadcast("acme", "s1", "delta", { text: "a" });
    reg.broadcast("acme", "s1", "delta", { text: "b" });
    expect(healthySeen).toBe(2);
  });

  it("parks an in-progress retry wait for late attachers and clears it on the next progress event", () => {
    const reg = new LiveTurnRegistry();
    reg.begin("acme", "s1");
    // Given the loop is backing off a transient model failure
    reg.broadcast("acme", "s1", "retry", { attempt: 2, delayMs: 4000, persistent: true });
    // Then a late attacher's snapshot replays the wait (it would otherwise see a frozen, silent turn)
    expect(reg.snapshot("acme", "s1")).toMatchObject({
      pendingRetry: { attempt: 2, delayMs: 4000, persistent: true },
    });
    // A newer attempt supersedes the parked one
    reg.broadcast("acme", "s1", "retry", { attempt: 3, delayMs: 8000 });
    expect(reg.snapshot("acme", "s1")?.pendingRetry).toEqual({ attempt: 3, delayMs: 8000 });
    // When the model call finally makes progress, the wait is over — no stale banner for attachers
    reg.broadcast("acme", "s1", "delta", { text: "recovered" });
    expect(reg.snapshot("acme", "s1")?.pendingRetry).toBeUndefined();
  });

  it("interrupt fires the parked step trigger without aborting the turn — stop() stays the whole-turn abort", () => {
    const reg = new LiveTurnRegistry();
    const controller = reg.begin("acme", "s1");
    if (!controller) throw new Error("expected a claimed turn");
    // Before the loop parks its trigger, interrupt reports false (the route answers honestly, not pretending)
    // and hasInterrupt says so WITHOUT firing — the atomic redirect checks it before queueing the message.
    expect(reg.hasInterrupt("acme", "s1")).toBe(false);
    expect(reg.interrupt("acme", "s1")).toBe(false);
    let fired = 0;
    reg.setInterrupt("acme", "s1", () => {
      fired += 1;
    });
    // When the soft interrupt fires, Then only the step trigger runs — the turn's own controller stays alive.
    expect(reg.hasInterrupt("acme", "s1")).toBe(true);
    expect(reg.interrupt("acme", "s1")).toBe(true);
    expect(fired).toBe(1);
    expect(controller.signal.aborted).toBe(false);
    expect(reg.isLive("acme", "s1")).toBe(true);
    // Unknown sessions report false.
    expect(reg.interrupt("acme", "missing")).toBe(false);
  });

  it("snapshot and attach report nothing for a session with no live turn (the 204 path)", () => {
    const reg = new LiveTurnRegistry();
    expect(reg.snapshot("acme", "missing")).toBeNull();
    expect(reg.attach("acme", "missing", () => {})).toBeNull();
    expect(reg.isLive("acme", "missing")).toBe(false);
  });
});
