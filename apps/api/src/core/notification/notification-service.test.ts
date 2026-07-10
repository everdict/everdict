import { InMemoryNotificationStore } from "@everdict/db";
import type { RunRecord, WorkspaceSettings } from "@everdict/db";
import { describe, expect, it } from "vitest";
import { mattermostHttpClient } from "../../infrastructure/mattermost/mattermost-client.js";
import { NotificationService } from "./notification-service.js";

const runRec = (status: "succeeded" | "failed"): RunRecord => ({
  id: "run-1",
  tenant: "acme",
  harness: { id: "scripted", version: "0" },
  caseId: "c1",
  status,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
});

interface PostCall {
  url: string;
  body: {
    channel_id?: string;
    message?: string;
    props?: {
      attachments?: Array<{
        actions?: Array<{ name?: string; integration?: { url?: string; context?: Record<string, unknown> } }>;
      }>;
    };
  };
  auth?: string;
}

function build(opts: {
  mattermost?: WorkspaceSettings["mattermost"]; // workspace registration (bot token)
  secrets?: Record<string, string>; // botTokenSecretName → value
  apiPublicUrl?: string; // enables the interactive Rerun button on completion posts
  fetchImpl?: typeof fetch;
}) {
  const calls: PostCall[] = [];
  const recording = ((url: string | URL, init?: { body?: string; headers?: Record<string, string> }) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}"), auth: init?.headers?.authorization });
    return Promise.resolve(new Response("{}"));
  }) as unknown as typeof fetch;
  const feed = new InMemoryNotificationStore();
  const svc = new NotificationService({
    settingsFor: async () => (opts.mattermost !== undefined ? { mattermost: opts.mattermost } : {}),
    secretsFor: async () => opts.secrets ?? {},
    feed,
    mattermost: mattermostHttpClient(opts.fetchImpl ?? recording),
    ...(opts.apiPublicUrl ? { apiPublicUrl: opts.apiPublicUrl } : {}),
  });
  return { svc, calls, feed };
}

describe("NotificationService.notifyRun (workspace Mattermost bot)", () => {
  const mm = { host: "https://mm.corp.io", botTokenSecretName: "MM_BOT", defaultChannelId: "ch-ops" };

  it("workspace registration (bot token + defaultChannelId) → posts to the channel with the bot token", async () => {
    const { svc, calls } = build({ mattermost: mm, secrets: { MM_BOT: "botxyz" } });
    await svc.notifyRun("acme", runRec("succeeded"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://mm.corp.io/api/v4/posts");
    expect(calls[0]?.auth).toBe("Bearer botxyz");
    expect(calls[0]?.body.channel_id).toBe("ch-ops");
    expect(calls[0]?.body.message).toContain("succeeded");
    expect(calls[0]?.body.message).toContain("run-1");
  });

  it("Mattermost unset → does not post", async () => {
    const { svc, calls } = build({});
    await svc.notifyRun("acme", runRec("succeeded"));
    expect(calls).toHaveLength(0);
  });

  it("does not post if the bot token is missing from the SecretStore (graceful skip)", async () => {
    const { svc, calls } = build({ mattermost: mm, secrets: {} });
    await svc.notifyRun("acme", runRec("succeeded"));
    expect(calls).toHaveLength(0);
  });

  it("does not post if defaultChannelId is unset", async () => {
    const { svc, calls } = build({
      mattermost: { host: "https://mm.corp.io", botTokenSecretName: "MM_BOT" },
      secrets: { MM_BOT: "botxyz" },
    });
    await svc.notifyRun("acme", runRec("succeeded"));
    expect(calls).toHaveLength(0);
  });

  it("swallows post failures (no throw — unrelated to the run result)", async () => {
    const failing = (() => Promise.reject(new Error("network"))) as unknown as typeof fetch;
    const { svc } = build({ mattermost: mm, secrets: { MM_BOT: "botxyz" }, fetchImpl: failing });
    await expect(svc.notifyRun("acme", runRec("succeeded"))).resolves.toBeUndefined();
  });
});

describe("NotificationService personal feed (bell inbox) — notifications N1/N2", () => {
  it("top-level run with createdBy completes → written to the initiator's feed (link=runId)", async () => {
    const { svc } = build({});
    await svc.notifyRun("acme", { ...runRec("succeeded"), createdBy: "alice" });
    const rows = await svc.listFeed("alice", "acme");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "run_completed", link: { runId: "run-1" }, recipient: "alice" });
  });

  it("a failed run becomes run_failed, and is not visible to other people / other workspaces", async () => {
    const { svc } = build({});
    await svc.notifyRun("acme", { ...runRec("failed"), createdBy: "alice" });
    expect((await svc.listFeed("alice", "acme"))[0]?.kind).toBe("run_failed");
    expect(await svc.listFeed("bob", "acme")).toHaveLength(0);
    expect(await svc.listFeed("alice", "other")).toHaveLength(0);
  });

  it("does not write scorecard child runs or runs without createdBy to the feed (flood prevention / unknown recipient)", async () => {
    const { svc } = build({});
    await svc.notifyRun("acme", { ...runRec("succeeded"), createdBy: "alice", parentScorecardId: "sc-1" });
    await svc.notifyRun("acme", runRec("succeeded"));
    expect(await svc.listFeed("alice", "acme")).toHaveLength(0);
  });

  it("scorecard completes → scorecard_completed (link=scorecardId) + mark-read (markFeedRead)", async () => {
    const { svc } = build({});
    await svc.notifyScorecard("acme", {
      id: "sc-9",
      status: "succeeded",
      dataset: { id: "d", version: "1" },
      harness: { id: "h", version: "2" },
      createdBy: "alice",
    });
    const rows = await svc.listFeed("alice", "acme", { unreadOnly: true });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "scorecard_completed", link: { scorecardId: "sc-9" } });
    expect(await svc.markFeedRead("alice", "acme", "all")).toBe(1);
    expect(await svc.listFeed("alice", "acme", { unreadOnly: true })).toHaveLength(0);
    expect(await svc.markFeedRead("alice", "acme", "all")).toBe(0); // idempotent
  });

  it("scheduled regression → schedule_regression goes to the schedule creator's feed", async () => {
    const { svc } = build({});
    await svc.notifyRegression("acme", {
      scheduleName: "nightly",
      scorecardId: "sc-2",
      previousScorecardId: "sc-1",
      regressions: [{ caseId: "c1", metric: "tests_pass", baseline: 1, candidate: 0 }],
      createdBy: "alice",
    });
    expect((await svc.listFeed("alice", "acme"))[0]?.kind).toBe("schedule_regression");
  });
});

