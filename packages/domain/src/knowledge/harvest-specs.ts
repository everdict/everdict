import type {
  AgentSpec,
  CapabilityRecord,
  Dataset,
  HarnessSpec,
  JudgeSpec,
  ModelBinding,
  ModelSpec,
  NodeRef,
  RubricRef,
  RubricSpec,
  RuntimeSpec,
} from "@everdict/contracts";
import { HarvestBuilder, type HarvestResult } from "./harvest.js";

// Structured harvesters for the versioned REGISTRY specs (the eval subjects/config the scorecard/schedule harvesters'
// edges point at — `evaluates` → harness, `uses_dataset` → dataset, `applies_judge` → judge). Unlike the result/activity
// records, a registry spec carries NO tenant/timestamp/owner (those are registry metadata), so each harvester takes a
// `SpecHarvestMeta` alongside the spec. Pure and deterministic; built on the shared HarvestBuilder.

export const HARNESS_HARVESTER = "harness_harvester_v1";
export const DATASET_HARVESTER = "dataset_harvester_v1";
export const JUDGE_HARVESTER = "judge_harvester_v1";
export const RUNTIME_HARVESTER = "runtime_harvester_v1";
export const MODEL_HARVESTER = "model_harvester_v1";
export const RUBRIC_HARVESTER = "rubric_harvester_v1";
export const AGENT_HARVESTER = "agent_harvester_v1";
export const CAPABILITY_HARVESTER = "capability_harvester_v1";

// The registry metadata a spec does not carry itself. `tags` is here (not on the spec) for harnesses — a HarnessSpec has
// no tags field; dataset/judge/runtime carry their own on the spec and ignore this.
export interface SpecHarvestMeta {
  tenant: string;
  createdAt: string;
  updatedAt: string;
  createdBy?: string;
  tags?: string[];
}

// A registered-Model binding resolves to a `model` node only when it is a REF (an object) — a bare string is a raw
// model name (e.g. "claude-opus-4-8"), not a registry entity, so it produces no edge.
function modelRefNode(binding: ModelBinding): NodeRef | undefined {
  if (typeof binding !== "object") return undefined;
  return { type: "model", key: binding.ref, ...(binding.version !== undefined ? { version: binding.version } : {}) };
}

// A rubric is `string` (inline text) OR a RubricRef (a registry reference) — only the latter is a `rubric` node.
function rubricRefNode(rubric: string | RubricRef | undefined): NodeRef | undefined {
  if (rubric === undefined || typeof rubric !== "object") return undefined;
  return { type: "rubric", key: rubric.id, version: rubric.version };
}

// The edges every spec shares: workspace scoping, ownership, and tag classification.
function common(b: HarvestBuilder, tenant: string, meta: SpecHarvestMeta, tags: string[]): void {
  b.ref("in_workspace", { type: "workspace", key: tenant }, "tenant");
  if (meta.createdBy !== undefined && meta.createdBy !== "")
    b.ref("created_by", { type: "user", key: meta.createdBy }, "createdBy");
  tags.forEach((t, i) => b.ref("tagged_with", { type: "tag", key: t }, `tags[${i}]`));
}

// A HarnessSpec — the agent under test (process | service | command). Tags live in the registry meta, not the spec.
export function harvestHarness(meta: SpecHarvestMeta, spec: HarnessSpec): HarvestResult {
  const b = new HarvestBuilder(
    meta.tenant,
    "harness_spec",
    spec.id,
    HARNESS_HARVESTER,
    meta.updatedAt,
    meta.createdAt,
  ).self({ type: "harness", key: spec.id, version: spec.version }, `${spec.id}@${spec.version}`, { kind: spec.kind });
  common(b, meta.tenant, meta, meta.tags ?? []);
  if (spec.kind === "command") {
    const mr = spec.model !== undefined ? modelRefNode(spec.model) : undefined;
    if (mr !== undefined) b.ref("uses_model", mr, "model");
    // env secret refs → the secret-usage graph
    for (const [k, v] of Object.entries(spec.env)) {
      if (typeof v !== "string") b.ref("uses_secret", { type: "secret", key: v.secretRef }, `env.${k}.secretRef`);
    }
    if (spec.trace.kind !== "none" && spec.trace.authSecret !== undefined) {
      b.ref("uses_secret", { type: "secret", key: spec.trace.authSecret }, "trace.authSecret");
    }
  }
  return b.result();
}

