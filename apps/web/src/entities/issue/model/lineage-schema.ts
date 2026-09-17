import { z } from 'zod'

// A local mirror of the control plane's issue-lineage read (apps/api `GET /issues/:id/lineage`). Mirrored
// rather than imported: the web is a pure HTTP client of the API and shares no `@everdict/*` types with it.
const serviceRefSchema = z.object({ repository: z.string(), path: z.string().optional() })

export const lineageChangeSchema = z.object({
  campaignId: z.string(),
  roundSeq: z.number(),
  repository: z.string(),
  path: z.string().optional(),
  commits: z.array(
    z.object({ sha: z.string(), message: z.string().optional(), at: z.string().optional() })
  ),
  pr: z
    .object({ number: z.number(), url: z.string().optional(), mergedSha: z.string().optional() })
    .optional(),
})

export const lineageCampaignSchema = z.object({
  grade: z.enum(['change', 'evaluated']),
  id: z.string(),
  state: z.string(),
  service: serviceRefSchema.optional(),
  rounds: z.array(
    z.object({
      seq: z.number(),
      outcome: z.string(),
      hypothesis: z.string().optional(),
      answers: z
        .object({
          met: z.number(),
          notMet: z.number(),
          notRun: z.number(),
          observed: z.number(),
          asserted: z.number(),
        })
        .optional(),
    })
  ),
  continues: z.string().optional(),
  closedAt: z.string().optional(),
})

export const issueLineageSchema = z.object({
  issueId: z.string(),
  campaigns: z.array(lineageCampaignSchema),
  changes: z.array(lineageChangeSchema),
  knowledge: z.array(
    z.object({
      id: z.string(),
      kind: z.string(),
      title: z.string(),
      status: z.string(),
      // Every way in, not the first one found: an entry pinned to both is reachable twice.
      reachedBy: z.object({ issue: z.boolean(), campaigns: z.array(z.string()) }),
    })
  ),
  // Which collaborators the control plane could not read. An unwired source must never render as a request
  // that caused nothing, so the UI says so rather than drawing an empty section.
  sources: z.object({
    changeCampaigns: z.enum(['read', 'unavailable']),
    evaluatedCampaigns: z.enum(['read', 'unavailable']),
    knowledge: z.enum(['read', 'unavailable']),
  }),
})

export type IssueLineage = z.infer<typeof issueLineageSchema>
export type LineageCampaign = z.infer<typeof lineageCampaignSchema>
export type LineageChange = z.infer<typeof lineageChangeSchema>
