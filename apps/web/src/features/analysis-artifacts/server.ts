// Server-only entry — the gallery pulls authContext/agentPlane (server-only), so it must not ride the
// client-safe barrel (a client import would drag server-only into the client bundle).
export { ViewArtifactGallery } from './ui/view-artifact-gallery'
