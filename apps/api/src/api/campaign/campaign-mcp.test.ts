import { CampaignService, type CampaignSnapshot, RunService } from "@everdict/application-control";
import type { Principal } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import { AgentSpecSchema, type CampaignFrame } from "@everdict/contracts";
import { InMemoryEvolutionCampaignStore, InMemoryRunStore } from "@everdict/db";
import { contentDigest } from "@everdict/domain";
import { InMemoryAgentRegistry } from "@everdict/registry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildCampaignAdoption } from "../../composition/campaign-adoption.js";
import { type McpDeps, buildMcpServer } from "../../mcp.js";

// BFF↔MCP parity for the campaign settlement: the agent-evolve loop drives the SAME service over MCP that
// the HTTP routes serve — open, derived round, gate decision, settle. Role gating rides `scorecards:*`.

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in campaign MCP tests");
  },
};

const frame: CampaignFrame = {
  subject: { type: "agent", id: "everdict", baselineVersion: "1.0.0" },
  scenarios: [
    { id: "c1", heldOut: true },
    { id: "c2", heldOut: true },
  ],
  judges: [],
  trialsPerCase: 5,
  budget: { maxRounds: 5 },
  stopAfterRejectedRounds: 3,
  significance: {},
  allowUnverifiedIdentity: false,
  allowLabelOnlyAdoption: false,
  observationPolicy: { allowDivergent: false },
};

const winning: CampaignSnapshot = {
  diff: {
    comparability: "full",
    trials: {
      baseline: "b",
      candidate: "c",
      zThreshold: 1.96,
      minDelta: 0,
      cases: [
        {
          caseId: "c1",
          baselineRate: 0,
          baselineTrials: 5,
          candidateRate: 1,
          candidateTrials: 5,
          delta: 1,
          z: 3,
          method: "fisher",
          p: 0.0079,
          significant: true,
        },
        {
          caseId: "c2",
          baselineRate: 0.2,
          baselineTrials: 5,
          candidateRate: 0.2,
          candidateTrials: 5,
          delta: 0,
          z: 0,
          method: "fisher",
          p: 1,
          significant: false,
        },
      ],
    } as NonNullable<CampaignSnapshot["diff"]["trials"]>,
    experiment: { held: ["execution_world"], confounds: [], unverified: [] },
  },
  baseline: { record: { harness: { id: "agent:everdict", version: "1.0.0" } } },
  // …with the manifest a real batch seals: without it the gate refuses (arch-review 73).
  candidate: {
    record: {
      harness: { id: "agent:everdict", version: "1.0.1" },
      manifest: { harness: { specDigest: "sha256:cand-1.0.1" } },
    },
  },
};

function makeDeps(
  agents: InMemoryAgentRegistry = new InMemoryAgentRegistry(),
  // The digest the round seals. Overridable so an adoption case can make the campaign's manifest and the
  // registry's document ONE document — a fixed string would leave only the refusals reachable.
  specDigest = "sha256:cand-1.0.1",
): McpDeps {
  const store = new InMemoryEvolutionCampaignStore();
  const snapshot: CampaignSnapshot = {
    ...winning,
    candidate: { record: { ...winning.candidate.record, manifest: { harness: { specDigest } } } },
  };
  const campaignService = new CampaignService({
    store,
    operations: store,
    issues: { get: async () => ({ id: "iss_1" }) },
    diffs: { diffSnapshot: async () => snapshot },
    newId: () => "evc_mcp",
    now: () => "2026-08-26T04:00:00.000Z",
  });
  return {
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    campaignService,
    // Opening a campaign resolves the issue's TEAM, so the tracker is a REQUIRED dependency of that tool
    // now (arch-review 79). These cases run with no teams configured — the unowned shape, which is the
    // workspace's and writable by every member.
    issueService: {
      async get(_t: string, ref: string) {
        return ref === "iss_1" ? { id: "iss_1" } : undefined;
      },
    } as unknown as McpDeps["issueService"],
    // Through the PRODUCTION builder over a real registry — BFF↔MCP parity means the same consumer, not a
    // second one (arch-review 72 P0 / 73).
    campaignAdoption: buildCampaignAdoption({
      operations: store,
      agents,
      harnesses: unusedHarnesses(),
      templates: unusedTemplates(),
      issues: openIssue(),
    }),
  };
}

