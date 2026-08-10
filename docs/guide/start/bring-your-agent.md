# Bring your own agent

Find your agent below. Each path ends at a registered harness you can point a dataset at.

## A CLI agent — the default answer

If your agent is something you can run in a terminal, you are done in one JSON document. No adapter, no
SDK, no package to install:

```json
{
  "kind": "command",
  "category": "cli-agent",
  "id": "my-agent",
  "version": "1.0.0",
  "setup": [],
  "command": "my-agent --prompt {{task}} < /dev/null",
  "model": "claude-sonnet-5",
  "env": {},
  "trace": { "kind": "none" }
}
```

```bash
curl -XPOST localhost:8787/harnesses \
  -H 'x-everdict-tenant: default' -H 'content-type: application/json' -d @my-agent.json
```

Three details that decide whether this works on the first try:

- **`{{task}}`** — where the case's instruction is substituted. Without it the agent gets no task.
- **`< /dev/null`** — an immediate stdin EOF. Run through a pipe rather than a TTY, an agent that
  waits for input hangs until the timeout and every case "fails".
- **`setup`** — commands run before the agent, for installing it. Leave it empty when the agent is
  already on the machine (a self-hosted runner, usually).

Full reference: [`../../command-harness.md`](../../command-harness.md).

## Claude Code

Claude Code has a coded adapter, because its stream-JSON output is worth parsing into a real trace —
you get tool calls, token counts and `total_cost_usd` rather than an exit code:

```json
{ "harness": { "id": "claude-code", "version": "latest" } }
```

Under `LocalDriver` it uses the machine's existing login, so no API key is needed. Set
`ANTHROPIC_API_KEY` or `CLAUDE_CODE_OAUTH_TOKEN` when running somewhere that has no login.

## Codex

A declarative `command` harness, shipped as a bundle you can apply as data:

```bash
curl -XPOST localhost:8787/bundles/apply \
  -H 'content-type: application/json' -d @examples/bundles/codex-pinch/bundle.json
```

See [Running Codex](../integrations/codex.md) — including why it runs best on a self-hosted runner,
where the machine's own ChatGPT login pays.

## An agent that is really a stack

If your "agent" is an API plus a worker plus a browser plus a vector store, it is a `service` harness.
Everdict deploys the topology for the run and tears it down after:

```json
{
  "kind": "service",
  "id": "my-stack",
  "version": "1.0.0",
  "services": [
    { "name": "api",   "image": "ghcr.io/acme/agent-api:1.2.0", "port": 8000 },
    { "name": "redis", "image": "redis:7-alpine" }
  ],
  "target": { "acquire": { "mode": "service", "capacity": 4 } },
  "trace": { "kind": "langfuse" }
}
```

`trace.kind` matters here: a stack usually already emits traces to an observability platform, and
Everdict pulls them rather than asking you to re-instrument. See
[`../../service-harness.md`](../../service-harness.md).

## An agent that already ran

Sometimes there is nothing to drive — the run happened last week, in production, somewhere else
entirely. Score the traces directly:

```bash
curl -XPOST localhost:8787/scorecards/ingest/pull \
  -H 'content-type: application/json' -d '{
  "source": "mlflow-prod",
  "dataset": { "id": "retrieval-smoke", "version": "latest" },
  "judges":  [{ "id": "tone-rubric", "version": "latest" }]
}'
```

No harness is registered and no agent is started. When the source kind matches your platform, the
scores are attached to the original traces rather than duplicated.

## Which one am I?

- It runs in a terminal → **`command`**
- It needs its native output parsed into a real trace → **`process`** (Claude Code today)
- It is several services → **`service`**
- It already ran and you have the trace → **ingest**, no harness at all

:::tip
Start with `command` even if you will eventually need more. A working `command` harness in ten minutes
tells you whether your dataset and graders are right, which is the part that is actually hard.
:::

## Next

- [Your first scorecard](first-scorecard.md) — point a dataset at what you just registered
- [Harness](../concepts/harness.md) — templates, instances, and pinning what actually ran
- [Environments](../workspace/environments.md) — the world the agent acts on
