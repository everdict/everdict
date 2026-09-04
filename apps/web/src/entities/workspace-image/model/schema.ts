import type {
  ImageCatalogResponse,
  ImageInspectResponse,
  ImageRemoveResponse,
  ImageTagsResponse,
} from '@everdict/contracts/wire'
import { z } from 'zod'

// The web mirror of the managed image store (everdict's own registry). Runtime validation is owned entirely by the zod here, and
// the drift guard below binds it to the control plane's wire types in both directions.
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

// GET /workspace/images/manifest — the substance of the detail screen. The digest is the pin value, and everything below it (build history,
// runtime configuration, size) are best-effort fields filled only when the registry serves the OCI config blob.
export const workspaceImageBuildStepSchema = z.object({
  createdBy: z.string(),
  created: z.string().optional(),
  emptyLayer: z.boolean().optional(),
  comment: z.string().optional(),
})

export const workspaceImageRuntimeConfigSchema = z.object({
  entrypoint: z.array(z.string()).optional(),
  cmd: z.array(z.string()).optional(),
  env: z.array(z.string()).optional(),
  workingDir: z.string().optional(),
  user: z.string().optional(),
  exposedPorts: z.array(z.string()).optional(),
  labels: z.record(z.string(), z.string()).optional(),
})

export const workspaceImageInspectSchema = z.object({
  reference: z.string(),
  digest: z.string().optional(),
  mediaType: z.string().optional(),
  platforms: z.array(z.string()).optional(),
  layerCount: z.number().int().nonnegative().optional(),
  sizeBytes: z.number().int().nonnegative().optional(),
  created: z.string().optional(),
  os: z.string().optional(),
  architecture: z.string().optional(),
  history: z.array(workspaceImageBuildStepSchema).optional(),
  config: workspaceImageRuntimeConfigSchema.optional(),
})

// A bidirectional guard — a field added or renamed on either side breaks the web typecheck.
type AssertAssignable<A extends B, B> = A
type WebCatalog = z.infer<typeof workspaceImageCatalogSchema>
type WebTags = z.infer<typeof workspaceImageTagsSchema>
type WebRemove = z.infer<typeof workspaceImageRemoveSchema>
type WebInspect = z.infer<typeof workspaceImageInspectSchema>
type _catalogFwd = AssertAssignable<WebCatalog, ImageCatalogResponse>
type _catalogBack = AssertAssignable<ImageCatalogResponse, WebCatalog>
type _tagsFwd = AssertAssignable<WebTags, ImageTagsResponse>
type _tagsBack = AssertAssignable<ImageTagsResponse, WebTags>
type _removeFwd = AssertAssignable<WebRemove, ImageRemoveResponse>
type _removeBack = AssertAssignable<ImageRemoveResponse, WebRemove>
type _inspectFwd = AssertAssignable<WebInspect, ImageInspectResponse>
type _inspectBack = AssertAssignable<ImageInspectResponse, WebInspect>
export type __workspaceImageDriftGuard = [
  _catalogFwd,
  _catalogBack,
  _tagsFwd,
  _tagsBack,
  _removeFwd,
  _removeBack,
  _inspectFwd,
  _inspectBack,
]

export type WorkspaceImageCatalog = ImageCatalogResponse
export type WorkspaceImageRepo = ImageCatalogResponse['repositories'][number]
export type WorkspaceImageTags = ImageTagsResponse
export type WorkspaceImageRemoveResult = ImageRemoveResponse
export type WorkspaceImageInspect = ImageInspectResponse