// A Dataset — a versioned, harness-agnostic bundle of eval cases.
export function harvestDataset(meta: SpecHarvestMeta, spec: Dataset): HarvestResult {
  const b = new HarvestBuilder(
    meta.tenant,
    "dataset_spec",
    spec.id,
    DATASET_HARVESTER,
    meta.updatedAt,
    meta.createdAt,
  ).self({ type: "dataset", key: spec.id, version: spec.version }, `${spec.id}@${spec.version}`, {
    cases: spec.cases.length,
  });
  common(b, meta.tenant, meta, spec.tags);
  return b.result();
}

// A JudgeSpec — a verdict scorer (model | code | harness). Each kind wires a different subset of model/rubric/runtime.
export function harvestJudge(meta: SpecHarvestMeta, spec: JudgeSpec): HarvestResult {
  const b = new HarvestBuilder(
    meta.tenant,
    "judge_spec",
    spec.id,
    JUDGE_HARVESTER,
    meta.updatedAt,
    meta.createdAt,
  ).self({ type: "judge", key: spec.id, version: spec.version }, `${spec.id}@${spec.version}`, { kind: spec.kind });
  common(b, meta.tenant, meta, spec.tags);
  if (spec.kind === "model") {
    const mr = modelRefNode(spec.model);
    if (mr !== undefined) b.ref("uses_model", mr, "model");
    const rr = rubricRefNode(spec.rubric);
    if (rr !== undefined) b.ref("uses_rubric", rr, "rubric");
  } else if (spec.kind === "code") {
    const mr = spec.model !== undefined ? modelRefNode(spec.model) : undefined;
    if (mr !== undefined) b.ref("uses_model", mr, "model");
    if (spec.runtime !== undefined && spec.runtime !== "")
      b.ref("runs_on", { type: "runtime", key: spec.runtime }, "runtime");
  } else {
    const rr = rubricRefNode(spec.rubric);
    if (rr !== undefined) b.ref("uses_rubric", rr, "rubric");
    if (spec.runtime !== undefined && spec.runtime !== "")
      b.ref("runs_on", { type: "runtime", key: spec.runtime }, "runtime");
  }
  return b.result();
}

// A RuntimeSpec — execution infra (local | nomad | k8s). The cluster-auth secret names become the secret-usage graph.
export function harvestRuntime(meta: SpecHarvestMeta, spec: RuntimeSpec): HarvestResult {
  const b = new HarvestBuilder(
    meta.tenant,
    "runtime_spec",
    spec.id,
    RUNTIME_HARVESTER,
    meta.updatedAt,
    meta.createdAt,
  ).self({ type: "runtime", key: spec.id, version: spec.version }, `${spec.id}@${spec.version}`, { kind: spec.kind });
  common(b, meta.tenant, meta, spec.tags);
  if (spec.kind === "nomad" && spec.authSecret !== undefined) {
    b.ref("uses_secret", { type: "secret", key: spec.authSecret }, "authSecret");
  }
  if (spec.kind === "k8s") {
    if (spec.authSecret !== undefined) b.ref("uses_secret", { type: "secret", key: spec.authSecret }, "authSecret");
    if (spec.kubeconfigSecret !== undefined)
      b.ref("uses_secret", { type: "secret", key: spec.kubeconfigSecret }, "kubeconfigSecret");
  }
  return b.result();
}

