import { RunService } from "@everdict/application-control";
import type { Principal } from "@everdict/auth";
import type { Dispatcher } from "@everdict/backends";
import { DatasetSchema, JudgeSpecSchema, RuntimeSpecSchema } from "@everdict/contracts";
import { InMemoryRunStore } from "@everdict/db";
import {
  InMemoryDatasetRegistry,
  InMemoryHarnessTemplateRegistry,
  InMemoryJudgeRegistry,
  InMemoryRuntimeRegistry,
} from "@everdict/registry";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { buildServer } from "../server.js";
import type { McpDeps } from "./mcp-context.js";

// ── [R119 COUNTEREXAMPLE] A PRIVATE TEAM'S ASSET IS 404 THROUGH EVERY DOOR, NOT MOST ────────────────
//
// `isPrivate` hides a team's work from everyone outside its roster, and the rule is that such an asset reads
// as one that does not exist (docs/auth.md §"The team axis"). Each resource enforces it at its PRIMARY read
// — `get_dataset`, `get_judge`, `get_runtime`, `GET /harnesses/:id` all call `assertEntityVisible` — and the
// SECONDARY read beside it did not:
//
//     GET /datasets/:id/diff            ✓        diff_datasets            ✗   ← BFF↔MCP parity break
//     GET /judges/:id/diff              ✓        diff_judge_versions      ✗   ← BFF↔MCP parity break
//     GET /runtimes/:id/…/inspect       ✗        inspect_runtime          ✗   ← both, sibling deviation
//     GET /harness-templates/:id/:ver   ✓        GET /harness-templates/:id ✗ ← sibling deviation
//
// A diff returns the full content of both versions and an inspect returns the resolved spec, so these are
// not narrower reads that happen to skip a guard — they are the same bytes through a second door. The
// one-lane-only shape on the READ axis, where it is easier to miss because nothing fails loudly: the caller
// simply gets an answer.
//
// Seen RED before the fix, all four:
//   "a private team's dataset was diffed by an outsider: expected false to be true"

const PRIVATE = "team-secret";
const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("unused");
  },
};

// The one place privacy is decided. `canSeeTeam` is false for the private team and true for everything else,
// which is exactly the shape `TeamService` produces for a non-member.
const teamService = {
  async resolveId(_t: string, ref: string) {
    return ref;
  },
  async visibleTeamIds() {
    return []; // nothing is visible to this caller — the private team is the only owner here
  },
  async canSeeTeam(_t: string, teamId: string) {
    return teamId !== PRIVATE;
  },
  async list() {
    return [{ id: PRIVATE }];
  },
};

const dataset = (version: string) =>
  DatasetSchema.parse({
    id: "swe-mini",
    version,
    cases: [{ id: "c1", env: { kind: "prompt" }, task: "hi", graders: [] }],
  });
const judge = (version: string) =>
  JudgeSpecSchema.parse({ id: "quality", version, kind: "model", model: "claude-opus-4-8", rubric: "be strict" });
const runtime = (version: string) =>
  RuntimeSpecSchema.parse({ id: "seoul", version, kind: "nomad", addr: "http://nomad:4646", image: "x/y:1" });

async function world() {
  const datasets = new InMemoryDatasetRegistry();
  const judges = new InMemoryJudgeRegistry();
  const runtimes = new InMemoryRuntimeRegistry();
  const templates = new InMemoryHarnessTemplateRegistry();
  await datasets.register("acme", dataset("1.0.0"), "u-a", PRIVATE);
  await datasets.register("acme", dataset("1.1.0"), "u-a", PRIVATE);
  await judges.register("acme", judge("1.0.0"), "u-a", PRIVATE);
  await judges.register("acme", judge("1.1.0"), "u-a", PRIVATE);
  await runtimes.register("acme", runtime("1.0.0"), "u-a", PRIVATE);
  await templates.register(
    "acme",
    { id: "bu", version: "1.0.0", kind: "process", command: "x" } as never,
    "u-a",
    PRIVATE,
  );
  return { datasets, judges, runtimes, templates };
}

const OUTSIDER: Principal = { subject: "u-b", workspace: "acme", roles: ["member"], via: "oidc", teams: ["team-b"] };

// ⚠️ WIRED, because both inspect doors are feature-gated on it. The first draft of this file omitted it and
// the two runtime cases "passed" on `{ code: "NOT_FOUND", message: "inspect not configured" }` — a control
// that passes on an error proves nothing about the gate it is the control for (rule `testing`). It must
// answer, so the refusal under test is the team's and not the composition's.
const inspectRuntime = async () => ({ reachable: true, nodes: [] });

