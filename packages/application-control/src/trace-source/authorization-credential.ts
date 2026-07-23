// Turn a resolved SecretStore value into the credential a trace source/sink injects into its outbound request.
//
// Every trace kind but langsmith sends the credential as a verbatim `Authorization` header, which RFC 7235 requires to
// be shaped "<scheme> <credentials>". A plain secret stores the scheme itself ("Bearer <token>" for OTel/Jaeger,
// "Basic <base64>" for MLflow) and is used as-is; but an offline_token secret resolves to a *bare* OAuth2 access token
// (the minter returns `access_token` with no scheme), so a schemeless value is wrapped as a Bearer credential
// (RFC 6750). Without this the header would go out as a bare token and a Keycloak/OIDC-protected platform 401s.
// langsmith injects the value as `x-api-key` (a raw key, never an Authorization scheme), so it is returned untouched.
export type TraceCredentialKind = "otel" | "mlflow" | "langfuse" | "langsmith" | "phoenix";

// Already "<scheme> <credentials>" (a plain secret) → verbatim; a schemeless token (an offline_token access token) →
// Bearer-wrapped. A real credential (JWT / opaque token / base64) never contains whitespace, so the "token space rest"
// shape reliably distinguishes a scheme-carrying value from a bare one.
export function traceAuthorizationCredential(kind: TraceCredentialKind, value: string): string {
  if (kind === "langsmith") return value;
  return /^\S+\s+\S/.test(value) ? value : `Bearer ${value}`;
}
