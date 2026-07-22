import { ForbiddenError, UnauthenticatedError, UpstreamError } from "@everdict/contracts";
import { z } from "zod";

export interface Principal {
  subject: string;
  workspace: string;
  roles: string[];
}

// The headers apps/agent forwards to the control plane on the caller's behalf: the bearer (Keycloak JWT or ak_
// key) plus the active-workspace / dev-tenant selectors the web already sets.
export interface ForwardHeaders {
  authorization?: string;
  workspace?: string;
  tenant?: string;
}

export type Authenticate = (headers: ForwardHeaders) => Promise<Principal>;

const MeResponseSchema = z.object({
  subject: z.string(),
  workspace: z.string(),
  roles: z.array(z.string()).default([]),
});

// Render the forward headers into a plain record for a fetch / MCP transport (bearer + workspace/tenant selectors).
export function forwardHeaderRecord(h: ForwardHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  if (h.authorization) out.authorization = h.authorization;
  if (h.workspace) out["x-everdict-workspace"] = h.workspace;
  if (h.tenant) out["x-everdict-tenant"] = h.tenant;
  return out;
}

// Authenticate by forwarding the caller's headers to the control plane's GET /me, which already resolves identity,
// membership, and the active workspace. apps/agent stays a pure token courier — no JWKS/OIDC or key store of its own.
export function meAuthenticate(controlPlaneUrl: string, fetchImpl: typeof fetch = fetch): Authenticate {
  const base = controlPlaneUrl.replace(/\/$/, "");
  return async (headers) => {
    let res: Response;
    try {
      res = await fetchImpl(`${base}/me`, { headers: forwardHeaderRecord(headers) });
    } catch (err) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { detail: err instanceof Error ? err.message : String(err) },
        "The control plane is unreachable.",
      );
    }
    if (res.status === 401) throw new UnauthenticatedError("UNAUTHENTICATED");
    if (!res.ok) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status },
        "The control plane rejected the identity lookup.",
      );
    }
    const parsed = MeResponseSchema.parse(await res.json());
    if (parsed.workspace.length === 0) {
      throw new ForbiddenError("FORBIDDEN", undefined, "No active workspace — create or select a workspace first.");
    }
    return { subject: parsed.subject, workspace: parsed.workspace, roles: parsed.roles };
  };
}
