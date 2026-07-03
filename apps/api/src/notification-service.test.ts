import { InMemoryNotificationStore } from "@assay/db";
import type { ConnectionMeta, ConnectionToken, RunRecord, WorkspaceSettings } from "@assay/db";
import { describe, expect, it } from "vitest";
import { NotificationService } from "./notification-service.js";

const mmConn: ConnectionMeta = {
  id: "c-mm",
  provider: "mattermost",
  host: "https://mm.acme.io",
  accountLabel: "alice",
  scopes: [],
  connectedAt: "2026-01-01T00:00:00Z",
};
const ghConn: ConnectionMeta = {
  id: "c-gh",
  provider: "github",
  accountLabel: "octocat",
  scopes: [],
  connectedAt: "2026-01-01T00:00:00Z",
};

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
  body: { channel_id?: string; message?: string };
  auth?: string;
}

function build(opts: {
  notify?: WorkspaceSettings["notify"];
  conns?: ConnectionMeta[];
  token?: ConnectionToken | null; // undefined → 기본 토큰 있음, null → 토큰 없음
  fetchImpl?: typeof fetch;
}) {
  const calls: PostCall[] = [];
  const recording = ((url: string | URL, init?: { body?: string; headers?: Record<string, string> }) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body ?? "{}"), auth: init?.headers?.authorization });
    return Promise.resolve(new Response("{}"));
  }) as unknown as typeof fetch;
  const feed = new InMemoryNotificationStore();
  const svc = new NotificationService({
    settingsFor: async () => (opts.notify ? { notify: opts.notify } : {}),
    connections: {
      list: async () => opts.conns ?? [],
      tokenFor: async () => (opts.token === undefined ? { accessToken: "mm_tok" } : opts.token),
    },
    feed,
    fetch: opts.fetchImpl ?? recording,
  });
  return { svc, calls, feed };
}

describe("NotificationService.notifyRun (Mattermost)", () => {
  it("notify 설정 + Mattermost 연결 + 토큰 → 채널에 게시", async () => {
    const { svc, calls } = build({
      notify: { connectionId: "c-mm", channelId: "chan-1", ownerSubject: "u-alice" },
      conns: [mmConn],
    });
    await svc.notifyRun("acme", runRec("succeeded"));
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://mm.acme.io/api/v4/posts");
    expect(calls[0]?.auth).toBe("Bearer mm_tok");
    expect(calls[0]?.body.channel_id).toBe("chan-1");
    expect(calls[0]?.body.message).toContain("succeeded");
    expect(calls[0]?.body.message).toContain("run-1");
  });

  it("notify 미설정 → 게시 안 함", async () => {
    const { svc, calls } = build({ conns: [mmConn] });
    await svc.notifyRun("acme", runRec("succeeded"));
    expect(calls).toHaveLength(0);
  });

  it("연결이 Mattermost 가 아니면(예: github) 게시 안 함", async () => {
    const { svc, calls } = build({
      notify: { connectionId: "c-gh", channelId: "x", ownerSubject: "u-alice" },
      conns: [ghConn],
    });
    await svc.notifyRun("acme", runRec("failed"));
    expect(calls).toHaveLength(0);
  });

  it("토큰이 없으면 게시 안 함", async () => {
    const { svc, calls } = build({
      notify: { connectionId: "c-mm", channelId: "x", ownerSubject: "u-alice" },
      conns: [mmConn],
      token: null,
    });
    await svc.notifyRun("acme", runRec("succeeded"));
    expect(calls).toHaveLength(0);
  });

  it("ownerSubject 없는 구 설정 → 누구 토큰인지 모르므로 게시 안 함(graceful skip)", async () => {
    const { svc, calls } = build({ notify: { connectionId: "c-mm", channelId: "x" }, conns: [mmConn] });
    await svc.notifyRun("acme", runRec("succeeded"));
    expect(calls).toHaveLength(0);
  });

  it("게시 실패는 swallow (throw 안 함 — run 결과 무관)", async () => {
    const failing = (() => Promise.reject(new Error("network"))) as unknown as typeof fetch;
    const { svc } = build({
      notify: { connectionId: "c-mm", channelId: "x", ownerSubject: "u-alice" },
      conns: [mmConn],
      fetchImpl: failing,
    });
    await expect(svc.notifyRun("acme", runRec("succeeded"))).resolves.toBeUndefined();
  });
});

describe("NotificationService 개인 피드(벨 인박스) — notifications N1/N2", () => {
  it("createdBy 있는 최상위 run 완료 → 실행자 피드에 적재(링크=runId)", async () => {
    const { svc } = build({});
    await svc.notifyRun("acme", { ...runRec("succeeded"), createdBy: "alice" });
    const rows = await svc.listFeed("alice", "acme");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "run_completed", link: { runId: "run-1" }, recipient: "alice" });
  });

  it("실패 run 은 run_failed 로, 다른 사람/다른 워크스페이스에는 안 보인다", async () => {
    const { svc } = build({});
    await svc.notifyRun("acme", { ...runRec("failed"), createdBy: "alice" });
    expect((await svc.listFeed("alice", "acme"))[0]?.kind).toBe("run_failed");
    expect(await svc.listFeed("bob", "acme")).toHaveLength(0);
    expect(await svc.listFeed("alice", "other")).toHaveLength(0);
  });

  it("스코어카드 자식 run 과 createdBy 없는 run 은 피드에 적재하지 않는다(범람 방지/수신자 불명)", async () => {
    const { svc } = build({});
    await svc.notifyRun("acme", { ...runRec("succeeded"), createdBy: "alice", parentScorecardId: "sc-1" });
    await svc.notifyRun("acme", runRec("succeeded"));
    expect(await svc.listFeed("alice", "acme")).toHaveLength(0);
  });

  it("스코어카드 완료 → scorecard_completed(링크=scorecardId) + 읽음 처리(markFeedRead)", async () => {
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
    expect(await svc.markFeedRead("alice", "acme", "all")).toBe(0); // 멱등
  });

  it("예약 회귀 → schedule_regression 이 예약 생성자 피드로", async () => {
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
