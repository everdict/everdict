import { describe, expect, it } from "vitest";
import { SaveCapabilityBodySchema } from "./save-capability.js";

// The contract McpToolSpec leaves both `url` and `image` optional (a discriminatedUnion member can't be a refined
// ZodEffects in zod v3), so the "exactly one transport" invariant is enforced at this request boundary.
const base = { name: "grafana", description: "query grafana" };

describe("SaveCapabilityBodySchema — mcp transport invariant", () => {
  it("accepts an HTTP-url mcp capability (no image)", () => {
    const r = SaveCapabilityBodySchema.safeParse({
      ...base,
      spec: { type: "mcp", url: "https://mcp.example.com/mcp" },
    });
    expect(r.success).toBe(true);
  });

  it("accepts a container-image mcp capability (no url)", () => {
    const r = SaveCapabilityBodySchema.safeParse({
      ...base,
      spec: { type: "mcp", image: "grafana/mcp-grafana", args: ["-t", "stdio"] },
    });
    expect(r.success).toBe(true);
  });

  it("rejects an mcp capability that declares BOTH url and image", () => {
    const r = SaveCapabilityBodySchema.safeParse({
      ...base,
      spec: { type: "mcp", url: "https://mcp.example.com/mcp", image: "grafana/mcp-grafana" },
    });
    expect(r.success).toBe(false);
  });

  it("rejects an mcp capability that declares NEITHER url nor image", () => {
    const r = SaveCapabilityBodySchema.safeParse({ ...base, spec: { type: "mcp", provides: [] } });
    expect(r.success).toBe(false);
  });

  it("leaves non-mcp capabilities unaffected by the transport refinement", () => {
    const r = SaveCapabilityBodySchema.safeParse({
      ...base,
      spec: { type: "skill", instructions: "do the thing", files: [] },
    });
    expect(r.success).toBe(true);
  });
});
