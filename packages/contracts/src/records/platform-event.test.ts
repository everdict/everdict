import { describe, expect, it } from "vitest";
import { AGENT_RUN_EVENT_KIND_ALIASES, PLATFORM_EVENT_KINDS, canonicalEventKind } from "./platform-event.js";

describe("platform-event kind grammar (E0 alias)", () => {
  it("aliases the WHOLE agent.run.* family to the run.* spelling, verb preserved", () => {
    const agentRunKinds = PLATFORM_EVENT_KINDS.filter((k) => k.startsWith("agent.run."));
    expect(agentRunKinds.length).toBeGreaterThan(0);
    for (const kind of agentRunKinds) {
      const canonical = canonicalEventKind(kind);
      expect(canonical).toBe(kind.replace(/^agent\./, "")); // agent.run.<verb> → run.<verb>
      expect(canonical).toBe(AGENT_RUN_EVENT_KIND_ALIASES[kind as keyof typeof AGENT_RUN_EVENT_KIND_ALIASES]);
    }
  });

  it("passes every non-agent kind through unchanged", () => {
    for (const kind of PLATFORM_EVENT_KINDS.filter((k) => !k.startsWith("agent.run."))) {
      expect(canonicalEventKind(kind)).toBe(kind);
    }
  });

  it("keeps the family OUT of the closed vocabulary's run.* members (the emit side flips at P3, not here)", () => {
    // The aliased spellings that don't exist yet (run.started/awaiting_approval/cancelled) must not have
    // leaked into the closed enum — adding them without an emit point would violate the vocabulary rule.
    const kinds: readonly string[] = PLATFORM_EVENT_KINDS;
    expect(kinds).not.toContain("run.started");
    expect(kinds).not.toContain("run.awaiting_approval");
    expect(kinds).not.toContain("run.cancelled");
  });
});
