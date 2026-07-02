import { z } from 'zod'

// 컨트롤플레인 BundleService.install 결과의 클라이언트 미러(항목별 상태). 웹은 HTTP 로만 결합.
export const installItemResultSchema = z.object({
  kind: z.string(), // harness-template | harness | benchmark-recipe | dataset | judge | model | metric | runtime
  id: z.string(),
  version: z.string(),
  status: z.enum(['ok', 'conflict', 'error', 'skipped']),
  message: z.string().optional(),
})
export type InstallItemResult = z.infer<typeof installItemResultSchema>

export const bundleInstallResultSchema = z.object({
  id: z.string(),
  version: z.string(),
  results: z.array(installItemResultSchema),
})
export type BundleInstallResult = z.infer<typeof bundleInstallResultSchema>
