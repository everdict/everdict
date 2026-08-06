import { CycleService, IssueService, RunService, TeamService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryCycleStore, InMemoryIssueStore, InMemoryRunStore, InMemoryTeamStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// Putting an issue in an iteration, over the wire. The three surfaces that do it (the issue's property column,
// the create form, the list's bulk move) all send `cycleId` on PATCH /issues/:id — and the body schema never
// declared it, so zod stripped the key before the service ever saw it: a cycle-only edit answered 400 "Nothing
// to update.", and a cycle bundled with another field answered 200 having moved nothing. These assert the round
// trip, not the status code.
const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in tracker tests");
  },
};

const H = { "x-everdict-tenant": "acme" };

function build() {
  const teamStore = new InMemoryTeamStore();
  const issueStore = new InMemoryIssueStore();
  const cycleStore = new InMemoryCycleStore();
  const teamService = new TeamService({ store: teamStore, issues: issueStore });
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    teamService,
    // `cycles` is what production wires (main.ts) — without it the service cannot answer "whose iteration is
    // this", which is the check the reported bug was hiding.
    issueService: new IssueService({ teams: teamService, store: issueStore, cycles: cycleStore }),
    cycleService: new CycleService({ store: cycleStore, teams: teamStore, issues: issueStore }),
  });
  return { app };
}

type App = ReturnType<typeof build>["app"];

async function fileIssue(app: App, title: string): Promise<{ id: string; teamId: string }> {
  const res = await app.inject({ method: "POST", url: "/issues", headers: H, payload: { title } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

async function planCycle(app: App, teamId: string): Promise<{ id: string; number: number }> {
  const res = await app.inject({ method: "POST", url: "/cycles", headers: H, payload: { teamId } });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe("PATCH /issues/:id — joining an iteration", () => {
  it("pulls an issue into its team's cycle instead of refusing the edit as empty", async () => {
    // Given: an issue on a team that is running an iteration
    const { app } = build();
    const issue = await fileIssue(app, "Agent drops the tool result on retry");
    const cycle = await planCycle(app, issue.teamId);

    // When: the detail screen's cycle picker sends the one field it changes
    const res = await app.inject({
      method: "PATCH",
      url: `/issues/${issue.id}`,
      headers: H,
      payload: { cycleId: cycle.id },
    });

    // Then: the issue is in the cycle, and the next read agrees
    expect(res.statusCode).toBe(200);
    expect(res.json().cycleId).toBe(cycle.id);
    const reread = await app.inject({ method: "GET", url: `/issues/${issue.id}`, headers: H });
    expect(reread.json().cycleId).toBe(cycle.id);
  });

  it("records both ends of the move on the history entry the burn-down replays", async () => {
    const { app } = build();
    const issue = await fileIssue(app, "Judge times out on long traces");
    const first = await planCycle(app, issue.teamId);
    const second = await planCycle(app, issue.teamId);

    await app.inject({ method: "PATCH", url: `/issues/${issue.id}`, headers: H, payload: { cycleId: first.id } });
    const moved = await app.inject({
      method: "PATCH",
      url: `/issues/${issue.id}`,
      headers: H,
      payload: { cycleId: second.id },
    });

    const history: {
      event: string;
      detail?: { changed?: string[]; cycleFrom?: string | null; cycleTo?: string | null };
    }[] = moved.json().history;
    const last = history.at(-1);
    expect(last?.event).toBe("updated");
    expect(last?.detail?.changed).toContain("cycle");
    expect(last?.detail?.cycleFrom).toBe(first.id);
    expect(last?.detail?.cycleTo).toBe(second.id);
  });

  it("takes an issue back out of the cycle when the picker clears it", async () => {
    const { app } = build();
    const issue = await fileIssue(app, "Runner reconnects but never leases again");
    const cycle = await planCycle(app, issue.teamId);
    await app.inject({ method: "PATCH", url: `/issues/${issue.id}`, headers: H, payload: { cycleId: cycle.id } });

    const cleared = await app.inject({
      method: "PATCH",
      url: `/issues/${issue.id}`,
      headers: H,
      payload: { cycleId: null },
    });

    expect(cleared.statusCode).toBe(200);
    expect(cleared.json().cycleId).toBeUndefined();
  });

  it("moves the cycle alongside another edit, rather than silently keeping the old one", async () => {
    // The quiet half of the same bug: bundled with a field the schema DID declare, the request answered 200 and
    // applied everything except the move.
    const { app } = build();
    const issue = await fileIssue(app, "Scorecard diff hides an improved case");
    const cycle = await planCycle(app, issue.teamId);

    const res = await app.inject({
      method: "PATCH",
      url: `/issues/${issue.id}`,
      headers: H,
      payload: { priority: "high", cycleId: cycle.id },
    });

    expect(res.json()).toMatchObject({ priority: "high", cycleId: cycle.id });
  });

  it("refuses another team's iteration — the value now reaches the check that says whose it is", async () => {
    const { app } = build();
    const issue = await fileIssue(app, "Trace ingest drops spans past the first page");
    const other = (
      await app.inject({ method: "POST", url: "/teams", headers: H, payload: { key: "OPS", name: "Ops" } })
    ).json();
    const theirs = await planCycle(app, other.id);

    const res = await app.inject({
      method: "PATCH",
      url: `/issues/${issue.id}`,
      headers: H,
      payload: { cycleId: theirs.id },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().message).toMatch(/another team/i);
  });
});
