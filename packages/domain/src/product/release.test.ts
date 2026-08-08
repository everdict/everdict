import { BadRequestError, ConflictError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { Release } from "./release.js";

const NOW = "2026-08-08T00:00:00.000Z";
const LATER = "2026-08-20T00:00:00.000Z";
const SERIES = ["support-quality", "latency"] as const;

function newRelease(targetDate?: string) {
  return Release.newRelease({
    id: "rel-1",
    tenant: "acme",
    productId: "prod-1",
    name: "2026.3",
    productSeriesKeys: [...SERIES],
    createdBy: "dana",
    now: NOW,
    ...(targetDate !== undefined ? { targetDate } : {}),
  });
}

describe("Release — a gated checkpoint on the product's axis", () => {
  it("starts planned and announces itself against its product", () => {
    const record = newRelease("2026-08-31");
    expect(record.status).toBe("planned");
    expect(Release.creationFacts(record)[0]).toMatchObject({
      kind: "release.created",
      subject: { type: "release", id: "rel-1" },
      payload: { productId: "prod-1", name: "2026.3", targetDate: "2026-08-31" },
    });
  });

  it("refuses watching a series its product never declared", () => {
    expect(() =>
      Release.newRelease({
        id: "rel-2",
        tenant: "acme",
        productId: "prod-1",
        name: "2026.4",
        seriesKeys: ["ghost"],
        productSeriesKeys: [...SERIES],
        createdBy: "dana",
        now: NOW,
      }),
    ).toThrow(BadRequestError);
  });

  it("refuses to release while linked issues are open, naming the count", () => {
    const release = Release.from(newRelease());
    expect(() => release.setStatus({ to: "released", openIssues: 2, regressedSeries: [] }, "dana", LATER)).toThrow(
      ConflictError,
    );
  });

  it("refuses to release while a watched series has regressed, naming the series", () => {
    const release = Release.from(newRelease());
    expect(() =>
      release.setStatus({ to: "released", openIssues: 0, regressedSeries: ["support-quality"] }, "dana", LATER),
    ).toThrow(/support-quality/);
  });

  it("releases cleanly when nothing blocks, reporting whether it landed on time", () => {
    const transition = Release.from(newRelease("2026-08-31")).setStatus(
      { to: "released", openIssues: 0, regressedSeries: [] },
      "dana",
      LATER,
    );
    expect(transition.patch.status).toBe("released");
    expect(transition.patch.releasedAt).toBe(LATER);
    expect(transition.patch.history?.at(-1)?.event).toBe("released");
    expect(transition.facts[0]?.payload).toMatchObject({
      from: "planned",
      to: "released",
      productId: "prod-1",
      onTime: true,
    });
  });

  it("records the override when a release ships over known blockers", () => {
    const transition = Release.from(newRelease()).setStatus(
      { to: "released", openIssues: 1, regressedSeries: ["latency"], force: true },
      "dana",
      LATER,
    );
    expect(transition.patch.status).toBe("released");
    expect(transition.facts[0]?.payload).toMatchObject({
      forced: true,
      openIssues: 1,
      regressedSeries: ["latency"],
    });
    expect(transition.patch.history?.at(-1)?.detail).toMatchObject({ forced: true });
  });

  it("treats a released release as history — no reopening", () => {
    const released = { ...newRelease(), status: "released" as const, releasedAt: LATER };
    expect(() =>
      Release.from(released).setStatus({ to: "planned", openIssues: 0, regressedSeries: [] }, "dana", LATER),
    ).toThrow(ConflictError);
  });

  it("lets a cancelled release be re-planned, clearing nothing it never had", () => {
    const cancelled = { ...newRelease(), status: "cancelled" as const };
    const transition = Release.from(cancelled).setStatus(
      { to: "planned", openIssues: 3, regressedSeries: [] },
      "dana",
      LATER,
    );
    expect(transition.patch.status).toBe("planned");
    expect(transition.patch.releasedAt).toBeUndefined();
  });

  it("refuses a no-op move and an empty edit", () => {
    const release = Release.from(newRelease());
    expect(() => release.setStatus({ to: "planned", openIssues: 0, regressedSeries: [] }, "dana", LATER)).toThrow(
      ConflictError,
    );
    expect(() => release.update({ name: "2026.3" }, "dana", LATER, [...SERIES])).toThrow(BadRequestError);
  });
});
