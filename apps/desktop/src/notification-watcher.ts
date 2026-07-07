import { z } from "zod";

// Desktop independent notifications (N6, docs/architecture/notifications.md) — independent of any web session/window,
// poll the control-plane MCP `list_notifications` with the runner pairing token (rnr_) and fire OS notifications. The runner token's
// principal.subject = the pairing owner, so the "work I started" feed (N2) is directly mine.
// The path by which a web-less (runner-only) user still gets job completions — the web bell yields firing when desktop+paired.
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
  // MCP tool call (runner-token session) — the same callJson contract as RunnerHost (isError is promoted to a throw).
  callJson(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  notify(row: WatcherNotification): void; // fire the OS notification — main binds the Electron Notification
  loadCursor(): string | undefined; // last fired createdAt (ISO) — prevents re-firing the backlog on restart (persisted in config)
  saveCursor(iso: string): void;
  intervalMs?: number; // default 30s
  fireCap?: number; // per-poll firing ceiling (default 3 — prevents a flood)
  log?: (msg: string) => void;
  schedule?: (fn: () => void, ms: number) => () => void; // test injection
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
    if (this.polling) return; // prevent overlap (interval stacking on a slow network)
    this.polling = true;
    try {
      const raw = await this.deps.callJson("list_notifications", { unread: true, limit: 20 });
      const parsed = WatcherResultSchema.safeParse(raw);
      if (!parsed.success) return;
      const rows = parsed.data.notifications;
      if (rows.length === 0) {
        // Starting with an empty feed — pin the cursor to "" (every later item is new) so the first real notification is not mistaken for backlog.
        if (this.cursor === undefined) this.advance("");
        return;
      }
      const maxCreatedAt = rows.reduce((m, r) => (r.createdAt > m ? r.createdAt : m), rows[0]?.createdAt ?? "");
      if (this.cursor === undefined) {
        // Backlog present on the first poll — do not fire past unread items (prevents a flood the moment the app opens). Just set the cursor.
        this.advance(maxCreatedAt);
        return;
      }
      const cursor = this.cursor;
      const fresh = rows.filter((r) => r.createdAt > cursor).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      for (const row of fresh.slice(0, this.deps.fireCap ?? 3)) {
        this.deps.notify(row);
        this.deps.log?.(`Fired native notification: ${row.title}`);
      }
      if (fresh.length > 0) this.advance(maxCreatedAt);
    } catch (e) {
      // Offline / API restart is a normal condition — retry on the next cycle.
      this.deps.log?.(`Notification poll failed (will retry): ${e instanceof Error ? e.message : e}`);
    } finally {
      this.polling = false;
    }
  }

  private advance(iso: string): void {
    this.cursor = iso;
    try {
      this.deps.saveCursor(iso);
    } catch {
      // A failed cursor save at worst duplicates the next firing — not fatal.
    }
  }
}
