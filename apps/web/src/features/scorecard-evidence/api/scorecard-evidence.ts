'use server'

import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface VerifyManifestResult {
  ok: boolean
  // THREE answers, not two. A manifest that could not be checked is not a manifest that failed — the
  // control plane distinguishes them and a page that collapsed them would accuse a batch it never read.
  verdict?: 'verified' | 'mismatch' | 'unverifiable'
  detail?: string
  error?: string
}

// Server action: re-check that this batch is still what its manifest says — the digests over the dataset
// documents, the grading plan, the harness closure. A settled scorecard is evidence, and evidence that
// nobody can re-verify is a story about the past.
export async function verifyScorecardManifestAction(id: string): Promise<VerifyManifestResult> {
  const ctx = await authContext()
  try {
    const out = await controlPlane.verifyScorecardManifest<{ verdict?: string; detail?: string }>(ctx, id)
    const verdict =
      out.verdict === 'verified' || out.verdict === 'mismatch' || out.verdict === 'unverifiable'
        ? out.verdict
        : undefined
    return { ok: true, ...(verdict ? { verdict } : {}), ...(out.detail ? { detail: out.detail } : {}) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface OverrideGateResult {
  ok: boolean
  error?: string
}

// Server action: override a BLOCKING gate decision. The reason is required by the control plane and is
// recorded on the decision — an override that leaves no artifact overrides nothing (rule `suite`).
export async function overrideScorecardGateAction(id: string, reason: string): Promise<OverrideGateResult> {
  const ctx = await authContext()
  try {
    await controlPlane.overrideScorecardGate(ctx, id, { reason })
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export interface ReportResult {
  ok: boolean
  markdown?: string
  error?: string
}

// Server action: the batch as a report somebody else can cite — the numbers with the identity that makes
// them mean something (which dataset documents, which harness closure, which policy judged it). Returned as
// text rather than rendered here: a citable report is something a reader takes AWAY, and re-rendering it in
// our own components would produce a second document that says almost the same thing.
export async function scorecardReportAction(id: string): Promise<ReportResult> {
  const ctx = await authContext()
  try {
    const out = await controlPlane.scorecardReport<{ markdown?: string; report?: string }>(ctx, id)
    return { ok: true, markdown: out.markdown ?? out.report ?? '' }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}