async function mcp(deps: Record<string, unknown>): Promise<Client> {
  // biome-ignore lint/suspicious/noExplicitAny: only the registries these tools reach are wired
  const server = (await import("../mcp.js")).buildMcpServer({ ...deps, teamService } as any as McpDeps, OUTSIDER);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await server.connect(serverT);
  await client.connect(clientT);
  return client;
}

const isRefusal = (r: unknown): boolean => {
  const text = ((r as { content?: { text?: string }[] }).content ?? []).map((c) => c.text ?? "").join("");
  return (r as { isError?: boolean }).isError === true && /NOT_FOUND|not found/i.test(text);
};

type ServerOptions = Parameters<typeof buildServer>[0];

// ⚠️ `requireAuth` + a MEMBER authenticator, because the dev-header fallback hands out `roles: ["admin"]` and
// an admin sees every team by design — an admin fixture would "pass" by bypassing the guard under test. Both
// collaborators are named through the options type rather than `as any`, so a field either side stops
// declaring is a compile error here instead of a silently ignored key.
const outsiderAuthenticator: NonNullable<ServerOptions["authenticator"]> = {
  async authenticate() {
    return OUTSIDER;
  },
} as unknown as NonNullable<ServerOptions["authenticator"]>;

function http(deps: Record<string, unknown>) {
  return buildServer({
    service: new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() }),
    ...deps,
    teamService: teamService as unknown as NonNullable<ServerOptions["teamService"]>,
    requireAuth: true,
    authenticator: outsiderAuthenticator,
  } as unknown as ServerOptions);
}
const AUTH = { authorization: "Bearer t" };

describe("[R119 COUNTEREXAMPLE] a private team's asset is not readable through the secondary door", () => {
  it("diff_datasets refuses — the MCP twin of a route that already refuses", async () => {
    const { datasets } = await world();
    const client = await mcp({ datasetRegistry: datasets });
    const res = await client.callTool({
      name: "diff_datasets",
      arguments: { id: "swe-mini", base: "1.0.0", candidate: "1.1.0" },
    });
    expect(isRefusal(res), "a private team's dataset was diffed by an outsider").toBe(true);
  });

  it("diff_judge_versions refuses — same pair, same break", async () => {
    const { judges } = await world();
    const client = await mcp({ judgeRegistry: judges });
    const res = await client.callTool({
      name: "diff_judge_versions",
      arguments: { id: "quality", base: "1.0.0", candidate: "1.1.0" },
    });
    expect(isRefusal(res), "a private team's judge was diffed by an outsider").toBe(true);
  });

  it("inspect_runtime refuses — the door its own get_runtime sibling already guards", async () => {
    const { runtimes } = await world();
    const client = await mcp({ runtimeRegistry: runtimes, inspectRuntime });
    const res = await client.callTool({ name: "inspect_runtime", arguments: { id: "seoul", version: "1.0.0" } });
    expect(isRefusal(res), "a private team's runtime was inspected by an outsider").toBe(true);
  });

  it("GET /runtimes/:id/versions/:version/inspect refuses — the HTTP half of the same door", async () => {
    const { runtimes } = await world();
    const res = await http({ runtimeRegistry: runtimes, inspectRuntime }).inject({
      method: "GET",
      url: "/runtimes/seoul/versions/1.0.0/inspect",
      headers: AUTH,
    });
    expect(res.statusCode, "a private team's runtime was inspected over HTTP").toBe(404);
  });

  // ⚠️ `POST /runtimes/:id/versions/:version/control` LOOKS like one of these and is not. Its vocabulary is
  // `stopWorkload` / `reclaimIdle` / `cordonNode` — a live cluster drain — and it is gated on
  // `runtimes:control`, which the role matrix makes ADMIN-ONLY. An admin reaches every team by design
  // (docs/auth.md), so the role already answers a strictly harder question and a team scope on top would be
  // asking for less. Two cases here asserted it refused a member and were removed: the member never reaches
  // it, so what they measured was the role gate wearing this file's name.
  it("GET /harness-templates/:id refuses — its per-version sibling already does", async () => {
    const { templates } = await world();
    const res = await http({ harnessTemplates: templates }).inject({
      method: "GET",
      url: "/harness-templates/bu",
      headers: AUTH,
    });
    expect(res.statusCode, "a private team's template versions were listed by an outsider").toBe(404);
  });
});
