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
  // GitHub-owned content the tracker's imported copy mirrors (docs/tracker.md ownership split). Absent body =
  // the issue has none; labels is always present (possibly empty) so a pull can clear them.
  body?: string;
  labels: string[];
}

// One comment on an issue — pulled read-only into the tracker's copy for context.
export interface GithubIssueComment {
  author: string;
  body: string;
  createdAt: string;
  url: string;
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
  // `since` (ISO) asks GitHub for only what changed after that instant — the tracker's manual bulk pull uses it as
  // an incremental watermark so a repo with 500 issues costs one page, not five. `maxPages` bounds the Link-header
  // walk (default 1: the historical single-page behaviour every existing caller relies on).
  listIssues(
    repository: string,
    opts: { state?: string; perPage: number; since?: string; maxPages?: number },
  ): Promise<GithubIssue[]>;
  // One issue by number — the per-issue sync's read (list narrows, this confirms).
  getIssue(repository: string, issueNumber: number): Promise<GithubIssue>;
  // Push the local resolution back: close or reopen the remote issue. Title/body stay GitHub-owned, so this
  // deliberately writes STATE ONLY (the accompanying explanation rides as a comment).
  updateIssue(repository: string, issueNumber: number, patch: { state: "open" | "closed" }): Promise<void>;
  // The issue's comment thread, oldest first, capped — context for whoever reads the imported copy.
  listIssueComments(
    repository: string,
    issueNumber: number,
    opts: { maxComments: number },
  ): Promise<GithubIssueComment[]>;
  // Create an issue; returns its number + html_url.
  createIssue(repository: string, opts: { title: string; body?: string }): Promise<{ number: number; url: string }>;
  // Add a comment to an issue or PR (PRs are issues via the issues API); returns the comment's html_url.
  createIssueComment(repository: string, issueNumber: number, body: string): Promise<{ url: string }>;
}

// Writers are minted per (installation token, host) — the use-case resolves the token via the
// workspace GitHub App and hands it to the factory.
export interface GithubRepoWriterFactory {
  for(token: string, host?: string): GithubRepoWriter;
}
