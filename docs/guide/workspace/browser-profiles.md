---
kind: wiki
title: "Browser profiles"
status: current
updated: 2026-09-15
anchors: [apps/api/src/api/browser-profile/browser-profile.routes.ts, apps/api/src/api/browser-profile/request/create-browser-profile.ts, apps/api/src/api/browser-profile/request/capture-browser-profile.ts, apps/api/src/api/browser-session/browser-session.routes.ts, packages/contracts/src/records/browser-profile.ts]
---

> Design SSOT: [browser-profiles.md](../../architecture/browser-profiles.md) — the maintainer page holds the mechanism. Describe the behaviour here; do not re-derive the design.
# Browser profiles

A `browser` case starts at a login wall unless the browser already knows who you are. A **profile** is
a captured login — the cookies the site set — that eval browsers start inside. In the web app this is
**Settings → Browser profiles**, which walks the steps below.

Create the profile:

```bash
curl -XPOST localhost:8787/browser-profiles \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "name": "demo-tenant-admin",
  "cookieDomains": ["demo.internal"],
  "visibility": "workspace"
}'
# → { "id": "bp_31a", … }
```

Open a **real interactive remote browser** (`POST /browser-sessions`, available when the deployment
enables browser sessions) and log in by hand — MFA, SSO, whatever your app demands. Then capture what
the session became:

```bash
curl -XPOST localhost:8787/browser-profiles/bp_31a/capture \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' \
  -d '{"sessionId":"<browser-session-id>"}'
```

`cookies` narrows the capture to named cookies; omitted, everything the session holds is saved. The
captured state is stored encrypted and never crosses the wire again.

From then on, name the profile on the harness's browser target, and every case's browser has those
cookies seeded before the agent connects:

```json
{ "target": { "kind": "browser", "engine": "chromium", "profile": "bp_31a" } }
```

## Why capture rather than script a login

Scripting the login into the case makes every case an authentication test. When the login flow changes
— a new consent screen, an MFA prompt — every case fails for a reason that has nothing to do with the
agent, and the failures look like agent regressions.

Capturing separates them. The profile is the thing that expires; the cases stay about the task.

## Sessions expire, and that is a maintenance job

:::warning
A stale profile does not fail loudly — and neither does one that could not be injected: a profile the
run's submitter cannot use is skipped, and the eval runs unauthenticated. The agent lands on a login page
and does something reasonable with it, and the case fails as though the agent could not book a seat.
Re-capture on a schedule rather than on discovery.
:::

Each profile records `expiresAt` — the earliest expiry among its captured cookies — and Settings shows
it, so the lapse is visible before it bites. Cases graded on DOM state are especially prone to this —
"confirmation not found" is the same symptom for "agent failed" and "session expired".

`POST /browser-profiles/:id/restore` seeds a saved login back into a live session, so a re-login starts
from where the last one was.

## Scope

A profile is `private` by default — visible and usable only by its creator. `workspace` shares it: any
member can read it, and its creator or an admin manages it. Either way it carries real credentials in
the form of live sessions. Treat one as you would a shared account: use a dedicated test tenant on the
target system, never a person's real login, and never a production account with write access to
anything that matters.

## See also

- [Environments](environments.md) — where `kind: browser` fits among the others
- [`../../architecture/browser-profiles.md`](../../architecture/browser-profiles.md) — the design record
