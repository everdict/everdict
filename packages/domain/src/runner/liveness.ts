// Self-hosted runner liveness — a runner refreshes its lastSeenAt on every long-poll lease (~25s) and on every
// heartbeat, so within this window it counts as "online" (connected and able to pick up work). A runner silent
// longer than this is treated as offline: its process is stopped, it lost network, or it's attached to a different
// control-plane replica. This is the server-side SSOT the dispatch-time "no online runner" diagnostic keys on; the
// web mirrors the same 90s constant locally (it's runtime-decoupled and can't import the domain — see docs/web.md).
export const RUNNER_ONLINE_WINDOW_MS = 90_000;

// Online = lastSeenAt is present and within the window of `now`. A never-seen runner (no lastSeenAt — paired but its
// lease loop has not started) is offline. A malformed timestamp is offline (fail closed rather than assume online).
export function isRunnerOnline(lastSeenAt: string | undefined, now: number): boolean {
  if (lastSeenAt === undefined) return false;
  const seen = Date.parse(lastSeenAt);
  return Number.isFinite(seen) && now - seen < RUNNER_ONLINE_WINDOW_MS;
}