// A ModelSpec — a registered LLM/VLM connection. Its api-key secret name feeds the secret-usage graph.
export function harvestModel(meta: SpecHarvestMeta, spec: ModelSpec): HarvestResult {
  const b = new HarvestBuilder(
    meta.tenant,
    "model_spec",
    spec.id,
    MODEL_HARVESTER,
    meta.updatedAt,
    meta.createdAt,
  ).self({ type: "model", key: spec.id, version: spec.version }, `${spec.id}@${spec.version}`, {
    provider: spec.provider,
    model: spec.model,
  });
  common(b, meta.tenant, meta, spec.tags);
  if (spec.apiKeySecret !== undefined && spec.apiKeySecret !== "") {
    b.ref("uses_secret", { type: "secret", key: spec.apiKeySecret }, "apiKeySecret");
  }
  return b.result();
}

// A RubricSpec — reusable verdict criteria that judges reference via uses_rubric.
export function harvestRubric(meta: SpecHarvestMeta, spec: RubricSpec): HarvestResult {
  const b = new HarvestBuilder(
    meta.tenant,
    "rubric_spec",
    spec.id,
    RUBRIC_HARVESTER,
    meta.updatedAt,
    meta.createdAt,
  ).self({ type: "rubric", key: spec.id, version: spec.version }, `${spec.id}@${spec.version}`, {});
  common(b, meta.tenant, meta, spec.tags);
  return b.result();
}

// An AgentSpec — a conversational-agent configuration. `model` is a registered id; `capabilities` are cross-tenant
// adoption refs (a subset/public capability is owned by another workspace — the adopts edge points at THAT tenant's
// capability node); the adopter's secretBindings VALUES are this workspace's real secret names (uses_secret).
export function harvestAgent(meta: SpecHarvestMeta, spec: AgentSpec): HarvestResult {
  const b = new HarvestBuilder(
    meta.tenant,
    "agent_spec",
    spec.id,
    AGENT_HARVESTER,
    meta.updatedAt,
    meta.createdAt,
  ).self({ type: "agent", key: spec.id, version: spec.version }, `${spec.id}@${spec.version}`, {});
  common(b, meta.tenant, meta, spec.tags);
  if (spec.model !== undefined && spec.model !== "") b.ref("uses_model", { type: "model", key: spec.model }, "model");
  spec.mcpServers.forEach((s, i) => {
    if (s.authSecret !== undefined && s.authSecret !== "") {
      b.ref("uses_secret", { type: "secret", key: s.authSecret }, `mcpServers[${i}].authSecret`);
    }
  });
  spec.capabilities.forEach((c, i) => {
    b.ref("adopts", { type: "capability", key: c.id, version: c.version }, `capabilities[${i}]`, {}, c.source);
    for (const [logical, secretName] of Object.entries(c.secretBindings)) {
      b.ref("uses_secret", { type: "secret", key: secretName }, `capabilities[${i}].secretBindings.${logical}`);
    }
  });
  return b.result();
}

// A CapabilityRecord — a published tool/code/skill/environment. Unlike the versioned specs it IS a record (carries
// tenant/createdAt/createdBy), so it needs no SpecHarvestMeta.
export function harvestCapability(record: CapabilityRecord): HarvestResult {
  const b = new HarvestBuilder(
    record.tenant,
    "capability_spec",
    record.id,
    CAPABILITY_HARVESTER,
    record.createdAt,
    record.createdAt,
  ).self({ type: "capability", key: record.id, version: record.version }, `${record.name} (${record.spec.type})`, {
    type: record.spec.type,
    visibility: record.visibility,
  });
  b.ref("in_workspace", { type: "workspace", key: record.tenant }, "tenant");
  if (record.createdBy !== undefined && record.createdBy !== "") {
    b.ref("created_by", { type: "user", key: record.createdBy }, "createdBy");
  }
  record.tags.forEach((t, i) => b.ref("tagged_with", { type: "tag", key: t }, `tags[${i}]`));
  return b.result();
}
