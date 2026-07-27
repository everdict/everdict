import type { GithubRepoWriter, GithubRepoWriterFactory } from "@everdict/application-control";
import { UpstreamError } from "@everdict/contracts";
import { z } from "zod";

// The fetch-backed GitHub repo-write adapter — owns the REST endpoints, response parsing, and the
// 422 reuse translations behind the GithubRepoWriter port. Moved out of ci-link-service in
// re-architecture P2d; the injectable fetch keeps tests recording the exact wire bytes.

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
          if (!put.ok) throw await upstream(put, "workflow file commit failed");
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
          const url = `${base}/repos/${repository}/issues?state=${state}&per_page=${opts.perPage}&sort=updated&direction=desc`;
          const rows = z
            .array(
              z.object({
                number: z.number(),
                title: z.string(),
                state: z.string(),
                html_url: z.string(),
                updated_at: z.string(),
                user: z.object({ login: z.string() }).nullish(),
                pull_request: z.unknown().optional(),
              }),
            )
            .parse(await (await gh(url)).json());
          return rows.map((r) => ({
            number: r.number,
            title: r.title,
            state: r.state,
            author: r.user?.login ?? "",
            url: r.html_url,
            isPullRequest: r.pull_request !== undefined,
            updatedAt: r.updated_at,
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
      };
    },
  };
}
