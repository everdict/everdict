// Outbound GitHub repo-write port (re-architecture P2d) — the setup-PR use-case decides the ORDER
// (branch → file → PR) and the reuse semantics; the adapter owns the REST endpoints, response
// parsing, and the 422 translations (apps/api infrastructure/github). Non-2xx surfaces as
// UpstreamError from the adapter (never a raw GitHub error).
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
}

// Writers are minted per (installation token, host) — the use-case resolves the token via the
// workspace GitHub App and hands it to the factory.
export interface GithubRepoWriterFactory {
  for(token: string, host?: string): GithubRepoWriter;
}
