import type { IssueRecord } from "@everdict/contracts";
import { BadRequestError, ConflictError, NotFoundError, TRACKER_HISTORY_LIMIT } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { Issue } from "./issue.js";

const NOW = "2026-07-31T00:00:00.000Z";
const LATER = "2026-08-01T00:00:00.000Z";

function newIssue(overrides: Partial<Parameters<typeof Issue.newIssue>[0]> = {}): IssueRecord {
  return Issue.newIssue({
    id: "iss-1",
    tenant: "acme",
    number: 1,
    identifier: "ENG-1",
    title: "Agent drops the tool result on retry",
    createdBy: "dana",
    now: NOW,
    ...overrides,
  });
}

describe("Issue — the tracker's unit of intent", () => {
  it("newIssue starts in the backlog and records its own creation in the durable history", () => {
    const record = newIssue();
    expect(record.status).toBe("backlog");
    expect(record.labelIds).toEqual([]);
    expect(record.links).toEqual([]);
    expect(record.history).toEqual([{ at: NOW, by: "dana", event: "created", detail: { status: "backlog" } }]);
  });

  it("newIssue stamps link attribution and marks a GitHub copy as imported", () => {
    const record = newIssue({
      status: "todo",
      links: [{ type: "harness", id: "web-agent", version: "2.1.0" }],
      github: {
        repository: "acme/agent",
        number: 42,
        url: "https://github.com/acme/agent/issues/42",
        state: "open",
        sync: { pull: true, push: false },
        comments: [],
      },
    });
    expect(record.links).toEqual([
      { type: "harness", id: "web-agent", version: "2.1.0", addedBy: "dana", addedAt: NOW },
    ]);
    expect(record.history[0]?.event).toBe("github_imported");
    expect(Issue.creationFacts(record)[0]?.payload).toMatchObject({
      source: "github",
      repository: "acme/agent",
      number: 42,
      title: "Agent drops the tool result on retry",
    });
  });

  // The provenance has to stay ADDRESSABLE on its own: the live `github` block is detachable state, so an
  // origin recorded as `owner/name#42` would leave a GitHub Enterprise copy pointing nowhere afterwards.
  it("records the imported issue's full address — host included — in the history, the fact and the detach entry", () => {
    const github = {
      host: "https://github.acme.internal",
      repository: "acme/agent",
      number: 42,
      url: "https://github.acme.internal/acme/agent/issues/42",
      state: "open" as const,
      sync: { pull: true, push: false },
      comments: [],
    };
    const record = newIssue({ status: "todo", github });
    const origin = {
      repository: "acme/agent",
      number: 42,
      url: "https://github.acme.internal/acme/agent/issues/42",
      host: "https://github.acme.internal",
    };
    expect(record.history[0]?.detail).toMatchObject(origin);
    expect(Issue.creationFacts(record)[0]?.payload).toMatchObject(origin);

    const detached = Issue.from(record).detachGithub("dana", LATER);
    expect(detached.patch.github).toBeUndefined();
    expect(detached.patch.history?.at(-1)).toMatchObject({ event: "updated", detail: origin });
  });

  it("omits the host for a github.com copy — unset is the public host, not a missing value", () => {
    const record = newIssue({
      github: {
        repository: "acme/agent",
        number: 7,
        url: "https://github.com/acme/agent/issues/7",
        state: "open",
        sync: { pull: false, push: false },
        comments: [],
      },
    });
    expect(record.history[0]?.detail).not.toHaveProperty("host");
    expect(record.history[0]?.detail).toMatchObject({ url: "https://github.com/acme/agent/issues/7" });
  });

  it("setStatus moves between open states and emits the folded status_changed fact", () => {
    const record = newIssue();
    const transition = Issue.from(record).setStatus("in_progress", "dana", LATER);
    expect(transition.patch.status).toBe("in_progress");
    expect(transition.facts).toEqual([
      {
        kind: "issue.status_changed",
        subject: { type: "issue", id: "iss-1" },
        actor: "dana",
        payload: {
          from: "backlog",
          to: "in_progress",
          cause: "manual",
          identifier: "ENG-1",
          // A feed row reads the fact alone — the title rides along so the line can say WHAT moved.
          title: "Agent drops the tool result on retry",
        },
      },
    ]);
  });

  it("setStatus refuses the two statuses that must carry evidence, and a no-op move", () => {
    const issue = Issue.from(newIssue());
    expect(() => issue.setStatus("done", "dana", LATER)).toThrow(BadRequestError);
    expect(() => issue.setStatus("regressed", "dana", LATER)).toThrow(BadRequestError);
    expect(() => issue.setStatus("backlog", "dana", LATER)).toThrow(ConflictError);
  });

  it("resolve closes with the evidence and reports the scorecard on the fact", () => {
    const transition = Issue.from(newIssue()).resolve({ scorecardId: "sc-9", note: "green" }, "dana", LATER);
    expect(transition.patch.status).toBe("done");
    expect(transition.patch.resolution).toEqual({ scorecardId: "sc-9", note: "green", by: "dana", at: LATER });
    expect(transition.facts[0]?.payload).toMatchObject({ to: "done", cause: "manual", scorecardId: "sc-9" });
    expect(transition.patch.history?.at(-1)?.event).toBe("resolved");
  });

  it("resolve is refused once the issue is already settled", () => {
    const resolved = { ...newIssue(), status: "done" as const };
    expect(() => Issue.from(resolved).resolve({}, "dana", LATER)).toThrow(ConflictError);
  });

  it("reopen keeps the prior resolution — a regressed issue must remember the scorecard it fell from", () => {
    const done = {
      ...newIssue(),
      status: "done" as const,
      resolution: { scorecardId: "sc-9", by: "dana", at: NOW },
    };
    const transition = Issue.from(done).reopen(
      { to: "regressed", cause: "regression", scorecardId: "sc-12" },
      "system",
      LATER,
    );
    expect(transition.patch.status).toBe("regressed");
    expect(transition.patch.resolution).toBeUndefined(); // untouched by the patch, so the record keeps sc-9
    expect(transition.facts[0]?.payload).toMatchObject({
      from: "done",
      to: "regressed",
      cause: "regression",
      scorecardId: "sc-12",
    });
  });

  it("reopen only applies to a settled issue, and only a resolved one can regress", () => {
    expect(() => Issue.from(newIssue()).reopen({ cause: "manual" }, "dana", LATER)).toThrow(ConflictError);
    const cancelled = { ...newIssue(), status: "cancelled" as const };
    expect(() => Issue.from(cancelled).reopen({ to: "regressed", cause: "regression" }, "dana", LATER)).toThrow(
      ConflictError,
    );
    expect(Issue.from(cancelled).reopen({ cause: "manual" }, "dana", LATER).patch.status).toBe("todo");
  });

  it("update edits content without emitting lifecycle news, and clears an optional field with null", () => {
    const record = { ...newIssue(), assignee: "dana" };
    const transition = Issue.from(record).update({ title: "Retry drops tool results", assignee: null }, "eve", LATER);
    expect(transition.facts).toEqual([]);
    expect(transition.patch.title).toBe("Retry drops tool results");
    expect(transition.patch.assignee).toBeUndefined();
    expect(transition.patch.history?.at(-1)).toMatchObject({
      event: "updated",
      detail: { changed: ["title", "assignee"] },
    });
  });

  it("update refuses a request that changes nothing", () => {
    expect(() =>
      Issue.from(newIssue()).update({ title: "Agent drops the tool result on retry" }, "eve", LATER),
    ).toThrow(BadRequestError);
  });

  it("link attaches a capability once and unlink removes it", () => {
    const linked = Issue.from(newIssue()).link({ type: "dataset", id: "regression-suite" }, "dana", LATER);
    expect(linked.patch.links).toEqual([{ type: "dataset", id: "regression-suite", addedBy: "dana", addedAt: LATER }]);
    expect(linked.facts[0]?.kind).toBe("issue.linked");

    const withLink = { ...newIssue(), links: linked.patch.links ?? [] };
    expect(() => Issue.from(withLink).link({ type: "dataset", id: "regression-suite" }, "dana", LATER)).toThrow(
      ConflictError,
    );
    expect(Issue.from(withLink).unlink("dataset", "regression-suite", "dana", LATER).patch.links).toEqual([]);
    expect(() => Issue.from(withLink).unlink("dataset", "missing", "dana", LATER)).toThrow(NotFoundError);
  });

  it("history is capped so sync churn cannot grow a row without bound", () => {
    const crowded: IssueRecord = {
      ...newIssue(),
      history: Array.from({ length: TRACKER_HISTORY_LIMIT }, (_, index) => ({
        at: NOW,
        by: "dana",
        event: "updated" as const,
        detail: { index },
      })),
    };
    const transition = Issue.from(crowded).setStatus("todo", "dana", LATER);
    expect(transition.patch.history).toHaveLength(TRACKER_HISTORY_LIMIT);
    expect(transition.patch.history?.[0]?.detail).toEqual({ index: 1 }); // oldest dropped
    expect(transition.patch.history?.at(-1)?.event).toBe("status_changed");
  });
});

