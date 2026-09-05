import type { ModelSpec as ContractModelSpec } from '@everdict/contracts'
import type {
  ModelListEntry,
  SaveModelResult as ContractSaveModelResult,
  TestModelConnectionResult as ContractTestModelConnectionResult,
} from '@everdict/contracts/wire'
import { z } from 'zod'

// Boundary validation for a model (the LLM used for inference and judging) lives only in this zod v4, and the EXPORTED types are pinned to @everdict/contracts (re-architecture P4).
// `import type` only — the zod v3 wire schemas do not run in the web.

// GET /models 200 — one entry per model id (workspace-owned plus the _shared fallback).
// createdBy = the subject that registered the FIRST version (absent for seed/_shared) — used to decide who may delete it (registrant-or-admin).
export const modelSummarySchema = z.object({
  id: z.string(),
  versions: z.array(z.string()),
  owner: z.string(),
  createdBy: z.string().optional(),
})
export const modelsSchema = z.array(modelSummarySchema)
export type ModelSummary = z.infer<typeof modelSummarySchema>

// GET /models/:id/versions/:version 200 — the whole ModelSpec. The provider connection details plus apiKeySecret (a secret NAME, never a value).
// apiKeySecret is the name of the workspace SecretStore key a harness's agent server or judge connects with when it uses this model — the value is resolved just before dispatch.
export const modelSpecSchema = z.object({
  id: z.string(),
  version: z.string(),
  description: z.string().optional(),
  provider: z.enum(['anthropic', 'openai']),
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKeySecret: z.string().optional(),
  params: z
    .object({
      temperature: z.number().optional(),
      maxTokens: z.number().optional(),
    })
    .optional(),
  // The companion tiers that run alongside this model when it drives an agent — refs to other registered models in the same catalog.
  // small = digest/memory extraction, fallback = switching on a persistent failure, subagent = sub-agents. The spec beats the deployment env defaults.
  companions: z
    .object({
      small: z.string().optional(),
      fallback: z.string().optional(),
      subagent: z.string().optional(),
    })
    .optional(),
  tags: z.array(z.string()).default([]),
})
export type ModelSpec = z.infer<typeof modelSpecSchema>

// POST /models/test-connection 200 — the result of a dummy call. ok:true carries a response text preview, ok:false the failure reason (NOT a 4xx).
export const testModelConnectionResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    provider: z.string(),
    model: z.string(),
    text: z.string(),
    latencyMs: z.number(),
  }),
  z.object({
    ok: z.literal(false),
    provider: z.string(),
    model: z.string(),
    error: z.string(),
  }),
])
export type TestModelConnectionResult = z.infer<typeof testModelConnectionResultSchema>

// PUT /models/:id 200 — a versionless save (an upsert). created=false means it was identical to the existing latest and no new version was written (idempotent).
export const saveModelResultSchema = z.object({
  workspace: z.string(),
  id: z.string(),
  version: z.string(),
  created: z.boolean(),
})
export type SaveModelResult = z.infer<typeof saveModelResultSchema>

// The drift guard — the summary has the same shape as the wire list entry, so it is bidirectional (a field change on either side breaks the web typecheck);
// the spec is web→contract only (the web merely displays and registers; the wire contract is the SSOT).
type AssertAssignable<A extends B, B> = A
type _SummaryFwd = AssertAssignable<ModelSummary, ModelListEntry>
type _SummaryBack = AssertAssignable<ModelListEntry, ModelSummary>
type _SpecFwd = AssertAssignable<ModelSpec, ContractModelSpec>
type _TestConnFwd = AssertAssignable<TestModelConnectionResult, ContractTestModelConnectionResult>
type _TestConnBack = AssertAssignable<ContractTestModelConnectionResult, TestModelConnectionResult>
type _SaveFwd = AssertAssignable<SaveModelResult, ContractSaveModelResult>
type _SaveBack = AssertAssignable<ContractSaveModelResult, SaveModelResult>
