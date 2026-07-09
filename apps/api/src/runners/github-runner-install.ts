import { BadRequestError } from "@everdict/core";
import type { RunnerMeta } from "@everdict/db";
import type { CiLinkService } from "../integrations/ci-link-service.js";
import type { RunnerService } from "./runner-service.js";

// GitHub Actions self-hosted runner self-registration (design doc §4) — one admin action stands up **two workers** on a build server:
//  (1) a GitHub Actions self-hosted runner (config.sh — CI builds the image + calls Everdict)
//  (2) an Everdict workspace-shared runner (everdict runner — leases self:ws:<id> jobs to run evals)
// The two workers live side by side on the same host. The Everdict runner token is issued by pairing a new workspace-shared runner (shown once),
// and the GitHub registration token is minted via the workspace GitHub App (administration; short-lived). Shared BFF↔MCP core (routes/tools call this).

export interface GithubRunnerInstallInput {
  workspace: string;
  // Target: repo level (repository="owner/name") or org level (org="org"). The workspace GitHub App must be installed on that org/repo. Exactly one.
  repository?: string; // "owner/name"
  org?: string; // org name — org level (all repos share this runner). Requires an admin:org scoped connection.
  host?: string; // GHE base URL — unset = github.com preferred. Mints from the exact installation even when the same owner is installed on multiple hosts.
  label: string; // Everdict runner display name
  apiUrl: string; // control-plane base — `everdict runner --api-url`
  githubLabels?: string[]; // extra GH runner labels (always in addition to self-hosted + everdict-<id>)
  capabilities?: string[]; // initial Everdict runner capability labels (re-probed when the runner attaches)
  runnerGroup?: string; // org runner group (org level only, optional) — that group's access policy applies to this runner
}

export interface GithubRunnerInstallResult {
  runner: RunnerMeta;
  runtimeTarget: string; // "self:ws:<id>" — the value to put in the workflow runtime input
  githubRunnerLabel: string; // "everdict-<id>" — the label to put in the workflow runs-on
  installScript: string; // bash to run on the build server (starts both workers)
  workflowHint: string; // a runs-on/runtime snippet to add to the workflow
  registrationExpiresAt: string; // GitHub registration token expiry (short-lived)
}

export async function installGithubWorkspaceRunner(
  deps: { runnerService: RunnerService; ciLinkService: CiLinkService },
  input: GithubRunnerInstallInput,
): Promise<GithubRunnerInstallResult> {
  // Target is exactly one of repo or org. repo is "owner/name", org is a single segment with no slash/whitespace.
  if ((input.repository === undefined) === (input.org === undefined))
    throw new BadRequestError("BAD_REQUEST", {}, "Specify exactly one of repository or org.");
  if (input.repository !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(input.repository))
    throw new BadRequestError(
      "BAD_REQUEST",
      { repository: input.repository },
      "repository must be in 'owner/name' form.",
    );
  if (input.org !== undefined && !/^[^/\s]+$/.test(input.org))
    throw new BadRequestError("BAD_REQUEST", { org: input.org }, "org must be an org name with no slash/whitespace.");
  const target: { repo: string } | { org: string } =
    input.org !== undefined ? { org: input.org } : { repo: input.repository as string };

  // (2) Pair the Everdict workspace-shared runner — the plaintext rnr_ token goes only into the script (stored as a hash).
  const paired = await deps.runnerService.pairWorkspace({
    workspace: input.workspace,
    label: input.label,
    ...(input.capabilities !== undefined ? { capabilities: input.capabilities } : {}),
  });
  // (1) Mint the GitHub registration token — via the workspace GitHub App (administration). The App must be installed on that org/repo.
  const reg = await deps.ciLinkService.mintRunnerToken(input.workspace, target, input.host);

  const runnerId = paired.meta.id;
  const runtimeTarget = `self:ws:${runnerId}`;
  const githubRunnerLabel = `everdict-${runnerId}`;
  const ghLabels = ["self-hosted", githubRunnerLabel, ...(input.githubLabels ?? [])];
  // config.sh --url: a repo runner uses the repo URL, an org runner uses the org URL (shared by all repos in that org).
  const host = (reg.host ?? "https://github.com").replace(/\/$/, "");
  const repoUrl = "org" in target ? `${host}/${target.org}` : `${host}/${target.repo}`;

  const installScript = renderRunnerInstall({
    repoUrl,
    githubRegToken: reg.token,
    githubLabels: ghLabels,
    runnerName: `${input.label}-${runnerId}`,
    everdictRunnerToken: paired.token,
    apiUrl: input.apiUrl.replace(/\/$/, ""),
    runtimeTarget,
    // Runner groups are org-runner only (--runnergroup is a no-op for repo runners). Pass it only for org targets.
    ...("org" in target && input.runnerGroup ? { runnerGroup: input.runnerGroup } : {}),
  });
  const workflowHint = renderWorkflowHint(githubRunnerLabel, runtimeTarget);

  return {
    runner: paired.meta,
    runtimeTarget,
    githubRunnerLabel,
    installScript,
    workflowHint,
    registrationExpiresAt: reg.expiresAt,
  };
}

