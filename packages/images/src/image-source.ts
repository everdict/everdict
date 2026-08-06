import { UpstreamError } from "@everdict/contracts";
import type { RegistryAuth } from "@everdict/contracts";
import type { ImageSource } from "./copy-image.js";

// Read an image from the registry it actually lives in — Docker Hub, GHCR, a workspace's BYO registry, or the
// managed store itself — so a world can be founded on a base the control plane does not already hold.
//
// The auth here is the ordinary v2 dance: a 401 carries a `WWW-Authenticate: Bearer realm=…,service=…,scope=…`
// challenge, and the realm issues a token for that scope (anonymously for a public image, with Basic
// credentials for a private one). This is the same handshake the BYO registry reader performs; it lives again
// here because that reader answers "browse a registry" while this one answers "hand me the bytes", and the
// two would otherwise drag each other's shapes around.

const MANIFEST_ACCEPT = [
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
  "application/vnd.docker.distribution.manifest.v2+json",
].join(", ");

// Docker Hub is addressed by a name (`debian`, `library/debian`) rather than a host, and its API lives on a
// different domain than its friendly name — the one special case every registry client carries.
const DOCKER_HUB_HOSTS = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);

export interface ParsedImageLocation {
  base: string; // the registry's API base URL
  repository: string; // the path within that registry
  reference: string; // tag or digest
}

// An image reference as its registry addresses it. `debian:stable-slim` → Docker Hub's `library/debian`;
// `ghcr.io/acme/app:1` → ghcr.io's `acme/app`. A digest wins over a tag when the ref carries both, because
// that is what actually resolves.
export function parseImageLocation(ref: string): ParsedImageLocation {
  const atDigest = ref.lastIndexOf("@");
  const digest = atDigest !== -1 ? ref.slice(atDigest + 1) : undefined;
  const withoutDigest = atDigest !== -1 ? ref.slice(0, atDigest) : ref;
  const slash = withoutDigest.indexOf("/");
  const head = slash === -1 ? "" : withoutDigest.slice(0, slash);
  // A first segment is a HOST only when it looks like one (a dot, a colon, or literally localhost) — otherwise
  // `acme/app` is a Docker Hub path, not a registry called "acme".
  const isHost = head !== "" && (head.includes(".") || head.includes(":") || head === "localhost");
  const host = isHost ? head : "docker.io";
  const path = isHost ? withoutDigest.slice(slash + 1) : withoutDigest;
  const colon = path.lastIndexOf(":");
  const lastSlash = path.lastIndexOf("/");
  const hasTag = colon > lastSlash;
  let repository = hasTag ? path.slice(0, colon) : path;
  const tag = hasTag ? path.slice(colon + 1) : "latest";
  if (DOCKER_HUB_HOSTS.has(host) && !repository.includes("/")) repository = `library/${repository}`;
  const base = DOCKER_HUB_HOSTS.has(host)
    ? "https://registry-1.docker.io"
    : /^https?:\/\//.test(host)
      ? host.replace(/\/$/, "")
      : host.startsWith("localhost") || host.startsWith("127.0.0.1")
        ? `http://${host}` // a local dev registry is plain HTTP; TLS everywhere else
        : `https://${host}`;
  return { base, repository, reference: digest ?? tag };
}

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

// A source for one image reference. `auth` is used only if the registry asks for it.
export function remoteImageSource(ref: string, auth?: RegistryAuth, fetchImpl: typeof fetch = fetch): ImageSource {
  const { base, repository, reference } = parseImageLocation(ref);
  let bearer: string | undefined;

  const call = async (path: string, accept?: string): Promise<Response> => {
    const url = `${base}/v2/${repository}/${path}`;
    const headers = (): Record<string, string> => ({
      ...(accept ? { accept } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
    });
    let res: Response;
    try {
      res = await fetchImpl(url, { headers: headers() });
    } catch (e) {
      throw new UpstreamError(
        "UPSTREAM_ERROR",
        { image: ref },
        `the base image's registry is unreachable: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    if (res.status !== 401) return res;
    // One challenge round: get a token for exactly this repository's pull scope, then retry.
    const challenge = parseChallenge(res.headers.get("www-authenticate") ?? "");
    if (!challenge) return res;
    const tokenUrl = new URL(challenge.realm);
    if (challenge.service) tokenUrl.searchParams.set("service", challenge.service);
    tokenUrl.searchParams.set("scope", challenge.scope ?? `repository:${repository}:pull`);
    const tokenRes = await fetchImpl(tokenUrl.toString(), {
      headers: auth
        ? { authorization: `Basic ${Buffer.from(`${auth.username ?? ""}:${auth.password}`).toString("base64")}` }
        : {},
    });
    if (!tokenRes.ok) return res; // the original 401 is the honest answer
    const token = (await tokenRes.json()) as { token?: string; access_token?: string };
    bearer = token.token ?? token.access_token;
    return fetchImpl(url, { headers: headers() });
  };

  return {
    async manifest(reference_) {
      const res = await call(`manifests/${reference_ === "" ? reference : reference_}`, MANIFEST_ACCEPT);
      if (res.status === 404) return undefined;
      if (!res.ok)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { image: ref, status: res.status },
          `the base image's registry refused its manifest (${res.status})`,
        );
      return { body: await res.json(), mediaType: res.headers.get("content-type") ?? MANIFEST_ACCEPT };
    },
    async blob(digest) {
      const res = await call(`blobs/${digest}`);
      if (res.status === 404) return undefined;
      if (!res.ok)
        throw new UpstreamError(
          "UPSTREAM_ERROR",
          { image: ref, digest, status: res.status },
          `the base image's registry refused blob ${digest} (${res.status})`,
        );
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

// The reference this source resolves — the manifest call with an empty argument reads it.
export function sourceReferenceOf(ref: string): string {
  return parseImageLocation(ref).reference;
}
