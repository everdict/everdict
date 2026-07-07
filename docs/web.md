# SaaS web (`apps/web`)

The multi-tenant SaaS frontend — a Next.js app (FSD architecture, **Linear-style** design — refined dark-first
minimalism with a light/dark toggle) where tenant **users** log in (Keycloak), see their **per-tenant scores**,
runs, and harnesses.

## Two complementary auth paths
- **Humans → Keycloak (OIDC)** via Auth.js in `apps/web`. The web is a **BFF token courier, not an auth
  authority**: Auth.js stores (and refreshes) the Keycloak **access token** in the **server-only httpOnly
  encrypted cookie** — it is **never put on the client session** (no `/api/auth/session` leak). The server reads
  it via `getAccessToken()` (`getToken` over the cookie) and `control-plane.ts` forwards it as
  `Authorization: Bearer <jwt>` to `@assay/api`. The control plane resolves identity — `workspace` + roles come
  from `GET /me`, never decoded from the token by the web. UI is role-gated off `/me` (mirror in
  `shared/auth/can.ts`), but enforcement is always the control plane's (403). Without Keycloak configured the web
  falls back to the dev `x-assay-tenant=default` path. See `docs/auth.md`.
- **Agents / MCP / CI → MCP or API keys**: the agent-facing **MCP server** (`@assay/api` `/mcp`) exposes
  run/harness tools, OAuth-protected via Keycloak ("login like Linear MCP") or an `Authorization: Bearer ak_…`
  API key — same auth core, role-gated. See `docs/mcp.md`.

These don't conflict: Keycloak = people in the browser, API keys = machines. Both resolve to the same
control-plane `Principal{workspace, roles}`.

## Stack
Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 (`@theme inline` tokens) · shadcn-style UI
(new-york, neutral base, **Linear-style** indigo `#5e6ad2` primary + tight `0.5rem` radius + near-black dark
surface; light/dark toggle via `shared/ui/theme-toggle`, no-flash inline script in `layout.tsx`) · TanStack
Query · zod · Auth.js + Keycloak. Self-contained tooling: **eslint + prettier** (import-order plugin) — NOT the repo Biome (apps/web is
excluded from root Biome). The web is a pure HTTP client of the control plane — **no `@assay/*` package deps**.

## FSD layout (`src/`)
```
app/        Next App Router — landing(/), [workspace]/{layout(shell+멤버십 검증), page(overview), runs, runs/[id],
            harnesses, datasets(+[id],new), scorecards(+[id],new,compare), judges(+[id],new), runtimes(+[id],new),
            account, settings} — Linear 식 /{workspaceSlug}/... ; 워크스페이스 슬러그 없는 최상위 진입점
            onboarding·new-workspace·invite ; api/auth/[...nextauth] ; middleware(URL 첫 세그먼트 → x-assay-active-workspace 헤더 주입)
widgets/    page-level composition: app-shell (sidebar+topbar), workspace-switcher (Linear-style sidebar dropdown:
            현재 워크스페이스 + 전환(= /{workspace} 로 이동) + "새 워크스페이스"), scorecard-summary, runs-table, trace-timeline
features/   business actions: submit-run, register-harness, register-dataset, run-scorecard, register-judge, compare-scorecards, register-runtime, ingest-scorecard, create-workspace, manage-workspace-secrets, manage-github-app + manage-mattermost (워크스페이스 소유 통합: GitHub App 조직 설치→선택 repo, Mattermost 알림/슬래시커맨드) (client form/액션 → control plane; 워크스페이스 전환은 URL 이동이라 별도 액션 없음)
entities/   domain models + zod schemas mirroring the API (run + trace/snapshot, harness, dataset, scorecard, judge, runtime, workspace, secret, github-app, mattermost)
shared/     ui (button/card/badge/page-header/stat-card/status-pill/empty-state/callout/section-header/theme-toggle), lib (utils, control-plane),
            config (env), providers (query), auth (Keycloak token store/refresh, server-only access-token (getToken),
            authContext + currentPrincipal + can, workspace-scope(URL↔쿠키↔헤더 상수) + active-workspace cookie → x-assay-workspace)
```
Import order enforces downward layer deps (app → widgets → features → entities → shared).