async function connect(deps: McpDeps, roles: string[]): Promise<Client> {
  const principal: Principal = { subject: "user-a", workspace: "acme", roles, via: "oidc" };
  const server = buildMcpServer(deps, principal);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

const textOf = (result: unknown): string => {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? [];
  return content.map((c) => c.text ?? "").join("");
};

describe("campaign MCP tools — the loop's settlement surface", () => {
  it("open → log_campaign_round (derived verdict) → campaign_decision → settle_campaign", async () => {
    const client = await connect(makeDeps(), ["member"]);
    const opened = await client.callTool({ name: "open_campaign", arguments: { issue_id: "iss_1", frame } });
    expect(opened.isError).toBeFalsy();
    const { id } = JSON.parse(textOf(opened)) as { id: string };

    const logged = await client.callTool({
      name: "log_campaign_round",
      arguments: {
        id,
        hypothesis: "structure over phrasing",
        candidate_version: "1.0.1",
        baseline_scorecard_id: "sc-b",
        candidate_scorecard_id: "sc-c",
      },
    });
    expect(logged.isError).toBeFalsy();
    expect(JSON.parse(textOf(logged)).round.verdict.significantImprovements).toBe(1);

    const decision = await client.callTool({ name: "campaign_decision", arguments: { id } });
    expect(JSON.parse(textOf(decision)).kind).toBe("adopt");

    const settled = await client.callTool({ name: "settle_campaign", arguments: { id } });
    expect(settled.isError).toBeFalsy();
    expect(JSON.parse(textOf(settled)).record.state).toBe("adopted");
  });

  it("campaign_adoption reads the authorization and adopt_campaign_candidate SPENDS it", async () => {
    // The MCP half of the same protocol. arch-review 72 shipped the consumer with no caller on EITHER
    // transport; parity here means both reach the one service, never two implementations of it.
    const spec = AgentSpecSchema.parse({ id: "everdict", version: "1.0.1", instructions: "structure first" });
    const seeded = new InMemoryAgentRegistry();
    await seeded.register("acme", spec, "alice");
    const measured = contentDigest(await seeded.get("acme", "everdict", "1.0.1"));
    const agents = new InMemoryAgentRegistry();
    const client = await connect(makeDeps(agents, measured), ["member"]);

    const opened = await client.callTool({ name: "open_campaign", arguments: { issue_id: "iss_1", frame } });
    const { id } = JSON.parse(textOf(opened)) as { id: string };
    await client.callTool({
      name: "log_campaign_round",
      arguments: {
        id,
        hypothesis: "h",
        candidate_version: "1.0.1",
        baseline_scorecard_id: "sc-b",
        candidate_scorecard_id: "sc-c",
      },
    });
    await client.callTool({ name: "settle_campaign", arguments: { id } });

    const read = await client.callTool({ name: "campaign_adoption", arguments: { id } });
    const operation = JSON.parse(textOf(read)).operation as { state: string; proof: unknown };
    expect(operation.state, "an adopted campaign authorized nothing anybody could spend").toBe("decided");

    const adopted = await client.callTool({
      name: "adopt_campaign_candidate",
      arguments: { id, proof: JSON.stringify(operation.proof), spec: JSON.stringify(spec) },
    });
    expect(adopted.isError, textOf(adopted)).toBeFalsy();
    expect(JSON.parse(textOf(adopted)).kind).toBe("adopted");
    expect(await agents.has("acme", "everdict", "1.0.1"), "the registry never received the adopted version").toBe(true);

    // Spendable ONCE — an at-least-once retry converges rather than granting a second adoption.
    const again = await client.callTool({
      name: "adopt_campaign_candidate",
      arguments: { id, proof: JSON.stringify(operation.proof), spec: JSON.stringify(spec) },
    });
    expect(JSON.parse(textOf(again)).kind).toBe("already_adopted");
  });

  it("a premature settle is a CONFLICT the agent can read, and the campaign stays open", async () => {
    const client = await connect(makeDeps(), ["member"]);
    const opened = await client.callTool({ name: "open_campaign", arguments: { issue_id: "iss_1", frame } });
    const { id } = JSON.parse(textOf(opened)) as { id: string };
    const settled = await client.callTool({ name: "settle_campaign", arguments: { id } });
    expect(settled.isError).toBe(true);
    expect(textOf(settled)).toContain("CONFLICT");
    const read = await client.callTool({ name: "get_campaign", arguments: { id } });
    expect(JSON.parse(textOf(read)).state).toBe("open");
  });

  it("a viewer can read but not open — the write gate is scorecards:run", async () => {
    const deps = makeDeps();
    const member = await connect(deps, ["member"]);
    const opened = await member.callTool({ name: "open_campaign", arguments: { issue_id: "iss_1", frame } });
    expect(opened.isError).toBeFalsy();
    const viewer = await connect(deps, ["viewer"]);
    const list = await viewer.callTool({ name: "list_campaigns", arguments: {} });
    expect(list.isError).toBeFalsy();
    const denied = await viewer.callTool({ name: "open_campaign", arguments: { issue_id: "iss_1", frame } });
    expect(denied.isError).toBe(true);
  });
});

// The harness lane resolves through a template taxonomy; the agent lane drives the same closure, so these
// transport cases use it. `composition/adoption-is-spent.counterexample.test.ts` owns the closure itself.
function unusedHarnesses() {
  return {
    async register() {
      throw new Error("the harness lane is not exercised by these cases");
    },
    async get() {
      throw new Error("the harness lane is not exercised by these cases");
    },
  } as unknown as Parameters<typeof buildCampaignAdoption>[0]["harnesses"];
}

// The template half, unexercised for the same reason the harness lane is: resolving one needs a seeded
// taxonomy, and a double that skipped that would be testing a resolution production does not perform.
function unusedTemplates() {
  return {
    async get() {
      throw new Error("the harness lane is not exercised by these cases");
    },
  } as unknown as Parameters<typeof buildCampaignAdoption>[0]["templates"];
}

// An issue nobody has resolved — the ordinary case, and the one that leaves the completion join to the
// watcher. The cases that exercise the REVERSE ordering supply their own resolved issue.
function openIssue() {
  return {
    async get() {
      return { status: "in_progress" as const };
    },
  };
}
