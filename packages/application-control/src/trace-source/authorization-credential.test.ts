import { describe, expect, it } from "vitest";
import { traceAuthorizationCredential } from "./authorization-credential.js";

describe("traceAuthorizationCredential", () => {
  it("wraps a schemeless token (an offline_token access token) as a Bearer credential for Authorization-header kinds", () => {
    // An offline_token secret resolves to a bare OAuth2 access token — without the Bearer scheme the header 401s.
    const bareJwt = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.sig";
    for (const kind of ["otel", "mlflow", "langfuse", "phoenix"] as const)
      expect(traceAuthorizationCredential(kind, bareJwt)).toBe(`Bearer ${bareJwt}`);
  });

  it("leaves a value that already carries a scheme verbatim (a plain secret stores 'Bearer …'/'Basic …')", () => {
    expect(traceAuthorizationCredential("otel", "Bearer abc123")).toBe("Bearer abc123");
    expect(traceAuthorizationCredential("mlflow", "Basic dXNlcjpwYXNz")).toBe("Basic dXNlcjpwYXNz");
  });

  it("never touches a langsmith value — it is injected as a raw x-api-key, not an Authorization scheme", () => {
    expect(traceAuthorizationCredential("langsmith", "lsv2_pt_deadbeef")).toBe("lsv2_pt_deadbeef");
  });
});
