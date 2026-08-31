import { BadRequestError } from "../errors.js";

// ── WHERE WE ARE WILLING TO DIAL, DECIDED ONCE (arch-review 124) ─────────────────────────────────────
//
// The control plane sits inside a network its callers do not: cluster APIs, the metadata service, the
// database. Any field where a caller or a producer names a destination and the platform dials it is
// server-side request forgery in its plainest form — `http://169.254.169.254/…` is not a webhook, it is a
// credential read.
//
// This lived as two helpers INSIDE the run-webhook consumer. They were exported from that package's index,
// which is the tell: they were meant to be shared and nothing shared them. Three other lanes dial a
// caller-named URL — the subscription webhook reaction, a judge resolving http(s) artifacts out of a pushed
// trace, and the OAuth refresh-token grant — and each reached `fetch` directly. A safety decision that every
// new lane must REMEMBER to import is a convention; the same decision in the place every lane already
// imports is a choke point.
//
// It lives in contracts because it passes that admission test: no I/O (the resolver is injected), no store,
// no workspace policy, a total decision, and a consumer beneath the domain cone — `@everdict/trace` resolves
// producer-named artifact URLs and cannot depend on application-control's consumers.

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal)$/i;
const PRIVATE_IPV4 =
  /^(10\.|127\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.)/;

// Is this ADDRESS one we refuse to dial? The literal-hostname check and the resolved-address check ask the
// same question of different answers, which is the point: a name is not a destination.
export function isPrivateAddress(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    PRIVATE_HOST.test(bare) ||
    PRIVATE_IPV4.test(bare) ||
    bare === "::1" ||
    bare.startsWith("fc") ||
    bare.startsWith("fd") ||
    bare.startsWith("fe80")
  );
}

// What a lane is willing to accept. Both fields are opt-IN and named, because the two legitimate exceptions
// are real and must be a DECISION rather than a default:
//
//   · `allowPrivateHosts` — a single-tenant install whose callbacks genuinely stay inside its own network.
//   · `allowHttp` — a producer-named artifact URL in a pulled trace, where the tenant's own observability
//     platform may be plain http on a private network. That lane pairs it with `allowPrivateHosts`; a lane
//     that allows http and NOT private hosts is still refusing the addresses that matter.
export interface OutboundPolicy {
  allowPrivateHosts?: boolean;
  allowHttp?: boolean;
}

// The literal check: a scheme we speak, and a name that is not obviously ours. `lane` names the caller in the
// refusal, because an operator reading "points at a private address" needs to know WHICH destination was
// refused — the same reason `refuseUnenforceableNetwork` carries one.
export function refuseUnsafeOutboundUrl(raw: string, lane: string, policy: OutboundPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BadRequestError("BAD_REQUEST", { lane, url: raw }, `${lane} destination '${raw}' is not a URL`);
  }
  const schemes = policy.allowHttp === true ? ["https:", "http:"] : ["https:"];
  if (!schemes.includes(url.protocol))
    throw new BadRequestError(
      "BAD_REQUEST",
      { lane, url: raw, protocol: url.protocol },
      `${lane} destination '${raw}' is not ${schemes.join(" or ")}`,
    );
  if (policy.allowPrivateHosts === true) return url;
  if (isPrivateAddress(url.hostname))
    throw new BadRequestError(
      "BAD_REQUEST",
      { lane, url: raw },
      `${lane} destination '${raw}' points at a private address`,
    );
  return url;
}

// ── …AND WHERE THE NAME ACTUALLY GOES (arch-review 36/37 P1, security) ──────────────────────────────
//
// The literal check reads the hostname the caller wrote, and a hostname is not a destination:
// `https://hook.attacker.example/` resolves to whatever its owner's DNS says, including `169.254.169.254`.
// So the name is resolved and the ADDRESSES are judged before anything is dialled.
//
// WHAT THIS DELIBERATELY DOES NOT DO: put the resolved IP into the URL. That version looked like pinning and
// was a broken request — TLS verifies the certificate against the host in the URL, and the HTTP `Host` header
// is sent AFTER the handshake, so it cannot stand in for SNI. Every ordinary callback (a certificate for
// `hooks.example.com`, dialled as `https://93.184.216.34/`) would have failed verification or gone out
// without SNI. A security control that breaks the feature it protects is not a control; it is an outage with
// a rationale.
//
// So the URL keeps its name and the residual is stated instead of papered over: between this check and the
// connection, the name could answer differently (DNS rebinding). Closing THAT needs the connection itself to
// use the verified address — a custom dispatcher whose lookup returns only addresses this check approved,
// with the TLS servername left as the hostname — which is a transport-layer change and belongs with the
// outbound-proxy work rather than inside any one caller.
export async function assertPublicOutboundTarget(
  url: URL,
  lane: string,
  lookup: (host: string) => Promise<string[]>,
): Promise<URL> {
  const addresses = await lookup(url.hostname);
  if (addresses.length === 0)
    throw new BadRequestError(
      "BAD_REQUEST",
      { lane, url: url.href },
      `${lane} destination '${url.href}' resolves to nothing`,
    );
  const offender = addresses.find((address) => isPrivateAddress(address));
  if (offender !== undefined)
    throw new BadRequestError(
      "BAD_REQUEST",
      { lane, url: url.href, address: offender },
      `${lane} destination '${url.href}' resolves to the private address ${offender}`,
    );
  return url;
}
