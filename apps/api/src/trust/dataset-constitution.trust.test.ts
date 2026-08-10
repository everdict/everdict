import type { Authenticator } from "@everdict/auth";
import type { Dataset } from "@everdict/contracts";
import { InMemoryDatasetRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import { TRUST_SUITE_ENABLED } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-123.
//
// CONSTITUTIONAL AUTHORITY BELONGS TO THE DECLARATION ARTIFACT AT ITS WRITE BOUNDARY, not to whichever
// transport happens to execute it later.
//
// Declaring `ground_truth` redefines what passing means: `evaluateVerdict` ranks it above objective, so a
// custom `business_ok: true` passes a case a built-in `tests_pass: false` would fail. Submit gates that act
// for a run-time grading plan — and a dataset case may declare exactly the same thing under
// `datasets:write`, which is a MEMBER permission. Same constitutional act, admin through one door and open
// through the other.
//
// Gating it at submit instead would be worse than the hole: a dataset is immutable, so an approved one would
// have to be re-approved by every schedule, CI trigger and product auto-eval that runs it, none of which have
// an admin to ask. So it is gated where the declaration is authored, once.
const describeTrust = TRUST_SUITE_ENABLED ? describe : describe.skip;

const withDeclaration = (authority: "ground_truth" | "observational"): Dataset =>
  ({
    id: `constitution-${authority}`,
    version: "1.0.0",
    cases: [
      {
        id: "c1",
        env: { kind: "prompt" },
        task: "do",
        graders: [{ id: "probe", metrics: [{ id: "business_ok", authority }] }],
        timeoutSec: 60,
        tags: [],
      },
    ],
    tags: [],
  }) as Dataset;

// The PRODUCTION door, minimally wired: the dataset registry and an authenticator that fixes the caller's
// role. Everything else a server needs is absent on purpose — this scenario is about who may write a
// declaration, and a fuller fixture would only add ways for it to fail for other reasons.
const roleAuth = (roles: string[]): Authenticator => ({
  async authenticate() {
    return { subject: "u", workspace: "acme", roles, via: "oidc" };
  },
});

const serverAs = (role: string) =>
  buildServer({
    datasetRegistry: new InMemoryDatasetRegistry(),
    requireAuth: true,
    authenticator: roleAuth([role]),
  } as never);

describeTrust("TRUST-123 — a dataset cannot mint ground truth without the constitutional role", () => {
  it("a MEMBER registering a ground_truth declaration is refused, on both transports' shared door", async () => {
    const app = serverAs("member");
    const res = await app.inject({
      method: "POST",
      url: "/datasets",
      headers: { authorization: "Bearer x" },
      payload: withDeclaration("ground_truth"),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().message).toContain("business_ok");
    await app.close();
  });

  it("an ADMIN may — the act is gated, not forbidden", async () => {
    const app = serverAs("admin");
    const res = await app.inject({
      method: "POST",
      url: "/datasets",
      headers: { authorization: "Bearer x" },
      payload: withDeclaration("ground_truth"),
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });

  it("a member may still declare NON-constitutional semantics — the gate is narrow", async () => {
    const app = serverAs("member");
    const res = await app.inject({
      method: "POST",
      url: "/datasets",
      headers: { authorization: "Bearer x" },
      payload: withDeclaration("observational"),
    });
    expect(res.statusCode).toBe(201);
    await app.close();
  });
});
