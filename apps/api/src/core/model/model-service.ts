import type { ModelSpec } from "@everdict/contracts";
import type { SaveModelResult, TestModelConnectionResult } from "@everdict/contracts/wire";
import { modelApiKeySecretName, specsEqual } from "@everdict/domain";
import { type JudgeCompletion, anthropicComplete, openaiComplete } from "@everdict/graders";
import type { ModelRegistry } from "@everdict/registry";
import type { ScopedSecretTiers } from "../execution/judge-auth-dispatcher.js";

// The human "save" + "test connection" surface for workspace models — the two capabilities the raw registry CRUD
// (POST /models, immutable version) doesn't cover:
//   - testConnection: resolve the model's apiKeySecret from the tenant's secret tiers and fire ONE minimal dummy
//     completion, so the UI can preview the response before enabling registration / editing. Never throws for a
//     connection failure — the outcome is the return value.
//   - saveConnection: the version-free upsert the web uses. A brand-new id registers 1.0.0; an edit (endpoint/key
//     change) auto patch-bumps to a NEW immutable version so `latest` picks up the change while past scorecards that
//     pinned an older version stay reproducible (mirrors repinHarnessImages). Idempotent: an unchanged connection is
//     a no-op (no version spam).

// The connection subset a probe needs (id/version/tags are irrelevant to reaching the model).
export type ModelConnection = Pick<ModelSpec, "provider" | "model" | "baseUrl" | "apiKeySecret" | "params">;
// The upsert body: everything but the coordinates the caller doesn't set (id comes from the path, version is assigned).
export type ModelUpsert = Omit<ModelSpec, "id" | "version">;

export interface ModelServiceDeps {
  models: ModelRegistry;
  // The two secret tiers resolvable for a submitter (workspace first, personal fallback) — same source dispatch uses.
  scopedSecretsFor: (tenant: string, subject?: string) => Promise<ScopedSecretTiers>;
  anthropicBaseUrl?: string; // env default base (overridden by the model's own baseUrl)
  openaiBaseUrl?: string;
  fetchImpl?: typeof fetch; // injected in tests
}

// A one-word probe — cheap, deterministic, and enough to prove the connection + key + model id all resolve upstream.
const PROBE_PROMPT = "Reply with exactly the single word: OK";
const DEFAULT_PROBE_MAX_TOKENS = 64;
const PREVIEW_CHARS = 500;

// Auto version (same rule as harness re-pin): semver → patch bump (skip taken), else a "-r<n>" suffix.
function nextVersion(base: string, taken: ReadonlySet<string>): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
  if (m) {
    let patch = Number(m[3]) + 1;
    while (taken.has(`${m[1]}.${m[2]}.${patch}`)) patch += 1;
    return `${m[1]}.${m[2]}.${patch}`;
  }
  let n = 2;
  while (taken.has(`${base}-r${n}`)) n += 1;
  return `${base}-r${n}`;
}

export class ModelService {
  constructor(private readonly deps: ModelServiceDeps) {}

  // Fire a single dummy completion against the model's resolved connection. Returns the outcome (ok + preview text, or
  // ok:false + reason); it never throws for a reachability/auth failure so the caller can show it inline.
  async testConnection(
    tenant: string,
    subject: string | undefined,
    conn: ModelConnection,
  ): Promise<TestModelConnectionResult> {
    const { provider, model } = conn;
    // Reuse the one owner of the provider-standard key vocabulary (explicit apiKeySecret, else ANTHROPIC/OPENAI_API_KEY).
    const secretName = modelApiKeySecretName({ id: "", version: "", tags: [], ...conn });
    const scoped = await this.deps.scopedSecretsFor(tenant, subject);
    const apiKey = scoped.workspace[secretName] ?? scoped.user[secretName]; // workspace key first, personal fallback
    if (apiKey === undefined)
      return {
        ok: false,
        provider,
        model,
        error: `No API key resolved for '${secretName}' — set it in workspace or personal secrets, then test again.`,
      };

    const maxTokens = conn.params?.maxTokens ?? DEFAULT_PROBE_MAX_TOKENS;
    const envBaseUrl = provider === "anthropic" ? this.deps.anthropicBaseUrl : this.deps.openaiBaseUrl;
    const baseUrl = conn.baseUrl ?? envBaseUrl; // the model's own base wins; else the control-plane env default
    const cfg = {
      apiKey,
      model,
      ...(baseUrl ? { baseUrl } : {}),
      maxTokens,
      ...(this.deps.fetchImpl ? { fetchImpl: this.deps.fetchImpl } : {}),
    };
    const complete: JudgeCompletion = provider === "anthropic" ? anthropicComplete(cfg) : openaiComplete(cfg);

    const started = Date.now();
    try {
      const text = await complete(PROBE_PROMPT);
      return { ok: true, provider, model, text: text.slice(0, PREVIEW_CHARS), latencyMs: Date.now() - started };
    } catch (err) {
      // The transport already remaps upstream/network failures to UpstreamError with a readable message.
      return { ok: false, provider, model, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // Version-free upsert. New id → 1.0.0; a changed connection on an existing id → next patch version (new immutable
  // version, `latest` moves); an unchanged connection → idempotent no-op (created:false, no version written).
  async saveConnection(
    tenant: string,
    subject: string | undefined,
    id: string,
    body: ModelUpsert,
  ): Promise<SaveModelResult> {
    const own = await this.deps.models.ownVersions(tenant, id); // tenant-owned live versions, ascending; no _shared fallback
    if (own.length > 0) {
      const latest = await this.deps.models.get(tenant, id, "latest"); // tenant owns it → resolves to its own latest
      // Compare content at the same version so the version field itself doesn't force a difference (order-independent).
      if (specsEqual({ ...body, id, version: latest.version }, latest))
        return { workspace: tenant, id, version: latest.version, created: false };
      const version = nextVersion(latest.version, new Set(own)); // latest.version = the semver-latest own version

      await this.deps.models.register(tenant, { ...body, id, version }, subject);
      return { workspace: tenant, id, version, created: true };
    }
    const version = "1.0.0";
    await this.deps.models.register(tenant, { ...body, id, version }, subject);
    return { workspace: tenant, id, version, created: true };
  }
}
