import type { IssueLabelRecord, IssueRecord } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { InMemoryIssueStore } from "./issue-store.js";
import { InMemoryIssueLabelStore } from "./issue-label-store.js";

const label = (over: Partial<IssueLabelRecord>): IssueLabelRecord => ({
  id: "lbl-1",
  tenant: "acme",
  name: "flaky",
  color: "red",
  createdBy: "dana",
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
  ...over,
});

const issue = (over: Partial<IssueRecord>): IssueRecord => ({
  id: "iss-1",
  tenant: "acme",
  teamId: "team-eng",
  number: 1,
  identifier: "ENG-1",
  title: "Agent drops the tool result on retry",
  status: "todo",
  labelIds: [],
  links: [],
  history: [],
  createdBy: "dana",
  createdAt: "2026-08-03T00:00:00.000Z",
  updatedAt: "2026-08-03T00:00:00.000Z",
  ...over,
});

// The pair the composition root wires together — an in-memory binding has to honour the same two guarantees the
// Postgres one gets from SQL (mig 0107): unique names, and no dangling `labelIds` after a delete.
function pair() {
  const issues = new InMemoryIssueStore();
  const labels = new InMemoryIssueLabelStore();
  labels.attachIssues(issues);
  return { issues, labels };
}

describe("InMemoryIssueLabelStore", () => {
  it("refuses a second label whose name differs only by case or padding", async () => {
    const { labels } = pair();
    await labels.create(label({}));

    await expect(labels.create(label({ id: "lbl-2", name: "FLAKY" }))).rejects.toThrow(/already exists/);
    await expect(labels.create(label({ id: "lbl-3", name: "  flaky  " }))).rejects.toThrow(/already exists/);
    expect(await labels.list("acme")).toHaveLength(1);
  });

  it("lets another workspace define the same name", async () => {
    const { labels } = pair();
    await labels.create(label({}));
    await labels.create(label({ id: "lbl-2", tenant: "globex" }));

    expect(await labels.list("acme")).toHaveLength(1);
    expect(await labels.list("globex")).toHaveLength(1);
  });

  it("counts the issues wearing a label", async () => {
    const { issues, labels } = pair();
    await labels.create(label({}));
    await issues.create(issue({ id: "iss-1", labelIds: ["lbl-1"] }));
    await issues.create(issue({ id: "iss-2", labelIds: ["lbl-1", "lbl-9"] }));
    await issues.create(issue({ id: "iss-3" }));

    expect(await labels.usageCount("acme", "lbl-1")).toBe(2);
  });

  // The invariant the whole id model rests on: a deleted label must not survive as a pointer on an issue.
  it("strips the label off every issue it deletes it from, leaving the issues intact", async () => {
    const { issues, labels } = pair();
    await labels.create(label({}));
    await issues.create(issue({ id: "iss-1", labelIds: ["lbl-1", "lbl-keep"] }));
    await issues.create(issue({ id: "iss-2", labelIds: ["lbl-1"] }));

    expect(await labels.remove("acme", "lbl-1")).toBe(true);

    expect((await issues.get("acme", "iss-1"))?.labelIds).toEqual(["lbl-keep"]);
    expect((await issues.get("acme", "iss-2"))?.labelIds).toEqual([]);
    expect(await labels.get("acme", "lbl-1")).toBeUndefined();
  });

  it("reports a delete of something already gone rather than pretending it worked", async () => {
    const { labels } = pair();
    expect(await labels.remove("acme", "lbl-missing")).toBe(false);
  });

  it("keeps another workspace's label out of reach", async () => {
    const { labels } = pair();
    await labels.create(label({ tenant: "globex" }));

    expect(await labels.get("acme", "lbl-1")).toBeUndefined();
    expect(await labels.remove("acme", "lbl-1")).toBe(false);
  });
});
