// Semi-live helper: the Everdict-side automation for standing up a self-hosted runner on a real GitHub org/repo.
// This script calls `POST /workspace/runners/github-install`, which (1) pairs a workspace-shared Everdict runner and (2) mints a
// GitHub Actions runner registration token through the WORKSPACE GITHUB APP installation on the target repo/org, then
// (3) prints the **install script** to run on the build server plus a workflow hint.
// The GitHub side (run the script on the build server, merge the workflow, fire Actions) needs real infrastructure, so a human does it.
// → Full end-to-end verification with CI running is finished by the user in their own environment, following "Next steps" in the output below.
// Runbook: docs/runbooks/github-self-hosted-runner.md.
//
// Prerequisites: a really-deployed control plane + login (or API key) with `settings:write` in the workspace, and the
// workspace GitHub App installed on the target repo or org (Settings › Integrations) with `administration` permission.
// Auth:
//   EVERDICT_TOKEN=<Keycloak JWT or ak_… API key>   (recommended, real deployment)
//   or dev fallback: with nothing set, x-everdict-tenant:default (local dev only — no real GitHub App installation)
// Input (env):
//   EVERDICT_API_URL   control-plane base (default http://localhost:8787)
//   REPO            "owner/name" (repo level) — exactly one of REPO/ORG
//   ORG             org name (org level) — exactly one of REPO/ORG
//   HOST            (optional) GitHub Enterprise base URL, e.g. https://ghe.example.com (unset = github.com)
//   RUNNER_GROUP    (optional) org runner group
//   LABEL           (optional) Everdict runner display name
//
// Usage: EVERDICT_TOKEN=… REPO=acme/app node scripts/live/github-self-hosted-runner.mjs
import process from "node:process";

const B = (process.env.EVERDICT_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const token = process.env.EVERDICT_TOKEN;
const headers = {
  "content-type": "application/json",
  ...(token ? { authorization: `Bearer ${token}` } : { "x-everdict-tenant": "default" }),
};
const api = async (path, init = {}) => {
  const r = await fetch(`${B}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (!r.ok) throw new Error(`${path} → ${r.status}: ${(await r.text()).slice(0, 400)}`);
  return r.status === 204 ? null : r.json();
};

const repo = process.env.REPO;
const org = process.env.ORG;
if ((repo === undefined) === (org === undefined)) {
  console.error("✗ Specify exactly one of REPO('owner/name') or ORG(org name).");
  process.exit(2);
}

// github-install — pair an Everdict workspace-shared runner + mint a GitHub registration token through the workspace
// GitHub App installation + generate the install script. There is no connection to pick: the control plane resolves the
// App installation from the target owner (and HOST, for GitHub Enterprise). The App not being installed there is a 404.
const body = {
  ...(repo ? { repository: repo } : {}),
  ...(org ? { org } : {}),
  ...(process.env.HOST ? { host: process.env.HOST } : {}),
  ...(process.env.RUNNER_GROUP ? { runnerGroup: process.env.RUNNER_GROUP } : {}),
  ...(process.env.LABEL ? { label: process.env.LABEL } : {}),
};
let install;
try {
  install = await api("/workspace/runners/github-install", { method: "POST", body: JSON.stringify(body) });
} catch (err) {
  console.error(`✗ ${err instanceof Error ? err.message : String(err)}`);
  console.error(
    "  A 404 is usually the workspace GitHub App not installed on that repo/org (Settings › Integrations) — see docs/runbooks/github-self-hosted-runner.md.",
  );
  process.exit(1);
}
console.log(`▶ Everdict runner paired: ${install.runner.id}  (runtime=${install.runtimeTarget})`);
console.log(`▶ GitHub registration token expires: ${install.registrationExpiresAt} (short-lived — run it soon)`);

console.log("\n================= install script to run on the build server =================");
console.log(install.installScript);
console.log("================= add to the workflow (runs-on + runtime) =================");
console.log(install.workflowHint);

console.log("\nNext steps (human — real GitHub infrastructure):");
console.log(
  "  1. Run the install script above on the build server → the GitHub Actions runner + Everdict runner come up together.",
);
console.log(`  2. Set the target repo workflow's runs-on to [self-hosted, ${install.githubRunnerLabel}],`);
console.log(`     and the run-eval action runtime input to ${install.runtimeTarget} (hint above).`);
console.log(
  "     (In Settings › CI integration › Repo link, put the same values in '5. Self-hosted runner' to auto-generate the setup-PR.)",
);
console.log(
  "  3. PR/merge → GitHub Actions fires → CI builds the image → the co-located Everdict runner runs the self:ws eval.",
);
console.log("  4. repo/sha is recorded on the scorecard origin, and the eval result is reported back as a PR check.");
console.log(
  "\n✓ Everdict side ready. Verify the GitHub-side end-to-end firing in your own environment via the steps above.",
);
process.exit(0);
