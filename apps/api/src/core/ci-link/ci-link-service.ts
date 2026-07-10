// CiLinkService now lives in @everdict/application-control — re-architecture P2d compat
// re-export (removed in the P4 sweep). New code should import @everdict/application-control directly.
export {
  CiLinkService,
  type CiLinkServiceDeps,
  type GithubAppRepoAccess,
  renderCiWorkflow,
  type RepoInfo,
  type UpsertCiLinkBody,
  UpsertCiLinkBodySchema,
  type WorkspaceRunnerRoster,
} from "@everdict/application-control";