**Dropdowns are always `shared/ui/combobox` (`Combobox`)** — the native `<select>` atom was removed from
`shared/ui/input` and `<datalist>` suggestions were replaced too, so every picker (list sort/filter bars, form
fields, react-hook-form via `Controller`) opens the same Linear-style popover (search, keyboard nav, hints).
`<optgroup>` has no popover equivalent — encode the group as each option's `hint` (e.g. runtime picker's
"내 로컬 호스트", benchmark import's "카탈로그/내 레시피").

**Guide/help copy is never inline** — explanatory guidance (e.g. "수정은 새 버전으로 배포됩니다") must not sit
as visible caption text in panels; render a small info icon via `shared/ui/tooltip` (`InfoTip`, or `Tooltip`
around any trigger) and reveal the copy on hover/focus. Field-level `<p>` hints under form inputs are fine;
panel/list guidance is not.

## Screens
- **워크스페이스 스위처** (사이드바 최상단, 모든 화면) — 현재 워크스페이스(이름+역할) 드롭다운으로 내가 속한
  워크스페이스 간 전환(= `/{id}` 로 이동; URL 첫 세그먼트가 활성 워크스페이스의 권위, 미들웨어가 쿠키 동기화) + **새 워크스페이스**
  (`/new-workspace` → `create-workspace`, 생성자는 admin). 목록·활성은 `GET /me.workspaces` 권위. See `docs/tenancy.md`.
- **개요 `/{workspace}`** — scorecard stat cards (total / success / fail / pass-rate) + recent runs + harness summary.
- **Runs `/{workspace}/runs`** — full runs table (rows link to detail).
- **Run detail `/{workspace}/runs/[id]`** — status, meta, scores, **trace timeline**, snapshot, error.
- **하니스 `/{workspace}/harnesses`** — owned vs `_shared` harnesses with versions. **상세
  `/{workspace}/harnesses/[id]`** shows the active version's **구성(Config) 패널** — the raw, editable config
  (template 대분류 ref `id@version` + slot→value pins, via `GET /harnesses/:id/:version/instance` +
  `GET /harness-templates/:id/:version`) above the resolved spec views (diagram / structure / JSON). A **"새 버전
  만들기"** action (`/{workspace}/harnesses/[id]/new-version`) prefills the current config into the register
  wizard — versions are immutable, so editing = registering a new version (인스턴스 pins 재핀 → new instance tag,
  or 템플릿 구조 → new template semver, then re-pin an instance on it).
