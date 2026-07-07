# Security Policy

## Supported versions

Assay is pre-1.0: only the latest `main` (and the most recent release, once releases begin) receives
security fixes.

## Reporting a vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use GitHub's private vulnerability reporting: **Security tab → "Report a vulnerability"** on this
repository. If that is unavailable, email the maintainer at `heoin122@gmail.com` with a description,
reproduction steps, and impact assessment.

You can expect an acknowledgement within **72 hours** and a status update within **7 days**. Please
allow us a reasonable disclosure window to ship a fix before any public write-up.

## Scope notes for self-hosters

- The hardened compose profile (`deploy/compose/docker-compose.prod.yaml`) intentionally runs
  **without human auth** (single tenant, trusted network) — it must sit behind a reverse proxy /
  private network. Reports that this stack is open when deliberately exposed as documented are not
  vulnerabilities; bypasses of `ASSAY_REQUIRE_AUTH=1`, API-key scoping, workspace isolation, or
  secret-at-rest encryption very much are.
- Harness runs execute untrusted agent workloads. Isolation is delegated to your orchestrator
  runtime (gVisor/Kata, network policies, trust zones) — sandbox escapes from a properly configured
  isolated runtime are in scope.
