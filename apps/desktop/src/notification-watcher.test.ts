import { describe, expect, it, vi } from "vitest";
import { NotificationWatcher, type WatcherNotification } from "./notification-watcher.js";

const row = (id: string, createdAt: string): Record<string, unknown> => ({
  id,
  workspace: "acme",
  recipient: "alice",
  kind: "run_completed",
  title: `Run 완료 — ${id}`,
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

describe("NotificationWatcher — 데스크톱 독립 알림(N6)", () => {
  it("첫 폴링의 미읽음 백로그는 발화하지 않고 커서만 세팅한다", async () => {
    const { watcher, fired, getCursor } = build([[row("a", "2026-01-01T00:00:00Z"), row("b", "2026-01-01T01:00:00Z")]]);
    watcher.start();
    await flush();
    expect(fired).toHaveLength(0);
    expect(getCursor()).toBe("2026-01-01T01:00:00Z");
    watcher.stop();
  });

  it("커서 이후의 새 알림만 오래된 순으로 발화하고 커서를 전진시킨다", async () => {
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

  it("빈 피드로 시작해도 이후 첫 알림은 발화된다(빈 첫 폴링 → 커서 확정)", async () => {
    const { watcher, fired, tick } = build([[], [row("x", "2026-01-01T05:00:00Z")]]);
    watcher.start();
    await flush();
    expect(fired).toHaveLength(0);
    tick();
    await flush();
    expect(fired.map((f) => f.id)).toEqual(["x"]);
    watcher.stop();
  });

  it("재시작(저장된 커서)해도 이미 발화한 미읽음을 다시 쏘지 않는다", async () => {
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

  it("폴링 실패는 삼키고(다음 주기 재시도) 발화 상한을 지킨다", async () => {
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
    tick?.(); // 실패 폴링
    await flush();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("폴링 실패"));
    tick?.(); // 4건 신규 → 상한 3건만
    await flush();
    expect(fired).toHaveLength(3);
    watcher.stop();
  });
});
