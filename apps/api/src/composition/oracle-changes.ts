import type { CampaignService, GithubAppService } from "@everdict/application-control";
import { type ReadResult, readOrUnknown, readUnknown } from "@everdict/contracts";

type ChangesPort = ConstructorParameters<typeof CampaignService>[0]["changes"];

// ── WHAT A CANDIDATE'S PULL REQUEST CHANGED (docs/architecture/code-evolution-loop.md, D3) ───────────
//
// The frame's `oracleScope` is checked against the files the candidate's pull request touched, read through
// the workspace GitHub App. A deployment without the App answers UNKNOWN with the reason — the frame that
// declared a scope then rejects every round as unverifiable, which is the fail-closed answer (rule `protocol`
// L2) — never an empty listing that would read as "the change was clean".
//
// ⚠️ IT IS A NAMED FUNCTION SO ITS COUNTEREXAMPLE CAN DRIVE THE PRODUCTION CLOSURE (arch-review 72 P0 / 73).
// Inside `main.ts` it was an object literal nothing could reach, which is why what it returns has never been
// asserted. Moving it changes nothing it does; the next commit is about what it returns.
export function oracleChanges(githubAppService: GithubAppService | undefined): ChangesPort {
  return {
    pullRequestFiles: async (
      tenant: string,
      repository: string,
      pullNumber: number,
      commits: { baselineSha: string; candidateSha: string },
    ): Promise<ReadResult<{ paths: string[]; complete: boolean; baselineSha?: string; candidateSha?: string }>> => {
      if (githubAppService === undefined)
        return readUnknown(
          "no workspace GitHub App is configured on this deployment, so a pull request's changed files cannot be read",
        );
      return readOrUnknown(async () => {
        const listing = await githubAppService.listPullRequestChanges(tenant, repository, pullNumber, {
          maxFiles: 100,
          commits,
        });
        return { paths: listing.files.map((f) => f.filename), complete: !listing.truncated, ...commits };
      }, `pull request #${pullNumber} of ${repository}`);
    },
  };
}
