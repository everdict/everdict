// Principal/AuthContext (the identity subject shape) live in @everdict/domain; @everdict/auth re-exports them
// here beside the Authenticator port + its composition as a deliberate convenience (identity + auth together).
export type { AuthContext, Principal } from "@everdict/domain";
import type { AuthContext, Principal } from "@everdict/domain";

// Bearer credential → Principal. Handles both JWT (human/Keycloak) and API key (agent/MCP/CI).
export interface Authenticator {
  authenticate(bearer: string, ctx?: AuthContext): Promise<Principal | undefined>;
}

// Tries multiple authenticators in order, returns the first success.
export function compositeAuthenticator(authenticators: Authenticator[]): Authenticator {
  return {
    async authenticate(bearer, ctx) {
      for (const a of authenticators) {
        const p = await a.authenticate(bearer, ctx);
        if (p) return p;
      }
      return undefined;
    },
  };
}