describe("Issue — the GitHub copy seams", () => {
  const github = {
    repository: "acme/agent",
    number: 42,
    url: "https://github.com/acme/agent/issues/42",
    state: "open" as const,
    sync: { pull: true, push: true },
    comments: [],
  };

  it("applyGithubPull takes the remote fields and watermarks with the REMOTE clock", () => {
    const record = newIssue({ github });
    const transition = Issue.from(record).applyGithubPull(
      {
        title: "Retry drops tool results",
        description: "steps to reproduce",
        labelIds: ["lbl_bug"],
        state: "closed",
        url: github.url,
        updatedAt: "2026-08-02T10:00:00.000Z",
        comments: [{ author: "kim", body: "still failing", createdAt: LATER, url: `${github.url}#1` }],
      },
      "sync",
      LATER,
    );
    expect(transition.patch.title).toBe("Retry drops tool results");
    expect(transition.patch.github?.syncedAt).toBe("2026-08-02T10:00:00.000Z");
    expect(transition.patch.github?.state).toBe("closed");
    expect(transition.patch.github?.comments).toHaveLength(1);
    expect(transition.facts).toEqual([]); // state reconciliation goes through resolve/reopen, which emit
    expect(transition.patch.history?.at(-1)).toMatchObject({ event: "github_pulled" });
  });

  it("recordGithubPush annotates the outcome and never disturbs the committed local status", () => {
    const record = newIssue({ github });
    const ok = Issue.from(record).recordGithubPush({ ok: true, state: "closed" }, "dana", LATER);
    expect(ok.patch.status).toBeUndefined();
    expect(ok.patch.github?.state).toBe("closed");

    const failed = Issue.from(record).recordGithubPush({ ok: false, message: "403 from GitHub" }, "dana", LATER);
    expect(failed.patch.status).toBeUndefined();
    expect(failed.patch.github?.lastError).toEqual({ at: LATER, op: "push", message: "403 from GitHub" });
    expect(failed.patch.history?.at(-1)?.event).toBe("github_push_failed");
  });

  it("the GitHub seams refuse an issue that was never imported", () => {
    const issue = Issue.from(newIssue());
    expect(() => issue.setGithubSync({ pull: true, push: true }, "dana", LATER)).toThrow(BadRequestError);
  });

  it("an ordinary project change takes the milestone with it — a checkpoint belongs to ITS project", () => {
    // Given an issue at a checkpoint inside Apollo
    const issue = Issue.from(newIssue({ projectId: "prj-1", milestoneId: "ms-1" }));

    // When it is moved to another project without naming a checkpoint there
    const { patch } = issue.update({ projectId: "prj-2" }, "dana", LATER);

    // Then the old project's milestone does not come along (it is not one of the new project's)
    expect(patch.projectId).toBe("prj-2");
    expect(patch.milestoneId).toBeUndefined();
    expect(patch.history?.at(-1)).toMatchObject({ detail: { changed: ["project", "milestone"] } });

    // And an edit that names one in the same breath keeps it — the service checks that one against prj-2.
    expect(issue.update({ projectId: "prj-2", milestoneId: "ms-9" }, "dana", LATER).patch.milestoneId).toBe("ms-9");
  });
});
