---
paths: "packages/otel/**"
description: "The user-facing OTLP door helpers — dependency-free by design. Read before adding anything to @everdict/otel."
---
# `@everdict/otel` rules (push)

This package is for USERS pointing an existing OTLP-speaking stack at everdict — not an adapter everdict
uses. See `docs/everdict-otel.md`.

- **DEPENDENCY-FREE, deliberately.** No OTel SDK, no zod, no internal `@everdict/*` package. Everything here
  is strings, because the whole job is assembling env vars and resource attributes: pointing a stack at
  everdict is configuration, not code. Adding a dependency here makes users adopt our tree to send us a span.
- **`EVERDICT_SEMCONV` is a COPY of `@everdict/trace`'s, kept in lockstep by a drift test.** The duplication
  is the price of the rule above and is bounded by that test — never "fix" it by importing the other one.
- **Python needs no package at all** (the same env vars). This module exists so TypeScript users do not
  hand-assemble them; if a feature would only work with a TS package installed, it belongs on the door, not
  here.
- `OTEL_SERVICE_NAME` stays OTel's own attribute — never re-spelled as an everdict key. It is the plane key
  of a multi-service trajectory, and rewriting it would break joining against the user's existing telemetry.
