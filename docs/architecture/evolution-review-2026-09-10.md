---
kind: wiki
title: "Evolution and CI review — 2026-09-10"
status: current
updated: 2026-09-10
anchors: [apps/api/src/infrastructure/github/repo-writer.ts, apps/api/src/composition/oracle-changes.ts, packages/application-control/src/evolution/campaign-service.ts, packages/db/src/evolution/experiment-family.ts, scripts/review/run.mjs, scripts/hooks/pre-push-gate.mjs]
---
# Evolution and CI review — 2026-09-10

Reviewed commit: `2b6e04dd618e6f41d5584cdb97af2c333a5f1321`.
Scope: `2036077e..2b6e04dd`, 15 commits and 24 changed files, plus the production paths
those changes depend on. Fetching origin confirmed that local main and origin/main both
pointed at the reviewed commit.

**One finding was open, and is now closed** (2026-09-10, in the implementation rather than
in this record): a diverged GitHub comparison could produce a clean oracle receipt despite
different protected bytes in the two evaluated commits. The repair, its regressions, and the
review's own live probe re-run against the fixed code are under R1 below.

This follows the [2026-09-09 review](evolution-review-2026-09-09.md) and the
[identity and evidence authority implementation](evolution-review-follow-up.md).
The review applied authorship, blast radius, existing dependencies, composed limits and
sibling paths, adversarial inputs, and transaction-boundary inspection. Findings use the
repository's review severity definitions.

## Verified clean

- The composition forwards the listing's attested commits and returns unknown when GitHub
  is unavailable. Existing tests cover mismatched and absent attestation, renamed source
  paths, and the 300-file cap. These checks do not establish the comparison's file semantics.
- The family-size refactor preserves the declared limit, the explicit legacy-root
  allowance, continuation refusal, and limit-plus-one refusal. Non-inferiority receives
  the family size already validated by the caller.
- CI inheritance includes both trees and the commit message, and grants only `fast`.
  Review resumption checks ancestry and excludes explicitly unstructured stamps. These
  paths were source-reviewed; the current pre-push probe also completed normally in
  5.57 seconds without writing a gate ledger.

## R1 — P0 / Important / Leaned-on: diverged comparisons can certify changed oracle bytes as clean

Status: **closed** — `packages/db/src/evolution/oracle-commits-are-built.counterexample.test.ts`
(the diverged case and the named-no-starting-point case), plus the review's own live probe
re-run against the repair.

