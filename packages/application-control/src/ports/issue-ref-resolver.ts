import type { IssueRecord } from "@everdict/contracts";

// An issue is addressed by its id OR by the identifier the workspace minted (`ENG-12`), and both spellings
// reach every door. Anything that STORES a reference to an issue therefore has to resolve it first: a record
// keyed by whichever spelling the caller happened to use is a record no join can find, and the join is silent
// — a campaign filed against `ENG-12` simply stops appearing under the issue it was opened for.
//
// `IssueService` satisfies this structurally, so the two stay peers rather than one depending on the other.
export interface IssueRefResolver {
  // Resolves either spelling to the issue, or throws `NotFoundError` if the workspace has no such issue.
  get(tenant: string, ref: string): Promise<IssueRecord>;
}
