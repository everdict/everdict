import { createPrivateKey, createPublicKey } from "node:crypto";
import { BadRequestError, UnauthenticatedError, UpstreamError } from "@everdict/contracts";
import { SignJWT, jwtVerify } from "jose";

// The authorization server for the managed image registry. This is where the workspace boundary is ENFORCED:
// the registry itself holds no user database — it trusts tokens signed by this key and honors exactly the access
// they carry, so a token for another workspace's namespace is not "rejected", it is never minted.
// Design: docs/architecture/managed-image-store.md

// One entry of a Docker Registry v2 token's `access` claim.
//
// `type` is not always "repository": distribution guards the registry-WIDE `_catalog` endpoint with the
// `registry:catalog:*` scope, and a repository-scoped token — however broad its name pattern — is refused there
// with a 401. Listing a namespace therefore needs this second resource type. It is only ever minted for the
// control plane's own calls (`mintRegistryToken`); a user GRANT carries repository entries exclusively, and
// `narrowAccess` intersects, so no exchange can turn a grant into catalog access.
// `delete` is likewise its own action in the v2 spec, not a flavour of `push`: distribution refuses a pull+push
// token at manifest DELETE. Both extra members exist because a real registry said so — the fake registry the unit
// tests hand the adapter accepts whatever we pass, so neither gap could surface before a live push/delete.
export interface RegistryAccess {
  type: "repository" | "registry";
  name: string; // "<namespace>/<repo>", or "catalog" for the registry-wide listing
  actions: Array<"pull" | "push" | "delete" | "*">;
}

// The grant token's audience — a grant is NOT a registry token: docker presents it as the password in the
// registry's auth handshake, and the token endpoint exchanges it for the scoped registry token below.
// Keeping the two audiences distinct is what stops a grant from being replayed straight at the registry.
export const GRANT_AUDIENCE = "everdict-image-grant";

export interface RegistryTokenIssuerOptions {
  // Signing key (PEM, PKCS#8) and the matching certificate (PEM). The registry is configured with the same
  // certificate as its `rootcertbundle`; the registry token carries it in the JWT `x5c` header, which is how
  // distribution verifies the signature without any shared secret.
  privateKeyPem: string;
  certificatePem: string;
  issuer: string; // the `iss` claim the registry is configured to require
  service: string; // the registry's `service` name — the registry token's audience
  grantTtlSeconds?: number; // default 900 — grants are short-lived so revoked reach stops working promptly
  registryTokenTtlSeconds?: number; // default 300 — the registry token lives only for one client exchange
  now?: () => number; // injectable clock (tests)
}

// The `x5c` header value: the certificate's DER bytes, base64 (NOT PEM, and no line breaks) — the JOSE encoding
// distribution expects. Derived from the configured PEM so the operator supplies one file, not two encodings.
// Only the ENCODING is checked here; whether the certificate actually chains to the registry's rootcertbundle is
// the registry's verdict, and it is the one that matters. The check that pays for itself is the misconfiguration
// people actually make — pasting the private key into the certificate slot.
function certificateChain(certificatePem: string): string[] {
  if (!/-----BEGIN CERTIFICATE-----/.test(certificatePem))
    throw new BadRequestError(
      "BAD_REQUEST",
      undefined,
      certificatePem.includes("PRIVATE KEY")
        ? "the image-registry certificate slot holds a PRIVATE KEY — it wants the certificate (the registry's rootcertbundle), not the signing key"
        : "the image-registry certificate is not a PEM certificate (expected a -----BEGIN CERTIFICATE----- block)",
    );
  const body = certificatePem
    .replace(/-----BEGIN CERTIFICATE-----/g, "")
    .replace(/-----END CERTIFICATE-----/g, "")
    .replace(/\s+/g, "");
  if (!body) throw new BadRequestError("BAD_REQUEST", undefined, "the registry certificate PEM is empty");
  return [body];
}

export class RegistryTokenIssuer {
  private readonly privateKey: ReturnType<typeof createPrivateKey>;
  private readonly publicKey: ReturnType<typeof createPublicKey>;
  private readonly chain: string[];
  private readonly now: () => number;

