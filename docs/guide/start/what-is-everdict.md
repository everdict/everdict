# What is Everdict

Everdict runs your agent against your data and gives you a **defensible verdict** — a pass/fail you can
show someone, with the trace, the scores, and the exact versions behind it.

The name is the job: **eval + verdict**.

## The problem it solves

You changed a prompt, swapped a model, upgraded a framework. Is the agent better or worse? The usual
answer is somebody ran it on a few examples and read the output. That does not survive a disagreement,
it does not catch a regression three weeks later, and it cannot gate a pull request.

Everdict makes that answer mechanical: run the agent on a fixed dataset, score every case the same way,
and compare the result against the previous one. When the number moves, the trace that produced it is
still there.

## What it evaluates

**Any agent, over a process boundary.** Everdict does not ask you to rewrite your agent inside a
framework — it drives whatever you already built:

- **Claude Code, Codex, or any CLI agent** — declared, not coded. A `command` harness is a JSON
  `HarnessSpec` naming the executable and how to read its output. See
  [`../../command-harness.md`](../../command-harness.md).
- **Multi-service systems** — an agent that is really a stack (API + worker + browser + vector store)
  runs as a `service` topology harness on Nomad or Kubernetes. See
  [`../../service-harness.md`](../../service-harness.md).
- **Traces you already have** — if the run happened elsewhere, push or pull its trace from OTel, MLflow,
  Langfuse, LangSmith, or Phoenix and score it with no harness run at all.

**On your infrastructure.** Runs are placed on a runtime you register — a Nomad cluster, a Kubernetes
cluster, or your own laptop through a self-hosted runner. There is no vendor sandbox in the path, and
the agent's model keys are yours.

## What it deliberately is not

- **Not an agent framework.** Everdict has an agent runtime, but that is a *consumer* of the evaluation
  harness, not the product. If you are looking for a library to build an agent with, this is the wrong
  tool.
- **Not a hosted-only service.** Everything in this repository is Apache-2.0 and runs self-hosted; the
  control plane is a Fastify server and a Postgres database.
- **Not an opinion about your stack.** Harnesses, datasets, judges, and runtimes are all pluggable
  adapters behind interfaces. That is the one place this codebase deliberately inverts the usual
  "no interfaces for a single implementation" rule — see [`CLAUDE.md`](https://github.com/everdict/everdict/blob/main/CLAUDE.md).

## How a run is shaped

A run separates four concerns inside the sandbox, plus one outside it:

| Concern | What it is | Where it lives |
| --- | --- | --- |
| **Harness** | the agent under test | `@everdict/harnesses` |
| **Environment** | the world it acts on — repo, browser, OS | `@everdict/environments` |
| **Driver** | in-sandbox compute that actually starts the process | `@everdict/drivers` |
| **Grader / Judge** | how the result is scored | `@everdict/graders` |
| **Backend** | *placement* — where the job runs | `@everdict/backends` |

Keeping the grader out of the harness is what makes the score comparable across agents: two different
agents solving the same case are scored by the same code.

## Who drives it

Two audiences, one platform, the same permissions:

- **People** use the web app — Keycloak login, a workspace dashboard, scorecards and trends.
- **Agents and CI** use the MCP server and API keys — the same tools as the HTTP API, role-gated and
  workspace-scoped, with full parity between the two surfaces.

## Where to go next

- [Quickstart](quickstart.md) — bring the stack up
- [Your first scorecard](first-scorecard.md) — the shortest path to a real verdict
- [Core concepts](../concepts/README.md) — the vocabulary the rest of the docs assumes
