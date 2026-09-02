---
kind: wiki
title: "Notifications — job completion via web inbox + desktop native"
status: current
updated: 2026-08-11
anchors: [apps/web/src/entities/notification/model/href.ts, apps/desktop/src/notification-watcher.ts, apps/agent/src/server.ts, apps/api/src/api/ops/internal.routes.ts]
---
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
>   Mattermost connected-account notify already fires (run finalize · scorecard finalize) — one
>   completion event fans out to [feed, Mattermost].

## Shape

```
finalize(run|scorecard) ──▶ NotificationService.emit ──▶ NotificationStore (InMemory|Pg)
                                                            ▲ read/ack
web bell (poll /notifications) ──▶ new items → Web Notification API ──▶ (browser | Electron→OS)
```

- **Entity** — `{ id, workspace, recipient(subject), kind, title, body?, link{runId|scorecardId},
  createdAt, readAt? }`. `kind`: `run_completed` | `run_failed` | `scorecard_completed` |
  `scorecard_failed` | `schedule_completed` | `schedule_failed` | `comment_mention` | `issue_regressed` |
  `tracker_update_posted` (extensible). A
  scheduled eval (cron fire **or** manual "run now") reuses the scorecard completion seam but is
  **branded** — `NotificationService.notifyScorecard` emits `schedule_{completed,failed}` (title
  "Scheduled run …") when `record.origin.source === "schedule"`, in place of the generic
  `scorecard_{completed,failed}`, so the bell reads as "my scheduled job ran".
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
  independently (one channel's failure doesn't block the other). A scheduled scorecard branches on
  `record.origin.source === "schedule"` in the SAME `notifyScorecard` seam (so cron fires and manual
  "run now" both notify exactly once — `ScheduleService.finalize` only records the terminal `lastStatus`,
  it no longer notifies).
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

## N7 — a notification is only worth firing if the click LANDS (2026-08-05)

A row whose `link` no reader understands falls back to `/{workspace}` — and the click still marks it read, so
the person is told about something and can never reach it again. Measured on the live stack before the fix: an
@mention on an **issue** and on a **cycle** did nothing at all (unread → read, no navigation), a regression
opened the **scorecard** instead of the issue it names, a mention on a **goal** opened its Updates tab where
the thread isn't, and every resource link lost its `#comment-…` anchor on the way. So:

- **One resolver per surface, keyed by the WHOLE vocabulary.** `notificationHref`
  (`apps/web/src/entities/notification/model/href.ts`) and its desktop mirror `notificationPathOf`
  (`apps/desktop/src/notification-watcher.ts`) map `link.resourceType` over the full comment-target list
  (`COMMENT_RESOURCE_TYPES`: dataset · harness · scorecard · view · schedule · run · runtime · issue · cycle ·
  project · initiative). A resource that can be commented on but not addressed is the defect; the web test
  enumerates all of them, and one case asserts every registered `kind` resolves.
- **The subject beats the evidence.** `resourceType`+`resourceId` win over `runId`/`scorecardId`:
  `issue_regressed` carries both and the headline is about the issue.
- **The kind picks the screen only where the resource has two.** A posted goal update opens
  `/initiative/{id}/updates`; a mention on that same goal opens its overview, where the thread is.
- **Singular addresses, and the anchor is a QUERY parameter.** `/{ws}/datasets/{id}` still 307s to the singular
  form, but a redirect DROPS a fragment — measured. So the link is built singular, and what on the page it is
  about rides as `?comment=<id>` / `?artifact=<id>` (`useAnchorHighlight`, `shared/lib/use-anchor-highlight.ts`),
  which the two normalizing gateways (issue uuid → `ENG-12`, cycle uuid → the team's numbered cycle) carry
  through with `searchSuffix`. `#comment-<id>` is still honoured for a hand-copied link.
- **The desktop shell must parse what it navigates by.** Its watcher schema had a nested `z.object` for `link`
  that silently stripped `resourceType`/`resourceId`, so every mention/tracker/regression notification was a
  dead click; the schema now mirrors the record.

## N8 — a parked agent comes to find you (HITL approval requests, 2026-08-06)

An agent that parks on a human decision (a write-tool approval, a plan review) cannot continue until somebody
answers — and the park lives on exactly the surfaces nobody is necessarily watching: one of the member's many
conversations, a resource's discussion thread, or a headless activation. Before N8 the only signals were
in-place (the panel's PermissionPrompt, the thread's ApprovalStrip), so a member who navigated away starved the
turn into its deny-on-expiry. The kind `agent_approval_requested` brings the ask to the bell.

- **Three lanes, one choke point each — never per-call-site:**
  - **Chat conversations** (`apps/agent/src/server.ts` `noticeParkedApproval`): the park is reported
    IMMEDIATELY as `agent.run.awaiting_approval` (`cause: "chat"`, the parked `tool` named, plan asks
    tool-less). Best-effort, like every ledger report. (An earlier revision debounced this behind a grace so
    the attended prompt stayed notification-free; the auto-clear below made that unnecessary — the absent
    member gets pinged without delay, the attended one sees a badge that erases itself.)
  - **Headless activations** already report `agent.run.awaiting_approval` at the park.
  - Both land in the ONE hook in `POST /internal/agent-run-events` (`apps/api/src/api/ops/internal.routes.ts`):
    `kind = awaiting_approval` + a `creator` → `NotificationService.notifyApprovalRequested` with
    `link.conversationId = sessionId`. Recipient = the run's **creator** (the member the turn works for — for
    a workspace-visible session that is whoever typed the turn, not the session owner).
  - **Discussion threads** (`CommentService.applyProgress`): the transition INTO `agentStatus =
    "awaiting_approval"` pings `agentAskedBy` with the resource + `?comment=` link that lands on the
    ApprovalStrip. Transition-guarded like the terminal ping — parked re-reports never re-ping; a second park
    in the same turn is a new decision and does.
- **The decision erases the ask.** An approval notification stops being TRUE the moment somebody decides
  (allow/deny/expiry/sweep), so it is DELETED — not marked read: read-history would keep saying "approval
  needed", and the row's id must be free for the session's next ask to ping again. The row's id is
  **deterministic** (`nf-approval-<sessionId>` / `nf-approval-<commentId>` — one live ask per place, asks are
  sequential), which also deduplicates at-least-once park reports. Clear paths mirror the notify lanes: the
  agent's `clearApprovalNotice` bridge (`POST /internal/notifications/approval-clear`) after the in-process
  wait resolves — chained AFTER the notice on the chat lane so an instant decision cannot overtake the row it
  deletes — and `CommentService.applyProgress` on the transition OUT of awaiting for discussions. Best-effort:
  a clear that fails leaves a stale row whose click still lands on the (now decided) surface.
- **A conversation's only address is the panel** (N7 corollary). `link.conversationId` resolves to
  `/{ws}?conversation=<id>`: the infra panel consumes and strips the parameter on load (desktop OS click,
  pasted link), while the web bell short-circuits — a click posts `everdict:open-agent-session` and the panel
  opens IN PLACE, no navigation.
- The park itself is not a new platform-event kind: `agent.run.awaiting_approval` and `approval.requested`
  already exist; N8 only adds the personal-feed reaction (and `cause: "chat"` awaiting reports stay off the
  event log, per the O1 narrowing).

## See also
[workspace-scoped-integrations.md](./workspace-scoped-integrations.md) (Mattermost notify) · [desktop-app.md](./desktop-app.md) (D1/D4) ·
[scheduled-evals.md](./scheduled-evals.md) (schedule fire/finalize).
