---
paths: "deploy/**"
---
# Infra / deploy rules (push)

See skill `infra-deploy`.

- Pin everything; ban `:latest`; allow-list registries (Kyverno admission). Reproducibility at build AND admission time.
- Name-prefix every resource `assay-${env}-<role>`; attach uniform tags `{Project, Environment, ManagedBy}`.
- **No secret in git** — Vault (kv-v2) + External Secrets Operator at runtime; gitleaks pre-commit is the backstop. Bootstrap secrets seeded imperatively-and-idempotently.
- IaC = root + small single-purpose modules, each `main/variables/outputs/versions.tf`; remote versioned state; every var/output typed + described.
- Scripts: `set -e`, prerequisite gating, shared color `log/ok/warn/err`, idempotent (`kubectl apply` via `--dry-run=client -o yaml`, `helm upgrade --install --wait`).
- GitOps App-of-Apps; bootstrap installs only cert-manager + ArgoCD, the rest self-deploys.
- IaC CI (tflint / fmt / validate, kubeconform) + ship Assay's own Helm chart.
