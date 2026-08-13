// ── THE NO_PROXY GRAMMAR IS OURS TO STATE ────────────────────────────────────────────────────────────
//
// The outbound-proxy dispatcher inherited its matching from undici, which honours exact hostnames and dot
// suffixes and nothing else. Operators also write CIDR (`10.0.0.0/8`) and bare prefixes (`10.`,
// `192.168.`) — both conventional, both silently ignored — so every internal host tunnelled through the
// corporate proxy while the operator's file said otherwise.
//
// It is not cosmetic. A 75 KB span upload to an internal MLflow sat in a proxy for 120s and was dropped
// while SMALL requests to the same host succeeded: the export reported healthy and produced traces with no
// spans. Silence shaped like success, which is the failure mode this platform spends its effort refusing.
//
// Inheriting a dependency's narrower dialect also means the accepted grammar is undocumented, unversioned,
// and free to change on a patch bump. So it is stated here: pure, total, no I/O, consumed below the domain
// cone by every process that installs a dispatcher — the admission test for this package.
//
// Entries are comma- or whitespace-separated. `*` matches everything. An entry that cannot be parsed matches
// NOTHING — a typo must not quietly widen the bypass into "send this to the proxy" or "send nothing".

export function shouldBypassProxy(host: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const target = normalizeHost(host);
  if (!target) return false;
  for (const raw of noProxy.split(/[,\s]+/)) {
    const entry = raw.trim();
    if (entry === "") continue;
    if (entry === "*") return true;
    if (matches(target, entry)) return true;
  }
  return false;
}

function normalizeHost(host: string): string {
  // Accept a bare host, host:port, or a URL — a caller holding any of the three should not have to know.
  const trimmed = host.trim().toLowerCase();
  const withoutScheme = trimmed.includes("://") ? (trimmed.split("://")[1] ?? "") : trimmed;
  const authority = withoutScheme.split("/")[0] ?? "";
  // A bracketed literal owns its colons: `[::1]:5000` → `::1`. Only the part after the bracket is a port.
  const bracketed = /^\[([^\]]*)\]/.exec(authority);
  if (bracketed) return bracketed[1] ?? "";
  // Otherwise a single trailing `:digits` is a port, and anything with more colons is a bare IPv6 literal.
  const colons = authority.split(":");
  if (colons.length === 2 && /^\d+$/.test(colons[1] ?? "")) return colons[0] ?? "";
  return authority;
}

function matches(host: string, entry: string): boolean {
  const candidate = entry.toLowerCase().replace(/^\[|\]$/g, "");
  // CIDR — the form undici ignores entirely, and the one an operator reaches for on a private network.
  if (candidate.includes("/")) return matchesCidr(host, candidate);
  // A bare prefix (`10.`, `192.168.`): conventional in curl/Python and unmatched by dot-suffix logic, because
  // an IP has no domain suffix to strip.
  if (candidate.endsWith(".")) return host.startsWith(candidate);
  // Dot-suffix (`.internal`, `internal`) — both spellings mean the same to an operator.
  const suffix = candidate.startsWith(".") ? candidate : `.${candidate}`;
  return host === candidate.replace(/^\./, "") || host.endsWith(suffix);
}

function matchesCidr(host: string, cidr: string): boolean {
  const [network, bitsText] = cidr.split("/");
  // `10.0.0.0/` has an empty width, and `Number("")` is 0 — which would read as `/0`, a bypass of the whole
  // internet from a typo. The width has to be written to count.
  if (!network || !bitsText || !/^\d{1,2}$/.test(bitsText)) return false;
  const bits = Number(bitsText);
  const target = ipv4ToInt(host);
  const base = ipv4ToInt(network);
  // IPv6 CIDR and any malformed entry match nothing: a bypass rule nobody can evaluate must not decide.
  if (target === undefined || base === undefined || !Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  if (bits === 0) return true;
  const mask = bits === 32 ? 0xffffffff : (0xffffffff << (32 - bits)) >>> 0;
  return (target & mask) >>> 0 === (base & mask) >>> 0;
}

function ipv4ToInt(value: string): number | undefined {
  const parts = value.split(".");
  if (parts.length !== 4) return undefined;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return undefined;
    const octet = Number(part);
    if (octet > 255) return undefined;
    out = (out << 8) | octet;
  }
  return out >>> 0;
}
