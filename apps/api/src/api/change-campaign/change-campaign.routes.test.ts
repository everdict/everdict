import { ChangeCampaignService, RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryChangeCampaignStore, InMemoryRunStore } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { buildServer } from "../../server.js";

// The `change` grade over HTTP. The interesting surface is what gets REFUSED — every rule the domain holds
// has to survive the transport, and the transport is the half no unit test crosses.

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in change campaign tests");
  },
};
const H = { "x-everdict-tenant": "acme" };

function build() {
  return buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    changeCampaignService: new ChangeCampaignService({ store: new InMemoryChangeCampaignStore() }),
  });
}

const CRITERIA = [
  { id: "tests", statement: "the suite is green" },
  { id: "device", statement: "verified on a device" },
];
const GATE = { id: "tests", command: "pnpm test", exitCode: 0, metrics: [{ name: "tests.passed", value: 4027 }] };
const met = (id: string) => ({ criterionId: id, answer: "met", how: "observed", gateRunIds: ["tests"] });
const notRun = (id: string) => ({ criterionId: id, answer: "not_run", how: "asserted", gateRunIds: [] });

async function open(app: ReturnType<typeof build>, issueId = "i-1", over: Record<string, unknown> = {}) {
  const res = await app.inject({
    method: "POST",
    url: "/change-campaigns",
    headers: H,
    payload: { issueId, service: { repository: "acme/widget" }, criteria: CRITERIA, ...over },
  });
  return res;
}

describe("change campaigns over HTTP", () => {
  it("opens with the criteria declared before the work, and reads back", async () => {
    const app = build();
    const created = await open(app);
    expect(created.statusCode).toBe(201);
    const campaign = created.json();
    expect(campaign).toMatchObject({ issueId: "i-1", state: "open", criteria: CRITERIA });

    const read = await app.inject({ method: "GET", url: `/change-campaigns/${campaign.id}`, headers: H });
    expect(read.statusCode).toBe(200);
    expect(read.json().id).toBe(campaign.id);

    const listed = await app.inject({ method: "GET", url: "/change-campaigns?issueId=i-1", headers: H });
    expect(listed.json().map((c: { id: string }) => c.id)).toEqual([campaign.id]);
  });

  it("refuses a second open campaign for the same request (409), naming the one in the way", async () => {
    const app = build();
    const first = (await open(app)).json();
    const second = await open(app);
    expect(second.statusCode).toBe(409);
    expect(second.json().message).toContain(first.id);
  });

  it("derives the round's outcome, and `not_run` cannot be adopted through", async () => {
    const app = build();
    const campaign = (await open(app)).json();
    const round = await app.inject({
      method: "POST",
      url: `/change-campaigns/${campaign.id}/rounds`,
      headers: H,
      payload: {
        hypothesis: "first attempt",
        changes: [{ repository: "acme/widget", commits: [{ sha: "aaa1111" }] }],
        gateRuns: [GATE],
        answers: [met("tests"), notRun("device")],
      },
    });
    expect(round.statusCode).toBe(201);
    expect(round.json().round.outcome).toBe("rejected");
    expect(round.json().campaign.rounds).toHaveLength(1);
  });

  it("refuses an observation with no measurement (400) — the rule survives the transport", async () => {
    const app = build();
    const campaign = (await open(app)).json();
    const round = await app.inject({
      method: "POST",
      url: `/change-campaigns/${campaign.id}/rounds`,
      headers: H,
      payload: {
        hypothesis: "green, trust me",
        changes: [{ repository: "acme/widget", commits: [{ sha: "bbb2222" }] }],
        answers: [{ criterionId: "tests", answer: "met", how: "observed", gateRunIds: [] }, notRun("device")],
      },
    });
    expect(round.statusCode).toBe(400);
    expect(round.json().message).toMatch(/names no gate run/);
  });

  it("refuses a commit another round already claimed (400)", async () => {
    const app = build();
    const campaign = (await open(app)).json();
    const body = {
      hypothesis: "h",
      changes: [{ repository: "acme/widget", commits: [{ sha: "ccc3333" }] }],
      gateRuns: [GATE],
      answers: [met("tests"), notRun("device")],
    };
    await app.inject({ method: "POST", url: `/change-campaigns/${campaign.id}/rounds`, headers: H, payload: body });
    const again = await app.inject({
      method: "POST",
      url: `/change-campaigns/${campaign.id}/rounds`,
      headers: H,
      payload: { ...body, hypothesis: "same commit again" },
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().message).toMatch(/already claimed by round 1/);
  });

  it("closes partially, naming what landed and what is owed — and the next campaign continues it", async () => {
    const app = build();
    const first = (await open(app)).json();
    const closed = await app.inject({
      method: "POST",
      url: `/change-campaigns/${first.id}/close`,
      headers: H,
      payload: {
        state: "partially_adopted",
        reason: "the api landed, the app did not",
        knowledge: ["k-1"],
        landed: [{ repository: "acme/api" }],
        remaining: [{ repository: "acme/mobile" }],
      },
    });
    expect(closed.statusCode).toBe(200);
    expect(closed.json()).toMatchObject({ state: "partially_adopted" });
    expect(closed.json().close.remaining).toEqual([{ repository: "acme/mobile" }]);

    const successor = await open(app, "i-1", { continues: first.id });
    expect(successor.statusCode).toBe(201);
    expect(successor.json().continues).toBe(first.id);
  });

  it("refuses a close that says nothing about what the work taught (400)", async () => {
    const app = build();
    const campaign = (await open(app)).json();
    const closed = await app.inject({
      method: "POST",
      url: `/change-campaigns/${campaign.id}/close`,
      headers: H,
      payload: { state: "abandoned", reason: "no reason to continue", knowledge: [] },
    });
    expect(closed.statusCode).toBe(400);
    expect(closed.json().message).toMatch(/may not close in silence/);
  });

  it("404s when the service is not composed, rather than pretending the request does not exist", async () => {
    const app = buildServer({
      service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    });
    const res = await app.inject({ method: "GET", url: "/change-campaigns", headers: H });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toMatch(/not configured/);
  });
});
