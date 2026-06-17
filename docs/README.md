# Assay docs

- [architecture/overview.md](architecture/overview.md) — the architecture map (spine, eval loop, extension points)
- [service-harness.md](service-harness.md) — service-topology harnesses (multi-service + browser/OS target env), Nomad/K8s, OTel/MLflow trace
- [execution-backends.md](execution-backends.md) — Backend (placement) vs Driver (in-sandbox), multi-cluster routing
- [orchestration.md](orchestration.md) — durable control plane on Temporal (Direct/Temporal orchestrators + worker)
- [sandbox-auth.md](sandbox-auth.md) — how `claude` authenticates across backends (subscription / token injection)
- [migration/README.md](migration/README.md) — DB migration discipline (expand→contract + preflight)

Conventions (single source of truth): [`../CLAUDE.md`](../CLAUDE.md) + `../.claude/` (rules + skills),
reinterpreted — not copied — from `digo-api` (backend) and `digo-infra-dev` (infra).
