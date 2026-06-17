# Harness auth across backends

How `claude` (Claude Code) authenticates depends on where the run lands.

## LocalBackend (dev) — subscription, no key
The run executes in-process on this host, so `claude` uses **this machine's existing login**
(Pro/Max subscription). Nothing to inject. Just:
```bash
pnpm assay run --task "..."
```

## Sandbox backends (Nomad / K8s / Windows) — no host login present
A dispatched job runs in a fresh isolated unit with **no** `claude` login. Inject a credential as
an env var — Assay forwards `RunContext.apiKeyEnv` into the harness command env, and the Backend
injects it into the job (Nomad alloc env / K8s Secret / Windows secure env):

| Mode | Env var | How to get it |
|------|---------|---------------|
| **Subscription** (recommended) | `CLAUDE_CODE_OAUTH_TOKEN` | on the host run `claude setup-token` (requires a Claude subscription) → copy the token |
| API billing | `ANTHROPIC_API_KEY` | Anthropic console |

Put it in `assay/.env` (gitignored), then run against a sandbox backend, e.g. Nomad:
```bash
pnpm assay run --backend nomad --nomad-addr http://<nomad>:4646 \
  --image <registry>/assay-agent:<tag> --runtime runsc --task "..."
```

### Sandbox requirements
- The **agent image** (`packages/agent/Dockerfile`) bakes Node + git + `@anthropic-ai/claude-code`,
  so the dispatched job already has the harness toolchain. Build & push it to your internal registry.

### ⚠ Security
`CLAUDE_CODE_OAUTH_TOKEN` is your **subscription credential**; `ANTHROPIC_API_KEY` is a billing
secret. Both are injected **into the job** in the target cluster. Only use **trusted / self-hosted**
backends (your own Nomad/K8s/Windows). Never commit them — `.env` is gitignored.
