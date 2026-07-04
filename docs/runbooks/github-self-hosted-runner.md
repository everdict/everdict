# Runbook — GitHub self-hosted runner co-registration (real GitHub)

Stand up a **GitHub Actions self-hosted runner + an Assay workspace-shared runner** on one build server, so CI
builds the image and the co-resident Assay runner (`self:ws:<id>`) evaluates it. This is the real-infrastructure
verification of `docs/architecture/self-hosted-runtime-and-runners.md` §4–5 — it needs a real GitHub org/repo, a
build server, and a live GitHub connection, so it is a **manual runbook**, not an automated CI test.

## Prerequisites

- A deployed Assay control plane you can authenticate to (Keycloak login **or** an `ak_…` API key).
- A **GitHub connection** on your account (Account → Connected accounts → GitHub). For **org-level** runners,
  connect with elevated scope: Settings › 공유 러너 › "GitHub Actions 러너" › 조직(org) › "admin:org 권한으로 다시 연결".
- A build server (Linux x64) with `curl`, `tar`, and the `assay` CLI available (or `npm i -g @assay/cli`).
- Admin (`settings:write`) in the target workspace.

## Steps

1. **Generate the install script (Assay side — automated).** Run the helper against your deployment:

   ```bash
   ASSAY_API_URL=https://assay.example.com \
   ASSAY_TOKEN=<Keycloak JWT or ak_… API key> \
   REPO=acme/app \
   node scripts/live/github-self-hosted-runner.mjs
   # org-level:  ORG=acme-inc  RUNNER_GROUP=assay-pool  (instead of REPO)
   ```

   It pairs a workspace-shared Assay runner, mints a **short-lived** GitHub registration token via your
   connection, and prints (a) the **install script** and (b) the **workflow hint** (`runs-on` label + run-eval
   `runtime`). Equivalent UI path: Settings › 공유 러너 › "GitHub Actions 러너". Equivalent MCP tool:
   `github_install_workspace_runner`.

2. **Run the install script on the build server (GitHub side — manual).** It configures `actions/runner`
   (`config.sh`, with `--runnergroup` for org runners) **and** starts `assay runner --pair …` — both workers on
   one host. The GitHub runner registers to the repo (or org); the Assay runner joins the `self:ws:<id>` pool.

3. **Wire the workflow (manual).** Either paste the printed `runs-on`/`runtime` hint into your workflow, or use
   the zero-input path: Settings › CI 연동 › connect the repo, fill "5. 셀프호스티드 러너" with the same
   `runs-on` label and `runtime: self:ws:<id>`, then "Open setup PR" — Assay generates the workflow file.

4. **Fire and verify (manual).** Open/merge a PR. GitHub Actions runs on your self-hosted runner, builds the
   image, and calls the Assay run-eval action with `runtime: self:ws:<id>`; the co-resident Assay runner executes
   the evaluation. Confirm: the scorecard's `origin` records `repo`/`sha`; the eval result posts back to the PR
   check; `provenance.by` on the run is `ws:<workspace>` (workspace-pays) and `provenance.runner` is the runner id.

## Notes

- Registration tokens are short-lived — run the install script promptly (re-run the helper to mint a fresh one).
- Assay never stores a long-lived GitHub runner token; the runner holds its own GitHub credential after config.
- The GitHub-side end-to-end (Actions firing) is intentionally out of scope for automated tests — this runbook is
  how you verify it against real GitHub. The Assay-side plumbing is covered by unit/integration tests and the
  `scripts/live/{workspace-shared,multi-runner,personal}-pool.mjs` live checks.
