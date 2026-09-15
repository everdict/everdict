---
kind: wiki
title: "Environments"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/execution/environment.ts, packages/graders/src/make-graders.ts, apps/api/src/api/environment/environment.routes.ts, apps/cli/src/image-bake.ts]
---
# Environments

An environment is **the world a case acts on**. It is declared per eval case (`env`), and it is what
makes the same task mean the same thing on every run.

There are four kinds, plus a reference to a registered one.

## `repo` — a seeded file tree

The most common one. You hand it files (or a git URL and ref, or a path already inside the image); the
agent edits them; the run captures a git diff of what changed.

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
  "graders": [{ "id": "judge", "config": { "rubric": "Under 120 words, leads with customer impact, no jargon." } }],
  "timeoutSec": 120
}
```

Use it when a repo would be theater. Most agent benchmarks that are really prompt benchmarks belong
here.

## `browser` — a real Chromium

The agent drives an actual browser, and the end state of the page is what gets graded. The case names
where to start; the browser itself is the harness's `target` (`{ "kind": "browser", "engine": "chromium" }`),
provisioned fresh per case.

```json
{
  "id": "book-a-seat",
  "env": { "kind": "browser", "startUrl": "https://demo.internal/booking" },
  "task": "Book seat 14C on the 09:00 departure.",
  "graders": [{ "id": "dom-contains", "config": { "text": "14C" } }],
  "timeoutSec": 600
}
```

For a logged-in target, a [browser profile](browser-profiles.md) named on the harness target supplies
the cookies so the agent starts inside the session instead of at a login wall.

## `os-use` — a desktop session

The agent controls an OS, not a page. This is what OSWorld-shaped benchmarks need. The case runs in a
desktop image; `setup` brings up the display and apps, and a screenshot is captured at the end.

```json
{
  "id": "export-csv",
  "env": { "kind": "os-use" },
  "image": "ghcr.io/everdict/osworld-ubuntu:1.4.0",
  "task": "Open the spreadsheet on the desktop and export it as CSV to ~/out.csv",
  "graders": [{ "id": "state-check", "config": { "cmd": "test -f /root/out.csv" } }],
  "timeoutSec": 900
}
```

## Choosing one

| If the task is… | Use | Graded by |
| --- | --- | --- |
| editing code | `repo` | tests, the diff |
| answering / writing | `prompt` | a judge, string checks |
| clicking a web app | `browser` | DOM state, URL, screenshots |
| operating a machine | `os-use` | files, screenshots, a VLM judge |

:::tip
Pick the *cheapest* environment that can still fail the case honestly. A `prompt` case that should
have been a `repo` case will pass agents that cannot actually write working code.
:::

## An environment by reference

A case that embeds its environment cannot be evaluated against a second version of it — changing the
seed rewrites the case. `{ "kind": "ref", "id": "checkout-app", "version": "3" }` names a registered
environment instead (`POST /environments`, `GET /environments`). The control plane resolves it before
dispatch, and the batch seals which version actually ran. An absent `version` means the registry's
`latest`, pinned at seal time.

## Environment images

`case.image` names the image a case runs in; `repo` and `prompt` cases can run without one. Those
images are the slow part of an eval, so Everdict treats them as first-class:

- **Bring your own** — any image reachable from the runtime. Wrap a BYO image with the in-job agent so
  it boots correctly on managed runtimes: `everdict image bake <base-ref> --tag <target-ref>`.
- **Publish to the workspace** — see [Image registry](image-registry.md).
- **Pin it.** An image ref that moves is an eval that silently changes. Pin by digest for anything you
  intend to compare across weeks.

## Worlds — when the environment must persist

The kinds above are ephemeral: each case gets a clean one. A **world** is the opposite — a durable,
versioned environment an agent builds up across sandbox sessions, snapshotted as an image that the next
session boots from. Reach for it when the thing you are evaluating is *ongoing operation* rather than a
task with an end.

See [`../../architecture/agent-worlds.md`](../../architecture/agent-worlds.md).

## See also

- [Dataset](../concepts/dataset.md) — where `env` is declared
- [Image registry](image-registry.md) — publishing the images these environments run
- [`../../architecture/environment-image-store.md`](../../architecture/environment-image-store.md) — managed environment images
