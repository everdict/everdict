# Guide — the product documentation

Written for someone using Everdict, not maintaining it. This is the tree the public docs site
publishes as `/docs`; the design records under [`../architecture/`](../architecture/overview.md) are a separate,
maintainer-facing section. See [`../architecture/docs-site.md`](../architecture/docs-site.md) for how
the two map onto the site.

## Get started
- [Section index](start/README.md)
- [What is Everdict](start/what-is-everdict.md) — what it does, what it refuses to do, and who it is for
- [Quickstart](start/quickstart.md) — the whole stack on your machine in one command
- [Your first scorecard](start/first-scorecard.md) — dataset × harness → a verdict you can defend
- [Bring your own agent](start/bring-your-agent.md) — the on-ramp per agent kind, ending at a registered harness
- [Connect an agent](start/connect-an-agent.md) — MCP, API keys, and the Claude Code plugin

## Core concepts
- [Overview](concepts/README.md) — the seven nouns, and how one run flows through them
- [Run](concepts/run.md) · [Harness](concepts/harness.md) · [Dataset](concepts/dataset.md) ·
  [Grader & Judge](concepts/grader-and-judge.md) · [Scorecard](concepts/scorecard.md) ·
  [Verdict](concepts/verdict.md) · [Workspace](concepts/workspace.md)

## Your workspace
- [Section index](workspace/README.md)
- [Workspace agents](workspace/agents.md) — the agent that runs *inside* Everdict, and how it wakes itself
- [The workspace filesystem](workspace/filesystem.md) — one file tree per workspace, with attributed revisions
- [Environments](workspace/environments.md) — `repo` · `prompt` · `browser` · `os-use`, and how to choose
- [Image registry](workspace/image-registry.md) — publishing images and keeping their provenance

## Integrations
- [Section index](integrations/README.md)
- [MCP](integrations/mcp.md) — drive Everdict from any agent
- [Claude Code plugin](integrations/claude-code-plugin.md) — two commands, tools plus domain context
- [Running Codex](integrations/codex.md) — Codex as the agent under test, via a declarative harness

## Self-hosting
- [Overview](self-host/overview.md) — deployment shapes, what each one needs, and what to decide first
