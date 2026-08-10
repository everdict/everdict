# Notifications

Evaluations are asynchronous and slow. If finding out requires remembering to check, you will find out
late.

## Mattermost

Register a bot token once, and completions and regressions land in a channel:

```bash
curl -XPUT localhost:8787/workspace/mattermost \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d '{
  "url": "https://mattermost.internal",
  "tokenSecret": "mattermost-bot",
  "channel": "evals"
}'
```

`tokenSecret` names a workspace secret; the token itself never appears in the request or the record.

## Webhooks

For anything else, a subscription delivers signed payloads to your endpoint:

```bash
curl -XPOST localhost:8787/subscriptions \
  -H 'content-type: application/json' -d '{
  "name": "post scorecards to ops",
  "selector": { "kinds": ["scorecard.completed"] },
  "reaction": { "kind": "webhook", "url": "https://ops.internal/hooks/everdict" },
  "enabled": true
}'
```

Delivery is cursor-based, so a consumer that was down does not lose events — it resumes from where it
stopped rather than from now.

## In the product

The web inbox collects the same events, and the desktop app raises them as native notifications. A run
you started an hour ago tells you it finished without you keeping the tab open.

## Choosing a trigger

`scorecard.completed` fires on every batch, which is noise if you run nightly. What you usually want is
the regression, not the run — a subscription whose reaction is an **agent** can diff the result and only
speak when something moved:

```json
{ "selector": { "kinds": ["scorecard.completed"] },
  "reaction": { "kind": "agent", "agentId": "default",
                "prompt": "Diff against the baseline. Say nothing unless a case regressed." },
  "cooldownSec": 300 }
```

:::tip
Notify on the thing that requires a decision. A channel that receives every completion gets muted in a
week, and then it notifies nobody about anything.
:::

## See also

- [Workspace agents](../workspace/agents.md) — reactions that do more than deliver
- [`../../architecture/notifications.md`](../../architecture/notifications.md) · [`../../architecture/event-plumbing.md`](../../architecture/event-plumbing.md)
