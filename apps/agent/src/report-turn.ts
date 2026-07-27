import { issueAgentToken } from "@everdict/db";
import { DEFAULT_SESSION_TITLE, runChat } from "./chat.js";
import type { AgentServerDeps } from "./server.js";

// Headless scheduled-report turn (docs/architecture/analysis-studio.md V4). The control plane's report-mode
// schedule fire calls the internal route, which runs ONE budgeted, request-less agent turn acting AS the schedule
// creator (a minted read-scoped agt_ token, revoked after the turn): load the saved View, query the pivot, and
// finish with a write_report artifact — which is then attached + pinned to the View (the report archive).

export interface ReportTurnInput {
  workspace: string;
  createdBy: string;
  scheduleId: string;
  scheduleName: string;
  view: string;
  instructions?: string;
  compare?: "previous-period";
}

// Report turns are unattended — cap them tighter than an interactive chat so a wandering model can't burn the
// tenant's budget on one fire.
const REPORT_MAX_TURNS = 24;

export function buildReportPrompt(input: ReportTurnInput): string {
  const lines = [
    `You are producing the scheduled analysis report "${input.scheduleName}" (an unattended run — never ask questions).`,
    "The deliverable is a NUMERIC dashboard — numbers first, prose last. Audience ranges from data analysts to",
    "non-technical teammates, so every metric must be readable at a glance.",
    `1. Load the saved analysis view with get_view(id: "${input.view}") and read its stored config — the keys mirror`,
    "   the analyze dashboard (group/pivot/measure/metric/viz/filters, from/to, q).",
    "2. Compute the numbers with query_scorecards, translating the stored config into the query body",
    "   (group → groupBy array, pivot → pivotBy, origin → filters.originSource, q → search, incomplete →",
    "   includeIncomplete). Also run per-metric variants (measure passRate AND mean; per-metric where useful)",
    "   so the dashboard shows metric-by-metric indicators, not one aggregate.",
    "   BUDGET: keep data-gathering to AT MOST 6 query calls, then RENDER — an unfinished run with no dashboard",
    "   is a failure; fewer well-chosen queries beat exhaustive exploration.",
  ];
  if (input.compare === "previous-period") {
    lines.push(
      "3. Run the SAME queries over the preceding period of equal length (shift the from/to window back once; when",
      "   the view has no from/to, use a sensible recent window, e.g. the last 7 days vs the 7 before) — every",
      "   headline metric must carry its BASELINE value and DELTA.",
    );
  }
  lines.push(
    `REQUIRED: call render_html once, titled "${input.scheduleName}" — a self-contained dashboard: metric cards`,
    "(current value, baseline, ▲/▼ delta with color), per-group inline-SVG bars/lines for the decision-relevant",
    "movements, and a compact comparison table. No external resources (they are blocked).",
    "Then call write_report once with a BRIEF markdown companion (3-6 bullets: what moved, why it matters, what",
    "to look at next). The dashboard carries the numbers; the report carries the judgement.",
  );
  if (input.instructions) lines.push(`Standing instructions from the schedule owner:\n${input.instructions}`);
  return lines.join("\n");
}

export async function runReportTurn(
  deps: AgentServerDeps,
  input: ReportTurnInput,
): Promise<{ sessionId: string; artifactId?: string }> {
  if (!deps.keyStore) throw new Error("Report turns need a key store (agt_ execution tokens) — set DATABASE_URL.");
  if (!deps.artifacts) throw new Error("Report turns need the analysis-artifact store.");
  const now = deps.now();
  const sessionId = deps.newId();
  await deps.sessions.createSession({
    id: sessionId,
    tenant: input.workspace,
    owner: input.createdBy, // the creator owns the transcript — it shows up in their history like any conversation
    title: `Report: ${input.scheduleName}`.slice(0, 60) || DEFAULT_SESSION_TITLE,
    createdAt: now,
    updatedAt: now,
  });
  // Read-scoped execution token acting AS the creator — the turn only reads eval data and emits artifacts
  // (native tools, no scope needed), so it gets less than a teammate's default "write".
  const { token, id: keyId } = await issueAgentToken(
    deps.keyStore,
    input.workspace,
    input.createdBy,
    ["read"],
    `report:${input.scheduleId}`,
  );
  try {
    const principal = await deps.authenticate({ authorization: `Bearer ${token}` });
    await runChat(
      { ...deps, maxTurns: REPORT_MAX_TURNS },
      principal,
      { authorization: `Bearer ${token}` },
      sessionId,
      buildReportPrompt(input),
    );
  } finally {
    await deps.keyStore.revoke(input.workspace, keyId, input.createdBy).catch(() => {}); // one-shot credential
  }
  // The deliverables: EVERY artifact this report session produced belongs to the View's archive (the dashboard,
  // its companion report, any extra charts). Primary = the newest html dashboard, else the newest report.
  const artifacts = await deps.artifacts.listBySession(input.workspace, sessionId);
  for (const artifact of artifacts) await deps.artifacts.attachToView(input.workspace, artifact.id, input.view);
  const newestFirst = [...artifacts].reverse();
  const primary = newestFirst.find((a) => a.kind === "html") ?? newestFirst.find((a) => a.kind === "report");
  if (!primary) return { sessionId };
  return { sessionId, artifactId: primary.id };
}