describe("NotificationService — interactive Rerun button on scorecard completion posts", () => {
  const scorecard = {
    id: "sc-1",
    status: "succeeded",
    dataset: { id: "webvoyager", version: "1.0.0" },
    harness: { id: "browser-use", version: "2.0.0" },
  };

  it("with inbound configured (commandTokenSecretName) + a public URL, the post carries a Rerun action with the embedded context", async () => {
    const { svc, calls } = build({
      mattermost: {
        host: "https://mm.corp.io",
        botTokenSecretName: "MM_BOT",
        defaultChannelId: "ch-ops",
        commandTokenSecretName: "MM_CMD",
      },
      secrets: { MM_BOT: "botxyz", MM_CMD: "cmd-secret" },
      apiPublicUrl: "https://everdict.corp.io/",
    });
    await svc.notifyScorecard("acme", scorecard);
    const action = calls[0]?.body.props?.attachments?.[0]?.actions?.[0];
    expect(action?.name).toBe("Rerun");
    expect(action?.integration?.url).toBe("https://everdict.corp.io/integrations/mattermost/action?ws=acme");
    // The click echoes this context back — the same token the inbound verifier checks, plus the rerun coordinates.
    expect(action?.integration?.context).toEqual({
      token: "cmd-secret",
      action: "rerun",
      dataset: "webvoyager",
      harness: "browser-use",
    });
  });

  it("without inbound config or without a public URL, the post stays a plain message (no dead button)", async () => {
    const noInbound = build({
      mattermost: { host: "https://mm.corp.io", botTokenSecretName: "MM_BOT", defaultChannelId: "ch-ops" },
      secrets: { MM_BOT: "botxyz" },
      apiPublicUrl: "https://everdict.corp.io",
    });
    await noInbound.svc.notifyScorecard("acme", scorecard);
    expect(noInbound.calls[0]?.body.props).toBeUndefined();

    const noUrl = build({
      mattermost: {
        host: "https://mm.corp.io",
        botTokenSecretName: "MM_BOT",
        defaultChannelId: "ch-ops",
        commandTokenSecretName: "MM_CMD",
      },
      secrets: { MM_BOT: "botxyz", MM_CMD: "cmd-secret" },
    });
    await noUrl.svc.notifyScorecard("acme", scorecard);
    expect(noUrl.calls[0]?.body.props).toBeUndefined();
  });
});