- **데이터셋 `/{workspace}/datasets`** — a **searchable, metadata-rich** list: each row shows description, all
  versions, latest-version case count, tags, **related harnesses** (joined from scorecards), the **author**
  (`createdBy` resolved to a member name) and created/updated times, plus an owned/shared badge. A client widget
  adds **search** (id/description/tags), an **owner filter** (전체/소유/공유), and **sort** over a stat strip
  (first-party example datasets are no longer auto-seeded, so the list is the workspace's own datasets). **상세
  `/{workspace}/datasets/[id]`** shows a **meta panel** (case/version/scorecard counts, created/updated, author
  avatar, tag chips — not a bare dl grid) above the eval-case table, plus a **"새 버전 만들기"** action
  (`/{workspace}/datasets/[id]/new-version`, owned datasets + `datasets:write` only) that prefills the current
  version's description/tags/cases into the register form — versions are immutable, so **editing = publishing a
  new semver** (same pattern as harness new-version). **데이터셋 등록 `/{workspace}/datasets/new`** —
  id/version/description/tags + cases-JSON with a **validate (dry-run)** step then register (`POST /datasets`;
  server-action body limit raised to 8MB — embedded repo-seed cases easily exceed 1MB). Role-gated off `/me`
  (`datasets:write` = member+). See `docs/datasets.md`.
- **스코어카드 `/{workspace}/scorecards`** — batch-eval runs (dataset@v → harness@v, status, per-metric summary
  chips; rows link to detail). **상세 `/{workspace}/scorecards/[id]`** shows per-metric stat cards + per-case
  scores. **실행 `/{workspace}/scorecards/new`** — pick dataset + harness (+ optional judges) → `POST /scorecards`.
  **비교 `/{workspace}/scorecards/compare`** — two scorecard pickers → metric Δ table + regressions/improvements
  (`diffScorecards`). **인제스트 `/{workspace}/scorecards/ingest`** — push|pull toggle: **push** uploads externally-run
  `TraceEvent[]`; **pull** fetches from a tenant's OTel/MLflow (`source` + `runs:[{caseId,runId}]`, auth-secret name).
  Both produce a scorecard with no harness run. Role-gated off `/me` (run/ingest = member+, read/compare = viewer+).
  See `docs/scorecards.md`.
- **작업 `/{workspace}/queue`** — the **work queue**: per-runtime lanes (기본 백엔드 · registered runtimes ·
  `self:<runner>`) each showing **실행 중** (batch = one item with a case-progress bar), **대기** (FIFO — first
  item badged '다음'), and **다음 예약** (upcoming schedule fires, Temporal-authoritative). Reads
  `GET /queue` (`runs:read`; MCP parity `get_queue`); auto-refreshes while anything is active. Runtime placement
  is captured on records (`RunRecord.runtime`/`ScorecardRecord.runtime`, mig 0040). See
  `docs/architecture/work-queue.md`.
- **Judge `/{workspace}/judges`** — owned vs `_shared` Agent Judges (kind + version chips; rows link to detail).
  **상세 `/{workspace}/judges/[id]`** shows kind + fields + rubric. **등록 `/{workspace}/judges/new`** — a
  **kind-toggle form** (model | harness) with a validate (dry-run) step → `POST /judges`. Role-gated off `/me`
  (`judges:write` = member+). See `docs/judges.md`.
- **런타임 `/{workspace}/runtimes`** — the single **"where evals run"** surface (first-class nav, Server icon):
  ① **등록 인프라** — tenant execution infra (nomad | k8s; push — the control plane connects),
  no auto-seeded defaults; ② **내 머신 연결 (셀프호스티드 러너)** — the personal self-hosted runners section
  (RunnersManager moved here from the account page: desktop one-click pairing, presence, revoke, download CTA;
  runners stay subject-owned — only the management entry point moved). **등록
  `/{workspace}/runtimes/new`** — kind-toggle form → `POST /runtimes` (role 무관 — any member registers; credentials
  via secrets, not the spec) with `authSecret`/`server`/`kubeconfigSecret` fields + a **연결 테스트** button (nomad/k8s) that runs
  the live probe (`POST /runtimes/probe`) to confirm the cluster actually responds before committing. The scorecard
  실행 form gains a 런타임 selector. See `docs/runtimes.md`.
- **워크스페이스 설정 `/{workspace}/settings`** — admin-gated 탭: 일반 · **시크릿** ·
  **통합**(GitHub App · Mattermost) · CI · 공유 러너 · 멤버. **시크릿 탭**: 프로바이더 토큰 큐레이션 + 직접
  추가한 시크릿의 **단일 목록** — the SecretStore is one flat namespace, so one list (splitting by purpose
  showed the same secrets twice); multi-line values (kubeconfig) are a toggle on the add form, and legacy
  `?tab=model|cluster` deep links land on this tab. **일반 탭**: 워크스페이스 카드(`features/workspace-settings`
  `WorkspaceInfoCard`) — 로고 **파일 업로드**(`shared/lib/image-resize` 로 256px data URL, 유저 아바타와 동일
  방식)·이름 수정 + **URL(slug) 읽기 전용**(복사; slug=tenant 키라 불변) → `PATCH /workspace`. 그 아래 사용량
  계측 정책(`SettingsForm`), 그리고 **owner 에게만** 위험 구역(`features/delete-workspace` `DeleteWorkspaceCard`):
  워크스페이스 이름을 타이핑 확인해야 활성화되는 hard delete → `DELETE /workspace` 후 홈(`/`)으로 이동(서버는
  `getWorkspace.owner === principal.subject` 로 노출 여부 판단, 최종 강제는 컨트롤플레인). 통합
  탭(`features/manage-github-app` + `features/manage-mattermost`)은 워크스페이스 소유 외부 통합을 관리:
  **GitHub App**(조직 설치 → 선택 repo → 워크스페이스 소유 installation 토큰: private-repo clone·CI setup-PR·러너
  등록; `GET/POST/DELETE /workspace/github-app*`, repo picker `GET /workspace/github-app/repos`) + **Mattermost**
  (완료/회귀 알림 + 슬래시커맨드/버튼; `GET/PUT/DELETE /workspace/mattermost`). `settings:*`=admin.
  See `architecture/workspace-scoped-integrations.md`.
- **계정 `/{workspace}/account`** (personal — self-scoped, no role gate) — 프로필 · **개인 시크릿** ·
  **API 키** 탭(`account-tabs.tsx`). 개인 outbound OAuth "연결된 계정"은 제거됨(S6c) — 외부 통합은 워크스페이스
  소유 GitHub App/Mattermost 로 일원화(설정 › 통합, See `architecture/workspace-scoped-integrations.md`);
  개인 러너 관리(`features/manage-runners`)는 런타임 페이지로 이동(위 참조).
- **다운로드 `/{workspace}/download`** (`features/download-desktop`) — 데스크톱 설치파일 다운로드 페이지.
  서버가 GitHub 릴리즈(private 유지)를 서버 전용 PAT(`DESKTOP_RELEASES_REPO`/`DESKTOP_RELEASES_TOKEN`,
  5분 캐시)로 읽어 OS 감지(UA) 권장 버튼 + 전 플랫폼 목록 + 설치 후 안내(unsigned 주의 포함)를 렌더링.
  실제 다운로드는 `GET /api/desktop/download?id=…` 라우트가 세션 검사(`currentPrincipal`) + 우리 릴리즈
  에셋 검증 후 GitHub 의 서명된 임시 URL 로 302 — 대용량이 웹 서버를 통과하지 않고, 토큰은 클라이언트로
  나가지 않는다. 토큰 미설정 시 `DESKTOP_DOWNLOAD_URL` 외부 링크 폴백. See `docs/architecture/desktop-app.md`. **데스크톱 셸 안에서는**(`window.assayDesktop` 감지 —
  `shared/lib/desktop-bridge.ts` 의 로컬 미러 타입, 웹은 `@assay/*` 미의존) **"이 기기를 러너로 연결"
  원클릭**: 라벨=호스트명 자동, 토큰은 화면에 노출되지 않고 브리지로만 하강(OS 키체인 저장); "이 기기" 행은
  lastSeenAt 추정 대신 브리지 **라이브 상태**(실행 중 (n)/온라인 + 라이브 capability, docker 없음 힌트)를
  쓰고, 해제 시 데스크톱 토큰도 함께 정리한다. 브라우저 사용자에게는 `DESKTOP_DOWNLOAD_URL` 설정 시
  데스크톱 앱 다운로드 링크가 뜬다. See `docs/architecture/desktop-app.md` +
  `docs/architecture/self-hosted-runner.md`.
- **새 run `/{workspace}/runs/new`** — submit-run form (react-hook-form) → `submitRunAction` (server action) →
  control plane `POST /runs` → redirect to the run detail.
- **하니스 등록 `/{workspace}/harnesses/new`** — a **structured wizard** (`features/register-harness`): pick
  kind, fill id/version and (for `service`) `services[]`/`dependencies[]`/`frontDoor`/`traceSource`/`target` via
  field arrays, with a **dry-run validate** step (`validateHarnessAction` → `POST /harnesses/validate`: schema +
  existing versions/conflict, no write) + a JSON preview + a raw-JSON mode toggle, then register
  (`registerHarnessAction` → `POST /harnesses`, 409 on the immutable-version violation). Validate + register are
  the same operations exposed on the API and MCP (`docs/mcp.md`).
The **새 run** and **하니스 등록** pages (and their list-page CTAs) are role-gated off `/me`: a viewer sees a
"권한이 없습니다" notice instead of the form, a member can submit runs, only an admin can register harnesses.
All under a shared app shell (sidebar nav + topbar **workspace + role** chip / sign-in-out). Mutations are
**server actions** (`'use server'`) that forward the user's token and call the control plane server-side, then
`revalidatePath`.

The dev server runs on **port 3001** (`pnpm --filter @assay/web dev`).

## Run
```bash
pnpm install
# control plane (separate terminal): pnpm build && pnpm api   (loads apps/api/.env; or DATABASE_URL for Postgres)
# Keycloak (optional; without it the web runs in dev mode as tenant "default"):
docker compose -f deploy/keycloak/docker-compose.yaml up -d        # then configure realm/client (see file)
cp apps/web/.env.example apps/web/.env                              # set CONTROL_PLANE_URL + Keycloak vars
pnpm --filter @assay/web dev                                       # http://localhost:3001
```
Without Keycloak configured, `/{workspace}` (dev: `/default`) renders for the dev `default` workspace (no login
required) — handy for local dev. With Keycloak configured, `/{workspace}/*` is protected (middleware redirects to
login) and the workspace/roles come from the control plane's `GET /me` over the forwarded token.

**Linear-style workspace URLs.** The URL's first path segment **is** the active workspace (`/{workspaceSlug}/runs`).
The `middleware` injects that segment as the `x-assay-active-workspace` request header (and syncs the most-recent
`assay-workspace` cookie); `authContext` reads the header (cookie fallback) and forwards it as `x-assay-workspace`,
so every page/action scopes to the URL workspace with no per-page param threading. Switching workspace = navigating
to `/{id}`. `onboarding`/`new-workspace`/`invite` are slug-less top-level routes (no workspace context yet).

**Auth-exchange gating (entry routing).** The control plane is the auth authority, so the web routes on what
`GET /me` returns, not just on the Keycloak session:
- **Home `/`** — if `GET /me` confirms a real login (`principal.via === 'oidc'`), the landing is skipped and the
  user is redirected to `/{workspace}` (their **most recent**, from `principal.workspace`); 0 workspaces →
  `/onboarding`. A `null` principal (control plane unreachable / token rejected) or the dev `x-assay-tenant`
  fallback (`via !== 'oidc'`) keeps the landing visible — no loop.
- **`/{workspace}/*`** — `[workspace]/layout` is the authoritative validator: `principal === null` (token rejected
  / control plane unreachable) → redirect to `/`; 0 workspaces → `/onboarding`; the URL slug is not one of my
  memberships → redirect to my default `/{principal.workspace}`; else render the app shell.

**Production (`next start`) gotchas** — the config bakes `trustHost: true` (self-hosted; otherwise Auth.js
throws **`UntrustedHost`** 500 on every `/api/auth/*`). For real Keycloak login you still must set **`AUTH_SECRET`**
(`openssl rand -base64 32`) plus the `KEYCLOAK_*` vars and run the control plane (`CONTROL_PLANE_URL`); a stable
`AUTH_SECRET` is required or sessions reset on restart. With Keycloak unconfigured, `/api/auth/*` uses a throwaway
dev secret so it doesn't 500.

## Verified
`next build` compiles + type-checks (9 routes); root gate (Biome / turbo typecheck / test) stays green with
`apps/web` self-contained. **Live (headless OAuth, real Keycloak)** via `scripts/live/web-auth-flow.py`: drives
the Auth.js + Keycloak authorization-code flow with a cookie jar (no browser) for `alice` (member) and `carol`
(admin) → the web forwards each user's token → `/{workspace}` (=`/acme`) shows `workspace=acme` (from `/me`);
`/acme/runs/new` is allowed for both; `/acme/harnesses/new` is gated for the member and allowed for the admin.
**BFF hardening proven**: the
same script asserts `/api/auth/session` carries **no** access token (no `eyJ…`/`accessToken` leak) while the
server-side path still works — the token lives only in the httpOnly cookie.
