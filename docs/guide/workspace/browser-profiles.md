---
kind: wiki
title: "Browser profiles"
status: current
updated: 2026-08-11
---

> Design SSOT: [browser-profiles.md](../../architecture/browser-profiles.md) — the maintainer page holds the mechanism. Describe the behaviour here; do not re-derive the design.
# Browser profiles

A `browser` case starts at a login wall unless the browser already knows who you are. A **profile** is
a captured browser session — cookies, storage, whatever the site uses — that eval cases start inside.

```bash
curl -XPOST localhost:8787/browser-profiles \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "name": "demo-tenant-admin",
  "startUrl": "https://demo.internal/login"
}'
```

That opens a **real interactive remote browser**. You log in by hand — MFA, SSO, whatever your app
demands — and then capture what the session became:

```bash
curl -XPOST localhost:8787/browser-profiles/bp_31a/capture \
  -H 'x-everdict-tenant: default' -d '{}'
```

From then on, cases restore that state instead of authenticating:

```json
{
  "id": "book-a-seat",
  "env": { "kind": "browser", "engine": "chromium",
           "url": "https://demo.internal/booking", "profile": "bp_31a" },
  "task": "Book seat 14C on the 09:00 departure.",
  "graders": [{ "id": "dom-contains", "config": { "selector": ".confirmation", "text": "14C" } }],
  "timeoutSec": 600
}
```

## Why capture rather than script a login

Scripting the login into the case makes every case an authentication test. When the login flow changes
— a new consent screen, an MFA prompt — every case fails for a reason that has nothing to do with the
agent, and the failures look like agent regressions.

Capturing separates them. The profile is the thing that expires; the cases stay about the task.

## Sessions expire, and that is a maintenance job

:::warning
A stale profile does not fail loudly. The agent lands on a login page and does something reasonable
with it, and the case fails as though the agent could not book a seat. Re-capture on a schedule rather
than on discovery.
:::

Cases graded on DOM state are especially prone to this — "confirmation not found" is the same symptom
for "agent failed" and "session expired".

## Scope

Profiles are workspace-scoped, and they carry real credentials in the form of live sessions. Treat one
as you would a shared account: use a dedicated test tenant on the target system, never a person's real
login, and never a production account with write access to anything that matters.

## See also

- [Environments](environments.md) — where `kind: browser` fits among the four
- [`../../architecture/browser-profiles.md`](../../architecture/browser-profiles.md) — the design record
