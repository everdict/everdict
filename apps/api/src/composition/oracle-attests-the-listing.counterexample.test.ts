import type { GithubAppService } from "@everdict/application-control";
import { describe, expect, it } from "vitest";
import { oracleChanges } from "./oracle-changes.js";

// ── THE ORACLE'S ATTESTATION WAS THE REQUEST, ECHOED (review of the follow-up batch) ─────────────────
//
// `CampaignService.oracleCheck` refuses a round whose listing does not describe the two commits the arms were
// BUILT from — `read.value.baselineSha !== baseline.sha`. The composition satisfying that read returned
// `{ …, ...commits }`: its own argument, spread into its own result. The comparison was therefore a value
// against itself and could not fail, in either direction, for any input. Nothing downstream was wrong — both
// shas come from the build ledger since R1 — but a guard that cannot fail is a guard that would not notice its
// premise being removed, which is the whole reason the check exists.
//
// The attested commits are read from the LISTING now (rule `protocol` L3 — provenance is born at the source),
// and a remote that does not say leaves the round unverifiable rather than attested by its own request.
const REQUESTED = { baselineSha: "a".repeat(40), candidateSha: "b".repeat(40) };
const COMPARED = {
  baselineSha: "c".repeat(40),
  candidateSha: "d".repeat(40),
  mergeBaseSha: "e".repeat(40),
  pathsCover: "fork-union" as const,
};

const appService = (listing: Record<string, unknown>): GithubAppService =>
  ({
    listPullRequestChanges: async () => listing,
  }) as unknown as GithubAppService;

describe("the oracle listing attests what GitHub compared", () => {
  it("reports the commits the LISTING names, never the ones it was asked about", async () => {
    const read = await oracleChanges(
      appService({ files: [{ filename: "src/a.ts" }], truncated: false, compared: COMPARED }),
    ).pullRequestFiles("acme", "acme/repo", 7, REQUESTED);
    expect(read.kind).toBe("read");
    if (read.kind !== "read") throw new Error("unreachable");
    // The counterexample. Before the repair these were REQUESTED's shas, whatever the remote had said.
    expect(read.value.baselineSha).toBe(COMPARED.baselineSha);
    expect(read.value.candidateSha).toBe(COMPARED.candidateSha);
    // Where the comparison STARTED travels too — naming both commits is not covering the difference between
    // them, and the consumer refuses a listing that began somewhere else (review 2026-09-10 R1).
    expect(read.value.mergeBaseSha).toBe(COMPARED.mergeBaseSha);
    // …and WHAT those paths cover, which is the claim the oracle actually decides on.
    expect(read.value.pathsCover).toBe(COMPARED.pathsCover);
    expect(read.value.paths).toEqual(["src/a.ts"]);
  });

  it("attests nothing when the remote said nothing, so the oracle refuses instead of believing itself", async () => {
    const read = await oracleChanges(
      appService({ files: [{ filename: "src/a.ts" }], truncated: false }),
    ).pullRequestFiles("acme", "acme/repo", 7, REQUESTED);
    expect(read.kind).toBe("read");
    if (read.kind !== "read") throw new Error("unreachable");
    // Absent, not the request. `oracleCheck` then answers `unverifiable` — the fail-closed direction.
    expect(read.value.baselineSha).toBeUndefined();
    expect(read.value.candidateSha).toBeUndefined();
    expect(read.value.mergeBaseSha).toBeUndefined();
    expect(read.value.pathsCover).toBeUndefined();
  });

  it("answers UNKNOWN with the reason on a deployment with no GitHub App, never an empty listing", async () => {
    const read = await oracleChanges(undefined).pullRequestFiles("acme", "acme/repo", 7, REQUESTED);
    expect(read.kind).toBe("unknown");
  });
});
