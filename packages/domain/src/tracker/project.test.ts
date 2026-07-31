import { BadRequestError, ConflictError } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { Initiative } from "./initiative.js";
import { Project } from "./project.js";

const NOW = "2026-07-31T00:00:00.000Z";
const LATER = "2026-08-15T00:00:00.000Z";

function newProject(targetDate?: string) {
  return Project.newProject({
    id: "prj-1",
    tenant: "acme",
    name: "v1 agent launch",
    createdBy: "dana",
    now: NOW,
    ...(targetDate !== undefined ? { targetDate } : {}),
  });
}

describe("Project — issues under one target date", () => {
  it("starts planned and announces itself", () => {
    const record = newProject("2026-08-10");
    expect(record.status).toBe("planned");
    expect(Project.creationFacts(record)[0]).toMatchObject({
      kind: "project.created",
      subject: { type: "project", id: "prj-1" },
      payload: { status: "planned", targetDate: "2026-08-10" },
    });
  });

  it("refuses completion while issues are open, and names the count", () => {
    const project = Project.from(newProject());
    expect(() => project.setStatus({ to: "completed", openIssues: 3 }, "dana", LATER)).toThrow(ConflictError);
  });

  it("completes cleanly when nothing is open, reporting whether it landed on time", () => {
    const transition = Project.from(newProject("2026-08-10")).setStatus(
      { to: "completed", openIssues: 0 },
      "dana",
      LATER,
    );
    expect(transition.patch.status).toBe("completed");
    expect(transition.patch.completedAt).toBe(LATER);
    expect(transition.facts[0]?.payload).toMatchObject({ to: "completed", openIssues: 0, onTime: false });
    expect(transition.patch.history?.at(-1)?.event).toBe("completed");
  });

  it("records the override when a release ships with known gaps", () => {
    const transition = Project.from(newProject()).setStatus(
      { to: "completed", openIssues: 2, force: true },
      "dana",
      LATER,
    );
    expect(transition.patch.status).toBe("completed");
    expect(transition.facts[0]?.payload).toMatchObject({ forced: true, openIssues: 2 });
  });

  it("clears completedAt on reopen so a reopened project never reads as finished", () => {
    const completed = { ...newProject(), status: "completed" as const, completedAt: LATER };
    const transition = Project.from(completed).setStatus({ to: "in_progress", openIssues: 1 }, "dana", LATER);
    expect(transition.patch.completedAt).toBeUndefined();
  });

  it("refuses a no-op move and an empty edit", () => {
    const project = Project.from(newProject());
    expect(() => project.setStatus({ to: "planned", openIssues: 0 }, "dana", LATER)).toThrow(ConflictError);
    expect(() => project.update({ name: "v1 agent launch" }, "dana", LATER)).toThrow(BadRequestError);
  });
});

describe("Initiative — the release gate", () => {
  function newInitiative() {
    return Initiative.newInitiative({ id: "ini-1", tenant: "acme", name: "v1 deploy", createdBy: "dana", now: NOW });
  }

  it("starts active", () => {
    expect(newInitiative().status).toBe("active");
  });

  it("refuses completion while any issue under it is open", () => {
    expect(() => Initiative.from(newInitiative()).setStatus({ to: "completed", openIssues: 1 }, "dana", LATER)).toThrow(
      ConflictError,
    );
  });

  it("completes when readiness is clean, and records a forced completion", () => {
    const clean = Initiative.from(newInitiative()).setStatus({ to: "completed", openIssues: 0 }, "dana", LATER);
    expect(clean.patch.status).toBe("completed");
    expect(clean.facts[0]?.kind).toBe("initiative.status_changed");

    const forced = Initiative.from(newInitiative()).setStatus(
      { to: "completed", openIssues: 4, force: true },
      "dana",
      LATER,
    );
    expect(forced.facts[0]?.payload).toMatchObject({ forced: true, openIssues: 4 });
  });
});
