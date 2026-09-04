'use server'

import { type CampaignDecision, campaignDecisionSchema } from '@/entities/campaign'
import { authContext } from '@/shared/auth/principal'
import { controlPlane } from '@/shared/lib/control-plane'

export interface CampaignActionResult {
  ok: boolean
  detail?: string
  error?: string
}

// Write the gate's answer. It REFUSES while the answer is `continue` — a campaign settles on an adoptable
// candidate or on its own ending, never because somebody decided it had gone on long enough. This action
// forwards that refusal rather than pre-checking, because the page's copy of the decision is a snapshot.
export async function settleCampaignAction(id: string): Promise<CampaignActionResult> {
  const ctx = await authContext()
  try {
    const out = await controlPlane.settleCampaign<{
      close?: { outcome?: { kind?: string; reason?: string } }
    }>(ctx, id)
    const outcome = out.close?.outcome
    // `adopted` | `halted` — and a halt carries WHICH ending fired, which is the half a driver acts on.
    const detail = outcome?.kind === 'halted' ? (outcome.reason ?? 'halted') : outcome?.kind
    return { ok: true, ...(detail !== undefined ? { detail } : {}) }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Spend the authorization a close left behind: register the version and read it back. The PROOF comes from
// the adoption read — it is not something a caller composes, which is why this reads it here rather than
// taking one from the browser.
// Merge the pull request the candidate came from, at the head the round measured. The proof is read from the
// operation SERVER-SIDE and never taken from the browser: a proof a client could compose is not an
// authorization. Unlike `adopt`, the merge body is the proof and nothing else — there are no candidate bytes
// to hold — which is why this act belongs on the page and that one does not.
export async function mergeCampaignAction(id: string): Promise<CampaignActionResult> {
  const ctx = await authContext()
  try {
    const authorization = await controlPlane.campaignAdoption<{ operation?: { proof?: unknown } | null }>(
      ctx,
      id
    )
    const proof = authorization.operation?.proof
    if (proof === undefined) return { ok: false, error: 'this campaign authorized no adoption' }
    const out = await controlPlane.mergeCampaignCandidate<{ url?: string }>(ctx, id, { proof })
    return { ok: true, ...(out.url ? { detail: out.url } : {}) }
  } catch (e) {
    // 404 no authorization · 409 forged proof, bytes not registered yet, or no code debt.
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// Log a round. It sends NO verdict — the platform derives that from the production scorecard diff, and a
// form that offered one would be asking a driver to grade its own work. `learned` is required (10–4000
// chars at the control plane) because it is the half that survives: the budget is spent either way, and
// what the round TAUGHT is the only thing the next one can use.
export async function logCampaignRoundAction(
  id: string,
  round: {
    hypothesis?: string
    learned: string
    candidateVersion: string
    baselineScorecardId: string
    candidateScorecardId: string
  }
): Promise<CampaignActionResult> {
  const ctx = await authContext()
  try {
    await controlPlane.logCampaignRound(ctx, id, round)
    return { ok: true }
  } catch (e) {
    // 409 once the frame's own ending has fired — the budget is spent, or the rejected streak was reached.
    // The record enforces its endings; this forwards the refusal rather than counting rounds itself.
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// What the close AUTHORIZED, and how much of it has actually happened. `decided` means the authorization
// exists and nobody has spent it — the single most surprising state in this domain (skill `evolve`), which
// is why the page draws it instead of a checkmark.
export interface CampaignAdoptionView {
  state: string
  candidate?: { type?: string; id?: string; version?: string }
  code?: { repo?: string; prNumber?: number; state?: string }
}

export interface CampaignReads {
  decision?: CampaignDecision
  adoption?: CampaignAdoptionView
  brief?: string
  builds: { id?: string; state?: string }[]
  buildSets: { id?: string; state?: string }[]
  error?: string
}

// Everything the detail page reads BESIDE the record, each carrying its own failure. They are separate
// questions — what the gate says, whether the authorization was spent, what the next delegate would be
// handed, what was built — and one failing must not blank the others.
export async function loadCampaignReads(id: string): Promise<CampaignReads> {
  const ctx = await authContext()
  const out: CampaignReads = { builds: [], buildSets: [] }
  const note = (e: unknown) => {
    out.error = out.error ?? (e instanceof Error ? e.message : String(e))
  }
  try {
    // PARSED, not cast. A cast is what let the previous version read a field the answer has never carried,
    // and a shape the page cannot understand must be a failure it reports rather than a button it draws.
    out.decision = campaignDecisionSchema.parse(await controlPlane.campaignDecision(ctx, id))
  } catch (e) {
    note(e)
  }
  try {
    // `{campaignId, state, operation}` — and the operation is an OBJECT carrying the proof, the candidate it
    // authorizes and any code debt. Reading it as a bare string made every campaign read as already spent.
    const a = await controlPlane.campaignAdoption<{
      operation?: {
        state?: string
        proof?: { candidate?: { type?: string; id?: string; version?: string } }
        code?: { repo?: string; prNumber?: number; state?: string }
      } | null
    }>(ctx, id)
    const op = a.operation
    if (op?.state !== undefined)
      out.adoption = {
        state: op.state,
        ...(op.proof?.candidate !== undefined ? { candidate: op.proof.candidate } : {}),
        ...(op.code !== undefined ? { code: op.code } : {}),
      }
  } catch {
    // A campaign that authorized nothing is the ordinary case for an open one, not an error worth showing.
    out.adoption = undefined
  }
  try {
    const b = await controlPlane.campaignBrief<{ brief?: unknown }>(ctx, id)
    out.brief = typeof b.brief === 'string' ? b.brief : JSON.stringify(b.brief ?? b, null, 2)
  } catch {
    out.brief = undefined
  }
  try {
    const b = await controlPlane.campaignBuilds<{ builds?: CampaignReads['builds'] }>(ctx, id)
    out.builds = b.builds ?? []
  } catch {
    out.builds = []
  }
  try {
    const b = await controlPlane.campaignBuildSets<{ sets?: CampaignReads['buildSets'] }>(ctx, id)
    out.buildSets = b.sets ?? []
  } catch {
    out.buildSets = []
  }
  return out
}

// One round's sealed evidence, on demand — a campaign with many rounds would otherwise pay for all of them
// on every page load.
export async function loadRoundEvidence(id: string, seq: number): Promise<{ text?: string; error?: string }> {
  const ctx = await authContext()
  try {
    const out = await controlPlane.campaignRoundEvidence<unknown>(ctx, id, seq)
    return { text: JSON.stringify(out, null, 2) }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
