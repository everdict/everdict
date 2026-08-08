import { effectsRequireConsent } from "@everdict/contracts";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { describe, expect, it, vi } from "vitest";
import {
  type McpClientBox,
  bridgedEffectsFor,
  dockerRunArgs,
  imageAllowed,
  isBaseToolReadOnly,
  isDefaultBaseTool,
  makeInvoke,
  stdioEnv,
} from "./mcp-tools.js";

// The base control-plane surface is bridge-all: every entity's reads AND mutations reach the agent, and safety lives
// in the layers (RBAC + the session's permission mode over the gate), not in surface shaping. These predicates are
// the SSOT for what is bridged and which calls skip the permission gate.
describe("base tool default wiring", () => {
  it("bridges reads and mutations alike (the whole catalog is the default surface)", () => {
    for (const name of [
      // reads
      "list_ci_links",
      "get_workspace_mattermost",
      "inspect_trace",
      "list_workspace_image_registries",
      // integration actions
      "post_mattermost_message",
      "open_ci_setup_pr",
      "create_github_issue",
      "open_github_pr",
      // eval-driving mutations (previously behind the eval-drive opt-in)
      "run_scorecard",
      "create_dataset",
      "pin_harness_images",
      "create_schedule",
      // destructive / governance verbs — bridged too; the permission mode decides per call
      "delete_scorecard",
      "remove_member",
      "set_secret",
      "set_workspace_mattermost",
      // knowledge reads + writes
      "knowledge_related",
      "annotate_knowledge",
      "relate_knowledge",
      // the workspace filesystem — reads and writes alike
      "list_files",
      "get_file",
      "write_file",
    ])
      expect(isDefaultBaseTool(name)).toBe(true);
  });

  it("excludes only the runner wire-protocol tools from bridging", () => {
    for (const name of [
      "lease_job",
      "submit_job_result",
      "heartbeat_job",
      "fail_job",
      "report_case_log",
      "report_case_screen",
      "report_case_track",
    ])
      expect(isDefaultBaseTool(name)).toBe(false);
  });

  it("classifies pure read verbs (and the knowledge reads) as gate-skipping read-only", () => {
    for (const name of [
      "list_ci_links",
      "inspect_trace",
      "get_knowledge_node",
      "knowledge_related",
      "knowledge_subgraph",
      "knowledge_notes",
      // knowledge-layer reads: context assembly + entry reads (get_/list_ verbs)
      "get_task_context",
      "list_knowledge_entries",
      "get_knowledge_entry",
      // workspace-filesystem reads (list_/get_ verbs)
      "list_files",
      "get_file",
      "get_fs_usage",
    ])
      expect(isBaseToolReadOnly(name)).toBe(true);
  });

  it("keeps every mutation permission-gated — including the credential-minting get_ read", () => {
    for (const name of [
      "get_image_push_credentials", // matches get_ but MINTS credentials
      "post_mattermost_message",
      "open_ci_setup_pr",
      "create_github_issue",
      "comment_on_github_issue",
      "open_github_pr",
      "run_scorecard",
      "delete_dataset",
      "set_secret",
      "annotate_knowledge",
      "relate_knowledge",
      "reindex_knowledge",
      // knowledge-entry writes — contributions stay HITL under the session's permission mode
      "create_knowledge_entry",
      "update_knowledge_entry",
      "verify_knowledge_entry",
      "verify_skill",
      // workspace-filesystem writes — permission-gated; the delete_ verbs additionally match the guarded prefix
      "write_file",
      "make_directory",
      "move_file",
      "delete_file",
      "delete_all_files",
    ])
      expect(isBaseToolReadOnly(name)).toBe(false);
  });
});

