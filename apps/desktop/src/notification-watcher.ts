import { z } from "zod";

// 데스크톱 독립 알림(N6, docs/architecture/notifications.md) — 웹 세션/창과 무관하게, 러너 페어링
// 토큰(rnr_)으로 컨트롤플레인 MCP `list_notifications` 를 폴링해 OS 알림을 쏜다. 러너 토큰의
// principal.subject = 페어링 소유자이므로 "내가 시킨 작업" 피드(N2)가 그대로 내 것이다.
// 웹을 안 쓰는(러너로만 쓰는) 유저도 작업 완료를 받는 경로 — 웹 벨은 데스크톱+페어링이면 발화를 양보한다.
const WatcherRowSchema = z
  .object({
    id: z.string(),
    workspace: z.string(),
    title: z.string(),
    body: z.string().optional(),
    link: z.object({ runId: z.string().optional(), scorecardId: z.string().optional() }).optional(),
    createdAt: z.string(),
  })
  .passthrough();
const WatcherResultSchema = z.object({ notifications: z.array(WatcherRowSchema) }).passthrough();
export type WatcherNotification = z.infer<typeof WatcherRowSchema>;

export interface NotificationWatcherDeps {
  // MCP tool 호출(러너 토큰 세션) — RunnerHost 와 같은 callJson 규약(isError 는 throw 로 승격).
  callJson(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  notify(row: WatcherNotification): void; // OS 알림 발화 — main 이 Electron Notification 을 바인딩
  loadCursor(): string | undefined; // 마지막 발화 createdAt(ISO) — 재시작 시 백로그 재발화 방지(config 영속)
  saveCursor(iso: string): void;
  intervalMs?: number; // 기본 30s
  fireCap?: number; // 폴링당 발화 상한(기본 3 — 폭주 방지)
  log?: (msg: string) => void;
  schedule?: (fn: () => void, ms: number) => () => void; // 테스트 주입
}

const DEFAULT_INTERVAL_MS = 30_000;

export class NotificationWatcher {
  private stopSchedule: (() => void) | null = null;
  private cursor: string | undefined;
  private polling = false;

  constructor(private readonly deps: NotificationWatcherDeps) {}

  start(): void {
    if (this.stopSchedule) return;
    this.cursor = this.deps.loadCursor();
    const tick = () => void this.poll();
    tick();
    const schedule =
      this.deps.schedule ??
      ((fn: () => void, ms: number) => {
        const t = setInterval(fn, ms);
        (t as { unref?: () => void }).unref?.();
        return () => clearInterval(t);
      });
    this.stopSchedule = schedule(tick, this.deps.intervalMs ?? DEFAULT_INTERVAL_MS);
  }

  stop(): void {
    this.stopSchedule?.();
    this.stopSchedule = null;
  }

  private async poll(): Promise<void> {
    if (this.polling) return; // 겹침 방지(느린 네트워크에서 인터벌 중첩)
    this.polling = true;
    try {
      const raw = await this.deps.callJson("list_notifications", { unread: true, limit: 20 });
      const parsed = WatcherResultSchema.safeParse(raw);
      if (!parsed.success) return;
      const rows = parsed.data.notifications;
      if (rows.length === 0) {
        // 빈 피드로 시작 — 커서를 ""(모든 이후 항목이 신규) 로 확정해 첫 실제 알림이 백로그로 오인되지 않게.
        if (this.cursor === undefined) this.advance("");
        return;
      }
      const maxCreatedAt = rows.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), rows[0]?.createdAt ?? "");
      if (this.cursor === undefined) {
        // 첫 폴링에 백로그 존재 — 과거 미읽음은 발화하지 않는다(앱 켜자마자 폭주 방지). 커서만 세팅.
        this.advance(maxCreatedAt);
        return;
      }
      const cursor = this.cursor;
      const fresh = rows.filter((r) => r.createdAt > cursor).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const row of fresh.slice(0, this.deps.fireCap ?? 3)) {
        this.deps.notify(row);
        this.deps.log?.(`네이티브 알림 발화: ${row.title}`);
      }
      if (fresh.length > 0) this.advance(maxCreatedAt);
    } catch (e) {
      // 오프라인/API 재시작은 정상 상황 — 다음 주기에 재시도.
      this.deps.log?.(`알림 폴링 실패(재시도 예정): ${e instanceof Error ? e.message : e}`);
    } finally {
      this.polling = false;
    }
  }

  private advance(iso: string): void {
    this.cursor = iso;
    try {
      this.deps.saveCursor(iso);
    } catch {
      // 커서 저장 실패는 다음 발화 중복 정도 — 치명 아님.
    }
  }
}
