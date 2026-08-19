---
paths: "packages/sdk/**"
description: "The one-call developer surface over the control plane. Read when adding an SDK method."
---
# SDK rules (push)

`@everdict/sdk` is the one-call surface over the control-plane HTTP API. Design: `docs/architecture/one-call-sdk.md`.

- **A pure HTTP client of the public API — no shortcuts.** It calls the same routes an external user calls,
  with the same auth (`Bearer <jwt|ak_…>`). It never imports a store, a registry or a service: a method that
  needs something the API does not expose is a missing ENDPOINT, not a reason to reach past the door.
- **One call does one thing the user named.** The value of this surface is that `evaluate(...)` is a single
  statement; a method that requires the caller to sequence three others has not been added yet.
- **Errors surface the control plane's own envelope** (`{code, message, data?}`) — never a re-worded string.
  A user debugging a 409 needs the code the API chose.
- Types come from `@everdict/contracts` **type-only** where they exist, so the SDK cannot drift from the wire
  it calls; it pulls no runtime code out of the monorepo into a user's dependency tree.
