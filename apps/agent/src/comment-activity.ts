// Report a discussion turn's lifecycle onto its placeholder comment via the control plane's internal bridge
// (POST /internal/comment-activity, x-internal-token) — the control plane stays the ONLY comment mutator. The
// callers swallow failures on progress ticks (a lost activity line never breaks the turn) but surface them on the
// terminal patch (a final answer that can't land is a failed turn). Twin of usage.ts.
export interface CommentActivityReport {
  workspace: string;
  commentId: string;
  status?: "running" | "awaiting_approval" | "complete" | "failed";
  activity?: string | null; // machine token ("thinking"|"writing"|"tool:<name>"); null clears the line
  body?: string; // the final markdown answer (terminal patch)
}

export type CommentActivityReporter = (report: CommentActivityReport) => Promise<void>;

export function commentActivityReporter(controlPlaneUrl: string, internalToken: string): CommentActivityReporter {
  const url = `${controlPlaneUrl.replace(/\/$/, "")}/internal/comment-activity`;
  return async (report) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-internal-token": internalToken },
      body: JSON.stringify({
        tenant: report.workspace,
        commentId: report.commentId,
        ...(report.status !== undefined ? { status: report.status } : {}),
        ...(report.activity !== undefined ? { activity: report.activity } : {}),
        ...(report.body !== undefined ? { body: report.body } : {}),
      }),
    });
    if (!res.ok) throw new Error(`comment-activity report failed: ${res.status}`);
  };
}
