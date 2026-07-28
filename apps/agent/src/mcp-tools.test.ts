import { describe, expect, it, vi } from "vitest";
import { dockerRunArgs, imageAllowed, isBaseToolReadOnly, isDefaultBaseTool, stdioEnv } from "./mcp-tools.js";

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
    ])
      expect(isBaseToolReadOnly(name)).toBe(false);
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
