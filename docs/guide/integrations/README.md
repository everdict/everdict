# Integrations

Everdict is driven by people through the web app, and by machines through MCP. These pages are the
machine half.

- **[MCP](mcp.md)** — the agent-facing surface, at parity with the HTTP API by construction
- **[Claude Code plugin](claude-code-plugin.md)** — two commands: the tools *and* the domain context
- **[Running Codex](codex.md)** — Codex as the agent under test, via a declarative harness

One distinction worth getting straight before you read further. An agent can be **the driver** (it
operates Everdict) or **the subject** (Everdict evaluates it). Claude Code can be either, and the two
are independent — you can drive Everdict from a Claude Code session while evaluating something else
entirely.

Driving is MCP. Being evaluated is a [harness](../concepts/harness.md).
