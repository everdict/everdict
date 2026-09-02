import type {
  GithubIssue,
  GithubRepoTreeReader,
  GithubRepoTreeReaderFactory,
  GithubRepoWriter,
  GithubRepoWriterFactory,
  GithubVersionReader,
  GithubVersionReaderFactory,
} from "@everdict/application-control";
import { ConflictError, UpstreamError } from "@everdict/contracts";
import { z } from "zod";

// The fetch-backed GitHub repo-write adapter — owns the REST endpoints, response parsing, and the
// 422 reuse translations behind the GithubRepoWriter port. Moved out of ci-link-service in
// re-architecture P2d; the injectable fetch keeps tests recording the exact wire bytes.

// The issue shape both the list and the single-issue read return — parsed once so the two paths can never drift.
const ISSUE_ROW = z.object({
  number: z.number(),
  title: z.string(),
  state: z.string(),
  html_url: z.string(),
  updated_at: z.string(),
  body: z.string().nullish(),
  labels: z.array(z.union([z.string(), z.object({ name: z.string() })])).default([]),
  user: z.object({ login: z.string() }).nullish(),
  pull_request: z.unknown().optional(),
});
const ISSUE_ROWS = z.array(ISSUE_ROW);

function toGithubIssue(row: z.infer<typeof ISSUE_ROW>): GithubIssue {
  return {
    number: row.number,
    title: row.title,
    state: row.state,
    author: row.user?.login ?? "",
    url: row.html_url,
    isPullRequest: row.pull_request !== undefined,
    updatedAt: row.updated_at,
    // An empty body reads as "no description", not as an empty string to render.
    ...(row.body ? { body: row.body } : {}),
    labels: row.labels.map((l) => (typeof l === "string" ? l : l.name)),
  };
}

// GitHub paginates with the RFC 5988 Link header; rel="next" is absent on the last page, which ends the walk.
function nextPageUrl(link: string | null): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (match?.[1]) return match[1];
  }
  return undefined;
}

// GitHub API base — github.com uses the api. subdomain, GHE uses /api/v3 (determined by the link's host).
function apiBase(host?: string): string {
  return host ? `${host.replace(/\/$/, "")}/api/v3` : "https://api.github.com";
}

function headers(token: string): Record<string, string> {
  return {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "user-agent": "everdict-control-plane",
  };
}

// What an attachment is allowed to come back as. GitHub answers an unauthenticated attachment request with a
// LOGIN PAGE (200 text/html) rather than a 401, so a content-type check is the only thing that separates "here is
// your image" from "here is a sign-in form" — without it a broken image would be replaced by a broken image that
// also costs a round trip, and nobody could tell from the outside that the token was the problem.
function isRenderableAsset(contentType: string): boolean {
  const type = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return type.startsWith("image/") || type.startsWith("video/") || type === "application/pdf";
}

async function upstream(res: Response, prefix: string): Promise<UpstreamError> {
  const text = await res.text().catch(() => "");
  return new UpstreamError(
    "UPSTREAM_ERROR",
    { status: res.status },
    `${prefix} (GitHub ${res.status}): ${text.slice(0, 200)}`,
  );
}

