import { describe, expect, it, vi } from "vitest";
import { NotificationWatcher, type WatcherNotification, notificationPathOf } from "./notification-watcher.js";

const row = (id: string, createdAt: string): Record<string, unknown> => ({
  id,
  workspace: "acme",
  recipient: "alice",
  kind: "run_completed",
  title: `Run completed — ${id}`,
  createdAt,
});

function build(responses: Array<Record<string, unknown>[]>) {
  let call = 0;
  const fired: WatcherNotification[] = [];
  let cursor: string | undefined;
  let tick: (() => void) | undefined;
  const watcher = new NotificationWatcher({
    callJson: async () => ({ notifications: responses[Math.min(call++, responses.length - 1)] ?? [] }),
    notify: (n) => fired.push(n),
    loadCursor: () => cursor,
    saveCursor: (iso) => {
      cursor = iso;
    },
    schedule: (fn) => {
      tick = fn;
      return () => {};
    },
  });
  return { watcher, fired, getCursor: () => cursor, tick: () => tick?.() };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("NotificationWatcher — desktop independent notifications (N6)", () => {
  it("does not fire the unread backlog on the first poll, only sets the cursor", async () => {
    const { watcher, fired, getCursor } = build([[row("a", "2026-01-01T00:00:00Z"), row("b", "2026-01-01T01:00:00Z")]]);
    watcher.start();
    await flush();
    expect(fired).toHaveLength(0);
    expect(getCursor()).toBe("2026-01-01T01:00:00Z");
    watcher.stop();
  });

  it("fires only notifications after the cursor, oldest-first, and advances the cursor", async () => {
    const { watcher, fired, getCursor, tick } = build([
      [row("a", "2026-01-01T00:00:00Z")],
      [row("c", "2026-01-01T03:00:00Z"), row("b", "2026-01-01T02:00:00Z"), row("a", "2026-01-01T00:00:00Z")],
    ]);
    watcher.start();
    await flush();
    tick();
    await flush();
    expect(fired.map((f) => f.id)).toEqual(["b", "c"]);
    expect(getCursor()).toBe("2026-01-01T03:00:00Z");
    watcher.stop();
  });

  it("even starting from an empty feed, the first later notification fires (empty first poll → cursor pinned)", async () => {
    const { watcher, fired, tick } = build([[], [row("x", "2026-01-01T05:00:00Z")]]);
    watcher.start();
    await flush();
    expect(fired).toHaveLength(0);
    tick();
    await flush();
    expect(fired.map((f) => f.id)).toEqual(["x"]);
    watcher.stop();
  });

  it("on restart (with a saved cursor), does not re-fire already-fired unread items", async () => {
    let cursor: string | undefined = "2026-01-01T03:00:00Z";
    const fired: WatcherNotification[] = [];
    const watcher = new NotificationWatcher({
      callJson: async () => ({ notifications: [row("b", "2026-01-01T02:00:00Z"), row("c", "2026-01-01T03:00:00Z")] }),
      notify: (n) => fired.push(n),
      loadCursor: () => cursor,
      saveCursor: (iso) => {
        cursor = iso;
      },
      schedule: () => () => {},
    });
    watcher.start();
    await flush();
    expect(fired).toHaveLength(0);
    watcher.stop();
  });

  it("swallows a poll failure (retries next cycle) and honors the firing cap", async () => {
    const fired: WatcherNotification[] = [];
    let call = 0;
    const many = ["2026-01-02T01:00:00Z", "2026-01-02T02:00:00Z", "2026-01-02T03:00:00Z", "2026-01-02T04:00:00Z"];
    let tick: (() => void) | undefined;
    const log = vi.fn();
    const watcher = new NotificationWatcher({
      callJson: async () => {
        call++;
        if (call === 1) return { notifications: [row("seed", "2026-01-01T00:00:00Z")] };
        if (call === 2) throw new Error("api down");
        return { notifications: many.map((ts, i) => row(`n${i}`, ts)) };
      },
      notify: (n) => fired.push(n),
      loadCursor: () => undefined,
      saveCursor: () => {},
      fireCap: 3,
      log,
      schedule: (fn) => {
        tick = fn;
        return () => {};
      },
    });
    watcher.start();
    await flush();
    tick?.(); // failing poll
    await flush();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("poll failed"));
    tick?.(); // 4 new → only the cap of 3
    await flush();
    expect(fired).toHaveLength(3);
    watcher.stop();
  });
});

// Where the click lands. A fired OS notification that opens nothing is the same failure as no notification at
// all — the shell mirrors the web bell's resolver, so these cases are its parity contract.
describe("notificationPathOf", () => {
  const link = (l: Record<string, string>): WatcherNotification => ({
    id: "n1",
    workspace: "acme",
    title: "t",
    createdAt: "2026-08-05T00:00:00Z",
    link: l,
  });

  it("opens a run and a scorecard at the address that names ONE of them", () => {
    expect(notificationPathOf(link({ runId: "r1" }))).toBe("/acme/run/r1");
    expect(notificationPathOf(link({ scorecardId: "s1" }))).toBe("/acme/scorecard/s1");
  });

  // The gap that made every mention/tracker/regression notification a dead click on the desktop.
  it("reaches the mentioned comment on a resource", () => {
    expect(notificationPathOf(link({ resourceType: "issue", resourceId: "i1", commentId: "c1" }))).toBe(
      "/acme/issue/i1?comment=c1",
    );
    expect(notificationPathOf(link({ resourceType: "cycle", resourceId: "y1", commentId: "c2" }))).toBe(
      "/acme/cycle/y1?comment=c2",
    );
  });

  it("opens the issue a regression is about, not the scorecard that proved it", () => {
    expect(notificationPathOf(link({ resourceType: "issue", resourceId: "i1", scorecardId: "s1" }))).toBe(
      "/acme/issue/i1",
    );
  });

  it("opens a parked agent conversation through the workspace home's ?conversation= parameter", () => {
    expect(notificationPathOf(link({ conversationId: "sess-1" }))).toBe("/acme?conversation=sess-1");
  });

  it("sends a posted goal update to the update timeline", () => {
    const row: WatcherNotification = {
      id: "n2",
      workspace: "acme",
      kind: "tracker_update_posted",
      title: "t",
      createdAt: "2026-08-05T00:00:00Z",
      link: { resourceType: "initiative", resourceId: "g1" },
    };
    expect(notificationPathOf(row)).toBe("/acme/initiative/g1/updates");
  });

  it("has nowhere to go without a link, and says so", () => {
    expect(notificationPathOf({ id: "n3", workspace: "acme", title: "t", createdAt: "2026-08-05T00:00:00Z" })).toBe(
      null,
    );
  });
});
