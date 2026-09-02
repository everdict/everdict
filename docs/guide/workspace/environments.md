---
kind: wiki
title: "Environments"
status: current
updated: 2026-08-11
---
# Environments

An environment is **the world a case acts on**. It is declared per eval case, and it is what makes the
same task mean the same thing on every run.

There are four kinds.

## `repo` — a seeded file tree

The most common one. You hand it files; the agent edits them; the run captures a git diff of what
changed.

```json
{
  "id": "add-retry",
  "env": {
    "kind": "repo",
    "source": { "files": { "client.py": "import requests\n\ndef fetch(u):\n    return requests.get(u)\n" } }
  },
  "task": "Add exponential-backoff retry to fetch(), max 3 attempts.",
  "graders": [{ "id": "tests-pass", "config": { "cmd": "pytest -q" } }],
  "timeoutSec": 300
}
```

The snapshot at the end is a diff, not a copy, so a grader can ask "what did it actually change?" and
not just "what does the tree look like now".

## `prompt` — no world at all

For tasks that are pure text in, text out. There is nothing to seed and nothing to diff, so grading is
a judge or a string check.

```json
{
  "id": "summarize-incident",
  "env": { "kind": "prompt" },
  "task": "Summarize this incident report for an exec audience in under 120 words:\n\n…",
  "graders": [{ "id": "judge", "config": { "judge": "concision-rubric" } }],
  "timeoutSec": 120
}
```

Use it when a repo would be theater. Most agent benchmarks that are really prompt benchmarks belong
here.

## `browser` — a real Chromium

The agent drives an actual browser, and the end state of the page is what gets graded.

```json
{
  "id": "book-a-seat",
  "env": { "kind": "browser", "engine": "chromium", "url": "https://demo.internal/booking" },
  "task": "Book seat 14C on the 09:00 departure.",
  "graders": [{ "id": "dom-contains", "config": { "selector": ".confirmation", "text": "14C" } }],
  "timeoutSec": 600
}
```

A per-case browser is provisioned on the runtime; for a logged-in target, an
authenticated browser profile supplies the cookies so the agent starts inside the session instead of
at a login wall.

## `os-use` — a desktop session

The agent controls an OS, not a page. This is what OSWorld-shaped benchmarks need.

```json
{
  "id": "export-csv",
  "env": { "kind": "os-use" },
  "image": "ghcr.io/everdict/osworld-ubuntu:1.4.0",
  "task": "Open the spreadsheet on the desktop and export it as CSV to ~/out.csv",
  "graders": [{ "id": "script", "config": { "cmd": "test -f /root/out.csv" } }],
  "placement": { "target": "docker" },
  "timeoutSec": 900
}
```

## Choosing one

| If the task is… | Use | Graded by |
| --- | --- | --- |
| editing code | `repo` | tests, the diff |
| answering / writing | `prompt` | a judge, string checks |
| clicking a web app | `browser` | DOM state, screenshots |
| operating a machine | `os-use` | files, screenshots, a VLM judge |

:::tip
Pick the *cheapest* environment that can still fail the case honestly. A `prompt` case that should
have been a `repo` case will pass agents that cannot actually write working code.
:::

## Environment images

`repo` and `prompt` need nothing. `browser` and `os-use` run inside an image, and `case.image` names
it. Those images are the slow part of an eval, so Everdict treats them as first-class:

- **Bring your own** — any image reachable from the runtime. Wrap a BYO image with the in-job agent so
  it boots correctly on managed runtimes: `everdict image bake <base-ref> --tag <target-ref>`.
- **Publish to the workspace registry** — see [Image registry](image-registry.md).
- **Pin it.** An image ref that moves is an eval that silently changes. Pin by digest for anything you
  intend to compare across weeks.

## Worlds — when the environment must persist

The four kinds above are ephemeral: each case gets a clean one. A **world** is the opposite — a
long-lived environment an agent returns to, so state accumulates across runs. Reach for it when the
thing you are evaluating is *ongoing operation* rather than a task with an end.

See [`../../architecture/agent-worlds.md`](../../architecture/agent-worlds.md).

## See also

- [Dataset](../concepts/dataset.md) — where `env` is declared
- [Image registry](image-registry.md) — publishing the images these environments run
- [`../../architecture/environment-image-store.md`](../../architecture/environment-image-store.md) — managed environment images