export function githubRepoWriterFactory(fetchImpl?: typeof fetch): GithubRepoWriterFactory {
  return {
    for(token, host): GithubRepoWriter {
      const base = apiBase(host);
      // Resolve fetch at operation time (not factory-creation time) so a test's vi.stubGlobal("fetch") is honored —
      // mirrors the gateway adapter, which references the global fetch inside its methods. An injected fetchImpl wins.
      const doFetch = fetchImpl ?? fetch;
      // Common for GET-family — remap non-2xx to UpstreamError (never leak a raw GitHub error).
      const gh = async (url: string): Promise<Response> => {
        const res = await doFetch(url, { headers: headers(token) });
        if (!res.ok) throw await upstream(res, "GitHub API call failed");
        return res;
      };
      return {
        async repoHead(repository) {
          const repo = z
            .object({ default_branch: z.string() })
            .parse(await (await gh(`${base}/repos/${repository}`)).json());
          const head = z
            .object({ object: z.object({ sha: z.string() }) })
            .parse(await (await gh(`${base}/repos/${repository}/git/ref/heads/${repo.default_branch}`)).json());
          return { defaultBranch: repo.default_branch, headSha: head.object.sha };
        },
        async ensureBranch(repository, branch, fromSha) {
          // Create branch (reuse if it already exists — 422 Reference already exists).
          const mkRef = await doFetch(`${base}/repos/${repository}/git/refs`, {
            method: "POST",
            headers: headers(token),
            body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: fromSha }),
          });
          if (!mkRef.ok && mkRef.status !== 422) throw await upstream(mkRef, "branch creation failed");
        },
        async putFile(repository, opts) {
          // Commit the file — if the file already exists, its sha is required (update). 404 = new.
          const existing = await doFetch(`${base}/repos/${repository}/contents/${opts.path}?ref=${opts.branch}`, {
            headers: headers(token),
          });
          const existingSha = existing.ok ? z.object({ sha: z.string() }).parse(await existing.json()).sha : undefined;
          const put = await doFetch(`${base}/repos/${repository}/contents/${opts.path}`, {
            method: "PUT",
            headers: headers(token),
            body: JSON.stringify({
              message: opts.message,
              content: Buffer.from(opts.contentUtf8, "utf8").toString("base64"),
              branch: opts.branch,
              ...(existingSha ? { sha: existingSha } : {}),
            }),
          });
          if (!put.ok) throw await upstream(put, "file commit failed");
        },
        async branchHead(repository, branch) {
          const head = z
            .object({ object: z.object({ sha: z.string() }) })
            .parse(await (await gh(`${base}/repos/${repository}/git/ref/heads/${branch}`)).json());
          return head.object.sha;
        },
        async openPr(repository, opts) {
          // Create PR — if one is already open (422), find and return the existing PR.
          const mkPr = await doFetch(`${base}/repos/${repository}/pulls`, {
            method: "POST",
            headers: headers(token),
            body: JSON.stringify({ title: opts.title, head: opts.head, base: opts.base, body: opts.body }),
          });
          if (mkPr.ok) {
            const pr = z.object({ html_url: z.string() }).parse(await mkPr.json());
            return { url: pr.html_url };
          }
          if (mkPr.status === 422) {
            const list = await gh(
              `${base}/repos/${repository}/pulls?head=${encodeURIComponent(`${repository.split("/")[0]}:${opts.head}`)}&state=open`,
            );
            const prs = z.array(z.object({ html_url: z.string() })).parse(await list.json());
            const first = prs[0];
            if (first) return { url: first.html_url };
          }
          throw await upstream(mkPr, "PR creation failed");
        },
        async getFile(repository, path, ref) {
          const url = `${base}/repos/${repository}/contents/${path.split("/").map(encodeURIComponent).join("/")}${
            ref ? `?ref=${encodeURIComponent(ref)}` : ""
          }`;
          const body = z
            .object({
              type: z.string(),
              path: z.string(),
              sha: z.string(),
              size: z.number(),
              content: z.string().optional(),
              encoding: z.string().optional(),
            })
            .parse(await (await gh(url)).json());
          if (body.type !== "file" || body.content === undefined)
            throw new UpstreamError("UPSTREAM_ERROR", { path }, `GitHub path is not a readable file: ${path}`);
          const content =
            body.encoding === "base64" ? Buffer.from(body.content, "base64").toString("utf8") : body.content;
          return { path: body.path, content, sha: body.sha, size: body.size };
        },
        async listIssues(repository, opts) {
          const state = opts.state === "closed" || opts.state === "all" ? opts.state : "open";
          const since = opts.since !== undefined ? `&since=${encodeURIComponent(opts.since)}` : "";
          // Default 1 page keeps every pre-existing caller's behaviour; the tracker's bulk pull opts into the walk.
          const maxPages = Math.max(1, opts.maxPages ?? 1);
          const collected: GithubIssue[] = [];
          let url: string | undefined =
            `${base}/repos/${repository}/issues?state=${state}&per_page=${opts.perPage}&sort=updated&direction=desc${since}`;
          for (let page = 0; page < maxPages && url !== undefined; page += 1) {
            const res = await gh(url);
            collected.push(...ISSUE_ROWS.parse(await res.json()).map(toGithubIssue));
            url = nextPageUrl(res.headers.get("link"));
          }
          return collected;
        },
        async getIssue(repository, issueNumber) {
          return toGithubIssue(
            ISSUE_ROW.parse(await (await gh(`${base}/repos/${repository}/issues/${issueNumber}`)).json()),
          );
        },
        async listPullRequestFiles(repository, pullNumber, opts) {
          const perPage = Math.min(100, Math.max(1, opts.maxFiles));
          // The PR itself carries changed_files — the honest denominator for "is this the whole diff".
          const pr = z
            .object({ changed_files: z.number().default(0) })
            .parse(await (await gh(`${base}/repos/${repository}/pulls/${pullNumber}`)).json());
          const rows = z
            .array(
              z.object({
                filename: z.string(),
                status: z.string(),
                additions: z.number().default(0),
                deletions: z.number().default(0),
                patch: z.string().nullish(),
              }),
            )
            .parse(
              await (await gh(`${base}/repos/${repository}/pulls/${pullNumber}/files?per_page=${perPage}`)).json(),
            );
          return {
            changedFiles: pr.changed_files,
            files: rows.map((r) => ({
              filename: r.filename,
              status: r.status,
              additions: r.additions,
              deletions: r.deletions,
              // A binary file (and one GitHub declined to render) has no patch — omitted rather than "".
              ...(r.patch ? { patch: r.patch } : {}),
            })),
          };
        },
        async mergePr(repository, pullNumber, opts) {
          // The head sha travels as GitHub's own precondition: a 409 here means the branch moved after the round
          // measured it, and the commit that would land is not the one the campaign proved.
          const res = await doFetch(`${base}/repos/${repository}/pulls/${pullNumber}/merge`, {
            method: "PUT",
            headers: headers(token),
            body: JSON.stringify({
              merge_method: opts.method ?? "merge",
              ...(opts.sha !== undefined ? { sha: opts.sha } : {}),
              ...(opts.message !== undefined ? { commit_message: opts.message } : {}),
            }),
          });
          if (res.ok) {
            const merged = z.object({ sha: z.string(), merged: z.boolean() }).parse(await res.json());
            if (!merged.merged) throw await upstream(res, "PR merge did not land");
            return { sha: merged.sha, alreadyMerged: false };
          }
          // 405 = not mergeable — which includes "already merged". Read the pull request back: a merged one is
          // this same effect having landed earlier (an at-least-once retry), anything else is a real refusal.
          if (res.status === 405) {
            const pr = z
              .object({ merged: z.boolean(), merge_commit_sha: z.string().nullish() })
              .parse(await (await gh(`${base}/repos/${repository}/pulls/${pullNumber}`)).json());
            if (pr.merged && pr.merge_commit_sha) return { sha: pr.merge_commit_sha, alreadyMerged: true };
            const text = await res.text().catch(() => "");
            throw new ConflictError(
              "CONFLICT",
              { repository, pullNumber, status: res.status },
              `pull request #${pullNumber} is not mergeable: ${text.slice(0, 200)}`,
            );
          }
          if (res.status === 409) {
            const text = await res.text().catch(() => "");
            throw new ConflictError(
              "CONFLICT",
              { repository, pullNumber, sha: opts.sha ?? null },
              `pull request #${pullNumber}'s head moved after the round measured it: ${text.slice(0, 200)}`,
            );
          }
          throw await upstream(res, "PR merge failed");
        },
        async updateIssue(repository, issueNumber, patch) {
          const res = await doFetch(`${base}/repos/${repository}/issues/${issueNumber}`, {
            method: "PATCH",
            headers: headers(token),
            body: JSON.stringify({ state: patch.state }),
          });
          if (!res.ok) throw await upstream(res, "issue state update failed");
        },
        async listIssueComments(repository, issueNumber, opts) {
          const perPage = Math.min(100, Math.max(1, opts.maxComments));
          const rows = z
            .array(
              z.object({
                body: z.string().nullish(),
                created_at: z.string(),
                html_url: z.string(),
                user: z.object({ login: z.string() }).nullish(),
              }),
            )
            .parse(
              await (await gh(`${base}/repos/${repository}/issues/${issueNumber}/comments?per_page=${perPage}`)).json(),
            );
          return rows.slice(-opts.maxComments).map((r) => ({
            author: r.user?.login ?? "",
            body: r.body ?? "",
            createdAt: r.created_at,
            url: r.html_url,
          }));
        },
        async createIssue(repository, opts) {
          const res = await doFetch(`${base}/repos/${repository}/issues`, {
            method: "POST",
            headers: headers(token),
            body: JSON.stringify({ title: opts.title, ...(opts.body ? { body: opts.body } : {}) }),
          });
          if (!res.ok) throw await upstream(res, "issue creation failed");
          const issue = z.object({ number: z.number(), html_url: z.string() }).parse(await res.json());
          return { number: issue.number, url: issue.html_url };
        },
        async createIssueComment(repository, issueNumber, body) {
          const res = await doFetch(`${base}/repos/${repository}/issues/${issueNumber}/comments`, {
            method: "POST",
            headers: headers(token),
            body: JSON.stringify({ body }),
          });
          if (!res.ok) throw await upstream(res, "comment creation failed");
          const comment = z.object({ html_url: z.string() }).parse(await res.json());
          return { url: comment.html_url };
        },
        async fetchAsset(url, opts) {
          // Deliberately NOT headers(token): an attachment is a web route, not the JSON API, so the API media type
          // and content-type would be wrong. The token still rides as the bearer, which is what makes a private /
          // Enterprise attachment resolve at all. redirect:"follow" is required — GitHub answers with a 302 to
          // signed object storage, and the fetch spec drops the authorization header on that cross-origin hop, so
          // our token never reaches the storage host.
          const res = await doFetch(url, {
            headers: {
              authorization: `Bearer ${token}`,
              accept: "image/*,video/*,application/pdf;q=0.9,*/*;q=0.8",
              "user-agent": "everdict-control-plane",
            },
            redirect: "follow",
          });
          if (!res.ok) throw await upstream(res, "attachment fetch failed");
          const contentType = res.headers.get("content-type") ?? "application/octet-stream";
          if (!isRenderableAsset(contentType))
            throw new UpstreamError(
              "UPSTREAM_ERROR",
              { url, contentType },
              `GitHub answered with ${contentType}, not an attachment. An HTML answer means the installation token was not accepted for this attachment.`,
            );
          const bytes = new Uint8Array(await res.arrayBuffer());
          if (bytes.byteLength > opts.maxBytes)
            throw new UpstreamError(
              "UPSTREAM_ERROR",
              { url, size: bytes.byteLength, maxBytes: opts.maxBytes },
              `The attachment is larger than the ${opts.maxBytes} byte limit.`,
            );
          return { bytes, contentType };
        },
      };
    },
  };
}

