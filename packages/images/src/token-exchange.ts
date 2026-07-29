import { UnauthenticatedError } from "@everdict/contracts";
import { type RegistryAccess, type RegistryTokenIssuer, narrowAccess, parseScopes } from "./token-issuer.js";

// The Docker Registry v2 token endpoint's business logic — the control plane acting as the managed registry's
// authorization server. It lives in this package, not in apps/api: nothing here knows about HTTP frameworks or
// the control plane's Principal chain, and keeping it beside the issuer lets the live registry check exercise the
// real exchange instead of a re-implementation. The registry holds no user database: it challenges a client with our realm, the client
// comes here with its grant, and we answer with a token scoped to exactly what that grant covers.
// Design: docs/architecture/managed-image-store.md

export interface ImageTokenExchange {
  token: string;
  expiresIn: number; // seconds — what the docker client uses to decide when to re-exchange
  issuedAt: string;
  access: RegistryAccess[]; // what was actually authorized (for logging/tests; the token is the authority)
}

export interface ImageTokenServiceDeps {
  issuer: RegistryTokenIssuer;
  service: string; // the registry's configured `service` — the audience the registry will accept
  tokenTtlSeconds?: number; // must match the issuer's registry-token TTL (reported to the client)
}

export class ImageTokenService {
  constructor(private readonly deps: ImageTokenServiceDeps) {}

  // Exchange a grant for a registry token. `credential` is the password from the client's basic auth (the grant);
  // `scopes` are the raw `scope` query values the registry told the client to ask for.
  //
  // Three deliberate behaviors:
  // - No credential is 401, never an anonymous token: this registry is private, and answering an unauthenticated
  //   request with a usable token is the one mistake that would make every namespace world-readable.
  // - A VALID grant with NO scope succeeds with an empty access list — that is `docker login`, which asks for a
  //   token before it knows what it wants. Refusing it would make login fail for a client that is authorized.
  // - A scope the grant does not cover is silently dropped rather than rejected (narrowAccess). The registry then
  //   answers 401/403 for that operation itself, which is the correct authority — we never invent access, and we
  //   never fail an exchange whose other scopes are legitimate.
  async exchange(input: {
    credential?: string;
    scopes: string[];
    service?: string;
  }): Promise<ImageTokenExchange> {
    if (input.service && input.service !== this.deps.service)
      throw new UnauthenticatedError(
        "UNAUTHENTICATED",
        { service: input.service },
        `this authorization server does not issue tokens for "${input.service}"`,
      );
    if (!input.credential)
      throw new UnauthenticatedError("UNAUTHENTICATED", undefined, "the image registry requires a grant");
    const grant = await this.deps.issuer.verifyGrant(input.credential);
    const access = narrowAccess(grant.access, parseScopes(input.scopes));
    const token = await this.deps.issuer.mintRegistryToken(grant.subject, access);
    return {
      token,
      expiresIn: this.deps.tokenTtlSeconds ?? 300,
      issuedAt: new Date().toISOString(),
      access,
    };
  }
}

// The grant out of an `Authorization: Basic <base64(user:pass)>` header. The username is ignored: docker sends
// whatever the client's config holds, and the password IS the grant (a bearer in a password field). A malformed
// header yields undefined, which the service turns into a 401.
export function grantFromBasicAuth(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const [scheme, value] = header.split(" ");
  if (!value || scheme?.toLowerCase() !== "basic") return undefined;
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 0) return undefined;
  const password = decoded.slice(separator + 1);
  return password.length > 0 ? password : undefined;
}

// The `scope` query parameter, which the registry may repeat. Fastify gives a string, an array, or nothing.
export function scopeValues(scope: unknown): string[] {
  if (typeof scope === "string") return [scope];
  if (Array.isArray(scope)) return scope.filter((s): s is string => typeof s === "string");
  return [];
}
