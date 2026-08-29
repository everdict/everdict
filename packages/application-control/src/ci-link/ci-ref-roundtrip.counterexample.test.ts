import { ciLinkTrusting } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { CiLinkService } from "./ci-link-service.js";

// ── [R122 COUNTEREXAMPLE] A REF PIN A WORKSPACE CANNOT SET IS NOT A POLICY ──────────────────────────
//
// `WorkspaceCiLink.refs` lets a workspace say which refs of a linked repository may authenticate as `ci`,
// and `ciLinkTrusting` enforces it. Neither is worth anything if the field cannot be WRITTEN: the upsert body
// listed every other link field and not this one, so the record could hold a pin that no API call could
// produce — a capability declared and undeliverable, which is what `unwired-capabilities` refuses one layer
// down and what this repository has now paid for several times.
//
//     the record can hold a ref pin   ≠   a workspace can set one
//
// So this drives the ROUND TRIP through the service — set it, read it back, and hand it to the policy that
// authenticates — rather than asserting the schema in isolation. A schema test would have passed on the day
// the field was unsettable.
//
// Seen RED before the fix: the upsert dropped `refs`, so the stored link came back without it and the policy
// trusted every branch.
describe("[R122 COUNTEREXAMPLE] a ref pin survives the upsert and reaches the policy", () => {
  // A settings double rather than `@everdict/db`'s: this package may not import the adapter layer (the
  // dependency runs the other way), and the service only reads and writes one record.
  const service = () => {
    let record: unknown;
    return new CiLinkService({
      settings: {
        async get() {
          return record;
        },
        async set(_workspace: string, patch: { ci?: unknown }) {
          record = { ...(record as object), ...patch };
          return record;
        },
      },
    } as never);
  };

  it("stores the refs the workspace set, and the policy then refuses another branch", async () => {
    const links = await service().upsert("acme", "admin", {
      repository: "acme/app",
      harness: "h",
      slots: {},
      refs: ["refs/heads/main"],
    } as never);

    const stored = links.find((l) => l.repository === "acme/app");
    expect(stored?.refs, "the upsert dropped the ref pin — the field is unsettable").toEqual(["refs/heads/main"]);

    // …and the pin is the one the authenticator will consult.
    expect(ciLinkTrusting(links, { repository: "acme/app", ref: "refs/heads/other" })).toBeUndefined();
    expect(ciLinkTrusting(links, { repository: "acme/app", ref: "refs/heads/main" })).toBeDefined();
  });

  it("a link saved without refs still trusts any ref — the permissive default survives the round trip too", async () => {
    const links = await service().upsert("acme", "admin", {
      repository: "acme/app",
      harness: "h",
      slots: {},
    } as never);
    expect(links.find((l) => l.repository === "acme/app")?.refs).toBeUndefined();
    expect(ciLinkTrusting(links, { repository: "acme/app", ref: "refs/heads/anything" })).toBeDefined();
  });
});
