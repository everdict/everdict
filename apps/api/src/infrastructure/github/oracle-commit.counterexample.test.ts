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

  it("covers a DIVERGED history with a second comparison, and unions both sides of the fork", async () => {
    // The finding, and why a refusal was the wrong repair. `/compare/A...B` is three-dot, so on a diverged
    // history its files describe merge-base→B. The baseline's own change since the fork is invisible there —
    // which is how a clean receipt was issued over a protected file that genuinely differs. A path in NEITHER
    // side's list has the same bytes at the fork, at the baseline and at the candidate, so the UNION is a
    // superset of the two-tree difference and a scope that misses it is genuinely clean.
    const urls: string[] = [];
    const writer = githubRepoWriterFactory(async (input) => {
      urls.push(String(input));
      return String(input).includes("ffffff")
        ? // merge-base→baseline: what the BASELINE moved after the fork, invisible to the first comparison
          Response.json({ files: [{ filename: "datasets/tb.json", status: "modified", additions: 1, deletions: 0 }] })
        : Response.json({
            base_commit: { sha: "c".repeat(40) },
            merge_base_commit: { sha: "f".repeat(40) },
            status: "diverged",
            commits: [{ sha: "d".repeat(40) }],
            files: [{ filename: "src/loop.ts", status: "modified", additions: 1, deletions: 0 }],
          });
    }).for("test-token");
    const result = await writer.listPullRequestFiles("acme/repo", 7, {
      maxFiles: 100,
      commits: { baselineSha: "a".repeat(40), candidateSha: "b".repeat(40) },
    });
    // Two GETs, the second one anchored at the merge base GitHub reported and ending at the baseline it
    // resolved — never at the sha the caller asked about.
    expect(urls).toEqual([
      `https://api.github.com/repos/acme/repo/compare/${"a".repeat(40)}...${"b".repeat(40)}`,
      `https://api.github.com/repos/acme/repo/compare/${"f".repeat(40)}...${"c".repeat(40)}`,
    ]);
    expect(result.files.map((f) => f.filename).sort()).toEqual(["datasets/tb.json", "src/loop.ts"]);
    expect(result.compared?.pathsCover).toBe("fork-union");
    expect(result.changedFiles).toBe(result.files.length);
  });

  it("makes no second call when the comparison already started at the evaluated baseline", async () => {
    const urls: string[] = [];
    const writer = githubRepoWriterFactory(async (input) => {
      urls.push(String(input));
      return Response.json({
        base_commit: { sha: "c".repeat(40) },
        merge_base_commit: { sha: "c".repeat(40) },
        status: "ahead",
        commits: [{ sha: "d".repeat(40) }],
        files: [{ filename: "src/loop.ts", status: "modified", additions: 1, deletions: 0 }],
      });
    }).for("test-token");
    const result = await writer.listPullRequestFiles("acme/repo", 7, {
      maxFiles: 100,
      commits: { baselineSha: "a".repeat(40), candidateSha: "b".repeat(40) },
    });
    expect(urls).toHaveLength(1);
    expect(result.compared?.pathsCover).toBe("evaluated-difference");
  });

  it("attests the commits GITHUB names, and nothing when it names none", async () => {
    const compare = (body: Record<string, unknown>) =>
      githubRepoWriterFactory(async () => Response.json({ files: [], ...body })).for("test-token");
    const asked = { baselineSha: "a".repeat(40), candidateSha: "b".repeat(40) };
    // GitHub's own account: the resolved base, and the head as the last commit of the comparison. Deliberately
    // DIFFERENT from what was asked, because a value that equals the request cannot show which one was read.
    const ahead = await compare({
      base_commit: { sha: "c".repeat(40) },
      merge_base_commit: { sha: "c".repeat(40) },
      status: "ahead",
      commits: [{ sha: "e".repeat(40) }, { sha: "d".repeat(40) }],
    }).listPullRequestFiles("acme/repo", 7, { maxFiles: 100, commits: asked });
    expect(ahead.compared).toEqual({
      baselineSha: "c".repeat(40),
      candidateSha: "d".repeat(40),
      // The comparison started at the base, so its files ARE the two-tree difference (review 2026-09-10 R1).
      mergeBaseSha: "c".repeat(40),
      pathsCover: "evaluated-difference",
    });
    // Nothing lies between an identical pair, so the head IS the base — not "no attestation".
    const identical = await compare({
      base_commit: { sha: "c".repeat(40) },
      merge_base_commit: { sha: "c".repeat(40) },
      status: "identical",
      commits: [],
    }).listPullRequestFiles("acme/repo", 7, { maxFiles: 100, commits: asked });
    expect(identical.compared).toEqual({
      baselineSha: "c".repeat(40),
      candidateSha: "c".repeat(40),
      mergeBaseSha: "c".repeat(40),
      pathsCover: "evaluated-difference",
    });
    // A response that says neither attests neither. The oracle reads that as unverifiable; echoing `asked`
    // here would have made the round look attested by its own request.
    // A response naming nothing cannot even be told whether it diverged, so it declares the exact-difference
    // cover it did not earn — which is why the CONSUMER cross-checks the claim against the merge base and
    // refuses a reader that disagrees with itself. Pinned here so that contract is visible from both ends.
    const silent = await compare({}).listPullRequestFiles("acme/repo", 7, { maxFiles: 100, commits: asked });
    expect(silent.compared).toEqual({
      baselineSha: undefined,
      candidateSha: undefined,
      mergeBaseSha: undefined,
      pathsCover: "evaluated-difference",
    });
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
