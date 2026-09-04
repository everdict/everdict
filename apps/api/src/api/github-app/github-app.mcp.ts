import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type McpToolContext, ok, run } from "../mcp-context.js";

// GitHub App MCP tools — the MCP twin of github-app.routes.ts.
export function registerGithubAppTools(server: McpServer, ctx: McpToolContext): void {
  const { deps, principal, ws } = ctx;

  // Workspace-owned GitHub App integration (replaces personal connections) — org install→selected repos→workspace-owned installation. settings:read/write.
  if (deps.githubAppService) {
    const gh = deps.githubAppService;
    server.registerTool(
      "list_workspace_github_app",
      {
        annotations: { readOnlyHint: true },
        description:
          "This workspace's GitHub App integration — workspace-owned installations (host/installationId/account + allowed repos), the configured providers (github.com / GitHub Enterprise, both operator env), and the callbackUrl to register as the App Setup URL. No secret values.",
        inputSchema: {},
      },
      () =>
        run(principal, "settings:read", async () => {
          const view = await gh.viewWithRepos(ws);
          const callbackUrl = gh.callbackUrl();
          return ok({ ...view, ...(callbackUrl !== undefined ? { callbackUrl } : {}) });
        }),
    );
    server.registerTool(
      "start_workspace_github_app_install",
      {
        annotations: { readOnlyHint: false },
        description:
          "Start a GitHub App install (admin) → returns the GitHub installation-page URL (admin opens it and selects repos). host unset=github.com (env App), set=the GitHub Enterprise host (env App). Both providers are operator env — no per-workspace App registration.",
        inputSchema: {
          host: z.string().url().optional().describe("GitHub Enterprise base URL (unset=github.com)"),
        },
      },
      ({ host }) =>
        run(principal, "settings:write", async () =>
          ok(await gh.startInstall({ workspace: ws, createdBy: principal.subject, ...(host ? { host } : {}) })),
        ),
    );
    server.registerTool(
      "unlink_workspace_github_app_installation",
      {
        annotations: { readOnlyHint: false },
        description:
          "Unlink an installation (admin). The actual uninstall happens on GitHub — here we just forget the record (idempotent).",
        inputSchema: { installationId: z.number().int().describe("GitHub installation id") },
      },
      ({ installationId }) =>
        run(principal, "settings:write", async () => ok(await gh.unlinkInstallation(ws, installationId))),
    );
    server.registerTool(
      "list_github_issues",
      {
        annotations: { readOnlyHint: true },
        description:
          "List issues and pull requests in a repository the workspace's GitHub App is installed on (most-recently-updated first): number, title, state, author, URL, and whether each is a PR. Use to triage or find an item to read. member+ (github:read).",
        inputSchema: {
          repository: z.string().min(1).describe('"owner/name"'),
          state: z.enum(["open", "closed", "all"]).optional().describe("state filter (default open)"),
          limit: z.number().int().positive().max(100).optional().describe("max rows (default 30, max 100)"),
          host: z.string().url().optional().describe("GitHub Enterprise base URL (unset = github.com)"),
        },
      },
      ({ repository, state, limit, host }) =>
        run(principal, "github:read", async () =>
          ok({
            issues: await gh.listRepoIssues(
              ws,
              repository,
              { ...(state ? { state } : {}), ...(limit !== undefined ? { limit } : {}) },
              host,
            ),
          }),
        ),
    );
    server.registerTool(
      "get_github_file",
      {
        annotations: { readOnlyHint: true },
        description:
          "Read a text file from a repository the workspace's GitHub App is installed on — returns its UTF-8 content, sha, and size. Use to inspect code or config referenced in a task; call list_github_repo_files first when you do not already know the path. member+ (github:read).",
        inputSchema: {
          repository: z.string().min(1).describe('"owner/name"'),
          path: z.string().min(1).describe("file path within the repo"),
          ref: z.string().optional().describe("branch, tag, or sha (default: the repo's default branch)"),
          host: z.string().url().optional().describe("GitHub Enterprise base URL (unset = github.com)"),
        },
      },
      ({ repository, path, ref, host }) =>
        run(principal, "github:read", async () => ok(await gh.getRepoFile(ws, repository, path, ref, host))),
    );
    server.registerTool(
      "list_github_repo_files",
      {
        annotations: { readOnlyHint: true },
        description:
          "List the file paths in a repository the workspace's GitHub App is installed on (recursive, on a ref). " +
          "This is how you FIND what to read — get_github_file needs an exact path. `prefix` narrows to a subtree. " +
          "`truncated` true = there are more paths than were returned (raise limit or narrow the prefix); never " +
          "treat a truncated listing as the whole repository. member+ (github:read).",
        inputSchema: {
          repository: z.string().min(1).describe('"owner/name"'),
          prefix: z.string().optional().describe("only paths inside this directory (unset = the whole tree)"),
          ref: z.string().optional().describe("branch, tag, or sha (default: the repo's default branch)"),
          limit: z.number().int().positive().max(2000).optional().describe("max paths (default 500, max 2000)"),
          host: z.string().url().optional().describe("GitHub Enterprise base URL (unset = github.com)"),
        },
      },
      ({ repository, prefix, ref, limit, host }) =>
        run(principal, "github:read", async () =>
          ok(
            await gh.listRepoFiles(
              ws,
              repository,
              {
                ...(prefix !== undefined ? { prefix } : {}),
                ...(ref !== undefined ? { ref } : {}),
                ...(limit !== undefined ? { limit } : {}),
              },
              host,
            ),
          ),
        ),
    );
    server.registerTool(
      "get_github_issue",
      {
        annotations: { readOnlyHint: true },
        description:
          "Read ONE issue or pull request in a repository the workspace's GitHub App is installed on — title, " +
          "state, author, labels, body, and the comment thread. list_github_issues says what is open; this says " +
          "what was actually reported and discussed. `commentsTruncated` true = older comments were not returned. " +
          "member+ (github:read).",
        inputSchema: {
          repository: z.string().min(1).describe('"owner/name"'),
          issueNumber: z.number().int().positive().describe("the issue or PR number"),
          maxComments: z.number().int().positive().max(100).optional().describe("newest comments (default 30)"),
          host: z.string().url().optional().describe("GitHub Enterprise base URL (unset = github.com)"),
        },
      },
      ({ repository, issueNumber, maxComments, host }) =>
        run(principal, "github:read", async () =>
          ok(
            await gh.getRepoIssue(
              ws,
              repository,
              issueNumber,
              { ...(maxComments !== undefined ? { maxComments } : {}) },
              host,
            ),
          ),
        ),
    );
    server.registerTool(
      "get_github_pull_request_changes",
      {
        annotations: { readOnlyHint: true },
        description:
          "What a pull request CHANGES in a repository the workspace's GitHub App is installed on — per file: " +
          "status, added/removed line counts, and GitHub's unified diff. Use to review a PR, or to see what an " +
          "earlier open_github_pr already proposed before adding to it. A file with no `patch` is binary or too " +
          "large to render — its counts still hold. `truncated` true = more files changed than were returned. " +
          "member+ (github:read).",
        inputSchema: {
          repository: z.string().min(1).describe('"owner/name"'),
          pullNumber: z.number().int().positive().describe("the pull request number"),
          maxFiles: z.number().int().positive().max(100).optional().describe("max files (default 50, max 100)"),
          host: z.string().url().optional().describe("GitHub Enterprise base URL (unset = github.com)"),
        },
      },
      ({ repository, pullNumber, maxFiles, host }) =>
        run(principal, "github:read", async () =>
          ok(
            await gh.listPullRequestChanges(
              ws,
              repository,
              pullNumber,
              { ...(maxFiles !== undefined ? { maxFiles } : {}) },
              host,
            ),
          ),
        ),
    );
    server.registerTool(
      "create_github_issue",
      {
        annotations: { readOnlyHint: false },
        description:
          "Create an issue in a repository the workspace's GitHub App is installed on — returns the new issue number and URL. Use to file a bug or task on the workspace's behalf. member+ (github:write).",
        inputSchema: {
          repository: z.string().min(1).describe('"owner/name"'),
          title: z.string().min(1).describe("issue title"),
          body: z.string().optional().describe("issue body (GitHub Markdown)"),
          host: z.string().url().optional().describe("GitHub Enterprise base URL (unset = github.com)"),
        },
      },
      ({ repository, title, body, host }) =>
        run(principal, "github:write", async () =>
          ok(await gh.createIssue(ws, repository, { title, ...(body ? { body } : {}) }, host)),
        ),
    );
    server.registerTool(
      "open_github_pr",
      {
        annotations: { readOnlyHint: false },
        description:
          "Open a pull request with file changes in a repository the workspace's GitHub App is installed on — creates " +
          "(or reuses) the branch off the default branch, commits each change (full new file content), and opens the " +
          "PR (an already-open PR for the branch is returned instead). Put the motivating context (what failed, " +
          "evidence, why this fix) in the body — the PR must be reviewable on its own. member+ (github:write).",
        inputSchema: {
          repository: z.string().min(1).describe('"owner/name"'),
          branch: z.string().min(1).describe("head branch to create/reuse (e.g. everdict/scorecard-123-fix)"),
          title: z.string().min(1).describe("PR title (imperative summary of the change)"),
          body: z.string().min(1).describe("PR body (GitHub Markdown) — carries the full context for the reviewer"),
          changes: z
            .array(
              z.object({
                path: z.string().min(1).describe("file path within the repo"),
                content: z.string().describe("the FULL new content of the file (create or overwrite)"),
              }),
            )
            .min(1)
            .describe("files to commit on the branch"),
          host: z.string().url().optional().describe("GitHub Enterprise base URL (unset = github.com)"),
        },
      },
      ({ repository, branch, title, body, changes, host }) =>
        run(principal, "github:write", async () =>
          ok(await gh.openPullRequest(ws, repository, { branch, title, body, changes }, host)),
        ),
    );
    server.registerTool(
      "commit_github_files",
      {
        annotations: { readOnlyHint: false },
        description:
          "Commit file changes DIRECTLY to a branch in a repository the workspace's GitHub App is installed on — " +
          "no pull request, no review. The branch is created off the default branch if it does not exist. Prefer " +
          "open_github_pr when the change is a PROPOSAL somebody should read first; use this for work on a branch " +
          "you already own, or when the member explicitly asked to commit. Naming the default branch here ships " +
          "straight to it. Each change carries the FULL new content of the file. Returns a commit sha per file. " +
          "member+ (github:write).",
        inputSchema: {
          repository: z.string().min(1).describe('"owner/name"'),
          branch: z.string().min(1).describe("branch to commit on (created off the default branch if absent)"),
          message: z.string().min(1).describe("commit message"),
          changes: z
            .array(
              z.object({
                path: z.string().min(1).describe("file path within the repo"),
                content: z.string().describe("the FULL new content of the file (create or overwrite)"),
              }),
            )
            .min(1)
            .describe("files to commit"),
          host: z.string().url().optional().describe("GitHub Enterprise base URL (unset = github.com)"),
        },
      },
      ({ repository, branch, message, changes, host }) =>
        run(principal, "github:write", async () =>
          ok(await gh.commitFiles(ws, repository, { branch, message, changes }, host)),
        ),
    );
    server.registerTool(
      "set_github_issue_state",
      {
        annotations: { readOnlyHint: false },
        description:
          "Close or reopen an issue or pull request (PRs are issues) in a repository the workspace's GitHub App is " +
          "installed on. STATE ONLY — the title and body stay as their author wrote them; put the reasoning in a " +
          "comment (comment_on_github_issue) so the state change is explained where people read it. member+ (github:write).",
        inputSchema: {
          repository: z.string().min(1).describe('"owner/name"'),
          issueNumber: z.number().int().positive().describe("the issue or PR number"),
          state: z.enum(["open", "closed"]).describe("closed = close it, open = reopen it"),
          host: z.string().url().optional().describe("GitHub Enterprise base URL (unset = github.com)"),
        },
      },
      ({ repository, issueNumber, state, host }) =>
        run(principal, "github:write", async () =>
          ok(await gh.setIssueState(ws, repository, issueNumber, state, host)),
        ),
    );
    server.registerTool(
      "comment_on_github_issue",
      {
        annotations: { readOnlyHint: false },
        description:
          "Add a comment to an issue or pull request (PRs are issues) in a repository the workspace's GitHub App is installed on — returns the comment URL. member+ (github:write).",
        inputSchema: {
          repository: z.string().min(1).describe('"owner/name"'),
          issueNumber: z.number().int().positive().describe("the issue or PR number"),
          body: z.string().min(1).describe("the comment text (GitHub Markdown)"),
          host: z.string().url().optional().describe("GitHub Enterprise base URL (unset = github.com)"),
        },
      },
      ({ repository, issueNumber, body, host }) =>
        run(principal, "github:write", async () =>
          ok(await gh.commentOnIssue(ws, repository, issueNumber, body, host)),
        ),
    );
  }
}
