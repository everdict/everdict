// GithubAppService now lives in @everdict/application-control — re-architecture P2d compat
// re-export (removed in the P4 sweep). New code should import @everdict/application-control directly.
export {
  type GithubAppDetailView,
  GithubAppService,
  type GithubAppServiceConfig,
  type GithubAppServiceDeps,
  type GithubAppView,
  type GithubComAppConfig,
  type InstallationRepo,
  type InstallationWithRepos,
  type ServedRegistration,
  type StartInstallInput,
} from "@everdict/application-control";
