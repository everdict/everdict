import { BadRequestError, ForbiddenError } from "@everdict/contracts";
import { type ScheduleRecord, ScheduleRecordSchema, type ScheduleRunTemplate } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { Schedule, isValidCron } from "./schedule.js";

const runTemplate: ScheduleRunTemplate = {
  dataset: { id: "repo-smoke", version: "latest" },
  harness: { id: "scripted", version: "latest" },
  judges: [],
};

function newRecord(overrides: Partial<Parameters<typeof Schedule.newRecord>[0]> = {}): ScheduleRecord {
  return Schedule.newRecord({
    id: "sch-1",
    tenant: "acme",
    createdBy: "owner",
    name: "nightly",
    cron: "0 3 * * *",
    runTemplate,
    now: "2026-07-10T00:00:00.000Z",
    ...overrides,
  });
}

describe("Schedule — the schedule domain model", () => {
  describe("newRecord (the only construction path)", () => {
    it("assembles a schema-valid record with the defaults (UTC / skip / enabled)", () => {
      const record = newRecord();
      expect(() => ScheduleRecordSchema.parse(record)).not.toThrow();
      expect(record).toMatchObject({
        id: "sch-1",
        tenant: "acme",
        name: "nightly",
        cron: "0 3 * * *",
        timezone: "UTC",
        overlapPolicy: "skip",
        enabled: true,
        createdBy: "owner",
        createdAt: "2026-07-10T00:00:00.000Z",
        updatedAt: "2026-07-10T00:00:00.000Z",
      });
    });

    it("honors explicit timezone/overlapPolicy/enabled over the defaults", () => {
      const record = newRecord({ timezone: "Asia/Seoul", overlapPolicy: "bufferOne", enabled: false });
      expect(record).toMatchObject({ timezone: "Asia/Seoul", overlapPolicy: "bufferOne", enabled: false });
    });

    it("rejects an invalid cron with the exact BadRequest the API has always returned", () => {
      expect(() => newRecord({ cron: "every minute" })).toThrow(BadRequestError);
      expect(() => newRecord({ cron: "every minute" })).toThrow(
        "cron expression is invalid (5 fields required): 'every minute'",
      );
    });
  });

  describe("cron validity (the model's own validation)", () => {
    it("accepts a 5-field cron and rejects malformed input", () => {
      expect(isValidCron("0 3 * * *")).toBe(true);
      expect(isValidCron("*/15 * * * 1-5")).toBe(true);
      expect(isValidCron("0 3 * *")).toBe(false); // 4 fields
      expect(isValidCron("0 3 * * * *")).toBe(false); // 6 fields
      expect(isValidCron("nope")).toBe(false);
    });

    it("assertValidCron is the throwing form shared by create and update", () => {
      expect(() => Schedule.assertValidCron("0 3 * * *")).not.toThrow();
      expect(() => Schedule.assertValidCron("bad")).toThrow(BadRequestError);
    });
  });

  describe("content-edit permission (creator or admin; pause stays member+)", () => {
    it("distinguishes a content edit from a pause-only patch", () => {
      expect(Schedule.editsContent({ enabled: false })).toBe(false);
      expect(Schedule.editsContent({})).toBe(false);
      expect(Schedule.editsContent({ cron: "0 6 * * *" })).toBe(true);
      expect(Schedule.editsContent({ enabled: true, name: "renamed" })).toBe(true);
    });

    it("the creator and a workspace admin can edit content; anyone else cannot", () => {
      const schedule = Schedule.from(newRecord());
      expect(schedule.canEditContent({ subject: "owner", isAdmin: false })).toBe(true);
      expect(schedule.canEditContent({ subject: "any-admin", isAdmin: true })).toBe(true);
      expect(schedule.canEditContent({ subject: "someone-else", isAdmin: false })).toBe(false);
    });

    it("a content edit by a non-creator/non-admin throws Forbidden with the schedules:edit action", () => {
      const schedule = Schedule.from(newRecord());
      let thrown: unknown;
      try {
        schedule.assertCanEdit({ cron: "0 6 * * *" }, { subject: "someone-else", isAdmin: false });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(ForbiddenError);
      expect((thrown as ForbiddenError).extra).toEqual({ id: "sch-1", action: "schedules:edit" });
      expect((thrown as ForbiddenError).message).toBe(
        "You do not have permission to edit this schedule (schedule creator or workspace admin only).",
      );
    });

    it("a pause-only patch is never gated, and no actor (internal call) skips the gate", () => {
      const schedule = Schedule.from(newRecord());
      expect(() =>
        schedule.assertCanEdit({ enabled: false }, { subject: "someone-else", isAdmin: false }),
      ).not.toThrow();
      expect(() => schedule.assertCanEdit({ cron: "0 6 * * *" })).not.toThrow(); // internal call — no actor
    });
  });

  describe("enabled/paused semantics (Temporal sync spec)", () => {
    it("projects the record to the Temporal spec with paused = !enabled", () => {
      expect(Schedule.from(newRecord()).toTemporalSpec()).toEqual({
        id: "sch-1",
        tenant: "acme",
        cron: "0 3 * * *",
        timezone: "UTC",
        overlapPolicy: "skip",
        paused: false,
      });
      expect(Schedule.from(newRecord({ enabled: false })).toTemporalSpec()).toMatchObject({ paused: true });
    });

    it("isEnabled reflects the active flag (disableByCreator targets only enabled schedules)", () => {
      expect(Schedule.from(newRecord()).isEnabled()).toBe(true);
      expect(Schedule.from(newRecord({ enabled: false })).isEnabled()).toBe(false);
    });
  });

  describe("autoDisable transition", () => {
    it("pairs enabled=false with a visible Auto-disabled reason and stamps updatedAt", () => {
      const patch = Schedule.from(newRecord()).autoDisable("creator left the workspace", "t1");
      expect(patch).toEqual({
        enabled: false,
        lastStatus: "Auto-disabled: creator left the workspace",
        updatedAt: "t1",
      });
    });

    it("caps the recorded reason at 300 chars (lastStatus is a status surface, not a log)", () => {
      const patch = Schedule.from(newRecord()).autoDisable(`NOT_FOUND — ${"x".repeat(400)}`, "t1");
      expect(patch.lastStatus).toHaveLength(300);
      expect(patch.lastStatus?.startsWith("Auto-disabled: NOT_FOUND — ")).toBe(true);
    });
  });
});
