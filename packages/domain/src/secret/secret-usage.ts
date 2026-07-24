import type { EnvValue, HarnessSpec, ModelSpec, RuntimeSpec, WorkspaceSettings } from "@everdict/contracts";
import type { SecretUsageRef } from "@everdict/contracts/wire";
import { modelApiKeySecretName } from "../model/model-binding.js";

// Reverse index of workspace secrets — given the CURRENT registry specs (latest per entity) + workspace settings,
// enumerate every site that names a secret. Pure: the control plane fetches the specs; this decides what references
// what. It is the read-time inverse of the same {secretRef}/authSecret/apiKeySecret vocabulary that
// resolveHarnessSecrets / runtime dispatch / the settings integrations resolve to values at run time — so a removed
// reference simply stops being emitted (nothing is cached; the usage disappears on the next read).
// Emits both scopes (a user-scoped harness env {secretRef} is a "user" usage); a workspace-only report filters to
// scope==="workspace" downstream. Model/runtime/settings references are always workspace-scoped.

export interface SecretUsageInputs {
  harnesses: ReadonlyArray<{ id: string; version: string; spec: HarnessSpec }>;
  runtimes: ReadonlyArray<{ id: string; version: string; spec: RuntimeSpec }>;
  models: ReadonlyArray<{ id: string; version: string; spec: ModelSpec }>;
  settings?: WorkspaceSettings;
}

// One (secret name → reference) edge — the service groups these by name and attaches them to the secret metadata.
export interface SecretUsage {
  name: string;
  scope: "user" | "workspace";
  ref: SecretUsageRef;
}

export function collectSecretUsages(inputs: SecretUsageInputs): SecretUsage[] {
  const out: SecretUsage[] = [];
  const workspaceRef = (name: string, ref: SecretUsageRef): void => {
    out.push({ name, scope: "workspace", ref });
  };

  // env {secretRef} → a usage keyed by the reference's OWN scope (a user-scoped ref names a personal secret).
  const scanEnv = (
    env: Record<string, EnvValue>,
    base: Omit<SecretUsageRef, "field" | "detail">,
    serviceName?: string,
  ): void => {
    for (const [varName, value] of Object.entries(env)) {
      if (typeof value === "string") continue; // literal env value — no secret reference
      out.push({
        name: value.secretRef,
        scope: value.scope === "user" ? "user" : "workspace",
        ref: { ...base, field: "env", detail: serviceName ? `${serviceName}:${varName}` : varName },
      });
    }
  };

  // --- harnesses (latest resolved spec): env {secretRef} + command trace auth / service trace-source auth ---
  for (const { id, version, spec } of inputs.harnesses) {
    const base: Omit<SecretUsageRef, "field" | "detail"> = { kind: "harness", label: id, resourceId: id, version };
    if (spec.kind === "command") {
      scanEnv(spec.env, base);
      if (spec.trace.kind !== "none" && spec.trace.authSecret) {
        workspaceRef(spec.trace.authSecret, { ...base, field: "trace-auth" });
      }
    } else if (spec.kind === "service") {
      for (const svc of spec.services) scanEnv(svc.env, base, svc.name);
      if (spec.traceSource.authSecret) workspaceRef(spec.traceSource.authSecret, { ...base, field: "trace-auth" });
    }
  }

  // --- runtimes (latest spec): cluster API auth + optional topology trace-source auth ---
  for (const { id, version, spec } of inputs.runtimes) {
    const base: Omit<SecretUsageRef, "field" | "detail"> = { kind: "runtime", label: id, resourceId: id, version };
    if (spec.kind === "nomad" || spec.kind === "k8s") {
      if (spec.authSecret) workspaceRef(spec.authSecret, { ...base, field: "cluster-token" });
      if (spec.traceSource?.authSecret) workspaceRef(spec.traceSource.authSecret, { ...base, field: "trace-auth" });
    }
    if (spec.kind === "k8s" && spec.kubeconfigSecret) {
      workspaceRef(spec.kubeconfigSecret, { ...base, field: "kubeconfig" });
    }
  }

  // --- models (latest spec): the resolved API-key secret name (explicit apiKeySecret, else provider default) ---
  for (const { id, version, spec } of inputs.models) {
    workspaceRef(modelApiKeySecretName(spec), { kind: "model", label: id, resourceId: id, version, field: "api-key" });
  }

  // --- workspace settings integrations (all workspace-scoped) ---
  const s = inputs.settings;
  if (s) {
    if (s.mattermost) {
      workspaceRef(s.mattermost.botTokenSecretName, { kind: "mattermost", label: "Mattermost", field: "bot-token" });
      if (s.mattermost.commandTokenSecretName) {
        workspaceRef(s.mattermost.commandTokenSecretName, {
          kind: "mattermost",
          label: "Mattermost",
          field: "command-token",
        });
      }
    }
    // image registries — the plural canonical list, else the legacy singular (mirrors the settings read-merge).
    const registries = s.imageRegistries?.length
      ? s.imageRegistries
      : s.imageRegistry
        ? [{ name: "default", ...s.imageRegistry }]
        : [];
    for (const r of registries) {
      if (r.pullSecretName)
        workspaceRef(r.pullSecretName, { kind: "imageRegistry", label: r.name, field: "registry-pull" });
      if (r.pushSecretName)
        workspaceRef(r.pushSecretName, { kind: "imageRegistry", label: r.name, field: "registry-push" });
    }
    // trace sources — the unified pool, else legacy sinks (both auth via authSecretName).
    const sources = s.traceSources?.length ? s.traceSources : (s.traceSinks ?? []);
    for (const src of sources) {
      if (src.authSecretName)
        workspaceRef(src.authSecretName, { kind: "traceSource", label: src.name, field: "trace-auth" });
    }
    // BYO egress proxies (browser-profiles S4) — the proxy "user:pass" credential.
    for (const proxy of s.proxies ?? []) {
      if (proxy.authSecretName)
        workspaceRef(proxy.authSecretName, { kind: "proxy", label: proxy.name, field: "proxy-auth" });
    }
  }

  return out;
}
