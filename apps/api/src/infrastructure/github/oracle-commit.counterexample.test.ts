import { describe, expect, it } from "vitest";
import { githubRepoWriterFactory } from "./repo-writer.js";

describe("oracle comparison pins evaluated commits", () => {
  it("never reads the moving PR and includes the previous path of renamed files", async () => {
    const urls: string[] = [];
    const writer = githubRepoWriterFactory(async (input) => {
      urls.push(String(input));
      return Response.json({
        files: [
          {
            filename: "src/moved.ts",
            previous_filename: "tests/oracle.ts",
            status: "renamed",
            additions: 0,
            deletions: 0,
          },
        ],
      });
    }).for("test-token");
    const commits = { baselineSha: "a".repeat(40), candidateSha: "b".repeat(40) };
    const result = await writer.listPullRequestFiles("acme/repo", 7, { maxFiles: 100, commits });
    expect(urls).toEqual([
      `https://api.github.com/repos/acme/repo/compare/${commits.baselineSha}...${commits.candidateSha}`,
    ]);
    expect(result.files.map((f) => f.filename)).toEqual(["src/moved.ts", "tests/oracle.ts"]);
    expect(result.changedFiles).toBe(result.files.length);
  });

  it("attests the commits GITHUB names, and nothing when it names none", async () => {
    const compare = (body: Record<string, unknown>) =>
      githubRepoWriterFactory(async () => Response.json({ files: [], ...body })).for("test-token");
    const asked = { baselineSha: "a".repeat(40), candidateSha: "b".repeat(40) };
    // GitHub's own account: the resolved base, and the head as the last commit of the comparison. Deliberately
    // DIFFERENT from what was asked, because a value that equals the request cannot show which one was read.
    const ahead = await compare({
      base_commit: { sha: "c".repeat(40) },
      status: "ahead",
      commits: [{ sha: "e".repeat(40) }, { sha: "d".repeat(40) }],
    }).listPullRequestFiles("acme/repo", 7, { maxFiles: 100, commits: asked });
    expect(ahead.compared).toEqual({ baselineSha: "c".repeat(40), candidateSha: "d".repeat(40) });
    // Nothing lies between an identical pair, so the head IS the base — not "no attestation".
    const identical = await compare({
      base_commit: { sha: "c".repeat(40) },
      status: "identical",
      commits: [],
    }).listPullRequestFiles("acme/repo", 7, { maxFiles: 100, commits: asked });
    expect(identical.compared).toEqual({ baselineSha: "c".repeat(40), candidateSha: "c".repeat(40) });
    // A response that says neither attests neither. The oracle reads that as unverifiable; echoing `asked`
    // here would have made the round look attested by its own request.
    const silent = await compare({}).listPullRequestFiles("acme/repo", 7, { maxFiles: 100, commits: asked });
    expect(silent.compared).toEqual({ baselineSha: undefined, candidateSha: undefined });
  });

  it("does not claim completeness at the comparison endpoint's file cap", async () => {
    const writer = githubRepoWriterFactory(async () =>
      Response.json({
        files: Array.from({ length: 300 }, (_, i) => ({
          filename: `src/${i}`,
          status: "modified",
          additions: 1,
          deletions: 0,
        })),
      }),
    ).for("test-token");
    const result = await writer.listPullRequestFiles("acme/repo", 7, {
      maxFiles: 100,
      commits: { baselineSha: "a".repeat(40), candidateSha: "b".repeat(40) },
    });
    expect(result.changedFiles).toBeGreaterThan(result.files.length);
  });
});
