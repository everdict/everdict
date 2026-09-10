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
// ⚠️ IT IS A NAMED FUNCTION SO ITS COUNTEREXAMPLE DRIVES THE PRODUCTION CLOSURE (arch-review 72 P0 / 73).
// While it was an object literal inside `main.ts` it returned `{ …, ...commits }` — its own argument spread
// into its own result — so the oracle's attestation check (`read.value.baselineSha !== baseline.sha`) compared
// a value with itself and could not fail. Nothing was WRONG downstream, because both shas came from the build
// ledger; what was wrong is that the guard would not have noticed its premise being removed, and no test could
// reach the closure to say so. The attested commits are read from the LISTING now — GitHub's own account of
// what it compared — and a remote that does not say leaves the round unverifiable.
export function oracleChanges(githubAppService: GithubAppService | undefined): ChangesPort {
  return {
    pullRequestFiles: async (
      tenant: string,
      repository: string,
      pullNumber: number,
      commits: { baselineSha: string; candidateSha: string },
    ): Promise<
      ReadResult<{
        paths: string[];
        complete: boolean;
        baselineSha?: string;
        candidateSha?: string;
        mergeBaseSha?: string;
      }>
    > => {
      if (githubAppService === undefined)
        return readUnknown(
          "no workspace GitHub App is configured on this deployment, so a pull request's changed files cannot be read",
        );
      return readOrUnknown(async () => {
        const listing = await githubAppService.listPullRequestChanges(tenant, repository, pullNumber, {
          maxFiles: 100,
          commits,
        });
        return {
          paths: listing.files.map((f) => f.filename),
          complete: !listing.truncated,
          ...(listing.compared?.baselineSha ? { baselineSha: listing.compared.baselineSha } : {}),
          ...(listing.compared?.candidateSha ? { candidateSha: listing.compared.candidateSha } : {}),
          ...(listing.compared?.mergeBaseSha ? { mergeBaseSha: listing.compared.mergeBaseSha } : {}),
        };
      }, `pull request #${pullNumber} of ${repository}`);
    },
  };
}
