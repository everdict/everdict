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

// One file changed by a pull request (GET /repos/{repo}/pulls/{n}/files). `patch` is GitHub's unified diff for
// that file — absent for a binary file, and for one whose diff GitHub declined to render (too large). Absent
// therefore means "not shown", never "unchanged": the counts stay authoritative on that.
export interface GithubPullRequestFile {
  filename: string;
  status: string; // added | modified | removed | renamed | …
  additions: number;
  deletions: number;
  patch?: string;
}

// One comment on an issue — pulled read-only into the tracker's copy for context.
export interface GithubIssueComment {
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

// One attachment fetched from GitHub — the image a reporter pasted into an issue or comment body. On a private
// repo (and on ANY GitHub Enterprise repo) the attachment URL is behind the same authentication the repo is, so
// the bytes have to be fetched with the installation token rather than linked to; `contentType` is what the
// upstream served, which is what the reader's browser must be told.
export interface GithubAsset {
  bytes: Uint8Array;
  contentType: string;
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
  // One branch's head sha. The direct-commit use-case's EVIDENCE read: a write nobody can name afterwards is a
  // write nobody can verify, and one sha for the finished branch says more than a sha per file. Read separately
  // rather than returned by putFile on purpose — a completed write must not fail on how its receipt parsed.
  branchHead(repository: string, branch: string): Promise<string>;
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
  // The files one pull request changes, with GitHub's own per-file diff. `maxFiles` bounds the page — the PR's
  // own `changedFiles` count says whether the listing is the whole change (the caller compares and reports).
  listPullRequestFiles(
    repository: string,
    pullNumber: number,
    opts: { maxFiles: number },
  ): Promise<{ changedFiles: number; files: GithubPullRequestFile[] }>;
  // Create an issue; returns its number + html_url.
  createIssue(repository: string, opts: { title: string; body?: string }): Promise<{ number: number; url: string }>;
  // Add a comment to an issue or PR (PRs are issues via the issues API); returns the comment's html_url.
  createIssueComment(repository: string, issueNumber: number, body: string): Promise<{ url: string }>;
  // Fetch a body attachment by its ABSOLUTE url with the installation token. Unlike everything above this is not
  // a REST endpoint — attachment URLs are web routes on the GitHub host, and they are the one GitHub read whose
  // caller (a browser rendering an issue) cannot authenticate itself. The URL is not trusted: the use-case pins
  // it to the issue's own host before calling. `maxBytes` bounds what a single image may pull into memory.
  fetchAsset(url: string, opts: { maxBytes: number }): Promise<GithubAsset>;
}

// Writers are minted per (installation token, host) — the use-case resolves the token via the
// workspace GitHub App and hands it to the factory.
export interface GithubRepoWriterFactory {
  for(token: string, host?: string): GithubRepoWriter;
}

// One repository release (GET /repos/{repo}/releases). `publishedAt` is absent on a draft — the product
// timeline skips drafts, because "released" is exactly the claim a draft has not made yet.
export interface GithubRelease {
  tagName: string;
  name?: string;
  body?: string;
  url: string; // html_url
  draft: boolean;
  prerelease: boolean;
  publishedAt?: string;
}

// One repository tag (GET /repos/{repo}/tags) — name + the commit it points at. Tags carry no date of their
// own; the commit's committer date is fetched separately, and only for tags the ledger does not know yet.
export interface GithubTag {
  name: string;
  sha: string;
}

// The version half of the GitHub read surface, narrowed to what the product timeline's sync needs (the same
// reasoning GithubRepositoryTokenSource gives: depend on the behaviour, not on the whole repo-ops port — and
// a separate interface keeps every existing GithubRepoWriter fake compiling untouched).
export interface GithubVersionReader {
  // PAGINATED (arch-review 14 §16). Both reads sent a single `per_page` and stopped, so a repository with
  // more than one page of history got its first page and nothing else — while the docs described the first
  // sync as backfilling "the timeline's past". For recent-release detection one page is plenty; for a
  // System of Record it is a silent truncation, and a silent truncation is the shape this codebase spends
  // most of its guards refusing. `maxPages` bounds the walk so an enormous repository cannot turn one sync
  // into an unbounded crawl — a bound that is DECLARED and reported, rather than one that happens.
  // `complete` says whether the walk REACHED THE END or stopped at the ceiling (arch-review 15 §13). A bare
  // array made "5,000 rows because that is all there are" and "5,000 rows because we stopped" the same
  // answer — the one-page truncation this replaced, scaled up rather than removed. A caller that imports
  // history needs to know which it got.
  listReleases(
    repository: string,
    opts: { perPage: number; maxPages?: number },
  ): Promise<{ rows: GithubRelease[]; complete: boolean }>;
  listTags(
    repository: string,
    opts: { perPage: number; maxPages?: number },
  ): Promise<{ rows: GithubTag[]; complete: boolean }>;
  // The commit's committer date (ISO) — the tag's stand-in for publishedAt. Undefined when the commit cannot
  // be read (a force-pushed-away sha), which the sync maps to its own import time rather than failing the tag.
  commitDate(repository: string, sha: string): Promise<string | undefined>;
}

export interface GithubVersionReaderFactory {
  for(token: string, host?: string): GithubVersionReader;
}

// The COMPOSITION half of the read surface — what a repository contains, as opposed to what it published.
// The product wizard needs it to answer "which deployable units live in this monorepo" from the repository
// itself instead of from a text field somebody fills in (a mistyped subpath or tag prefix fails SILENTLY: the
// sync imports zero versions and the timeline stays empty with no error anywhere).
//
// Separate from GithubVersionReader on purpose — a repository's tree and its version streams are different
// questions, only the wizard asks both, and every existing fake of the version reader keeps compiling.
export interface GithubRepoTreeReader {
  // The repository's file paths on a ref (default branch when omitted), recursively. `truncated` is GitHub's
  // own flag for a tree too large to return whole: a bounded read that reports its bound, because a partial
  // tree read as complete would present "we found three services" for a repository that has thirty.
  listTree(repository: string, opts?: { ref?: string }): Promise<{ paths: string[]; truncated: boolean }>;
}

export interface GithubRepoTreeReaderFactory {
  for(token: string, host?: string): GithubRepoTreeReader;
}
