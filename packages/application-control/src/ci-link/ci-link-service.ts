import { BadRequestError, NotFoundError } from "@everdict/contracts";
import type { WorkspaceCiLink } from "@everdict/contracts";
import { z } from "zod";
import type { GithubRepoWriterFactory } from "../ports/github-repo-writer.js";
import type { WorkspaceSettingsStore } from "../ports/workspace-settings-store.js";

// CI repo link service — CRUD for repository ↔ harness service-slot mappings (= the GitHub Actions OIDC trust policy) +
// a repo-list proxy over the member's personal GitHub connection (picker) + a setup-PR generator (PRs the workflow YAML into the target repo).
// "zero extra input": pick a repo in the picker → save the link → setup-PR button → merge — the user never touches YAML/keys.
// Design: docs/architecture/github-actions-trigger.md (D3). The HTTP route and the MCP tool share one core (BFF↔MCP parity).

export const UpsertCiLinkBodySchema = z.object({
  repository: z.string().min(1), // "owner/name"
  host: z.string().url().optional(), // GHE base URL (e.g. "https://ghe.acme.io") — absent = github.com
  harness: z.string().min(1), // harness instance id
  dataset: z.string().optional(), // dataset id to fire — needed for setup-PR workflow generation (absent → TODO in the YAML)
  slots: z.record(z.object({ path: z.string().optional() })).default({}), // service slot → monorepo path (optional)
  runsOn: z.string().min(1).optional(), // narrowing override — workflow runs-on (default "[self-hosted]", e.g. "[self-hosted, everdict-<id>]")
  runtime: z.string().min(1).optional(), // narrowing override — run-eval runtime (default "self:ws" pool, e.g. "self:ws:<id>")
  trigger: z.enum(["auto", "comment", "both"]).optional(), // how PR evals fire (absent = both) — see WorkspaceCiLinkSchema
});
export type UpsertCiLinkBody = z.infer<typeof UpsertCiLinkBodySchema>;

// One picker row — a thin normalization of the GitHub API response (heavy original not exposed).
export interface RepoInfo {
  fullName: string; // "owner/name"
  host?: string; // GHE base URL of the installation this repo belongs to — absent = github.com
  private: boolean;
  defaultBranch: string;
  pushedAt?: string;
}

// The workspace GitHub App capabilities that picker/setup-PR/runner-registration need (replacing personal connections). GithubAppService satisfies this structurally.
export interface GithubAppRepoAccess {
  listRepos(workspace: string): Promise<RepoInfo[]>;
  tokenForRepository(
    workspace: string,
    repository: string,
    permissions: Record<string, string>,
    host?: string, // absent = github.com — the link's host picks the exact installation
  ): Promise<{ token: string; host?: string }>;
  runnerRegistrationToken(
    workspace: string,
    target: { repo: string } | { org: string },
    host?: string, // absent = github.com preferred match — a call that went through the picker picks the exact installation by host
  ): Promise<{ token: string; expiresAt: string; host?: string }>;
}

// Workspace-shared runner roster (existence check) — RunnerService satisfies this structurally. CI placement is always self-hosted (design D6),
// so setup-PR fail-closed checks whether the default self:ws pool has any runner (a workflow merged with zero runners
// sits silently queued on GitHub — the latest and most confusing failure point, so we block it before opening the PR).
export interface WorkspaceRunnerRoster {
  listWorkspaceOwned(workspace: string): Promise<{ id: string }[]>;
}

export interface CiLinkServiceDeps {
  settings: WorkspaceSettingsStore;
  githubApp: GithubAppRepoAccess; // workspace-owned GitHub App — repos picker + setup-PR commit/PR + runner registration token
  runners: WorkspaceRunnerRoster; // workspace-shared runner roster — setup-PR's self:ws pool existence check
  apiPublicUrl?: string; // the api-url value in the generated workflow (falls back to the request base if unset)
  repoWriter?: GithubRepoWriterFactory; // outbound repo-write adapter (branch/file/PR) — setup-PR is disabled if absent
}

// link identity key = (host, repository) — the same "owner/name" can exist on both github.com and a GHE.
// host comparison ignores trailing slash/case; undefined = github.com.
function sameLinkKey(link: { repository: string; host?: string }, repository: string, host?: string): boolean {
  const norm = (h?: string): string | undefined => h?.replace(/\/$/, "").toLowerCase();
  return link.repository.toLowerCase() === repository.toLowerCase() && norm(link.host) === norm(host);
}

