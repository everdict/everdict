# Notifications — job completion via web inbox + desktop native

> **Status: DESIGN → implementation in progress (2026-07-03).**
> User ask: I want to receive "the job finished"-type events **as notifications in the web, and on the desktop too**.
>
> - **N1 — one feed, standard delivery.** The control plane keeps a per-user **notification feed**
>   (run/scorecard completion, etc.). The web renders it as a topbar **bell inbox** and fires the **standard
>   Web Notification API** for new items. Because the desktop renders the same web (D1), Electron
>   routes those renderer notifications to the **OS notification center automatically** — the desktop
>   gets native notifications with **zero bridge changes** (D4 stays intact: 4 methods + setup).
> - **N2 — recipient = the person who asked for the work.** Notifications are personal
>   (`recipient = subject`), like connections/runners. The emitter uses the record's creator; work
>   without a known creator emits nothing (v1) — no workspace broadcast rows, no per-user read joins.
> - **N3 — transport is polling (v1).** The web polls the unread feed (TanStack Query,
>   ~25s interval + refetch on window focus; TanStack Query is not yet used on the web, so a plain interval) — consistent with the control plane's async/poll idiom. SSE/web-push are
>   explicit non-goals for v1 (a browser tab or the resident desktop must be open; the desktop is
>   tray-resident anyway, which is exactly the "notification-receiving device" role).
> - **N4 — the runner's local drain notification stays.** The desktop main process already notifies
>   for jobs executed *on that machine* (running→idle aggregation, works even when logged out). The feed covers
>   the workspace view (whatever machine my requested work ran on); the two complement, not replace.
> - **N6 — the desktop is notification-independent of the web (2026-07-03).** For users who don't use the web
>   (runner-only), the desktop **main process** polls MCP `list_notifications` directly (30s) with the runner
>   pairing token (`rnr_`) and fires OS notifications — the runner token's `principal.subject` is the pairing
>   owner, so it becomes "my feed" with no separate server change (personal `plain` tools are also callable with a
>   runner principal). Independent of the web session/window state; tied to the pairing lifecycle
>   (pair→start, unpair→stop). A cursor (`config.json notifyCursor`, the last fired createdAt) prevents re-firing
>   the backlog on restart, and the first poll's backlog is not fired (starting with an empty feed pins the cursor
>   to "" — so the first real notification isn't mistaken for backlog). **Dedup**: the web bell yields
>   renderer-native firing when desktop+paired (subscribing to the bridge `runnerStatus().paired`), and the watcher
>   skips when the app window is visible and focused. It does not mark fired items as read (read happens in the inbox).
> - **N5 — same emission seam as Mattermost.** Feed rows are written at the exact points the
>   Mattermost connected-account notify already fires (run finalize · scorecard finalize · schedule
>   regression alert) — one completion event fans out to [feed, Mattermost].

## Shape

```
finalize(run|scorecard) ──▶ NotificationService.emit ──▶ NotificationStore (InMemory|Pg)
                                                            ▲ read/ack
web bell (poll /notifications) ──▶ new items → Web Notification API ──▶ (browser | Electron→OS)
```

- **Entity** — `{ id, workspace, recipient(subject), kind, title, body?, link{runId|scorecardId},
  createdAt, readAt? }`. `kind`: `run_completed` | `run_failed` | `scorecard_completed` |
  `scorecard_failed` | `schedule_regression` (extensible).
- **API (BFF+MCP parity)** — `GET /notifications?unread=1&limit=` (mine, workspace-scoped),
  `POST /notifications/read` `{ids?|all:true}`. Personal — **no role gate** (self-scoped, like
  connections/runners).
- **Web** — `widgets/notification-bell` in the topbar: unread badge, dropdown inbox (click → navigate to run/
  scorecard detail + mark read, "mark all read"), 25s polling + refetch on focus. New-item detection fires
  `new Notification(title, {body})`; browser needs a one-time permission (the bell dropdown's "enable browser
  notifications" toggle), Electron grants it by default.
- **Desktop** — nothing to change: renderer notifications surface natively; click → `window.focus()`.

## Slices
1. ✅ Store + emit + API + MCP (+ tests).
2. ✅ Web bell inbox + poll + native Notification + permission toggle.
3. ✅ Live verify: run completes → feed row → bell badge → mark read, in the real desktop shell renderer.

## Verified (confirmed implementation details)
- **Emission seam** — inside `NotificationService.notifyRun/notifyScorecard`, called by
  `RunService`/`ScorecardService`'s existing `onComplete` hook, feed insertion + Mattermost posting run
  independently (one channel's failure doesn't block the other). Schedule regression is `ScheduleService.finalize`
  → `notifyRegression(payload.createdBy=schedule.createdBy)`.
- **Recipient** — scorecard uses the existing `createdBy` (mig 0035), run uses the `createdBy` added this time
  (mig 0036; `POST /runs` already passes `submittedBy=principal.subject`, so it's stamped immediately).
  **Scorecard child runs are excluded from the feed** (subsumed by the single batch — prevents flooding by the
  number of cases); an unknown creator emits nothing.
- **Store** — `everdict_notifications` (mig 0037, recipient+workspace+created_at index),
  `InMemory/PgNotificationStore` (`markRead` counts rows via `RETURNING` — `SqlClient` only exposes rows).
- **API/MCP** — `GET /notifications?unread&limit` + `POST /notifications/read {ids|all}` (personal,
  no role gate) ↔ MCP `list_notifications`/`read_notifications` (BFF parity).
- **Web** — `widgets/notification-bell` (sidebar, Linear Inbox position): 25s polling + refetch on focus, unread
  badge, inbox dropdown (click → run/scorecard detail + mark read, mark all read — the header has controls only,
  no title), **native-notification state is an icon + dropdown** (on = Bell(primary) / off·blocked = BellOff):
  enable/disable (local preference `everdict:native-notifications`, persists across refresh); if permission is not
  granted, "grant permission"; if the browser has blocked it (denied), guidance + "re-check" (denied can't be
  re-requested programmatically — directs to site settings). Firing condition = granted && preference on.
  Native firing happens **only when the window is not visible**
  (`document.hidden` — a visible tab is covered by the badge; the first-load batch is excluded from firing, capped
  at 3 per poll). BFF proxy routes `GET /api/notifications` + `POST /api/notifications/read`. Note: the sidebar
  `aside` (sticky) is a stacking context, so the popover ends up beneath the body → fixed with `aside z-20`.
- **Live verified (2026-07-03)** — in-memory API + web + a real Electron shell: scripted run completes →
  `run_completed` feed (recipient=submitter) → bell badge 1 → inbox item → mark all read → badge cleared, renderer
  `Notification.permission === "granted"` (confirms the desktop native-firing path is enabled by default).
  5 service tests (including child-run exclusion / recipient scoping / read idempotency) + api 352 tests green.
- **N6 live verified (2026-07-03)** — real API + runner token + real MCP session + a real `NotificationWatcher`:
  pairing (no web session) → run completes → the watcher fires with the correct runId/workspace. 5 watcher unit
  tests (backlog skip / cursor advance·persistence / empty first poll / retry on failure / firing cap). The
  full-GUI end-to-end script is `scripts/live/desktop-notify.mjs` (requires a graphics session).

## See also
[connections.md](../connections.md) (Mattermost notify) · [desktop-app.md](./desktop-app.md) (D1/D4) ·
[scheduled-evals.md](./scheduled-evals.md) (regression alert).
