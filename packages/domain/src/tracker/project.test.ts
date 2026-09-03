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
      payload: { status: "planned", name: "v1 agent launch", targetDate: "2026-08-10" },
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
    expect(transition.facts[0]?.payload).toMatchObject({
      to: "completed",
      name: "v1 agent launch",
      openIssues: 0,
      onTime: false,
    });
    expect(transition.patch.history?.at(-1)?.event).toBe("completed");
  });

  it("records the override when a project is completed with known gaps", () => {
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

  it("lets an umbrella be detached freely — a project under no goal is still somebody's work", () => {
    // Given a project under one initiative
    const project = Project.from({ ...newProject(), initiativeIds: ["ini-1"] });

    // When the edit empties the initiative list
    // Then it is allowed — a project under no umbrella is still somebody's work.
    expect(project.update({ initiativeIds: [] }, "dana", LATER).patch.initiativeIds).toEqual([]);
  });
});

describe("Initiative — the completion gate", () => {
  function newInitiative() {
    return Initiative.newInitiative({ id: "ini-1", tenant: "acme", name: "v1 deploy", createdBy: "dana", now: NOW });
  }

  it("starts planned — a goal being shaped is not work in flight", () => {
    expect(newInitiative().status).toBe("planned");
  });

  it("carries its face, its people and where it is written down", () => {
    const edited = Initiative.from(newInitiative()).update(
      {
        icon: "🎯",
        memberIds: ["dana", "erin", "dana"],
        resources: [{ label: "design doc", url: "https://example.com/doc" }],
      },
      "dana",
      LATER,
    );
    // Deduped, order preserved — a repeat would show the same person twice in every list that walks it.
    expect(edited.patch).toMatchObject({
      icon: "🎯",
      memberIds: ["dana", "erin"],
      resources: [{ label: "design doc", url: "https://example.com/doc" }],
    });
    expect(edited.patch.history?.at(-1)?.detail).toMatchObject({
      changed: ["icon", "members", "resources"],
    });
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
    expect(forced.facts[0]?.payload).toMatchObject({ forced: true, openIssues: 4, name: "v1 deploy" });
  });

  it("carries a posted update's health onto the goal, and keeps the sentence as the record", () => {
    const posted = Initiative.from(newInitiative()).postUpdate(
      { id: "up-1", health: "at_risk", body: "The judge rewrite slipped a week." },
      "dana",
      LATER,
    );
    expect(posted.transition.patch.health).toBe("at_risk");
    expect(posted.record).toMatchObject({
      initiativeId: "ini-1",
      health: "at_risk",
      body: "The judge rewrite slipped a week.",
      createdBy: "dana",
    });
    expect(posted.transition.facts[0]?.kind).toBe("initiative.update_posted");
    // The history entry is what survives the swept event log — a reader six months later still sees the call.
    expect(posted.transition.patch.history?.at(-1)).toMatchObject({
      event: "update_posted",
      detail: { health: "at_risk" },
    });
  });

  it("refuses a health flag with no sentence — a colour nobody can explain is not an update", () => {
    expect(() =>
      Initiative.from(newInitiative()).postUpdate({ id: "up-1", health: "off_track", body: "  " }, "dana", LATER),
    ).toThrow(BadRequestError);
  });
});
