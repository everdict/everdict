import { describe, expect, it } from "vitest";
import { TraceSourceSpecSchema } from "./harness-spec.js";

describe("TraceSourceSpecSchema (G1 — widened to 5 kinds + auth/correlate/scope)", () => {
  it("accepts a Langfuse source with authSecret + tag correlation (the Suna case)", () => {
    const parsed = TraceSourceSpecSchema.parse({
      kind: "langfuse",
      endpoint: "https://cloud.langfuse.com",
      authSecret: "langfuse-key", // a SecretStore NAME — no plaintext in the spec
      correlate: "tag",
      project: "proj-1",
    });
    expect(parsed.kind).toBe("langfuse");
    expect(parsed.correlate).toBe("tag");
    expect(parsed.authSecret).toBe("langfuse-key");
  });

  it("accepts all five platform kinds (otel/mlflow/langfuse/langsmith/phoenix)", () => {
    for (const kind of ["otel", "mlflow", "langfuse", "langsmith", "phoenix"] as const) {
      expect(TraceSourceSpecSchema.parse({ kind, endpoint: "http://x" }).kind).toBe(kind);
    }
  });

  it("stays backward-compatible — the old {kind: otel|mlflow, endpoint} shape still parses (new fields optional)", () => {
    const parsed = TraceSourceSpecSchema.parse({ kind: "otel", endpoint: "http://jaeger" });
    expect(parsed).toEqual({ kind: "otel", endpoint: "http://jaeger" });
  });

  it("rejects an unknown kind", () => {
    expect(TraceSourceSpecSchema.safeParse({ kind: "datadog", endpoint: "http://x" }).success).toBe(false);
  });
});