export class CiLinkService {
  constructor(private readonly deps: CiLinkServiceDeps) {}

  async list(workspace: string): Promise<WorkspaceCiLink[]> {
    return (await this.deps.settings.get(workspace))?.ci?.links ?? [];
  }

  // upsert — one record per (host, repository) key (case-insensitive). A link existing IS that repo's OIDC trust, so create = grant trust (the admin gate is on the route).
  async upsert(workspace: string, subject: string, body: UpsertCiLinkBody): Promise<WorkspaceCiLink[]> {
    // CI cannot lease a personal runner (the dispatcher's self/self:<id> have owner=submitter — a via:"github-actions" principal
    // is not the owner of a member's personal runner). A personal self-family runtime only blows up at fire time, so we block it up front at link save.
    const rt = body.runtime;
    if (rt === "self" || (rt?.startsWith("self:") === true && rt !== "self:ws" && !rt.startsWith("self:ws:")))
      throw new BadRequestError(
        "BAD_REQUEST",
        { runtime: rt },
        `CI cannot use a personal runner (runtime '${rt}') — specify a workspace-shared runner (the "self:ws" pool or "self:ws:<id>").`,
      );
    const current = await this.list(workspace);
    const next: WorkspaceCiLink = {
      repository: body.repository,
      harness: body.harness,
      slots: body.slots,
      createdBy: subject,
      ...(body.host !== undefined ? { host: body.host } : {}),
      ...(body.dataset !== undefined ? { dataset: body.dataset } : {}),
      ...(body.runsOn !== undefined ? { runsOn: body.runsOn } : {}),
      ...(body.runtime !== undefined ? { runtime: body.runtime } : {}),
      ...(body.trigger !== undefined ? { trigger: body.trigger } : {}),
    };
    const rest = current.filter((l) => !sameLinkKey(l, body.repository, body.host));
    await this.deps.settings.set(workspace, { ci: { links: [...rest, next] } });
    return this.list(workspace);
  }

  async remove(workspace: string, repository: string, host?: string): Promise<WorkspaceCiLink[]> {
    const current = await this.list(workspace);
    const rest = current.filter((l) => !sameLinkKey(l, repository, host));
    if (rest.length !== current.length) await this.deps.settings.set(workspace, { ci: { links: rest } });
    return this.list(workspace);
  }

  // picker — the repos the workspace GitHub App installation can access (only the ones chosen at install time). The token stays inside the server.
  async listRepos(workspace: string): Promise<RepoInfo[]> {
    return this.deps.githubApp.listRepos(workspace);
  }

