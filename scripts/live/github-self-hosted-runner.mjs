// Semi-live helper: the Everdict-side automation for standing up a self-hosted runner on a real GitHub org/repo.
// This script calls the control-plane API to (1) pair a workspace-shared Everdict runner and (2) use your GitHub connection
// to mint a GitHub Actions runner registration token, then (3) print the **install script** to run on the build server plus a workflow hint.
// The GitHub side (run the script on the build server, merge the workflow, fire Actions) needs real infrastructure, so a human does it.
// → Full end-to-end verification with CI running is finished by the user in their own environment, following "Next steps" in the output below.
//
// Prerequisites: a really-deployed control plane + login (or API key) + an elevated GitHub connection if you want admin:org.
// Auth:
//   EVERDICT_TOKEN=<Keycloak JWT or ak_… API key>   (recommended, real deployment)
//   or dev fallback: with nothing set, x-everdict-tenant:default (local dev only — no real GitHub connection)
// Input (env):
//   EVERDICT_API_URL   control-plane base (default http://localhost:8787)
//   CONNECTION_ID   GitHub connection id to use (if unset, auto-selects the first github connection; if none, prints guidance and exits)
//   REPO            "owner/name" (repo level) — exactly one of REPO/ORG
//   ORG             org name (org level, needs an admin:org connection) — exactly one of REPO/ORG
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

// 1) Select the GitHub connection.
const { connections } = await api("/connections");
const githubConns = connections.filter((c) => c.provider === "github" || c.provider === "github-enterprise");
if (githubConns.length === 0) {
  console.error("✗ No GitHub connection. First connect GitHub under Account → Connected accounts.");
  console.error(
    "  To use org level, connect with elevated admin:org permission (Settings › Shared runners › GitHub Actions runner › 'Organization').",
  );
  process.exit(1);
}
const conn = process.env.CONNECTION_ID ? githubConns.find((c) => c.id === process.env.CONNECTION_ID) : githubConns[0];
if (!conn) {
  console.error(`✗ No GitHub connection found with CONNECTION_ID=${process.env.CONNECTION_ID}.`);
  console.error(`  Available connections: ${githubConns.map((c) => `${c.id}(${c.accountLabel})`).join(", ")}`);
  process.exit(1);
}
if (org && !conn.scopes.includes("admin:org")) {
  console.error(
    `✗ org level needs an admin:org-scoped connection. This connection (${conn.accountLabel}) scope: ${conn.scopes.join(",")}`,
  );
  console.error(
    "  In Settings › Shared runners › GitHub Actions runner › 'Organization', choose 'Reconnect with admin:org permission'.",
  );
  process.exit(1);
}
console.log(`▶ GitHub connection: ${conn.accountLabel}${conn.host ? ` (${conn.host})` : ""} [${conn.id}]`);

// 2) github-install — pair an Everdict workspace-shared runner + mint a GitHub registration token + generate the install script.
const body = {
  connectionId: conn.id,
  ...(repo ? { repository: repo } : {}),
  ...(org ? { org } : {}),
  ...(process.env.RUNNER_GROUP ? { runnerGroup: process.env.RUNNER_GROUP } : {}),
  ...(process.env.LABEL ? { label: process.env.LABEL } : {}),
};
const install = await api("/workspace/runners/github-install", { method: "POST", body: JSON.stringify(body) });
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
