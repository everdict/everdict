// Report-mode schedule firing (docs/architecture/analysis-studio.md V4) — run ONE headless, budgeted agent
// analysis turn over a saved View and return the emitted report artifact. The impl lives in apps/api (an HTTP
// client to the agent service's internal route, x-internal-token-gated); the agent authenticates with a minted
// agt_ token acting AS the schedule creator, so every tool call stays RBAC-bounded. A fire with no runner
// configured cleanly rejects (like the scorecard/pull firers).
export interface AgentReportRunner {
  run(input: {
    tenant: string;
    createdBy: string; // the schedule creator — the turn acts as this subject
    scheduleId: string;
    scheduleName: string;
    view: string; // saved View id (the analysis lens)
    instructions?: string;
    compare?: "previous-period";
  }): Promise<{ sessionId: string; artifactId?: string }>;
}
