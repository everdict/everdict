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
const REPORT_MAX_TURNS = 16;

export function buildReportPrompt(input: ReportTurnInput): string {
  const lines = [
    `You are producing the scheduled analysis report "${input.scheduleName}" (an unattended run — never ask questions).`,
    `1. Load the saved analysis view with get_view(id: "${input.view}") and read its stored config — the keys mirror`,
    "   the analyze dashboard (group/pivot/measure/metric/viz/filters, from/to, q).",
    "2. Compute the view's analysis with query_scorecards, translating the stored config into the query body",
    "   (group → groupBy array, pivot → pivotBy, origin → filters.originSource, q → search, incomplete → includeIncomplete).",
  ];
  if (input.compare === "previous-period") {
    lines.push(
      "3. Also run the SAME query over the preceding period of equal length (shift the from/to window back once) and",
      "   compare the two — call out regressions and improvements with numbers.",
    );
  }
  lines.push(
    "Render at most 2 charts (render_chart) for the most decision-relevant movements.",
    `REQUIRED: finish by calling write_report exactly once, titled "${input.scheduleName}" — a concise markdown report`,
    "with the headline numbers, notable regressions/improvements, and what to look at next. The report (not chat",
    "text) is the deliverable.",
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
  // The deliverable: the newest report-kind artifact of this session → attach + pin to the View (the archive).
  const artifacts = await deps.artifacts.listBySession(input.workspace, sessionId);
  const report = [...artifacts].reverse().find((a) => a.kind === "report");
  if (!report) return { sessionId };
  await deps.artifacts.attachToView(input.workspace, report.id, input.view);
  return { sessionId, artifactId: report.id };
}
