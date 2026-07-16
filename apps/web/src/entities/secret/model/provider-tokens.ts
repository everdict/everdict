import type { SecretScope } from './schema'

// "Reserved-name" secrets consumed by platform features (provider tokens) — so users don't have to memorize the reserved names (HF_TOKEN, etc.);
// the secrets UI surfaces them as a curated section. Storage is the same as regular secrets (SecretStore is the SSOT — this is only a UI split).
// GitHub isn't here: it's a higher-level UX handled by 'connected accounts' (OAuth one-click), not token entry.
// The display copy (provider/usedFor/help) is resolved by secrets-manager from the next-intl catalog by token name
// (manageWorkspaceSecrets.providerTokens.<NAME>.*) — this const is data holding only the reserved name·issue link·scopes.
export interface ProviderTokenDef {
  name: string // reserved secret name (the server consumes it by this name)
  helpUrl: string // issuance page
  scopes: SecretScope[] // the scopes consumed — a key with no personal consumption isn't shown on the personal (account) screen
}

// Model provider keys (ANTHROPIC_API_KEY / OPENAI_API_KEY) are NOT curated here — they're managed on the
// workspace Models tab (per-model apiKeySecret binding). They still work as a raw workspace secret and as the
// unset-model provider default; this list is only the curated convenience UI, not where the keys are consumed.
export const PROVIDER_TOKENS: ProviderTokenDef[] = [
  {
    name: 'HF_TOKEN',
    helpUrl: 'https://huggingface.co/settings/tokens',
    scopes: ['user', 'workspace'],
  },
]

export const providerTokenNames: ReadonlySet<string> = new Set(PROVIDER_TOKENS.map((t) => t.name))