  // setup-PR — synthesizes the workflow YAML from the link and opens a branch+commit+PR in the target repo (workspace App token).
  // Near-idempotent: if the branch/PR already exists, reuse it / return the existing PR. Whether to merge is a human decision on GitHub's side.
  async openSetupPr(
    workspace: string,
    repository: string,
    opts: { host?: string; requestBaseUrl?: string } = {},
  ): Promise<{ prUrl: string; branch: string }> {
    const link = (await this.list(workspace)).find((l) => sameLinkKey(l, repository, opts.host) && !l.disabled);
    if (!link) throw new NotFoundError("NOT_FOUND", { repository }, `No repo link for '${repository}'.`);
    // Placement is always self-hosted (design D6) — if the workflow targets the self:ws pool, a runner must actually be registered.
    // A workflow merged with zero runners sits silently queued on GitHub, so we fail-closed before opening the PR (the earliest observable point).
    const runtime = link.runtime ?? "self:ws";
    if (runtime === "self:ws" || runtime.startsWith("self:ws:")) {
      const roster = await this.deps.runners.listWorkspaceOwned(workspace);
      if (roster.length === 0)
        throw new BadRequestError(
          "BAD_REQUEST",
          { repository },
          "No workspace-shared runner — CI workflows run on self-hosted runners. Register a build server first via Settings › Shared runners' 'GitHub Actions runner' (POST /workspace/runners/github-install).",
        );
      const runnerId = runtime.startsWith("self:ws:") ? runtime.slice("self:ws:".length) : undefined;
      if (runnerId !== undefined && !roster.some((r) => r.id === runnerId))
        throw new NotFoundError(
          "NOT_FOUND",
          { runtime },
          `No shared runner matches the link's runtime '${runtime}' — re-register the runner or leave runtime empty (the "self:ws" pool).`,
        );
    }
    // Workspace App installation token (write) — creating branch/file/PR needs contents + pull_requests write.
    // Pick the installation by link.host (exact, even if the same org name exists on both github.com/GHE).
    const writerFactory = this.deps.repoWriter;
    if (!writerFactory)
      throw new BadRequestError("BAD_REQUEST", {}, "repo writer not configured — cannot open a setup PR.");
    const { token, host } = await this.deps.githubApp.tokenForRepository(
      workspace,
      link.repository,
      { contents: "write", pull_requests: "write" },
      link.host,
    );
    const writer = writerFactory.for(token, host);
    const apiUrl = this.deps.apiPublicUrl ?? opts.requestBaseUrl;
    if (!apiUrl)
      throw new BadRequestError("BAD_REQUEST", {}, "API_PUBLIC_URL unset — cannot determine the workflow's api-url.");
    const yaml = renderCiWorkflow(link, workspace, apiUrl.replace(/\/$/, ""));
    const branch = "everdict/eval-setup";
    const path = ".github/workflows/everdict-eval.yml";

    // The use-case owns the ORDER + reuse semantics; the adapter owns the wire (endpoints/parsing/422s).
    const { defaultBranch, headSha } = await writer.repoHead(link.repository);
    await writer.ensureBranch(link.repository, branch, headSha);
    await writer.putFile(link.repository, {
      branch,
      path,
      contentUtf8: yaml,
      message: "ci: add Everdict eval workflow",
    });
    const pr = await writer.openPr(link.repository, {
      title: "Add Everdict eval workflow",
      head: branch,
      base: defaultBranch,
      body: `CI eval setup generated by Everdict. Once merged, every PR/merge fires a \`${link.harness}\` eval.\n\n- workspace: \`${workspace}\`\n- auth: GitHub OIDC federation (keyless — the repo link grants trust)`,
    });
    return { prUrl: pr.url, branch };
  }

  // GitHub Actions self-hosted runner registration token — mint against the target (repo|org) via the workspace GitHub App (administration).
  // Short-lived token (≈1 hour). Everdict does not store long-lived runner tokens (mints one on demand). The App must be installed on that org/repo.
  async mintRunnerToken(
    workspace: string,
    target: { repo: string } | { org: string },
    host?: string,
  ): Promise<{ token: string; expiresAt: string; host?: string }> {
    return this.deps.githubApp.runnerRegistrationToken(workspace, target, host);
  }
}

// link.host → the container registry the CI build pushes to. github.com → GHCR, GHE → that instance's
// container registry (containers.<hostname> — subdomain isolation). GHES's `GITHUB_TOKEN` cannot log in to
// ghcr.io, so exporting ghcr.io on a GHE link makes the workflow fail every time.
function registryFor(host?: string): string {
  if (!host) return "ghcr.io";
  try {
    return `containers.${new URL(host).hostname}`;
  } catch {
    throw new BadRequestError("BAD_REQUEST", { host }, `the link's host is not a URL: ${host}`);
  }
}

