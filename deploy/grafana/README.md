# Everdict Grafana pack (operator scrape)

Dashboards + alert rules over the **operator** Prometheus scrape (`GET /metrics`).

## Wiring

The scrape is **fail-closed**: without `EVERDICT_METRICS_TOKEN` on the control plane the route does not
exist. Configure the token, then point Prometheus at it:

```yaml
scrape_configs:
  - job_name: everdict
    metrics_path: /metrics
    bearer_token: "<EVERDICT_METRICS_TOKEN>"
    static_configs:
      - targets: ["everdict-api:3000"]
```

- `everdict-operator-dashboard.json` — import via Grafana → Dashboards → Import. Panels: dispatch
  outcomes, scheduler queue/in-flight, case outcomes at settle (the CaseOutcome vocabulary), unmeasured
  reasons, time-to-verdict p50/p90, breakers, batch-resilience counters.
- `alerts.yaml` — Prometheus `rule_files` alerting rules (infra-failure share, scoring-plane outage,
  queue backlog, open breaker).

The operator exposition carries **per-workspace labels** — it is for the deployment's operator, never for
tenants. A workspace that wants its own numbers scrapes `GET /workspace/metrics` with an `ak_` API key
(bearer): only its own ledger tallies, no other tenant visible.
