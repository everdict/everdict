# Intent: two outbound-credential defects the first unscoped scan found

Author: pnpm scan (scope `contracts`, sonnet, ba700d60) — verified by hand before filing. Status: draft

## Problem

The first run of `pnpm scan` over `packages/contracts/src` — 291 files nobody had touched — returned two
findings. Both were read against the source before this was written, and both hold.

**1. `gitAuthEnv` scopes the credential to nothing** (`packages/contracts/src/execution/git-auth.ts:9`).

The header of that file is a security argument: the token goes into `http.extraheader` through the
environment, never into argv (world-readable through `ps`) and never into `.git/config` (outlives the command,
travels in a world snapshot). Both of those are right. The key it sets is bare:

    GIT_CONFIG_KEY_0: "http.extraheader"

Git applies a bare `http.extraheader` to **every** HTTP(S) request the process makes, not to the repository
host. A clone whose tree carries a `.gitmodules` pointing elsewhere, or a host that answers with a cross-host
30x, therefore sends `Authorization: Bearer <installation-token>` to that other host. The scoped form is
`http.<url>.extraheader`, which git applies only to URLs under that prefix.

The value at stake is a live GitHub App installation token for the workspace's selected repositories.

**2. `isPrivateAddress` classifies an IPv4-mapped IPv6 private address as public**
(`packages/contracts/src/infra/outbound-target.ts:27`).

It lowercases, strips brackets, and then tests dotted-decimal IPv4 patterns plus the literal IPv6 prefixes
`::1`, `fc`, `fd`, `fe80`. `::ffff:169.254.169.254` matches none of them: it is not dotted-decimal at the
start, and it does not begin with those prefixes. The function returns false and the address reads as public.

Both `refuseUnsafeOutboundUrl` (the literal check) and `assertPublicOutboundTarget` (the resolved-address
check) consult this one predicate, so a destination spelled that way passes both — and the address it reaches
is the cloud metadata service.

This is the shape rule `ci` calls a bound composed with an unbounded neighbour: two guards, one predicate, and
the predicate is the unbounded half.

## Proposed outcome

The git credential is presented scoped to the remote it is for, and the private-address predicate normalises
IPv4-mapped IPv6 before testing. Each ships with a regression test that fails on today's code.

## Affected users and systems

`packages/contracts/src/execution/git-auth.ts` and its two consumers (the eval lane's RepoEnvironment, the
session lane's clone/push); `packages/contracts/src/infra/outbound-target.ts` and every lane that dials a
caller-named URL — webhooks, trace artifacts, OAuth.

## Constraints

- `gitAuthEnv` has exactly one authority by design, so the fix goes there and both consumers must keep using
  it; scoping it needs the remote URL, which the signature does not currently take.
- The predicate is consumed by two guards. Changing it changes both, which is the point, and is why the test
  has to cover both call paths rather than the predicate alone.
- Filed by a scan, not accepted by one. `Status: draft` — a person triages this, and the confidence the
  scanner attached to itself is not evidence.

## Open questions

- Are there other spellings the predicate misses (`0x`/octal IPv4, `::ffff:0:169.254.169.254`, a trailing
  dot)? The two found here were found by reading; the class deserves a table.
- Does any lane legitimately need the unscoped header — a mirror, a proxy — or is the scoped form strictly
  better here?