// The release/tag shapes the product timeline's sync reads (records/product.ts). Parsed with the same
// tolerance the issue rows get: only the fields the port promises, everything else ignored.
const RELEASE_ROW = z.object({
  tag_name: z.string(),
  name: z.string().nullish(),
  body: z.string().nullish(),
  html_url: z.string(),
  draft: z.boolean().default(false),
  prerelease: z.boolean().default(false),
  published_at: z.string().nullish(),
});
const TAG_ROW = z.object({ name: z.string(), commit: z.object({ sha: z.string() }) });

// The version half of the GitHub read surface (GithubVersionReader) — same base/auth/error discipline as the
// repo writer above, minted per (installation token, host) by the same composition roots.
// How many pages one version read may walk before it stops. 50 × 100 = 5,000 versions, which is more history
// than any product timeline needs and still a bound rather than an open crawl — a limit that is DECLARED,
// because a limit that merely happens reads as completeness to whoever comes next.
const DEFAULT_MAX_PAGES = 50;

// The repository's file list on its default branch — one recursive tree call, which is why the product
// wizard can propose a monorepo's services without walking directories. GitHub answers with its OWN
// `truncated` flag for a tree it would not return whole; the caller propagates it rather than presenting a
// partial tree as the repository's full composition.
const TREE_ROW = z.object({
  tree: z.array(z.object({ path: z.string(), type: z.string() })).default([]),
  truncated: z.boolean().default(false),
});

