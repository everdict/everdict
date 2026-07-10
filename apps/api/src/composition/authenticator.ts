import {
  type Authenticator,
  apiKeyAuthenticator,
  compositeAuthenticator,
  githubActionsAuthenticator,
  oidcAuthenticator,
  runnerAuthenticator,
} from "@everdict/auth";
import type { RunnerStore, TenantKeyStore, WorkspaceSettingsStore } from "@everdict/db";

// Auth owned by the control plane: KEYCLOAK_ISSUER → OIDC(JWT) + always API keys. Both resolve to a workspace.
export function buildAuthenticator(
  keyStore: TenantKeyStore,
  runnerStore: RunnerStore,
  settingsStore: WorkspaceSettingsStore,
): Authenticator {
  const authers: Authenticator[] = [];
  // GitHub Actions OIDC federation — keyless CI. It pre-checks the issuer and silently passes Keycloak/other JWTs, so
  // put it before the OIDC(Keycloak) authenticator (reversed, a CI token would leave a Keycloak-verification-failed warn log).
  // Trust = a repo-link match (WorkspaceSettings.ci.links) in the named workspace (x-everdict-workspace) → roles=["ci"].
  // GHES supported too: only dynamically trust the issuer (https://<host>/_services/token) of a host that has a GHE link (fail-closed);
  // link matching is (host, repository) — a github.com token cannot pass a same-named GHE link (or vice versa).
  const normHost = (h?: string): string | undefined => h?.replace(/\/$/, "").toLowerCase();
  authers.push(
    githubActionsAuthenticator({
      resolveTrust: async (claims, workspaceHint) => {
        const settings = await settingsStore.get(workspaceHint);
        const link = settings?.ci?.links.find(
          (l) =>
            !l.disabled &&
            normHost(l.host) === normHost(claims.host) &&
            l.repository.toLowerCase() === claims.repository.toLowerCase(),
        );
        return link ? { workspace: workspaceHint, roles: ["ci"] } : undefined;
      },
      enterprise: {
        // Hosts this workspace has trusted via a GHE link — only GHES tokens from those issuers become verification candidates.
        hostsFor: async (workspaceHint) => {
          const settings = await settingsStore.get(workspaceHint);
          const hosts = new Set<string>();
          for (const l of settings?.ci?.links ?? []) if (!l.disabled && l.host) hosts.add(l.host);
          return [...hosts];
        },
      },
    }),
  );
  if (process.env.KEYCLOAK_ISSUER) {
    console.error(`▶ auth: OIDC(JWT) verifier enabled issuer=${process.env.KEYCLOAK_ISSUER}`);
    authers.push(
      oidcAuthenticator({
        issuer: process.env.KEYCLOAK_ISSUER,
        ...(process.env.OIDC_AUDIENCE ? { audience: process.env.OIDC_AUDIENCE } : {}),
        ...(process.env.WORKSPACE_CLAIM ? { workspaceClaim: process.env.WORKSPACE_CLAIM } : {}),
        // Log the reason a JWT failed verification to the control-plane log (401 causes: issuer mismatch / JWKS unreachable / expired / signature / aud).
        onError: (info) =>
          console.warn(
            `▶ auth: OIDC token verification failed [${info.code}] ${info.message} ` +
              `| expectedIssuer=${info.expectedIssuer} tokenIssuer=${info.tokenIssuer ?? "(none)"} ` +
              `tokenAud=${JSON.stringify(info.tokenAudience ?? null)} claims=[${(info.claimKeys ?? []).join(",")}]`,
          ),
      }),
    );
  } else {
    // The most common cause of internal SSO tokens getting 401'd — warn loudly at boot (case: only the web wired SSO, the control plane left unset).
    console.warn(
      "▶ auth: KEYCLOAK_ISSUER unset — OIDC(JWT) verifier disabled (API keys only). Internal SSO access tokens will be 401'd.",
    );
  }
  authers.push(apiKeyAuthenticator({ keyStore }));
  // Self-hosted runner pairing token (rnr_) — `everdict runner` authenticates to MCP. Resolves to owner/workspace/runnerId, least-privilege.
  authers.push(runnerAuthenticator({ runnerStore }));
  return compositeAuthenticator(authers);
}
