'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface ExtractResult {
  ok: boolean
  // How many CANDIDATES the pass proposed. They are `proposed` entries awaiting review, never published
  // knowledge — the whole point of the route is that a model does not get to write into the graph directly.
  proposed?: number
  error?: string
}

// Server action: mine a discussion thread for knowledge-entry candidates. A real billable model call, like
// skill-generate, which is why it is an explicit act rather than something the page does on open.
export async function extractKnowledgeAction(text: string): Promise<ExtractResult> {
  const ctx = await authContext()
  try {
    const out = await controlPlane.extractKnowledge<{ entries?: unknown[] }>(ctx, { text })
    return { ok: true, proposed: out.entries?.length ?? 0 }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