// Run on the build server — starts the GitHub Actions runner (config.sh) + the Everdict runner in the background. Tokens live only in this script.
function renderRunnerInstall(p: {
  repoUrl: string;
  githubRegToken: string;
  githubLabels: string[];
  runnerName: string;
  everdictRunnerToken: string;
  apiUrl: string;
  runtimeTarget: string;
  runnerGroup?: string; // org runner group (org level only, optional) — config.sh --runnergroup
}): string {
  const rv = "2.319.1"; // actions/runner version — bump as needed
  const groupFlag = p.runnerGroup ? ` \\\n  --runnergroup "${p.runnerGroup}"` : ""; // org runner group (if any)
  return `#!/usr/bin/env bash
# Everdict-generated self-hosted runner install script — stands up a GitHub Actions runner + an Everdict runner together on this build server.
# It contains tokens — do not share it (the GitHub registration token is short-lived, the Everdict token is shown once).
set -euo pipefail

# 1) GitHub Actions self-hosted runner (for CI builds)
mkdir -p actions-runner && cd actions-runner
if [ ! -f ./config.sh ]; then
  curl -fsSL -o runner.tar.gz "https://github.com/actions/runner/releases/download/v${rv}/actions-runner-linux-x64-${rv}.tar.gz"
  tar xzf runner.tar.gz
fi
./config.sh --unattended --replace \\
  --url "${p.repoUrl}" \\
  --token "${p.githubRegToken}" \\
  --name "${p.runnerName}" \\
  --labels "${p.githubLabels.join(",")}"${groupFlag}
nohup ./run.sh > /tmp/gh-actions-runner.log 2>&1 &
cd ..

# 2) Everdict runner (leases self:ws jobs to run evals) — the everdict CLI must be installed.
#    (if not installed: npm i -g @everdict/cli  or use the released binary)
nohup everdict runner --pair "${p.everdictRunnerToken}" --api-url "${p.apiUrl}" > /tmp/everdict-runner.log 2>&1 &

echo "✓ GitHub Actions runner + Everdict runner (${p.runtimeTarget}) started"
echo "  In your workflow, set the label on runs-on and ${p.runtimeTarget} on the run-eval action's runtime input."
`;
}

function renderWorkflowHint(githubRunnerLabel: string, runtimeTarget: string): string {
  return `jobs:
  eval:
    runs-on: [self-hosted, ${githubRunnerLabel}]   # runs on this build server's GitHub runner
    steps:
      # ... build image ...
      - uses: everdict/run-eval@v1
        with:
          runtime: ${runtimeTarget}                # run the Everdict eval on this workspace-shared runner
          # api-url / workspace / harness / dataset / images ...`;
}
