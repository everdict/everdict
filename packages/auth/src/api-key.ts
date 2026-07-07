import { type TenantKeyStore, hashKey } from "@everdict/db";
import type { Authenticator } from "./principal.js";

export interface ApiKeyAuthOptions {
  keyStore: TenantKeyStore;
  roles?: string[]; // key = operator-issued workspace machine credential → default full permissions (admin)
}

// API key (ak_) authenticator — for agents/MCP/CI. key hash → workspace (tenant) + issuer (owner) + per-key scope.
// Personal key (owner = issuer subject): resolved as the issuer → applyActiveWorkspace grants that person's membership role
//   (member key = member permissions, not a blanket admin). A non-member falls back to viewer (no privilege escalation).
// Machine key (owner = ""; legacy/internal issuance): keeps the old workspace machine credential (roles default = admin).
// If scopes are present, they're carried onto the Principal so authz can() further narrows the key by intersecting with role permissions (legacy/unset = unlimited).
export function apiKeyAuthenticator(opts: ApiKeyAuthOptions): Authenticator {
  const roles = opts.roles ?? ["admin"];
  return {
    async authenticate(bearer) {
      if (!bearer.startsWith("ak_")) return undefined;
      const resolved = await opts.keyStore.resolveByHash(hashKey(bearer));
      if (!resolved) return undefined;
      const { tenant: workspace, owner, scopes } = resolved;
      if (owner) return { subject: owner, workspace, roles: ["viewer"], via: "api-key", scopes };
      return { subject: `key:${workspace}`, workspace, roles, via: "api-key", scopes };
    },
  };
}
