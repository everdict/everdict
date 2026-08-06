import { describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../messages.js";
import { capMedia, compactMessages, compactStep, microcompact, summarizeAndCompact } from "./compaction.js";

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

describe("microcompact — stale images", () => {
  const shotTurn = (n: number): ChatMessage => ({
    role: "user",
    content: [
      { type: "text", text: "The tool call(s) above returned 1 image(s):" },
      { type: "image_url", image_url: { url: `data:image/png;base64,SHOT${n}` } },
    ],
  });

  it("clears images older than the recent window, keeping the newest ones intact", () => {
    // Given a screenshot-driven run: 12 image turns, of which only the last few are what the agent is acting on
    const messages = Array.from({ length: 12 }, (_, i) => shotTurn(i));
    // When rung 1 runs with a keep-window of 4
    const { messages: out, cleared } = microcompact(messages, 4);
    // Then the old screenshots' bytes are gone from the run's own history — not just from one request
    expect(cleared).toBe(8);
    const remaining = out.flatMap((m) =>
      (m.content as { image_url?: { url?: string } }[]).filter((p) => p.image_url).map((p) => p.image_url?.url),
    );
    expect(remaining).toEqual([
      "data:image/png;base64,SHOT8",
      "data:image/png;base64,SHOT9",
      "data:image/png;base64,SHOT10",
      "data:image/png;base64,SHOT11",
    ]);
    // …and each cleared one says how to get it back, so the model does not reason from an image it can no longer see
    const first = out[0]?.content as { type: string; text?: string }[];
    expect(first[1]?.text).toContain("take a fresh one");
    expect(first[0]?.text).toContain("returned 1 image(s)"); // surrounding text untouched
  });

  it("counts cleared images as reclaimed work, so the ladder stops at rung 1", async () => {
    // Given a context whose only bulk is old images (every tool result is small)
    const messages: ChatMessage[] = [
      ...Array.from({ length: 10 }, (_, i) => shotTurn(i)),
      { role: "user", content: "what changed?" },
    ];
    // When the loop escalates
    const step = await compactStep(messages, async () => "SUMMARY");
    // Then it stops at the cheapest rung instead of summarising or dropping turns
    expect(step.mode).toBe("microcompact");
    expect(step.dropped).toBe(0);
  });
});

describe("capMedia — the per-request media cap", () => {
  const shot = (n: number): ChatMessage => ({
    role: "user",
    content: [
      { type: "text", text: `screenshot ${n}` },
      { type: "image_url", image_url: { url: `data:image/png;base64,IMG${n}` } },
    ],
  });

  it("drops the OLDEST images past the cap and marks their place", () => {
    // Given more images than one request may carry
    const messages = Array.from({ length: 5 }, (_, i) => shot(i));
    // When the request is built with a cap of 3
    const out = capMedia(messages, 3);
    // Then exactly 3 images survive — the NEWEST, since those are what the agent is acting on
    const surviving = out.flatMap((m) =>
      (m.content as { image_url?: { url?: string } }[]).filter((p) => p.image_url).map((p) => p.image_url?.url),
    );
    expect(surviving).toEqual([
      "data:image/png;base64,IMG2",
      "data:image/png;base64,IMG3",
      "data:image/png;base64,IMG4",
    ]);
    // …and the dropped ones leave a mark rather than vanishing (so the model doesn't re-read a stale one)
    const firstParts = out[0]?.content as { type: string; text?: string }[];
    expect(firstParts[1]?.text).toContain("older image dropped");
    // The surrounding text of every message is untouched
    expect(firstParts[0]?.text).toBe("screenshot 0");
  });

  it("is a no-op under the cap and never mutates the input (the stored history keeps every image)", () => {
    const messages = [shot(0), shot(1)];
    const out = capMedia(messages, 100);
    expect(out).toBe(messages); // same reference — nothing rebuilt
    const capped = capMedia([shot(0), shot(1), shot(2)], 1);
    expect(capped).not.toBe(messages);
    // the ORIGINAL array still holds its images: the cap is a wire-payload transform, not a history edit
    const original = shot(0).content as { image_url?: unknown }[];
    expect(original.some((p) => p.image_url)).toBe(true);
  });

  it("drops an image the provider would reject WHOLE-request, and says which one and why", () => {
    // Given a run whose second screenshot came back too tall to send (a full-page capture)
    const tall = new Uint8Array(33);
    tall.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(tall.buffer);
    view.setUint32(8, 13);
    tall.set([0x49, 0x48, 0x44, 0x52], 12);
    view.setUint32(16, 1200);
    view.setUint32(20, 14_000);
    const oversized: ChatMessage = {
      role: "user",
      content: [
        { type: "text", text: "screenshot 1" },
        { type: "image_url", image_url: { url: `data:image/png;base64,${Buffer.from(tall).toString("base64")}` } },
      ],
    };
    // When the request is built well under the count cap
    const out = capMedia([shot(0), oversized, shot(2)], 100);
    // Then only that image is replaced — by a line naming the measurement and the way out
    const parts = out[1]?.content as { type: string; text?: string; image_url?: unknown }[];
    expect(parts[1]?.image_url).toBeUndefined();
    expect(parts[1]?.text).toContain("1200×14000 pixels");
    expect(parts[1]?.text).toContain("smaller region or a lower resolution");
    // …and its neighbours are untouched: one bad image must not cost the run its other screenshots
    const survivors = out.flatMap((m) =>
      (m.content as { image_url?: { url?: string } }[]).filter((p) => p.image_url).map((p) => p.image_url?.url),
    );
    expect(survivors).toEqual(["data:image/png;base64,IMG0", "data:image/png;base64,IMG2"]);
  });

  it("does not spend the count budget on an image it already dropped for size", () => {
    const huge: ChatMessage = {
      role: "user",
      content: [{ type: "image_url", image_url: { url: `data:image/png;base64,${"A".repeat(7 * 1024 * 1024)}` } }],
    };
    // Given a cap of 2 and four images, one of which is oversized
    const out = capMedia([huge, shot(0), shot(1), shot(2)], 2);
    // Then the oversized one is gone for its own reason, and the count cap still admits its full 2 newest
    const survivors = out.flatMap((m) =>
      (m.content as { image_url?: { url?: string } }[]).filter((p) => p.image_url).map((p) => p.image_url?.url),
    );
    expect(survivors).toEqual(["data:image/png;base64,IMG1", "data:image/png;base64,IMG2"]);
  });

  it("leaves image-free transcripts completely alone", () => {
    const plain: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ];
    expect(capMedia(plain, 0)).toBe(plain);
  });
});
