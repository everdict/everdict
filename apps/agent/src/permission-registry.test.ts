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
});
