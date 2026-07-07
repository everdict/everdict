import { describe, expect, it, vi } from "vitest";
import { NotificationWatcher, type WatcherNotification } from "./notification-watcher.js";

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
