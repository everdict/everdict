import { describe, expect, it, vi } from "vitest";
import { usageReporter } from "./usage.js";

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
