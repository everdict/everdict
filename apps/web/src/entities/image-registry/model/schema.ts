import { z } from 'zod'

// 컨트롤플레인 /workspace/image-registry 응답의 클라이언트 미러 — 워크스페이스 이미지 레지스트리(BYO).
// 비밀 없음: pull/pushSecretName 은 값이 아닌 SecretStore 이름 참조. imagePrefix = "host[/namespace]/"
// (분류 배지·assay image push 대상 ref 조립용).
export const imageRegistryConfigSchema = z.object({
  host: z.string(),
  namespace: z.string().optional(),
  username: z.string().optional(),
  pullSecretName: z.string().optional(),
  pushSecretName: z.string().optional(),
  imagePrefix: z.string(),
})
export type ImageRegistryConfig = z.infer<typeof imageRegistryConfigSchema>

// GET /workspace/image-registry → { config? }; PUT → { config, missingSecrets? }(참조 시크릿 부재 경고).
export const imageRegistryResponseSchema = z.object({
  config: imageRegistryConfigSchema.optional(),
})
export type ImageRegistryResponse = z.infer<typeof imageRegistryResponseSchema>

export const imageRegistrySetResponseSchema = z.object({
  config: imageRegistryConfigSchema,
  missingSecrets: z.array(z.string()).optional(),
})
export type ImageRegistrySetResponse = z.infer<typeof imageRegistrySetResponseSchema>