  constructor(private readonly opts: RegistryTokenIssuerOptions) {
    try {
      this.privateKey = createPrivateKey(opts.privateKeyPem);
    } catch (e) {
      throw new BadRequestError(
        "BAD_REQUEST",
        undefined,
        `the image-registry signing key is not a readable PEM private key: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    // Verification uses the PUBLIC half of the same key — a grant we issued is the only grant we accept.
    this.publicKey = createPublicKey(this.privateKey);
    this.chain = certificateChain(opts.certificatePem);
    this.now = opts.now ?? Date.now;
  }

  private seconds(): number {
    return Math.floor(this.now() / 1000);
  }

  // A grant: what the control plane hands a client (CLI push, a dispatched job) as its registry password.
  // It carries the FULL access the caller was authorized for; the exchange below can only narrow it.
  async mintGrant(subject: string, access: RegistryAccess[]): Promise<{ token: string; expiresAt: string }> {
    if (access.length === 0)
      throw new BadRequestError("BAD_REQUEST", undefined, "cannot mint a grant with no repository access");
    const issuedAt = this.seconds();
    const expires = issuedAt + (this.opts.grantTtlSeconds ?? 900);
    const token = await new SignJWT({ access })
      .setProtectedHeader({ alg: "RS256", typ: "JWT" })
      .setIssuer(this.opts.issuer)
      .setAudience(GRANT_AUDIENCE)
      .setSubject(subject)
      .setIssuedAt(issuedAt)
      .setExpirationTime(expires)
      .sign(this.privateKey);
    return { token, expiresAt: new Date(expires * 1000).toISOString() };
  }

  // Verify a grant presented at the token endpoint. An expired/foreign/tampered grant is 401 — never a partial
  // acceptance, because the access list is the only thing standing between two workspaces' namespaces.
  async verifyGrant(token: string): Promise<{ subject: string; access: RegistryAccess[] }> {
    try {
      const { payload } = await jwtVerify(token, this.publicKey, {
        issuer: this.opts.issuer,
        audience: GRANT_AUDIENCE,
        currentDate: new Date(this.now()),
      });
      const access = payload.access;
      if (!Array.isArray(access) || !payload.sub)
        throw new UnauthenticatedError("UNAUTHENTICATED", undefined, "the image grant carries no access");
      return { subject: payload.sub, access: access as RegistryAccess[] };
    } catch (e) {
      if (e instanceof UnauthenticatedError) throw e;
      throw new UnauthenticatedError(
        "UNAUTHENTICATED",
        undefined,
        `the image grant is not valid: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // The registry-facing token — audience = the registry service, `x5c` = our certificate. This is the only token
  // the registry ever sees, and it authorizes exactly the access passed here (already narrowed by the caller).
  async mintRegistryToken(subject: string, access: RegistryAccess[]): Promise<string> {
    const issuedAt = this.seconds();
    try {
      return await new SignJWT({ access })
        .setProtectedHeader({ alg: "RS256", typ: "JWT", x5c: this.chain })
        .setIssuer(this.opts.issuer)
        .setAudience(this.opts.service)
        .setSubject(subject)
        .setIssuedAt(issuedAt)
        .setNotBefore(issuedAt - 5) // small skew allowance: the registry rejects a token whose nbf is in its future
        .setExpirationTime(issuedAt + (this.opts.registryTokenTtlSeconds ?? 300))
        .sign(this.privateKey);
    } catch (e) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        undefined,
        `could not sign the registry token: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

// Narrow a granted access list to what the client actually asked for. The registry's auth handshake sends the
// scope it needs; we answer with the INTERSECTION, so a grant covering three repositories never yields a token
// broader than the one operation in flight, and a scope outside the grant simply produces no access (the
// registry then answers 401/403 itself — we never invent authorization the grant did not carry).
export function narrowAccess(granted: RegistryAccess[], requested: RegistryAccess[]): RegistryAccess[] {
  const out: RegistryAccess[] = [];
  for (const want of requested) {
    const have = granted.find((g) => g.type === want.type && g.name === want.name);
    if (!have) continue;
    const actions = want.actions.filter((a) => have.actions.includes(a));
    if (actions.length > 0) out.push({ type: want.type, name: want.name, actions });
  }
  return out;
}

// Parse the registry's `scope` query parameter ("repository:ns/name:pull,push", repeatable). Unknown resource
// types are dropped rather than rejected: distribution asks for `registry:catalog:*` on some flows, and refusing
// the whole request over an entry we simply do not grant would break the exchange for the entries we do.
export function parseScopes(scopes: string[]): RegistryAccess[] {
  const out: RegistryAccess[] = [];
  for (const scope of scopes) {
    const parts = scope.split(":");
    if (parts.length < 3) continue;
    const [type, name, actionList] = [parts[0], parts.slice(1, -1).join(":"), parts[parts.length - 1]];
    if (type !== "repository" || !name || !actionList) continue;
    const actions = actionList.split(",").filter((a): a is "pull" | "push" => a === "pull" || a === "push");
    if (actions.length > 0) out.push({ type: "repository", name, actions });
  }
  return out;
}
