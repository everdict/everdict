import { describe, expect, it } from "vitest";
import { adoptedImageReach } from "./adopted-image-reach.js";
import type { AdoptedEnvironmentView } from "./environment-adoption-service.js";

const ENDPOINT = "images.everdict.test";
const THEIRS = `${ENDPOINT}/rival-9f8e7d6c/officeqa`;

function view(over: Partial<AdoptedEnvironmentView> = {}): AdoptedEnvironmentView {
  return {
    source: "rival",
    id: "officeqa",
    version: "1.0.0",
    adoptedAt: "2026-01-01T00:00:00.000Z",
    available: true,
    image: `${THEIRS}:v1`,
    ...over,
  };
}

describe("adoptedImageReach — cross-tenant pull is bounded by adoption (M6)", () => {
  it("allows a ref an adopted, still-consumable environment declares", async () => {
    const reach = adoptedImageReach({ list: async () => [view()] });
    await expect(reach("acme", `${THEIRS}:v1`)).resolves.toBe(true);
  });

  it("matches by repository, so a digest pull of the tag that was adopted still reaches", async () => {
    // Given: the inventory pinned a tag; the job pulls the digest it resolves to
    const reach = adoptedImageReach({ list: async () => [view()] });
    await expect(reach("acme", `${THEIRS}@sha256:${"a".repeat(64)}`)).resolves.toBe(true);
  });

  it("refuses once the capability stops being consumable — revoked reach needs nothing invalidated here", async () => {
    const reach = adoptedImageReach({ list: async () => [view({ available: false })] });
    await expect(reach("acme", `${THEIRS}:v1`)).resolves.toBe(false);
  });

  it("refuses a repository nobody adopted, even in a namespace something else was adopted from", async () => {
    const reach = adoptedImageReach({ list: async () => [view()] });
    await expect(reach("acme", `${ENDPOINT}/rival-9f8e7d6c/secret:v1`)).resolves.toBe(false);
  });

  it("denies rather than throws when the inventory cannot be read — a lookup failure must not fail the job", async () => {
    const reach = adoptedImageReach({
      list: async () => {
        throw new Error("settings store down");
      },
    });
    await expect(reach("acme", `${THEIRS}:v1`)).resolves.toBe(false);
  });

  it("refuses a ref with no registry host — a docker.io shorthand is never our store", async () => {
    const reach = adoptedImageReach({ list: async () => [view()] });
    await expect(reach("acme", "officeqa:v1")).resolves.toBe(false);
  });
});