describe("bridgedEffectsFor — unknown egress is not a plain read", () => {
  it("an UNDECLARED remote read-only server synthesizes the structural egress — and it demands consent", () => {
    // Regression (O5): needsPermit short-circuits on effects === undefined, and read-only MCP servers never
    // required a declaration — so a remote server shipped model-chosen workspace data to an external URL as
    // a plain safe read. The transport being remote is a structural fact, not a guess.
    const effects = bridgedEffectsFor({ kind: "http", write: false });
    expect(effects).toEqual({ sideEffect: "none", dataAccess: { egress: "external" } });
    expect(effects && effectsRequireConsent(effects)).toBe(true);
  });

  it("the author's own declaration always wins over the synthesized one", () => {
    const declared = { sideEffect: "none" as const, dataAccess: { egress: "none" as const } };
    expect(bridgedEffectsFor({ kind: "http", write: false, effects: declared })).toBe(declared);
  });

  it("a local stdio server and a write-capable server synthesize nothing", () => {
    expect(bridgedEffectsFor({ kind: "stdio", write: false })).toBeUndefined();
    // write=true is permit-gated by isReadOnly already; its declaration is the registration guard's job.
    expect(bridgedEffectsFor({ kind: "http", write: true })).toBeUndefined();
  });
});

describe("dockerRunArgs — containerized stdio MCP transport", () => {
  it("assembles `docker run --rm -i --env NAME … <image> [args]`, passing secret NAMES only (values never on argv)", () => {
    const argv = dockerRunArgs({
      image: "grafana/mcp-grafana",
      args: ["-t", "stdio"],
      env: { GRAFANA_URL: "https://g.example.com", GRAFANA_SERVICE_ACCOUNT_TOKEN: "glsa_secret" },
    });
    expect(argv).toEqual([
      "run",
      "--rm",
      "-i",
      "--init",
      "--env",
      "GRAFANA_URL",
      "--env",
      "GRAFANA_SERVICE_ACCOUNT_TOKEN",
      "grafana/mcp-grafana",
      "-t",
      "stdio",
    ]);
    // The secret VALUES never appear on argv (no `NAME=value`) — they ride in the spawned docker process's env.
    const joined = argv.join(" ");
    expect(joined).not.toContain("glsa_secret");
    expect(joined).not.toContain("https://g.example.com");
  });

  it("assembles a bare `docker run --rm -i --init <image>` with no secrets and no args", () => {
    expect(dockerRunArgs({ image: "mcr.microsoft.com/playwright/mcp", args: [], env: {} })).toEqual([
      "run",
      "--rm",
      "-i",
      "--init",
      "mcr.microsoft.com/playwright/mcp",
    ]);
  });
});

describe("imageAllowed — operator stdio image allowlist", () => {
  it("permits any image when the allowlist is empty (no restriction)", () => {
    expect(imageAllowed("grafana/mcp-grafana", [])).toBe(true);
  });

  it("matches an exact repo, with or without a tag/digest", () => {
    const allow = ["crystaldba/postgres-mcp"];
    expect(imageAllowed("crystaldba/postgres-mcp", allow)).toBe(true);
    expect(imageAllowed("crystaldba/postgres-mcp:latest", allow)).toBe(true);
    expect(imageAllowed("crystaldba/postgres-mcp@sha256:abc", allow)).toBe(true);
    expect(imageAllowed("evil/postgres-mcp", allow)).toBe(false);
  });

  it("matches a trailing-slash repo prefix (a whole namespace)", () => {
    const allow = ["mcr.microsoft.com/playwright/"];
    expect(imageAllowed("mcr.microsoft.com/playwright/mcp", allow)).toBe(true);
    expect(imageAllowed("mcr.microsoft.com/other/mcp", allow)).toBe(false);
  });

  it("refuses an image that is on no allowlist entry", () => {
    expect(imageAllowed("attacker/backdoor", ["grafana/mcp-grafana", "crystaldba/"])).toBe(false);
  });
});

describe("stdioEnv — the docker CLI process environment", () => {
  it("carries the bound secrets + HOME + PATH, and does not leak the agent's own env vars", () => {
    vi.stubEnv("SECRET_ON_AGENT", "leak-me");
    vi.stubEnv("AWS_ACCESS_KEY_ID", "leak-too");
    const env = stdioEnv({ DATABASE_URI: "postgres://u:p@h/db" });
    expect(env.DATABASE_URI).toBe("postgres://u:p@h/db"); // bound secret → passed to the container via --env NAME
    if (process.env.PATH) expect(env.PATH).toBe(process.env.PATH); // forwarded so the docker CLI resolves
    if (process.env.HOME) expect(env.HOME).toBe(process.env.HOME); // forwarded → private image pulls via host `docker login`
    // The docker CLI env is exactly {bound secrets} + PATH/HOME — the agent's OWN secrets are never forwarded.
    const allowed = new Set(["DATABASE_URI", "PATH", "HOME"]);
    expect(Object.keys(env).every((k) => allowed.has(k))).toBe(true);
    expect(env.SECRET_ON_AGENT).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    vi.unstubAllEnvs();
  });
});

