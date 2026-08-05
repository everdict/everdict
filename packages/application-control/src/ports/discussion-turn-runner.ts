// Discussion-thread agent turn (@everdict in a resource's comment thread) — run ONE headless agent turn over the
// thread snapshot and stream its lifecycle back onto the placeholder agent comment. The impl lives in apps/api (an
// HTTP client to the agent service's internal route, x-internal-token-gated); the agent acks 202 and runs the turn
// DETACHED (a HITL approval park can last minutes — never a held request), reporting progress via the control
// plane's /internal/comment-activity callback. The agent authenticates with a minted agt_ token acting AS the
// asker, so every tool call stays RBAC-bounded. Unset runner → askAgent is skipped (the member comment still posts).
export interface DiscussionTurnRunner {
  run(input: {
    tenant: string;
    askedBy: string; // the asking member — the turn acts as this subject
    resourceType: string;
    resourceId: string;
    commentId: string; // the placeholder agent comment to drive (status/activity/final body)
    // The thread's top-level comment — the ONLY legal parent in a single-level thread, and the anchor the turn
    // must use if it posts a comment of its own. Without it the agent knows no comment ids at all (the snapshot
    // below carries none), so any create_comment it makes lands top-level, outside the discussion it is in.
    anchorId: string;
    sessionId: string; // the thread's workspace-visible agent session (created on first ask, reused after)
    // The full thread snapshot at ask time, oldest→newest (a later snapshot supersedes earlier ones).
    thread: { author: string; authorName: string; body: string; at: string }[];
  }): Promise<void>;
}
