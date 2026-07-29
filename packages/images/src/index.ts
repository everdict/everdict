// @everdict/images — adapters for the managed image store (the WorkspaceImages port in
// @everdict/application-control). A registry client is not object storage, so it does not live in
// @everdict/storage. Design: docs/architecture/managed-image-store.md
export {
  GRANT_AUDIENCE,
  narrowAccess,
  parseScopes,
  type RegistryAccess,
  RegistryTokenIssuer,
  type RegistryTokenIssuerOptions,
} from "./token-issuer.js";
export { fetchManagedRegistryApi, type ManagedRegistryApi } from "./registry-api.js";
export {
  grantAsRegistryAuth,
  ManagedImageStore,
  type ManagedImageStoreOptions,
} from "./managed-image-store.js";
export { InMemoryImageStore } from "./in-memory-image-store.js";
