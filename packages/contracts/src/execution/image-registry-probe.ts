// Connection-test for a workspace image registry BEFORE it is registered — verify the host answers as a Docker
// Registry HTTP API v2 endpoint and that the resolved credential authenticates. The pure result type; the
// fetch-backed engine is the injected RegistryReader.checkConnection(coords, auth) (application-control depends on
// @everdict/contracts only, so the fetch lives in apps/api's dockerRegistryReader). The wire Zod schema (the parse
// boundary) is wire/image-registry/image-registry-probe-result.ts. Mirrors trace-probe (a probe classifies, it
// never throws).

// The probe outcome — a classified failure is a normal result (never a thrown error): reason is the structured
// failure class, absent when reachable. detail is the human-readable line the form shows. `credential` reports
// which of the configured secrets the probe authenticated with (the test is single-credential — see the service).
export interface ImageRegistryProbeResult {
  reachable: boolean;
  detail: string;
  reason?: "auth" | "unreachable" | "error";
  credential: "push" | "pull" | "anonymous";
}