Source: [the GitHub comparison adapter at the reviewed commit](https://github.com/everdict/everdict/blob/2b6e04dd618e6f41d5584cdb97af2c333a5f1321/apps/api/src/infrastructure/github/repo-writer.ts#L230-L243),
especially its attestation at lines 231–233. Consumer:
[the campaign oracle check](https://github.com/everdict/everdict/blob/2b6e04dd618e6f41d5584cdb97af2c333a5f1321/packages/application-control/src/evolution/campaign-service.ts#L1546-L1578).

The new attestation treats `base_commit.sha` and the last comparison commit as evidence
that `files` describes the difference between the two evaluated trees. For diverged
histories, the observed file list instead describes changes from the merge base to the
candidate. Neither the adapter nor its consumer checks `merge_base_commit.sha` against
the evaluated baseline. Both attested SHAs can match while a protected file's actual
baseline-to-candidate change is missing from the list.

This is an existing defect in the comparison semantics that the new attestation relies
on. The requested and returned SHAs are genuine; the counterexample requires no forged
response or commit identity. The implementation violates the requirement that oracle
inspection cover the two evaluated commits. The requirement should remain in force.

### Live reproduction

The public repository `octocat/Hello-World` supplies immutable commits with this shape:

| Coordinate | Commit |
| --- | --- |
| Baseline | `b1b3f9723831141a31a1a7252a213e216ea76e56` |
| Candidate | `b3cbd5bbd7e81436d2eee04537ea2b4c0cad4cdf` |
| Merge base | `7fd1a60b01f91b314f59955a4e4d4e80d8edf11d` |

The [actual comparison response](https://api.github.com/repos/octocat/Hello-World/compare/b1b3f9723831141a31a1a7252a213e216ea76e56...b3cbd5bbd7e81436d2eee04537ea2b4c0cad4cdf)
reported `status: diverged`, named the requested baseline and candidate, and listed only
`CONTRIBUTING.md`. Direct reads of the protected `README` showed different bytes:

| Arm | README blob SHA | Content |
| --- | --- | --- |
| [Baseline](https://api.github.com/repos/octocat/Hello-World/contents/README?ref=b1b3f9723831141a31a1a7252a213e216ea76e56) | `cd0875583aabe89ee197ea133980a9085d08e497` | `Hello world!\n` |
| [Candidate](https://api.github.com/repos/octocat/Hello-World/contents/README?ref=b3cbd5bbd7e81436d2eee04537ea2b4c0cad4cdf) | `980a0d5f19a64b4b30a87d4206aade58726b60e3` | `Hello World!\n` |

With `oracleScope: ["README"]`, the production adapter, GithubAppService listing method,
composition, and CampaignService oracle method returned this receipt:

```json
{
  "kind": "clean",
  "receipt": {
    "repository": "octocat/Hello-World",
    "baselineSha": "b1b3f9723831141a31a1a7252a213e216ea76e56",
    "candidateSha": "b3cbd5bbd7e81436d2eee04537ea2b4c0cad4cdf",
    "pathsDigest": "sha256:51701b9741d26ee3ede907b6e3338443aec218e79cb048f1e0178162a44fa37e",
    "complete": true,
    "commitProvenance": "everdict-build"
  }
}
```

Authentication was stubbed to avoid using credentials, and the build ledger was a fixed
fixture. The comparison and file-content responses came from live public GitHub. This
exercised the production oracle method directly, not a deployed end-to-end campaign.
The probe exited 1 with:

```text
REPRODUCED: protected README differs between the evaluated commits, but the production oracle returned clean.
```

[GitHub's comparison API documentation](https://docs.github.com/en/rest/commits/commits#compare-two-commits)
was also checked for non-paginated commit ordering and response limits. The finding rests
on the live comparison and direct blob reads above.

### Impact and required repair

The oracle can issue a clean receipt even when the evaluated candidate changes protected
grading or dataset bytes relative to the evaluated baseline. That removes the oracle
refusal from a candidate that should be rejected as touched or unverifiable. This review
did not perform an actual adoption.

Compute the actual two-tree difference, or require the response's merge base to equal the
attested baseline and return unverifiable otherwise. Add a regression with baseline-only
protected changes in diverged history. Retain the existing ahead, identical,
missing-attestation, rename, and cap cases.

### Repair

The second of the two, because the first has no endpoint: GitHub's comparison API is
three-dot only, and a real two-tree difference would mean walking the trees API and diffing
by hand — a second implementation of a thing the oracle would then have to trust.

`merge_base_commit.sha` is read from the comparison response and travels as part of the
attestation (`compared.mergeBaseSha`), through `listPullRequestChanges` and the composition
untouched, exactly as the two commit SHAs do. `oracleCheck` refuses when it is not the
evaluated baseline, and the reason names the repair an operator has to make rather than the
mechanism: *rebase the candidate onto the evaluated baseline and build again*. A listing that
names **no** starting point is refused for its own reason — not saying is a third answer, not
a permission (rule `protocol` L2). The receipt is not written on either path, so nothing
downstream can read a diverged comparison as evidence.

⚠️ **This refusal will fire on ordinary pull requests.** A branch cut before the baseline was
built is diverged by definition, and that is the fail-closed direction: the oracle's claim is
about two evaluated trees, and a merge-base listing cannot make it. The cost is real and is
stated here rather than softened.

Both counterexamples were seen RED with the refusal removed — `comparable` came back `true`,
i.e. a clean receipt over a diverged comparison, which is the finding.

### What the gate said about the same commit

`pnpm review` ran over this exact range at this exact commit and returned **0 findings**
(`.git/everdict-review-2b6e04dd618e.json`), and `pnpm ci:commits`, `pnpm ci:local` and
`pnpm agent-evals` were all green. That is not the gate failing at its job; it is the gate's
job. It reads a diff, and this defect is not in a diff — it is in what GitHub's comparison
endpoint MEANS, which is answerable only by asking GitHub. The finding is therefore not
recorded in `findings/DISPOSITIONS.md`: that ledger grades what `pnpm review` and `pnpm scan`
raised, and counting a finding they did not raise would inflate the very number it exists to
keep honest. Its disposition is this section.

The generalisable part is the one rule `code-review`'s third pass already names — *which
existing component does your new guarantee now REST on?* — applied to a remote API rather
than to a function in this repository. The repair leaned on `/compare`'s file list, and the
sentence describing what that list contains was written from the endpoint's name.

### Live verification of the repair

The review's own probe, unchanged except for its exit condition, re-run against the fixed
tree on 2026-09-10 with the same public commits:

```text
protected README differs between the evaluated commits: true
oracle: {
 "kind": "unverifiable",
 "reason": "the oracle listing compares from 7fd1a60b01f91b314f59955a4e4d4e80d8edf11d rather than from the evaluated baseline b1b3f9723831141a31a1a7252a213e216ea76e56, so its file list describes a common ancestor's difference and can omit a protected file the baseline changed — rebase the candidate onto the evaluated baseline and build again"
}
CLOSED: the diverged comparison is refused, and the reason names the repair.
```

The merge base it names is the one this review's own table recorded, read from the live
response. Same limits as the reproduction: authentication stubbed, build ledger a fixture,
the production oracle method driven directly rather than through a deployed campaign.

## Verification and limits

The following existing suites were rerun at the reviewed commit:

| Suite | Passed |
| --- | ---: |
| API oracle adapter and composition | 6 |
| Database evolution | 96 |
| Domain campaign gate, non-inferiority, and oracle scope | 36 |
| Application-control evolution | 88 |
| **Total** | **226** |

None of these tests skipped. The separate live probe reproduced R1 despite these green
suites. Typecheck for API, application-control, database, and domain passed through Turbo
cache; dependency builds also used cache. The import-cycle check ran successfully:
16 existing baseline cycles across seven roots, none new.

Not executed: the complete repository test suite, full CI certification, real PostgreSQL
transactions or concurrency, authenticated private GitHub or GitHub Enterprise access,
and deployment E2E. No implementation fixes, commits, pushes, or review/CI stamps were
written by the review. The existing one-line local addition in `evals/history.jsonl` was
preserved.

## Re-running the oracle probe

Run from the repository root with dependencies installed. The probe was exercised with
Node 24.20.0 and pnpm 9.12.0; it uses Node's TypeScript stripping for the two API source
imports. Build application-control and its dependencies first:

```sh
pnpm exec turbo run build --filter=@everdict/application-control
```

The following probe preserves the original fixture boundaries and uses no credentials.
It performs public GET requests, so network or API rate-limit failures are execution
failures, not evidence for R1. At the reviewed commit, the expected reproduction is the
explicit failure message below; a zero exit by itself does not certify a future repair.

```sh
node --input-type=module <<'JS'
import { githubRepoWriterFactory } from './apps/api/src/infrastructure/github/repo-writer.ts';
import { oracleChanges } from './apps/api/src/composition/oracle-changes.ts';
import { GithubAppService, CampaignService } from './packages/application-control/dist/index.js';

const repo = 'octocat/Hello-World';
const baselineSha = 'b1b3f9723831141a31a1a7252a213e216ea76e56';
const candidateSha = 'b3cbd5bbd7e81436d2eee04537ea2b4c0cad4cdf';
const publicFetch = async (url) => {
  const response = await fetch(url, {
    headers: { 'user-agent': 'everdict-code-review', accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`GitHub ${response.status}`);
  return response;
};
const github = new GithubAppService({ repoOps: githubRepoWriterFactory(publicFetch) });
// Only authentication is stubbed; publicFetch sends no token.
github.tokenForRepository = async () => ({ token: 'unused-public-request' });
const service = new CampaignService({
  changes: oracleChanges(github),
  builds: {
    setsForCampaign: async () => [],
    forCampaign: async () => [{
      id: 'baseline-build', state: 'built', candidateVersion: '1',
      source: { repo, sha: baselineSha }, base: { image: 'fixture:baseline' },
    }],
  },
});
// Call the same oracle method used by logRound, with a fixed baseline build record.
const oracle = await service.oracleCheck('review', {
  id: 'review-campaign',
  frame: {
    oracleScope: ['README'],
    subject: { type: 'harness', id: 'fixture', baselineVersion: '1' },
  },
}, '2', { source: 'everdict-build', repo, sha: candidateSha, prNumber: 1 });
const readme = [];
for (const sha of [baselineSha, candidateSha]) {
  const response = await publicFetch(`https://api.github.com/repos/${repo}/contents/README?ref=${sha}`);
  const file = await response.json();
  readme.push({ commit: sha, blobSha: file.sha, content: Buffer.from(file.content, 'base64').toString('utf8') });
}
const protectedFileActuallyDiffers = readme[0].blobSha !== readme[1].blobSha;
console.log(JSON.stringify({ oracle, readme, protectedFileActuallyDiffers }, null, 2));
if (protectedFileActuallyDiffers && oracle.kind === 'clean') {
  console.error('REPRODUCED: protected README differs between the evaluated commits, but the production oracle returned clean.');
  process.exitCode = 1;
}
JS
```
