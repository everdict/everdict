# What is Everdict

You changed the retrieval prompt on Tuesday. On Thursday someone says the agent feels worse. You run it
on four examples, three look fine, and now there are two opinions and no way to settle them.

Everdict is the thing that settles it. It runs your agent against a fixed set of problems, scores every
case the same way, and produces a **verdict** — with the trace, the scores, and the exact versions
behind it.

The name is the job: **eval + verdict**.

## What you actually get

- **A number that moves for a reason.** Run a dataset, get a scorecard, diff it against last week's.
  Regressions are named case by case rather than averaged into a percentage.
- **A gate.** That diff is an API call, so a pull request that breaks a case can be blocked before it
  lands.
- **A record you can show someone.** Every scorecard seals the dataset version, the harness version,
  the resolved image pins and the verdict policy that decided pass and fail.

## What it evaluates

**Any agent, over a process boundary.** Everdict does not ask you to rewrite your agent inside a
framework — it starts whatever you already built and observes it:

- **Claude Code, Codex, or any CLI agent** — declared as JSON, not coded. See
  [Bring your own agent](bring-your-agent.md).
- **Multi-service systems** — an agent that is really a stack runs as a `service` topology on Nomad or
  Kubernetes.
- **Runs that already happened** — push or pull a trace from OTel, MLflow, Langfuse, LangSmith or
  Phoenix and score it with no harness run at all.

**On your infrastructure.** Runs land on a runtime you registered — your Nomad, your Kubernetes, or
your own laptop through a self-hosted runner. No vendor sandbox, and the model keys stay yours.

## When *not* to use it

Being honest about this saves everyone time:

- **You want a framework to build an agent with.** This is the wrong tool. Everdict has an agent
  runtime, but it exists to *consume* the evaluation harness, not to be the product.
- **You have no repeatable task.** Evaluation needs problems with a stable identity. If every request
  is one-of-a-kind and there is no notion of "solved", there is nothing to compare across versions.
- **You want a leaderboard without a dataset.** Public benchmark scores are cheap and mean little
  about *your* workload. The value here comes from cases that look like your traffic.
- **You need it hosted for you today.** Everything here is self-hosted and Apache-2.0.

## What it will not do for you

- **It will not tell you the task was worth doing.** A rising pass rate on a bad dataset is a rising
  number, nothing more. Case design is on you, and it is the hard part.
- **It will not make an LLM judge objective.** A judge introduces its own variance to every score it
  produces. Prefer deterministic grading whenever the output has a checkable shape.
- **It will not hide uncertainty.** When a grader dies, the case reads `not evaluated` — never a zero,
  never a pass. Some dashboards get quieter numbers by lying; this one gets noisier ones by not.

## How a run is shaped

Four concerns inside the sandbox, plus one outside it. Keeping them apart is what makes the same case
portable across agents and infrastructure.

The **harness** is the agent under test. The **environment** is the world it acts on — a repo, a
prompt, a browser, an OS. The **driver** is in-sandbox compute that starts the process. The
**grader** turns the result into a measurement. And the **backend** decides *where* the job runs at
all.

Grading sits outside the harness on purpose: two different agents solving the same case are scored by
the same code, which is the only reason their numbers can be compared.

## Who drives it

**People** use the web app — Keycloak login, a workspace dashboard, scorecards and trends.
**Agents and CI** use the MCP server and API keys. Both surfaces expose the same capabilities, at
parity by construction: a tool exists on both or on neither.

## Next

- [Quickstart](quickstart.md) — the stack, in one command
- [Your first scorecard](first-scorecard.md) — clone a working evaluation
- [Core concepts](../concepts/README.md) — the vocabulary the rest of the docs assumes
