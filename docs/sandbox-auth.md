# Harness auth across drivers

How `claude` (Claude Code) authenticates depends on the driver.

## LocalDriver (dev) — subscription, no key
`claude` uses **this machine's existing login** (Pro/Max subscription). `runContextFromEnv()`
injects nothing, so the sandboxed `claude -p` inherits the host login. Just:
```bash
pnpm assay run --task "..."
```

## Sandbox drivers (E2B / future pool) — no host login present
A fresh sandbox has **no** `claude` login. Inject a credential as an env var — Assay forwards
`RunContext.apiKeyEnv` into the harness command env (and the driver passes it to the sandbox):

| Mode | Env var | How to get it |
|------|---------|---------------|
| **Subscription** (recommended) | `CLAUDE_CODE_OAUTH_TOKEN` | on the host run `claude setup-token` (requires a Claude subscription) → copy the token |
| API billing | `ANTHROPIC_API_KEY` | Anthropic console |

Put it in `assay/.env` (gitignored), then:
```bash
pnpm assay run --driver e2b --task "..."
```
(`--driver e2b` also requires `E2B_API_KEY` / `E2B_DOMAIN` and `pnpm add e2b`.)

### Sandbox requirements
- The E2B template needs **Node ≥ 18** — the harness installs `@anthropic-ai/claude-code`
  with `npm i -g` (`install: true` is set automatically for `--driver e2b`).

### ⚠ Security
`CLAUDE_CODE_OAUTH_TOKEN` is your **subscription credential**; `ANTHROPIC_API_KEY` is a
billing secret. Both are sent **into the sandbox**. Only use a **trusted / self-hosted**
sandbox. Never commit them — `.env` is gitignored.
