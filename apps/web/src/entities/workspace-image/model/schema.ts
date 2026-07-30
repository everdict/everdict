import type {
  ImageCatalogResponse,
  ImageRemoveResponse,
  ImageTagsResponse,
} from '@everdict/contracts/wire'
import { z } from 'zod'

// 관리형 이미지 스토어(everdict 자체 레지스트리)의 웹 미러. 런타임 검증은 여기 zod가 전담하고,
// 아래 드리프트 가드가 컨트롤 플레인의 wire 타입과 양방향으로 묶어 둔다.
export const workspaceImageRepoSchema = z.object({
  name: z.string(),
  repository: z.string(),
  image: z.string(),
  tags: z.array(z.string()).optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  updatedAt: z.string().optional(),
})

export const workspaceImageCatalogSchema = z.object({
  endpoint: z.string(),
  namespace: z.string(),
  repositories: z.array(workspaceImageRepoSchema),
  usage: z.object({
    repositories: z.number().int().nonnegative(),
    bytes: z.number().int().nonnegative().optional(),
  }),
})

export const workspaceImageTagsSchema = z.object({
  repository: z.string(),
  tags: z.array(z.string()),
})

export const workspaceImageRemoveSchema = z.object({
  repository: z.string(),
  removed: z.number().int().nonnegative(),
})

// 양방향 가드 — 어느 쪽에 필드가 추가/개명돼도 웹 타입체크가 깨진다.
type AssertAssignable<A extends B, B> = A
type WebCatalog = z.infer<typeof workspaceImageCatalogSchema>
type WebTags = z.infer<typeof workspaceImageTagsSchema>
type WebRemove = z.infer<typeof workspaceImageRemoveSchema>
type _catalogFwd = AssertAssignable<WebCatalog, ImageCatalogResponse>
type _catalogBack = AssertAssignable<ImageCatalogResponse, WebCatalog>
type _tagsFwd = AssertAssignable<WebTags, ImageTagsResponse>
type _tagsBack = AssertAssignable<ImageTagsResponse, WebTags>
type _removeFwd = AssertAssignable<WebRemove, ImageRemoveResponse>
type _removeBack = AssertAssignable<ImageRemoveResponse, WebRemove>
export type __workspaceImageDriftGuard = [
  _catalogFwd,
  _catalogBack,
  _tagsFwd,
  _tagsBack,
  _removeFwd,
  _removeBack,
]

export type WorkspaceImageCatalog = ImageCatalogResponse
export type WorkspaceImageRepo = ImageCatalogResponse['repositories'][number]
export type WorkspaceImageTags = ImageTagsResponse
export type WorkspaceImageRemoveResult = ImageRemoveResponse
