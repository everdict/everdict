# Execution backends (Backend vs Driver)

Two layers decide *where a harness run executes*:

- **Driver** (`@assay/core`, in-sandbox compute): runs the harness as a subprocess INSIDE an
  already-isolated unit. The runner-agent uses `LocalDriver`.
- **Backend** (`@assay/backends`, placement): dispatches a runner-agent job to an orchestrator
  and returns the `CaseResult`. Isolation is the orchestrator's job, not Assay's.

## Model B (runner-agent)
The control plane (outside the clusters) builds an `AgentJob` and hands it to a `Backend`:
`dispatch(job)` → runs `@assay/agent` (`runAgentJob`) inside an isolated unit → the agent does
the whole `runCase` and prints the `CaseResult` on stdout behind the `__ASSAY_RESULT__`
sentinel → the Backend parses it.

| Backend | Target | Isolation | Status |
|---------|--------|-----------|--------|
| `LocalBackend` | this host (in-process) | none | dev |
| `NomadBackend` | on-prem Nomad (batch alloc, docker driver) | docker `runtime` (e.g. `runsc`=gVisor) | **phase 1** |
| `K8sBackend` | cloud + on-prem K8s (Job) | `runtimeClassName` (gVisor/Kata) | phase 2 |
| `WindowsBackend` | on-prem Windows node pool | Hyper-V VM checkpoint | phase 3 |

Cloud vs on-prem K8s is the **same** `K8sBackend` — differences are config (kubeconfig/context/
registry/runtimeClass/namespace).

## Nomad (phase 1)
```bash
# 1) build + push the agent image to your internal registry
docker build -f packages/agent/Dockerfile -t <registry>/assay-agent:<tag> .

# 2) host: mint a subscription token, put it in assay/.env
claude setup-token            # → CLAUDE_CODE_OAUTH_TOKEN=...

# 3) run against your Nomad
pnpm assay run --backend nomad \
  --nomad-addr http://<nomad>:4646 \
  --image <registry>/assay-agent:<tag> --runtime runsc \
  --task "..." --test "..."
```
The control plane submits a batch job, polls the alloc to completion, and parses the
trace+scores from the alloc's stdout. `CLAUDE_CODE_OAUTH_TOKEN` is injected into the alloc env
→ **trusted / self-hosted Nomad only**.

> Isolation runtime (`--runtime runsc` for gVisor, or firecracker plugin, or none) depends on
> what your Nomad cluster has configured.