export function githubRepoTreeReaderFactory(fetchImpl?: typeof fetch): GithubRepoTreeReaderFactory {
  return {
    for(token, host): GithubRepoTreeReader {
      const base = apiBase(host);
      const doFetch = fetchImpl ?? fetch;
      return {
        async listTree(repository, opts) {
          let ref = opts?.ref;
          if (ref === undefined) {
            // The default branch is the honest "current composition" — a tree read against a stale ref would
            // propose services the repository has since removed.
            const head = await doFetch(`${base}/repos/${repository}`, { headers: headers(token) });
            if (!head.ok) throw await upstream(head, "GitHub repository read failed");
            const parsed = z.object({ default_branch: z.string() }).safeParse(await head.json());
            if (!parsed.success)
              throw new UpstreamError(
                "UPSTREAM_ERROR",
                { repository },
                `GitHub did not name a default branch for ${repository}.`,
              );
            ref = parsed.data.default_branch;
          }
          const res = await doFetch(`${base}/repos/${repository}/git/trees/${encodeURIComponent(ref)}?recursive=1`, {
            headers: headers(token),
          });
          if (!res.ok) throw await upstream(res, "GitHub tree read failed");
          const parsed = TREE_ROW.parse(await res.json());
          return {
            paths: parsed.tree.filter((entry) => entry.type === "blob").map((entry) => entry.path),
            truncated: parsed.truncated,
          };
        },
      };
    },
  };
}

