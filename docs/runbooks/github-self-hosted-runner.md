---
kind: runbook
title: "Runbook — GitHub self-hosted runner co-registration (real GitHub)"
status: current
updated: 2026-09-15
anchors: [packages/application-control/src/runner/github-runner-install.ts, apps/api/src/api/runner/workspace-runner.routes.ts]
---
# Runbook — GitHub self-hosted runner co-registration (real GitHub)

Stand up a **GitHub Actions self-hosted runner + an Everdict workspace-shared runner** on one build server, so CI
builds the image and the co-resident Everdict runner (`self:ws:<id>`) evaluates it. This is the real-infrastructure
verification of [self-hosted runtime and runners](../architecture/self-hosted-runtime-and-runners.md) §4 — it needs a
real GitHub org/repo, a build server, and the workspace GitHub App, so it is a **manual runbook**, not an automated
CI test.

## Prerequisites

- A deployed Everdict control plane you can authenticate to (Keycloak login **or** an `ak_…` API key).
- The **workspace GitHub App** installed on the target repo or org (Settings › Integrations), with `administration`
  permission — the runner registration token is minted through that installation, not through a personal account.
- A build server (Linux x64) with `curl` and `tar`. The install script downloads `actions/runner` and starts
  `everdict runner`, so the `everdict` CLI must be on the PATH (`npm i -g @everdict/cli`).
- Admin (`settings:write`) in the target workspace.

## Steps

1. **Generate the install script (Everdict side).** Any of three equivalent entry points, all backed by
   `installGithubWorkspaceRunner`:
   - UI: Settings › Shared runners › "GitHub Actions runner" — pick a repo or org the App can see.
   - MCP tool: `github_install_workspace_runner`.
   - HTTP:

     ```bash
     curl -sS -X POST "$EVERDICT_API_URL/workspace/runners/github-install" \
       -H "authorization: Bearer $EVERDICT_TOKEN" -H 'content-type: application/json' \
       -d '{"repository":"acme/app"}'
     # org-level: {"org":"acme-inc","runnerGroup":"everdict-pool"}   GHE: add "host":"https://<ghe-host>"
     ```

   It pairs a new workspace-shared Everdict runner, mints a **short-lived** GitHub registration token via the App
   installation, and returns `installScript`, `workflowHint` (`runs-on` label + run-eval `runtime`),
   `runtimeTarget` and `registrationExpiresAt`. The App not being installed on the owner is a `404`.
   `scripts/live/github-self-hosted-runner.mjs` drives the same `POST /workspace/runners/github-install` for a live
   check (`HOST` optional) and points back at this runbook when the App is not installed.

2. **Run the install script on the build server (GitHub side — manual).** It configures `actions/runner`
   (`config.sh`, with `--runnergroup` for org runners) **and** starts `everdict runner --pair …` — both workers on
   one host. The GitHub runner registers to the repo (or org); the Everdict runner joins the `self:ws:<id>` pool.

3. **Wire the workflow (manual).** Either paste the returned `runs-on`/`runtime` hint into your workflow, or use
   the zero-input path: open a harness's **CI integration** panel › "Connect GitHub repo", fill step "5. Runner"
   with the same `runs-on` label and `runtime: self:ws:<id>` (blank = any runner in the pool), save the link, then
   "Setup PR" — Everdict opens a PR adding the workflow file.

4. **Fire and verify (manual).** Open/merge a PR. GitHub Actions runs on your self-hosted runner, builds the
   image, and calls the Everdict run-eval action with `runtime: self:ws:<id>`; the co-resident Everdict runner executes
   the evaluation. Confirm: the scorecard's `origin` records `repo`/`sha`; the eval result posts back to the PR
   check; the run's `provenance.ranOn` is `self-hosted`, `provenance.by` is `ws:<workspace>` (workspace-pays) and
   `provenance.runner` is the runner id.

## Live-verified (repo-level, 2026-07-05)

The full loop was run for real against GitHub Actions, at a time when the registration token was still minted through
a personal GitHub connection rather than the workspace App: this machine acted as the build server (local control
plane + Everdict runner + a real GitHub Actions **self-hosted runner** registered to a throwaway repo). A
`workflow_dispatch` job dispatched to the self-hosted runner drove an Everdict run on `self:ws`; the workflow log
showed:

```
submitted run … -> self:ws
status: succeeded
"ranOn": "self-hosted"
"by": "ws:default"          # workspace-pays
OK: Everdict eval ran on self:ws (self-hosted, workspace-pays)
```

Workflow conclusion: **success**. The runner was registered `--ephemeral`, so it auto-deregistered after the one
job (no lingering runner). **Org-level** was not exercised; it is covered by unit tests only.

## Notes

- Registration tokens are short-lived (about one hour) — run the install script promptly, or generate a fresh one.
- Everdict never stores a long-lived GitHub runner token; the runner holds its own GitHub credential after config.
- The GitHub-side end-to-end (Actions firing) is intentionally out of scope for automated tests — this runbook is
  how you verify it against real GitHub. The Everdict-side plumbing is covered by unit/integration tests and the
  `scripts/live/workspace-shared-runner.mjs`, `scripts/live/multi-runner-pool.mjs` and
  `scripts/live/personal-pool.mjs` live checks.
