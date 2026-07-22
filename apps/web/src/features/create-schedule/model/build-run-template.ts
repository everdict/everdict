// Pure form-input → schedule runTemplate builder, shared by the create + update server actions. It lives OUTSIDE the
// 'use server' action modules on purpose: a 'use server' file may only export async functions (server actions), so a
// synchronous helper has to sit in a plain module.

export interface CreateScheduleInput {
  name: string
  cron: string
  timezone: string
  overlapPolicy: string
  // batch mode (dataset×harness)
  datasetId?: string
  datasetVersion?: string
  harnessId?: string
  harnessVersion?: string
  runtime?: string
  concurrency?: number
  trials?: number // pass@k / flakiness — run each case N times per fire (empty = 1)
  cases?: { limit?: number; tags?: string[] } // partial run each fire — first N / tag filter (empty = all)
  // trace-evaluation mode — judge a rolling window of a registered trace source (no harness run). Present = pull mode.
  pull?: { source: string; scope?: string; windowHours: number }
  // Agent Judges to score each fire's traces → judge:<id> metrics (empty = control-plane default scoring). Shared by both modes.
  judges?: { id: string; version: string }[]
}

// Build the schedule runTemplate from the form input — trace-evaluation (pull) mode when `pull` is set, else batch
// (dataset×harness). The control plane's XOR refine rejects a template that is neither/both.
export function buildScheduleRunTemplate(input: CreateScheduleInput): Record<string, unknown> {
  const judges = input.judges && input.judges.length > 0 ? { judges: input.judges } : {}
  if (input.pull) {
    return {
      pull: {
        source: input.pull.source,
        ...(input.pull.scope ? { scope: input.pull.scope } : {}),
        windowHours: input.pull.windowHours,
      },
      ...judges,
    }
  }
  return {
    dataset: { id: input.datasetId ?? '', version: input.datasetVersion || 'latest' },
    harness: { id: input.harnessId ?? '', version: input.harnessVersion || 'latest' },
    ...judges,
    ...(input.runtime ? { runtime: input.runtime } : {}),
    ...(input.concurrency ? { concurrency: input.concurrency } : {}),
    ...(input.trials ? { trials: input.trials } : {}),
    ...(input.cases ? { cases: input.cases } : {}),
  }
}