describe("makeInvoke — resilient MCP invocation (reconnect through a dead session)", () => {
  // A minimal fake with the two members makeInvoke touches. Cast once at the seam.
  type FakeClient = {
    callTool: (req: { name: string; arguments?: unknown }) => Promise<unknown>;
    close: () => Promise<void>;
  };
  const asClient = (c: FakeClient): Client => c as unknown as Client;
  const ok = (text: string) => ({ content: [{ type: "text", text }], isError: false });

  it("retries a READ call once on a fresh session after a transport death", async () => {
    // Given a live client whose session dies mid-turn, and a connect() that yields a healthy replacement
    const dead: FakeClient = {
      callTool: async () => {
        throw new Error("Not connected");
      },
      close: async () => {},
    };
    const healthy: FakeClient = { callTool: async () => ok("fresh answer"), close: async () => {} };
    const box: McpClientBox = { current: asClient(dead) };
    const invoke = makeInvoke(
      box,
      async () => asClient(healthy),
      () => true,
    );
    // When a read tool is invoked, Then the call transparently succeeds on the reconnected session
    const result = await invoke("get_run", { id: "r1" });
    expect(result).toEqual({ content: "fresh answer", isError: false });
    expect(box.current).toBe(asClient(healthy)); // the box now serves the fresh session
  });

  it("does NOT auto-retry a MUTATING call — the healed session serves later calls, the model gets an explicit error", async () => {
    let freshCalls = 0;
    const dead: FakeClient = {
      callTool: async () => {
        throw new Error("Not connected");
      },
      close: async () => {},
    };
    const healthy: FakeClient = {
      callTool: async () => {
        freshCalls += 1;
        return ok("should not run for the failed mutation");
      },
      close: async () => {},
    };
    const box: McpClientBox = { current: asClient(dead) };
    const invoke = makeInvoke(
      box,
      async () => asClient(healthy),
      () => false,
    );
    // When a mutating tool call dies in flight
    const result = await invoke("create_dataset", { id: "d1" });
    // Then it is NOT silently re-fired (its first attempt may have landed) — the model is told to verify
    expect(result.isError).toBe(true);
    expect(result.content).toContain("NOT retried automatically");
    expect(freshCalls).toBe(0);
    // …but the session IS healed for the calls that follow
    expect(box.current).toBe(asClient(healthy));
    expect(await invoke("create_dataset", { id: "d2" })).toEqual({
      content: "should not run for the failed mutation",
      isError: false,
    });
  });

  it("shares ONE in-flight reconnect across concurrently-failing calls (no reconnect storm)", async () => {
    let connects = 0;
    const dead: FakeClient = {
      callTool: async () => {
        throw new Error("fetch failed");
      },
      close: async () => {},
    };
    const healthy: FakeClient = { callTool: async () => ok("x"), close: async () => {} };
    const box: McpClientBox = { current: asClient(dead) };
    const invoke = makeInvoke(
      box,
      async () => {
        connects += 1;
        await new Promise((r) => setTimeout(r, 5)); // keep the reconnect in flight while both calls fail
        return asClient(healthy);
      },
      () => true,
    );
    await Promise.all([invoke("get_a", {}), invoke("get_b", {})]);
    expect(connects).toBe(1);
  });

  it("a tool-level isError RESULT does not trigger a reconnect (only a transport throw does)", async () => {
    let connects = 0;
    const client: FakeClient = {
      callTool: async () => ({ content: [{ type: "text", text: "no such run" }], isError: true }),
      close: async () => {},
    };
    const box: McpClientBox = { current: asClient(client) };
    const invoke = makeInvoke(
      box,
      async () => {
        connects += 1;
        return asClient(client);
      },
      () => true,
    );
    const result = await invoke("get_run", { id: "nope" });
    expect(result).toEqual({ content: "no such run", isError: true });
    expect(connects).toBe(0);
  });
});
