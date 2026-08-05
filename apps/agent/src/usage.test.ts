import type { TraceSpan } from "@everdict/contracts";
import { describe, expect, it, vi } from "vitest";
import { runEventReporter, usageReporter } from "./usage.js";

describe("usageReporter", () => {
  it("POSTs the usage as source 'agent' to /internal/usage with the internal-token header", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        return new Response(null, { status: 200 });
      }),
    );
    const report = usageReporter("https://cp.example.com/", "s3cret");
    await report({ workspace: "acme", model: "claude-opus-4-8", inputTokens: 100, outputTokens: 20 });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://cp.example.com/internal/usage");
    expect((calls[0]?.init.headers as Record<string, string>)["x-internal-token"]).toBe("s3cret");
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({
      tenant: "acme",
      source: "agent",
      model: "claude-opus-4-8",
      inputTokens: 100,
      outputTokens: 20,
    });
    vi.unstubAllGlobals();
  });

  it("forwards the prompt-cache token split so the meter can price cached tokens at cache rates", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return new Response(null, { status: 200 });
      }),
    );
    const report = usageReporter("https://cp", "t");
    await report({
      workspace: "acme",
      model: "claude-opus-4-8",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 60,
      cacheWriteTokens: 15,
    });
    expect(bodies[0]).toMatchObject({ cacheReadTokens: 60, cacheWriteTokens: 15 });
    vi.unstubAllGlobals();
  });

  it("throws on a non-2xx response so the best-effort caller can swallow it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 500 })),
    );
    const report = usageReporter("https://cp", "t");
    await expect(report({ workspace: "a", model: "m", inputTokens: 1, outputTokens: 1 })).rejects.toThrow(/500/);
    vi.unstubAllGlobals();
  });
});

describe("runEventReporter", () => {
  it("carries the turn's SPANS to the control plane — they are the evidence the trajectory is sealed from", async () => {
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(init.body as string));
        return new Response(null, { status: 200 });
      }),
    );
    const spans: TraceSpan[] = [
      {
        traceId: "0af7651916cd43dd8448eb211c80319c",
        spanId: "b7ad6b7169203331",
        name: "invoke_agent default",
        kind: "internal",
        startedAt: "2026-08-05T00:00:00.000Z",
        endedAt: "2026-08-05T00:00:02.000Z",
        attributes: {},
      },
    ];
    const report = runEventReporter("https://cp.example.com/", "s3cret");
    await report({
      workspace: "acme",
      kind: "agent.run.completed",
      sessionId: "sess-1",
      agentId: "default",
      eventKind: "chat",
      message: "Chat turn completed in conversation sess-1.",
      runId: "run-1",
      creator: "alice",
      cause: "chat",
      spans,
    });
    // A turn that recorded spans reports NO transcript projection, so a body that forgets `spans` reports no
    // evidence at all: the run settles and the ledger seals nothing — the conversation vanishes from the
    // trace browse.
    expect(bodies[0]).toMatchObject({ runId: "run-1", cause: "chat", spans });
  });
});
