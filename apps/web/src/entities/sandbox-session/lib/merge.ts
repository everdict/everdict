import type { SandboxTaskSummary } from '@/entities/sandbox-session'

// Reconcile the task feed against what the session reports. The panel adds an OPTIMISTIC card the moment a
// submit returns 202, and the session poll then repeats that same task by runId — so merging by id (server
// fields win) keeps the card in place instead of making it blink out and back. Order is submission order.
export function mergeTasksById(
  prev: SandboxTaskSummary[],
  incoming: SandboxTaskSummary[]
): SandboxTaskSummary[] {
  const byId = new Map(prev.map((task) => [task.runId, task]))
  for (const task of incoming) byId.set(task.runId, { ...byId.get(task.runId), ...task })
  return [...byId.values()].sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
}

// Remaining session life as mm:ss (h:mm:ss past an hour), floored at zero — the header countdown. Deliberately
// NOT a date-format atom: this is a live ticking remainder, not a timestamp.
export function fmtCountdown(remainingMs: number): string {
  const total = Math.max(0, Math.floor(remainingMs / 1000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3600)
  const pad = (n: number) => String(n).padStart(2, '0')
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`
}
