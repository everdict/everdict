import { z } from 'zod'

// The upload route's answer (`POST /api/fs/uploads`). It comes from our own BFF, but a boundary is a boundary, so it is parsed.
export const uploadedMediaSchema = z.object({
  path: z.string(),
  url: z.string(),
  name: z.string(),
  kind: z.enum(['image', 'video', 'audio']).optional(), // a file that is not media attaches as a plain link, with no kind
})
export type UploadedMedia = z.infer<typeof uploadedMediaSchema>
