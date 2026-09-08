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
