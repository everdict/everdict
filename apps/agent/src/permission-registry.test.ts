import { describe, expect, it, vi } from "vitest";
import { PermissionRegistry } from "./permission-registry.js";

describe("PermissionRegistry", () => {
  it("resolves a parked request with the human's decision", async () => {
    const registry = new PermissionRegistry();
    const pending = registry.wait("req-1", "session-1");
    const answered = registry.respond("req-1", "session-1", "allow");
    expect(answered).toBe(true);
    await expect(pending).resolves.toBe("allow");
  });

  it("denies on abort so a disconnected client never leaves a write tool auto-approved", async () => {
    const registry = new PermissionRegistry();
    const controller = new AbortController();
    const pending = registry.wait("req-1", "session-1", controller.signal);
    controller.abort();
    await expect(pending).resolves.toBe("deny");
  });

  it("denies on timeout so an unanswered request never hangs the loop forever", async () => {
    vi.useFakeTimers();
    try {
      const registry = new PermissionRegistry(1000);
      const pending = registry.wait("req-1", "session-1");
      vi.advanceTimersByTime(1000);
      await expect(pending).resolves.toBe("deny");
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a decision for a different session so it cannot grief another conversation", async () => {
    const registry = new PermissionRegistry();
    const pending = registry.wait("req-1", "session-1");
    expect(registry.respond("req-1", "session-2", "allow")).toBe(false);
    // still pending — the wrong-session attempt did not resolve it
    expect(registry.respond("req-1", "session-1", "deny")).toBe(true);
    await expect(pending).resolves.toBe("deny");
  });

  it("returns false for an unknown or already-decided request id", async () => {
    const registry = new PermissionRegistry();
    expect(registry.respond("nope", "session-1", "allow")).toBe(false);
    const pending = registry.wait("req-1", "session-1");
    registry.respond("req-1", "session-1", "allow");
    expect(registry.respond("req-1", "session-1", "deny")).toBe(false);
    await expect(pending).resolves.toBe("allow");
  });

  it("pendingFor lists a session's parked asks (name + input) so a late-attaching watcher can render them", async () => {
    const registry = new PermissionRegistry();
    const pending = registry.wait("req-1", "session-1", undefined, {
      name: "retry_scorecard",
      input: { id: "sc-1" },
    });
    const other = registry.wait("req-2", "session-2", undefined, { name: "delete_dataset", input: {} });
    const listed = registry.pendingFor("session-1");
    expect(listed).toEqual([{ requestId: "req-1", name: "retry_scorecard", input: { id: "sc-1" } }]);
    registry.respond("req-1", "session-1", "allow");
    expect(registry.pendingFor("session-1")).toHaveLength(0); // resolved asks disappear
    registry.respond("req-2", "session-2", "deny");
    await expect(pending).resolves.toBe("allow");
    await expect(other).resolves.toBe("deny");
  });

  it("a per-wait timeout overrides the registry default (background turns park longer)", async () => {
    vi.useFakeTimers();
    try {
      const registry = new PermissionRegistry(1000);
      const long = registry.wait("req-1", "session-1", undefined, undefined, 5000);
      vi.advanceTimersByTime(1000); // the registry default would have denied by now
      expect(registry.pendingFor("session-1")).toHaveLength(1); // still parked
      vi.advanceTimersByTime(4000);
      await expect(long).resolves.toBe("deny"); // the longer window still denies on expiry
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("resolveWhere — mid-turn permission-mode relaxation", () => {
  it("resolves only the parked asks the predicate decides, leaving the rest parked", async () => {
    // Given two asks parked in one session (a routine write + a guarded one) and one in another session
    const registry = new PermissionRegistry(60_000);
    const routine = registry.wait("r-1", "s-1", undefined, { name: "create_dataset", input: {} });
    const guarded = registry.wait("r-2", "s-1", undefined, { name: "delete_harness", input: {} });
    const other = registry.wait("r-3", "s-2", undefined, { name: "create_dataset", input: {} });
    // When the session's mode relaxes to auto (allow non-guarded only)
    const resolved = registry.resolveWhere("s-1", (name) => (name === "create_dataset" ? "allow" : undefined));
    // Then the routine ask is allowed, the guarded one stays parked, the other session is untouched
    expect(resolved).toBe(1);
    await expect(routine).resolves.toBe("allow");
    expect(registry.pendingFor("s-1").map((p) => p.name)).toEqual(["delete_harness"]);
    expect(registry.pendingFor("s-2")).toHaveLength(1);
    // Clean up the still-parked asks so no timers leak past the test
    registry.respond("r-2", "s-1", "deny");
    registry.respond("r-3", "s-2", "deny");
    await expect(guarded).resolves.toBe("deny");
    await expect(other).resolves.toBe("deny");
  });
});
