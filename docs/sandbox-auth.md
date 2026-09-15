---
kind: wiki
title: "Harness auth across backends"
status: current
updated: 2026-09-15
anchors: [packages/contracts/src/harness/auth-env.ts, packages/job-runner/src/env.ts, packages/job-runner/Dockerfile]
---
# Harness auth across backends

How `claude` (Claude Code) authenticates depends on where the run lands.

## LocalBackend (dev) — subscription, no key
The run executes in-process on this host, so `claude` uses **this machine's existing login**
(Pro/Max subscription). Nothing to inject. Just:
```bash
pnpm everdict run --task "..."
```

## Sandbox backends (Nomad / K8s) — no host login present
A dispatched job runs in a fresh isolated unit with **no** `claude` login. Inject a credential as
an env var — the CLI collects the harness auth vars present in its env (`collectAuthEnv`, vocabulary
`HARNESS_AUTH_ENV_VARS`), the Backend injects them into the job (Nomad alloc env / K8s Secret), and the
job-runner forwards them to the harness command as `RunContext.apiKeyEnv`:

| Mode | Env var | How to get it |
|------|---------|---------------|
| **Subscription** (recommended) | `CLAUDE_CODE_OAUTH_TOKEN` | on the host run `claude setup-token` (requires a Claude subscription) → copy the token |
| API billing | `ANTHROPIC_API_KEY` | Anthropic console |

A gateway-fronted or non-claude harness uses the rest of the same vocabulary: `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL`, `ANTHROPIC_MODEL`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`.

Put it in `everdict/.env` (gitignored), then run against a sandbox backend, e.g. Nomad:
```bash
pnpm everdict run --backend nomad --nomad-addr http://<nomad>:4646 \
  --image <registry>/everdict-job-runner:<tag> --runtime runsc --task "..."
```

### Sandbox requirements
- The **job-runner image** (`packages/job-runner/Dockerfile`) bakes Node + git + `@anthropic-ai/claude-code`,
  so the dispatched job already has the harness toolchain. Build & push it to your internal registry.

### ⚠ Security
`CLAUDE_CODE_OAUTH_TOKEN` is your **subscription credential**; `ANTHROPIC_API_KEY` is a billing
secret. Both are injected **into the job** in the target cluster. Only use **trusted / self-hosted**
backends (your own Nomad/K8s). Never commit them — `.env` is gitignored.
