// A text file read from a repo (GET /repos/{repo}/contents/{path}). `content` is UTF-8 (the adapter base64-decodes).
export interface GithubFileContent {
  path: string;
  content: string; // UTF-8 text
  sha: string;
  size: number;
}

// One issue or pull request (GET /repos/{repo}/issues returns both; `isPullRequest` distinguishes them).
export interface GithubIssue {
  number: number;
  title: string;
  state: string; // "open" | "closed"
  author: string; // user login ("" if unattributable)
  url: string; // html_url
  isPullRequest: boolean;
  updatedAt: string;
}

// Outbound GitHub repo-ops port (re-architecture P2d) — read + write operations on one repo behind a resolved
// installation token. The setup-PR use-case decides the WRITE order (branch → file → PR) and reuse semantics; the
// agent's repo tools use the READ side (get file / list issues). The adapter owns the REST endpoints, response
// parsing, and the 422 translations (apps/api infrastructure/github). Non-2xx surfaces as UpstreamError from the
// adapter (never a raw GitHub error).
export interface GithubRepoWriter {
  // Default branch name + its head sha — the base for branch creation and the PR.
  repoHead(repository: string): Promise<{ defaultBranch: string; headSha: string }>;
  // Create the branch at fromSha; an already-existing branch is reused (not an error).
  ensureBranch(repository: string, branch: string, fromSha: string): Promise<void>;
  // Create or update the file on the branch (the adapter resolves the existing sha for updates).
  putFile(
    repository: string,
    opts: { branch: string; path: string; contentUtf8: string; message: string },
  ): Promise<void>;
  // Open the PR; if one is already open for the head (422), return that PR instead.
  openPr(
    repository: string,
    opts: { head: string; base: string; title: string; body: string },
  ): Promise<{ url: string }>;
  // Read a text file's UTF-8 content on a ref (default branch when omitted). A non-file path is an error.
  getFile(repository: string, path: string, ref?: string): Promise<GithubFileContent>;
  // List issues (includes PRs), filtered by state ("open"|"closed"|"all", default open), most-recently-updated first.
  listIssues(repository: string, opts: { state?: string; perPage: number }): Promise<GithubIssue[]>;
}

// Writers are minted per (installation token, host) — the use-case resolves the token via the
// workspace GitHub App and hands it to the factory.
export interface GithubRepoWriterFactory {
  for(token: string, host?: string): GithubRepoWriter;
}
