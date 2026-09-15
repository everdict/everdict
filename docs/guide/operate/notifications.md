---
kind: wiki
title: "Notifications"
status: current
updated: 2026-09-15
anchors: [apps/api/src/api/mattermost/mattermost.routes.ts, packages/contracts/src/records/subscription.ts, packages/application-control/src/platform-event/subscription-reaction-consumer.ts, apps/desktop/src/notification-watcher.ts]
---
# Notifications

Evaluations are asynchronous and slow. If finding out requires remembering to check, you will find out
late.

## Mattermost

The operator points the control plane at a Mattermost server once (`MATTERMOST_HOST`). A workspace admin
then registers a bot — under **Settings → Integrations**, or:

```bash
curl -XPUT localhost:8787/workspace/mattermost \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "botTokenSecretName": "MATTERMOST_BOT_TOKEN",
  "defaultChannelId": "<channel-id>"
}'
```

`botTokenSecretName` names a workspace secret; the token itself never appears in the request or the
record. The token (and channel) are verified against the live server when you save. Completions and
regressions then land in that channel.

## Webhooks

For anything else, a subscription delivers payloads to your endpoint:

```bash
curl -XPOST localhost:8787/subscriptions \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "name": "post scorecards to ops",
  "selector": { "kinds": ["scorecard.completed"] },
  "reaction": { "kind": "webhook", "url": "https://ops.internal/hooks/everdict",
                "secret": "a-long-shared-secret" }
}'
```

With a `secret`, each body is HMAC-SHA256 signed in `x-everdict-signature`. Delivery is at-least-once
from a durable cursor, with retries and a dead letter for an endpoint that keeps failing — so dedupe on
the event id in `x-everdict-event`.

## In the product

The web notification bell collects the same events, and the desktop app raises them as native
notifications. A run you started an hour ago tells you it finished without you keeping the tab open.

## Choosing a trigger

`scorecard.completed` fires on every batch, which is noise if you run nightly. What you usually want is
the regression, not the run. A selector can filter on the event's payload, and a reaction that wakes an
**agent** can diff the result and only speak when something moved:

```json
{ "name": "speak up on failing batches",
  "selector": { "kinds": ["scorecard.completed"],
                "filters": [{ "field": "passRate", "op": "lt", "value": 1 }] },
  "reaction": { "kind": "agent", "agentId": "regression-watch" },
  "governance": { "cooldownSec": 300 } }
```

The woken agent follows its own `task` — here, something like "diff against the baseline; say nothing
unless a case regressed" (see [Workspace agents](../workspace/agents.md)).

:::tip
Notify on the thing that requires a decision. A channel that receives every completion gets muted in a
week, and then it notifies nobody about anything.
:::

## See also

- [Workspace agents](../workspace/agents.md) — reactions that do more than deliver
- [`../../architecture/notifications.md`](../../architecture/notifications.md) · [`../../architecture/event-plumbing.md`](../../architecture/event-plumbing.md)