// link → workflow YAML synthesis — the user never touches YAML (the heart of zero-input).
// One file for PR/push/PR-comment (/evaluate): per-slot image build (registry is GHCR/GHE per link.host, digest output) →
// the everdict run-eval action (mode auto, OIDC keyless — the control plane trusts the GHES issuer too).
// trigger knob: auto = PR-event auto only · comment = /evaluate comment only (expensive suites on demand) · both (default) = both.
// push (default-branch re-pin) is always on. This template absorbs the 3 issue_comment pitfalls (no user YAML knowledge needed):
//  ① it runs in default-branch context, so explicitly check out the PR head (refs/pull/N/head) and resolve the sha via git,
//  ② group concurrency by PR number so a comment fire ↔ the same PR's auto fire supersede each other,
//  ③ a comment fire gets no PR check (default-branch run), so the conversation comment is the only feedback — hand it write permission + a token.
// Monorepo optimization (path filter to build only changed slots) is a follow-up — v1 builds every linked slot (correctness first).
export function renderCiWorkflow(link: WorkspaceCiLink, workspace: string, apiUrl: string): string {
  const registry = registryFor(link.host);
  const slots = Object.entries(link.slots);
  const buildSteps = slots
    .map(([slot, cfg]) =>
      [
        `      - name: Build ${slot}`,
        `        id: build-${slot}`,
        "        uses: docker/build-push-action@v6",
        "        with:",
        `          context: ${cfg.path ?? "."}`,
        "          push: true",
        `          tags: ${registry}/\${{ github.repository }}/${slot}:\${{ steps.head.outputs.sha }}`,
      ].join("\n"),
    )
    .join("\n");
  const imagesJson = `{${slots
    .map(
      ([slot]) =>
        `"${slot}":"${registry}/\${{ github.repository }}/${slot}@\${{ steps.build-${slot}.outputs.digest }}"`,
    )
    .join(",")}}`;
  // Placement is always self-hosted (design D6) — CI (run-eval) must reach the control plane even on a private network, so there is no GitHub-hosted
  // runner path. Default: any self-hosted runner registered on the repo ([self-hosted]) + the workspace runner pool (self:ws).
  // link.runsOn/runtime are overrides that narrow to a specific label/runner or a managed runtime.
  const runsOn = link.runsOn ?? "[self-hosted]";
  const runtimeLine = `\n          runtime: ${link.runtime ?? "self:ws"}`;
  const trigger = link.trigger ?? "both";
  const onBlock = [
    ...(trigger !== "comment" ? ["  pull_request:"] : []),
    ...(trigger !== "auto" ? ["  issue_comment:", "    types: [created]"] : []),
    "  push:",
    "    branches: [main]",
  ].join("\n");
  // Write permission/token for comment-fire feedback (👀 reaction + result comment) — not granted when there is no comment trigger (least privilege).
  const commentPermissions = trigger !== "auto" ? "\n  issues: write\n  pull-requests: write" : "";
  const commentTokenLine = trigger !== "auto" ? "\n          github-token: ${{ github.token }}" : "";
  // /evaluate gate — only when it's a comment on a PR conversation and the author is a collaborator or above (defends against evals fired by arbitrary comments on fork PRs).
  const commentGate =
    trigger !== "auto"
      ? `
    if: >-
      github.event_name != 'issue_comment' ||
      (github.event.issue.pull_request &&
      startsWith(github.event.comment.body, '/evaluate') &&
      contains(fromJSON('["OWNER","MEMBER","COLLABORATOR"]'), github.event.comment.author_association))`
      : "";
  // A comment fire is in default-branch context — explicitly check out the PR head (other events get an empty ref = default behavior).
  const checkoutRef =
    trigger !== "auto"
      ? `
        with:
          ref: \${{ github.event_name == 'issue_comment' && format('refs/pull/{0}/head', github.event.issue.number) || '' }}`
      : "";
  return `# CI eval workflow generated by Everdict — a PR is an ephemeral-pin eval, a /evaluate PR comment is an on-demand re-eval, a default-branch push is a re-pin (new version) + eval.
# Self-hosted runners only — the runner must be able to reach the Everdict control plane even on a private network (GitHub-hosted not supported).
# Caution: a fork PR on a public repo can run arbitrary code on a self-hosted runner (private team repos assumed).
name: everdict-eval
on:
${onBlock}
permissions:
  contents: read
  packages: write
  id-token: write # Everdict OIDC federation (keyless)${commentPermissions}
concurrency:
  group: everdict-eval-\${{ github.event.pull_request.number || github.event.issue.number || github.ref }}
  cancel-in-progress: true
jobs:
  eval:
    runs-on: ${runsOn}${commentGate}
    steps:
      - uses: actions/checkout@v4${checkoutRef}
      - name: Resolve eval head
        id: head
        run: echo "sha=$(git rev-parse HEAD)" >> "$GITHUB_OUTPUT"
      - uses: docker/login-action@v3
        with:
          registry: ${registry}
          username: \${{ github.actor }}
          password: \${{ secrets.GITHUB_TOKEN }}
${buildSteps}
      - name: Everdict eval
        uses: everdict/run-eval@v1
        with:
          api-url: ${apiUrl}
          workspace: ${workspace}
          harness: ${link.harness}
          dataset: ${link.dataset ?? "# TODO: specify a dataset id"}
          images: '${imagesJson}'
          head-sha: \${{ steps.head.outputs.sha }}${commentTokenLine}${runtimeLine}
`;
}
