import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../messages.js";
import { compactMessages, microcompact, summarizeAndCompact } from "./compaction.js";

const big = (n = 600): string => "R".repeat(n);

// A transcript: goal + 6×(assistant tool_call, tool BIG result), no trailing user. Length 13, recentKeep 8 → cutoff 5,
// so tool messages at idx 2 and 4 are "old" (big → clearable); tools at idx 6,8,10,12 are recent (kept).
function transcript(): ChatMessage[] {
  const m: ChatMessage[] = [{ role: "user", content: "goal" }];
  for (let i = 0; i < 6; i++) {
    m.push({
      role: "assistant",
      content: null,
      tool_calls: [{ id: `c${i}`, type: "function", function: { name: "t", arguments: "{}" } }],
    });
    m.push({ role: "tool", tool_call_id: `c${i}`, content: big() });
  }
  return m;
}

describe("microcompact", () => {
  it("clears old tool-result bodies while preserving role + tool_call_id, and leaves recent ones intact", () => {
    const { messages, cleared } = microcompact(transcript());
    expect(cleared).toBe(2); // idx 2 (c0) and idx 4 (c1)
    // Cleared: shorter, marked, but still a tool message paired by id.
    for (const i of [2, 4]) {
      const m = messages[i] as { role: string; tool_call_id: string; content: string };
      expect(m.role).toBe("tool");
      expect(m.tool_call_id).toBe(`c${(i - 2) / 2}`);
      expect(m.content.length).toBeLessThan(600);
      expect(m.content).toContain("elided");
    }
    // Recent tool result is untouched.
    expect((messages[6] as { content: string }).content).toBe(big());
  });

  it("is a no-op (cleared 0) when nothing old is eligible, and is idempotent", () => {
    const short: ChatMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "ok" },
    ];
    expect(microcompact(short).cleared).toBe(0);
    // Second pass over an already-cleared transcript clears nothing new.
    const once = microcompact(transcript()).messages;
    expect(microcompact(once).cleared).toBe(0);
  });

  it("keeps loaded-skill payloads (use_skill / read_skill_file results) that ordinary results would lose", () => {
    const m = transcript();
    // Rebrand the two OLD calls as skill loads: c0 = use_skill, c1 = read_skill_file.
    const skillNames = ["use_skill", "read_skill_file"];
    for (const [k, name] of skillNames.entries()) {
      m[1 + 2 * k] = {
        role: "assistant",
        content: null,
        tool_calls: [{ id: `c${k}`, type: "function", function: { name, arguments: "{}" } }],
      };
    }
    const { messages, cleared } = microcompact(m);
    expect(cleared).toBe(0); // both old results were skill payloads — survived
    expect((messages[2] as { content: string }).content).toBe(big());
    expect((messages[4] as { content: string }).content).toBe(big());
  });

  it("clears the OLDEST skill payloads first once they exceed the keep budget", () => {
    const m: ChatMessage[] = [{ role: "user", content: "goal" }];
    // 3 old use_skill loads of 10k each (30k > the 24k budget) + filler turns pushing them past the recent window.
    for (let i = 0; i < 3; i++) {
      m.push({
        role: "assistant",
        content: null,
        tool_calls: [{ id: `s${i}`, type: "function", function: { name: "use_skill", arguments: "{}" } }],
      });
      m.push({ role: "tool", tool_call_id: `s${i}`, content: `# Skill: s${i}\n${"B".repeat(10_000)}` });
    }
    for (let i = 0; i < 9; i++) m.push({ role: "assistant", content: `filler ${i}` });
    const { messages, cleared } = microcompact(m);
    expect(cleared).toBe(1); // only the oldest fell out of the 24k budget
    expect((messages[2] as { content: string }).content).toContain("elided");
    expect((messages[4] as { content: string }).content).toContain("# Skill: s1");
    expect((messages[6] as { content: string }).content).toContain("# Skill: s2");
  });
});

describe("summarizeAndCompact", () => {
  const conv: ChatMessage[] = [
    { role: "user", content: "goal" },
    { role: "assistant", content: "a1" },
    { role: "assistant", content: "a2" },
    { role: "assistant", content: "a3" },
    { role: "user", content: "continue" },
    { role: "assistant", content: "a4" },
  ];

  it("replaces the old span with a digest and keeps the tail from a clean user boundary", async () => {
    const summarize = vi.fn(async (span: ChatMessage[]) => `DIGEST(${span.length})`);
    const out = await summarizeAndCompact(conv, summarize, 2); // recentKeep 2 → boundary search in [4,5] → user at idx 4
    expect(summarize).toHaveBeenCalledOnce();
    expect(summarize.mock.calls[0]?.[0]).toHaveLength(4); // old span = idx 0..3
    expect(out).toHaveLength(3); // [summary, user "continue", assistant a4]
    expect(out[0]?.role).toBe("user");
    expect(out[0]?.content).toContain("DIGEST(4)");
    expect((out[1] as { content: string }).content).toBe("continue");
  });

  it("returns the input unchanged when there is no safe user boundary in the recent window", async () => {
    const noBoundary: ChatMessage[] = [
      { role: "user", content: "goal" },
      { role: "assistant", content: "a1" },
      { role: "assistant", content: "a2" },
    ];
    const summarize = vi.fn(async () => "unused");
    expect(await summarizeAndCompact(noBoundary, summarize, 2)).toBe(noBoundary);
    expect(summarize).not.toHaveBeenCalled();
  });

  it("does not drop context when the summariser yields an empty digest", async () => {
    const out = await summarizeAndCompact(conv, async () => "   ", 2);
    expect(out).toBe(conv);
  });
});

describe("compactMessages (structural fallback)", () => {
  it("drops the oldest turns to a clean user boundary", () => {
    const m: ChatMessage[] = [
      { role: "user", content: "u0" },
      { role: "assistant", content: "a0" },
      ...Array.from({ length: 8 }, (_, i): ChatMessage => ({ role: "assistant", content: `x${i}` })),
      { role: "user", content: "u1" },
    ];
    // len 11, recentKeep 8 → dropUpTo 3; first user in [3..] is u1 at idx 10 → slice from 10.
    const out = compactMessages(m);
    expect(out).toHaveLength(1);
    expect(out[0]?.content).toBe("u1");
  });
});
