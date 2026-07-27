import type { ImageManifestInfo, RegistryReader } from "@everdict/application-control";
import { type ImageRegistryCoordinates, type RegistryAuth, UpstreamError } from "@everdict/contracts";

// The fetch-backed Docker Registry HTTP API v2 read adapter — owns the base URL, the bearer/basic token-auth handshake
// (401 → WWW-Authenticate Bearer challenge → fetch a token from the realm with Basic creds → retry; basic-auth direct
// fallback), and media-type negotiation. A transport/non-2xx failure is remapped to UpstreamError (never a raw error).
// Covers standard bearer/basic registries (GHCR, Harbor, Docker Hub, GAR, generic v2); AWS ECR (SigV4) is out of scope.

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

// A registry host → https base (registries are TLS; a host may already carry a scheme in rare self-hosted setups).
function baseUrl(host: string): string {
  const h = host.replace(/\/$/, "");
  return /^https?:\/\//.test(h) ? h : `https://${h}`;
}

function basicHeader(auth: RegistryAuth): string {
  return `Basic ${Buffer.from(`${auth.username ?? ""}:${auth.password}`).toString("base64")}`;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// Parse a `WWW-Authenticate: Bearer realm="…",service="…",scope="…"` challenge.
function parseChallenge(header: string): { realm: string; service?: string; scope?: string } | undefined {
  const m = /Bearer\s+(.*)/i.exec(header);
  if (!m?.[1]) return undefined;
  const params: Record<string, string> = {};
  for (const part of m[1].split(",")) {
    const kv = /([a-z]+)="([^"]*)"/i.exec(part.trim());
    if (kv?.[1] && kv[2] !== undefined) params[kv[1].toLowerCase()] = kv[2];
  }
  return params.realm
    ? {
        realm: params.realm,
        ...(params.service ? { service: params.service } : {}),
        ...(params.scope ? { scope: params.scope } : {}),
      }
    : undefined;
}

export function dockerRegistryReader(fetchImpl?: typeof fetch): RegistryReader {
  // fetch is resolved at operation time (not factory-creation), so a test's vi.stubGlobal("fetch") is honored.
  const safeFetch = async (url: string, init: RequestInit): Promise<Response> => {
    const doFetch = fetchImpl ?? fetch;
    try {
      return await doFetch(url, init);
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      throw new UpstreamError("UPSTREAM_ERROR", { detail }, `Could not reach the image registry: ${detail}`);
    }
  };

  // Exchange the Bearer challenge for a token (Basic creds when present). undefined → couldn't obtain one (caller falls back / fails).
  const fetchToken = async (
    challenge: { realm: string; service?: string; scope?: string },
    auth: RegistryAuth | undefined,
  ): Promise<string | undefined> => {
    const u = new URL(challenge.realm);
    if (challenge.service) u.searchParams.set("service", challenge.service);
    if (challenge.scope) u.searchParams.set("scope", challenge.scope);
    const res = await safeFetch(u.toString(), { headers: auth ? { authorization: basicHeader(auth) } : {} });
    if (!res.ok) return undefined;
    const body: unknown = await res.json().catch(() => ({}));
    if (!isRecord(body)) return undefined;
    if (typeof body.token === "string") return body.token;
    if (typeof body.access_token === "string") return body.access_token;
    return undefined;
  };

  // One v2 GET with the token-auth handshake.
  const v2Get = async (
    coords: ImageRegistryCoordinates,
    auth: RegistryAuth | undefined,
    path: string,
    accept: string | undefined,
  ): Promise<Response> => {
    const url = `${baseUrl(coords.host)}/v2/${path}`;
    const base: Record<string, string> = accept ? { accept } : {};
    let res = await safeFetch(url, { headers: base });
    if (res.status === 401) {
      const challenge = parseChallenge(res.headers.get("www-authenticate") ?? "");
      if (challenge) {
        const token = await fetchToken(challenge, auth);
        if (token) res = await safeFetch(url, { headers: { ...base, authorization: `Bearer ${token}` } });
      } else if (auth) {
        res = await safeFetch(url, { headers: { ...base, authorization: basicHeader(auth) } });
      }
    }
    if (!res.ok)
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { status: res.status, host: coords.host },
        `Image registry request failed (HTTP ${res.status}) for ${path}.`,
      );
    return res;
  };

  return {
    async listTags(coords, auth, repository) {
      const body: unknown = await (await v2Get(coords, auth, `${repository}/tags/list`, undefined))
        .json()
        .catch(() => ({}));
      const tags = isRecord(body) ? body.tags : undefined;
      return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === "string") : [];
    },
    async inspectManifest(coords, auth, repository, reference): Promise<ImageManifestInfo> {
      const res = await v2Get(coords, auth, `${repository}/manifests/${reference}`, MANIFEST_ACCEPT);
      const digest = res.headers.get("docker-content-digest") ?? undefined;
      const mediaType = res.headers.get("content-type") ?? undefined;
      const body: unknown = await res.json().catch(() => ({}));
      const rec = isRecord(body) ? body : {};
      const platforms = Array.isArray(rec.manifests)
        ? rec.manifests
            .map((m) => {
              const p = isRecord(m) && isRecord(m.platform) ? m.platform : undefined;
              return p
                ? `${typeof p.os === "string" ? p.os : ""}/${typeof p.architecture === "string" ? p.architecture : ""}`
                : undefined;
            })
            .filter((x): x is string => Boolean(x))
        : undefined;
      const layerCount = Array.isArray(rec.layers) ? rec.layers.length : undefined;
      return {
        reference,
        ...(digest ? { digest } : {}),
        ...(mediaType ? { mediaType } : {}),
        ...(platforms && platforms.length > 0 ? { platforms } : {}),
        ...(layerCount !== undefined ? { layerCount } : {}),
      };
    },
  };
}
