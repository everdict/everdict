import { NotFoundError } from "@everdict/contracts";
import { contentDigest } from "@everdict/domain";
import { describe, expect, it } from "vitest";
import { verifyForkLineage } from "./harness-fork.js";

// ── A FORK NAMES BYTES IT CAME FROM (harness-identity-and-seeds-spec.md §1) ──────────────────────────
describe("verifyForkLineage", () => {
  const parent = { kind: "command", id: "claude-scaffold", version: "1.0.0", command: "claude -p {{task}}" };
  const instances = {
    async get(_t: string, id: string, version: string) {
      if (id === "claude-scaffold" && version === "1.0.0") return parent as never;
      throw new NotFoundError("NOT_FOUND", { id }, "harness not found");
    },
  };
  it("accepts a fork whose named digest is the parent's, refuses a missing parent (404) and a wrong digest (409)", async () => {
    await expect(
      verifyForkLineage(instances, "acme", {
        id: "claude-scaffold",
        version: "1.0.0",
        specDigest: contentDigest(parent),
      }),
    ).resolves.toBeUndefined();
    await expect(
      verifyForkLineage(instances, "acme", {
        id: "claude-scaffold",
        version: "9.9.9",
        specDigest: contentDigest(parent),
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      verifyForkLineage(instances, "acme", { id: "claude-scaffold", version: "1.0.0", specDigest: "sha256:wish" }),
    ).rejects.toMatchObject({ status: 409 });
  });
});
