import { IssueService, withOriginBacklink } from "@everdict/application-control";
import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryIssueStore, InMemoryRunStore, InMemoryScorecardStore } from "@everdict/db";
import { InMemoryJudgeRegistry } from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { buildServer } from "../server.js";

// Registering a capability records WHERE IT CAME FROM, and a capability born from an issue links itself back.
// These are transport tests over the composition main.ts actually builds (the registry wrapped in the backlink
// decorator), because the two halves only mean something together: the stamp is what the detail view reads, and
// the link is what lets the issue notice its own regression later.

const teamAllocator = (() => {
  let n = 0;
  return {
    async allocateForIssue() {
      n += 1;
      return { team: { id: "team-eng" }, grant: { number: n, identifier: `ENG-${n}` } };
    },
  };
})();

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in these tests");
  },
};

const H = { "x-everdict-tenant": "acme" };

const CODE_JUDGE = {
  kind: "code",
  id: "truncation",
  version: "1.0.0",
  language: "python",
  code: "print('[]')",
};

function build() {
  const issueStore = new InMemoryIssueStore();
  const issueService = new IssueService({
    teams: teamAllocator,
    store: issueStore,
    scorecards: new InMemoryScorecardStore(),
  });
  // Exactly how main.ts composes it — one decorator at the composition root, so every caller goes through it.
  const judgeRegistry = withOriginBacklink(new InMemoryJudgeRegistry(), "judge", issueService);
  const app = buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    issueService,
    judgeRegistry,
  });
  return { app, issueService };
}

async function createIssue(app: ReturnType<typeof build>["app"]) {
  const res = await app.inject({
    method: "POST",
    url: "/issues",
    headers: H,
    payload: { title: "Judge misses truncated answers" },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string; identifier: string };
}

async function judgeOrigin(app: ReturnType<typeof build>["app"], id: string, version: string) {
  const list = await app.inject({ method: "GET", url: "/judges", headers: H });
  expect(list.statusCode).toBe(200);
  const entry = (list.json() as Array<{ id: string; versionOrigins?: Record<string, unknown> }>).find(
    (j) => j.id === id,
  );
  return entry?.versionOrigins?.[version];
}

describe("capability origin — a registration records where it came from", () => {
  it("stamps the declared issue and resolves it to the STABLE record id, with a display snapshot", async () => {
    // Given: an issue someone is working from
    const { app } = build();
    const issue = await createIssue(app);

    // When: a judge is registered declaring that issue by its IDENTIFIER (what a member pastes at an agent)
    const res = await app.inject({
      method: "POST",
      url: "/judges",
      headers: H,
      payload: { ...CODE_JUDGE, origin: { from: { type: "issue", id: issue.identifier }, note: "built for ENG-1" } },
    });
    expect(res.statusCode).toBe(201);

    // Then: what is stored is the record id — an identifier is re-minted when an issue moves team, and a stamp
    // that dies on a team move is worse than none. The label is the snapshot the detail view draws.
    expect(await judgeOrigin(app, "truncation", "1.0.0")).toEqual({
      via: "web",
      from: {
        type: "issue",
        id: issue.id,
        label: `${issue.identifier} Judge misses truncated answers`,
      },
      note: "built for ENG-1",
    });
  });

  it("links the judge back to the issue, so a regression against it can surface", async () => {
    const { app } = build();
    const issue = await createIssue(app);

    await app.inject({
      method: "POST",
      url: "/judges",
      headers: H,
      payload: { ...CODE_JUDGE, origin: { from: { type: "issue", id: issue.id } } },
    });

    const detail = await app.inject({ method: "GET", url: `/issues/${issue.id}`, headers: H });
    expect(detail.statusCode).toBe(200);
    const links = (detail.json() as { links: Array<{ type: string; id: string; version?: string }> }).links;
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ type: "judge", id: "truncation" });
    // At id level, with NO version pinned — the issue means "this judge", not "this judge at 1.0.0", and the
    // regression watch matches at id level for the same reason.
    expect(links[0]).not.toHaveProperty("version");
  });

  it("records the agent and conversation that acted, from the attribution headers", async () => {
    // The bearer says which MEMBER; these headers say which agent ran on their behalf — the same provenance the
    // workspace filesystem already records on a revision.
    const { app } = build();
    const issue = await createIssue(app);

    await app.inject({
      method: "POST",
      url: "/judges",
      headers: {
        ...H,
        "x-everdict-agent-id": "everdict",
        "x-everdict-agent-name": "Everdict",
        "x-everdict-conversation-id": "conv-9",
      },
      payload: { ...CODE_JUDGE, origin: { from: { type: "issue", id: issue.id } } },
    });

    expect(await judgeOrigin(app, "truncation", "1.0.0")).toMatchObject({
      agentId: "everdict",
      agentName: "Everdict",
      conversationId: "conv-9",
    });
  });

  it("keeps an unresolvable issue reference verbatim instead of dropping the provenance", async () => {
    const { app } = build();

    await app.inject({
      method: "POST",
      url: "/judges",
      headers: H,
      payload: { ...CODE_JUDGE, origin: { from: { type: "issue", id: "ENG-404" } } },
    });

    // No label (nothing to snapshot) and the id stays as written — a note about an issue the caller cannot read
    // is still better than none, and it renders as plain text rather than a link.
    expect(await judgeOrigin(app, "truncation", "1.0.0")).toEqual({
      via: "web",
      from: { type: "issue", id: "ENG-404" },
    });
  });

  it("never lets the declaration leak into the spec — versions stay content-identical", async () => {
    // Given: a judge registered with an origin
    const { app } = build();
    const issue = await createIssue(app);
    await app.inject({
      method: "POST",
      url: "/judges",
      headers: H,
      payload: { ...CODE_JUDGE, origin: { from: { type: "issue", id: issue.id } } },
    });

    // When: the identical spec is re-registered with a DIFFERENT origin
    const again = await app.inject({
      method: "POST",
      url: "/judges",
      headers: H,
      payload: { ...CODE_JUDGE, origin: { note: "different story" } },
    });

    // Then: idempotent, not a 409 — provenance is metadata beside the spec, never part of it.
    expect(again.statusCode).toBe(201);
    const spec = await app.inject({ method: "GET", url: "/judges/truncation/versions/1.0.0", headers: H });
    expect(spec.json()).not.toHaveProperty("origin");
  });
});
