import { z } from 'zod'

// GET /harnesses 응답: 테넌트가 보는 하니스 목록(자기 소유 + _shared).
export const harnessSchema = z.object({
  id: z.string(),
  owner: z.string(),
  versions: z.array(z.string()),
})
export type Harness = z.infer<typeof harnessSchema>

export const harnessesSchema = z.array(harnessSchema)
