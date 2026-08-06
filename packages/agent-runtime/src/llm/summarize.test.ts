import type { LlmTransport, StreamRequest } from "@everdict/llm";
import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../messages.js";
import { buildSummarizer, stripImages } from "./summarize.js";

const withImage = (text: string): ChatMessage => ({
  role: "user",
  content: [
    { type: "text", text },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ],
});

describe("stripImages", () => {
  it("replaces image parts with a placeholder and leaves everything else identical", () => {
    const out = stripImages([withImage("the tool returned:")]);
    const parts = out[0]?.content as { type: string; text?: string }[];
    expect(parts).toEqual([
      { type: "text", text: "the tool returned:" },
      { type: "text", text: "[image]" },
    ]);
  });

  it("returns image-free messages by reference (no needless rebuild)", () => {
    const plain: ChatMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: null, tool_calls: [] },
    ];
    expect(stripImages(plain)[0]).toBe(plain[0]);
    expect(stripImages(plain)[1]).toBe(plain[1]);
  });
});

describe("buildSummarizer", () => {
  it("never sends images into the summary call — the escape hatch must not carry the payload it exists to shed", async () => {
    // Given a span carrying tool-returned screenshots (the exact shape that makes a run need compaction)
    const requests: StreamRequest[] = [];
    const transport: LlmTransport = {
      provider: "fake",
      stream: async (req) => {
        requests.push(req);
        return { content: "DIGEST", toolCalls: [], finishReason: "stop" };
      },
    };
    // When the span is summarised
    const digest = await buildSummarizer(transport, "small-model")([withImage("shot 1"), withImage("shot 2")]);
    // Then the request that went out carries no image at all — pre-fix this call shipped both screenshots and
    // failed with prompt-too-long (or outright, on a summariser tier that cannot accept images).
    expect(digest).toBe("DIGEST");
    const sent = JSON.stringify(requests[0]?.messages ?? []);
    expect(sent).not.toContain("image_url");
    expect(sent).toContain("[image]");
    expect(sent).toContain("shot 1"); // the surrounding text still reaches the summariser
  });
});