export function githubVersionReaderFactory(fetchImpl?: typeof fetch): GithubVersionReaderFactory {
  return {
    for(token, host): GithubVersionReader {
      const base = apiBase(host);
      const doFetch = fetchImpl ?? fetch;
      const gh = async (url: string): Promise<Response> => {
        const res = await doFetch(url, { headers: headers(token) });
        if (!res.ok) throw await upstream(res, "GitHub API call failed");
        return res;
      };
      // Walk GitHub's pages until one comes back short (the last page) or the declared ceiling is reached.
      // A page-1-only read is fine for "what shipped lately" and wrong for "backfill the timeline's past",
      // which is what the first sync claims to do (arch-review 14 §16).
      const pages = async <S extends z.ZodTypeAny>(
        url: (page: number) => string,
        row: S,
        opts: { perPage: number; maxPages?: number },
      ): Promise<{ rows: z.infer<S>[]; complete: boolean }> => {
        const out: z.infer<S>[] = [];
        const ceiling = Math.max(1, opts.maxPages ?? DEFAULT_MAX_PAGES);
        for (let page = 1; page <= ceiling; page++) {
          const rows = z.array(row).parse(await (await gh(url(page))).json());
          out.push(...rows);
          // A SHORT page is the last page — that, and only that, is what "complete" means here. Falling out
          // of the loop at the ceiling means there is very likely more, and saying so is the whole point.
          if (rows.length < opts.perPage) return { rows: out, complete: true };
        }
        return { rows: out, complete: false };
      };
      return {
        async listReleases(repository, opts) {
          const { rows, complete } = await pages(
            (page) => `${base}/repos/${repository}/releases?per_page=${opts.perPage}&page=${page}`,
            RELEASE_ROW,
            opts,
          );
          return {
            complete,
            rows: rows.map((row) => ({
              tagName: row.tag_name,
              ...(row.name ? { name: row.name } : {}),
              ...(row.body ? { body: row.body } : {}),
              url: row.html_url,
              draft: row.draft,
              prerelease: row.prerelease,
              ...(row.published_at ? { publishedAt: row.published_at } : {}),
            })),
          };
        },
        async listTags(repository, opts) {
          const { rows, complete } = await pages(
            (page) => `${base}/repos/${repository}/tags?per_page=${opts.perPage}&page=${page}`,
            TAG_ROW,
            opts,
          );
          return { complete, rows: rows.map((row) => ({ name: row.name, sha: row.commit.sha })) };
        },
        async commitDate(repository, sha) {
          // Best-effort by contract: a commit that cannot be read (force-pushed away) is not an error the
          // whole sync should die on — the caller substitutes its own import time.
          const res = await doFetch(`${base}/repos/${repository}/commits/${sha}`, { headers: headers(token) });
          if (!res.ok) return undefined;
          const parsed = z
            .object({ commit: z.object({ committer: z.object({ date: z.string() }).nullish() }) })
            .safeParse(await res.json());
          return parsed.success ? (parsed.data.commit.committer?.date ?? undefined) : undefined;
        },
      };
    },
  };
}
