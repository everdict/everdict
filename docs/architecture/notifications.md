# Notifications — 작업 완료를 웹 인박스 + 데스크톱 네이티브로

> **Status: DESIGN → implementation in progress (2026-07-03).**
> User ask: "작업이 끝났다" 같은 이벤트를 **웹에서 알림으로 받고, 데스크톱에서도** 받고 싶다.
>
> - **N1 — one feed, standard delivery.** The control plane keeps a per-user **notification feed**
>   (run/scorecard 완료 등). The web renders it as a topbar **bell inbox** and fires the **standard
>   Web Notification API** for new items. Because the desktop renders the same web (D1), Electron
>   routes those renderer notifications to the **OS notification center automatically** — the desktop
>   gets native notifications with **zero bridge changes** (D4 stays intact: 4 methods + setup).
> - **N2 — recipient = the person who asked for the work.** Notifications are personal
>   (`recipient = subject`), like connections/runners. The emitter uses the record's creator; work
>   without a known creator emits nothing (v1) — no workspace broadcast rows, no per-user read joins.
> - **N3 — transport is polling (v1).** The web polls the unread feed (TanStack Query,
>   ~25s interval + 창 포커스 재조회; TanStack Query 는 웹에서 아직 미사용이라 plain interval) — consistent with the control plane's async/poll idiom. SSE/web-push are
>   explicit non-goals for v1 (a browser tab or the resident desktop must be open; the desktop is
>   tray-resident anyway, which is exactly the "알림 받는 기기" role).
> - **N4 — the runner's local drain notification stays.** The desktop main process already notifies
>   for jobs executed *on that machine* (running→idle 집계, works even logged-out). The feed covers
>   the workspace view (내가 시킨 작업이 어디서 돌았든); the two complement, not replace.
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
- **Web** — `widgets/notification-bell` in the topbar: unread badge, dropdown inbox (클릭 → run/
  scorecard 상세로 이동 + read 처리, "모두 읽음"), 25s 폴링+포커스 재조회. New-item detection fires
  `new Notification(title, {body})`; browser needs a one-time permission (bell dropdown의 "브라우저
  알림 켜기" 토글), Electron grants it by default.
- **Desktop** — nothing to change: renderer notifications surface natively; click → `window.focus()`.

## Slices
1. ✅ Store + emit + API + MCP (+ tests).
2. ✅ Web bell inbox + poll + native Notification + permission toggle.
3. ✅ Live verify: run completes → feed row → bell badge → 읽음 처리, in the real desktop shell renderer.

## Verified (구현 확정 사항)
- **Emission seam** — `RunService`/`ScorecardService` 의 기존 `onComplete` 훅이 부르는
  `NotificationService.notifyRun/notifyScorecard` 안에서 피드 적재 + Mattermost 게시가 독립적으로
  실행된다(한 채널 실패가 다른 채널을 막지 않음). 예약 회귀는 `ScheduleService.finalize` →
  `notifyRegression(payload.createdBy=schedule.createdBy)`.
- **Recipient** — scorecard 는 기존 `createdBy`(mig 0035), run 은 이번에 추가한 `createdBy`(mig 0036,
  `POST /runs` 가 이미 `submittedBy=principal.subject` 를 넘기고 있어 즉시 스탬프됨). **스코어카드
  자식 run 은 피드 제외**(배치 1건으로 갈음 — 케이스 수만큼 범람 방지), creator 불명은 무발행.
- **Store** — `assay_notifications`(mig 0037, recipient+workspace+created_at 인덱스),
  `InMemory/PgNotificationStore`(`markRead` 는 `RETURNING` 으로 건수 집계 — `SqlClient` 는 rows 만 노출).
- **API/MCP** — `GET /notifications?unread&limit` + `POST /notifications/read {ids|all}` (personal,
  no role gate) ↔ MCP `list_notifications`/`read_notifications` (BFF 패리티).
- **Web** — `widgets/notification-bell`(사이드바, Linear Inbox 위치): 25s 폴링+포커스 재조회, 미읽음
  배지, 인박스 드롭다운(클릭→run/scorecard 상세+읽음, 모두 읽음), 네이티브 발화는 **창이 안 보일 때만**
  (`document.hidden` — 보이는 탭은 배지로 충분; 첫 로드 배치는 발화 제외, 폴링당 3건 캡). BFF 프록시
  라우트 `GET /api/notifications` + `POST /api/notifications/read`. 주의: 사이드바 `aside`(sticky)는
  스태킹 컨텍스트라 팝오버가 본문에 깔린다 → `aside z-20` 로 해결.
- **Live verified (2026-07-03)** — in-memory API + 웹 + 실제 Electron 셸: scripted run 완료 →
  `run_completed` 피드(recipient=제출자) → 벨 배지 1 → 인박스 항목 → 모두 읽음 → 배지 제거, 렌더러
  `Notification.permission === "granted"` (데스크톱 네이티브 발화 경로 기본 활성 확인).
  서비스 테스트 5종(자식 run 제외/수신자 스코프/읽음 멱등 포함) + api 352 tests green.

## See also
[connections.md](../connections.md) (Mattermost notify) · [desktop-app.md](./desktop-app.md) (D1/D4) ·
[scheduled-evals.md](./scheduled-evals.md) (regression alert).
