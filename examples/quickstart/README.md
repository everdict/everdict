# quickstart — a working evaluation you can clone

Everything needed for a first result: one harness, one dataset, one script that runs them and prints
the verdict. No API key required — the `scripted` harness replays a canned trajectory, so this measures
the *plumbing*, not a model.

```bash
docker compose -f deploy/compose/docker-compose.dev.yaml up --build -d
bash examples/quickstart/run.sh
```

Expected output:

```
① registering harness   demo-agent@1.0.0
② registering dataset   demo-smoke@1.0.0
③ running scorecard     sc_…
   waiting … succeeded
④ verdict               2/2 passed (passRate 1)
```

## Files

| File | What it is |
| --- | --- |
| `harness.json` | a declarative `command` harness — the whole integration, no code |
| `dataset.json` | two `repo` cases, graded deterministically by a shell command |
| `run.sh` | register → submit → poll → print the verdict |

## Make it yours

**Swap the agent.** Change `command` in `harness.json` to your own CLI, keeping `{{task}}` where the
instruction should be substituted:

```json
{ "command": "my-agent --prompt {{task}}" }
```

Everything else stays. That is the point of a harness-agnostic dataset — the cases never mention the
agent, so exchanging one agent for another is a one-line edit and the numbers stay comparable.

**Swap the problems.** Add cases to `dataset.json`. Each needs an `id`, an `env`, a `task`, at least
one grader and a `timeoutSec`.

**Add trials.** Change `"trials": 1` to `3` in `run.sh` and watch whether the same case passes every
time. If it does not, you have found flakiness, and a single-run scorecard was always going to report
one of those attempts at random.

## Next

- [Your first scorecard](https://github.com/everdict/everdict/blob/main/docs/guide/start/first-scorecard.md)
- [Bring your own agent](https://github.com/everdict/everdict/blob/main/docs/guide/start/bring-your-agent.md)
