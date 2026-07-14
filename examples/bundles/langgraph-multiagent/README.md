# langgraph-multiagent — a real multi-agent app as an Everdict service-topology harness

Unlike a browser/infra harness (Selenium Grid, etc.), this is an **actual agent application** evaluated end to end:
a **LangGraph planner ↔ executor** multi-agent that exchanges messages to perform a task, a **web frontend** that
talks to it, and **Postgres** (run history) + **Redis** (inter-agent message stream) stores. Everdict deploys the
whole topology, drives each task through the front door, and an **LLM judge** scores the answer quality → a
**Scorecard**.

## The topology (`kind: "service"`)

```
[web :8080]──HTTP──►[agent :8000]  (planner → executor, 2 LLM calls exchanging messages)
                        │  │
                   localhost    (co-located netns — the agent reaches its stores over loopback)
                        ▼  ▼
                 [postgres]  [redis]     postgres = persisted runs · redis = per-run message stream
```

- `agent/` — FastAPI + LangGraph. `POST /runs {task, thread_id}` runs **planner** (decompose the task) → **executor**
  (produce the final answer); every inter-agent message is persisted to Postgres and `XADD`ed to a Redis stream.
  LLM over an OpenAI-compatible endpoint (`OPENAI_BASE_URL`/`OPENAI_API_KEY`/`MODEL`).
- `web/` — Flask frontend: a chat box that POSTs to the agent and shows the planner/executor conversation.
- Harness template: `examples/harness-templates/langgraph-multiagent.template.json` (registerable; slots =
  `postgres`/`redis`/`agent`/`web` images).

## Build + verify (live)

```bash
docker build -t everdict-lg-agent:1 examples/bundles/langgraph-multiagent/agent
docker build -t everdict-lg-web:1   examples/bundles/langgraph-multiagent/web
# nomad agent -dev (docker driver) + an OpenAI-compatible endpoint on the host (LiteLLM :4000)
node scripts/live/langgraph-multiagent-nomad.mjs
```

The live script deploys the topology to real Nomad via `NomadTopologyRuntime`, drives 3 tasks through the real
`ServiceTopologyBackend` (front door), and scores each answer with an LLM `JudgeGrader` (LiteLLM) — printing a
Scorecard. **Verified run** (gpt-5.4-mini agent + judge):

```
SCORECARD (langgraph-multiagent × judge)
  pct      quality=1.00 PASS   (15% of 240 = 36)
  primes   quality=1.00 PASS   (11, 13, 17, 19)
  reverse  quality=1.00 PASS   (tcidreve)
  mean quality=1.000 · passRate=100%  (3 cases)
```

The agent genuinely uses its stores: the run rows land in Postgres (`SELECT * FROM runs`) and the planner→executor
messages land in the Redis stream (`XLEN run:<id>`).
