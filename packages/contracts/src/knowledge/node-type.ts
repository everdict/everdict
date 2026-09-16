import { z } from "zod";

// The closed vocabulary of entity TYPES a knowledge reference (`NodeRef`) can point at — the everdict domain entities
// a knowledge entry is about, the evidence it cites, a skill documents, or a task-context anchor names.
//
// Everdict's domain entities already carry stable canonical identity (`(tenant, id, version)` for registry entities,
// a UUID for result records, a subject for users), so a reference is `{type, key, version?}` over this list rather
// than a surface form resolved after the fact.
//
// GOVERNANCE: this vocabulary is CLOSED and PR-gated — inventing a type is a code change, never a runtime value. And it
// only GROWS: stored knowledge entries and skills parse their `refs`/`evidence` against it, so removing a value makes
// every row that names it unreadable. See docs/architecture/workspace-knowledge.md.
export const NODE_TYPES = [
  // WHO — actors
  "workspace", // the tenant / trust-zone root that scopes every other entity
  "user", // an authenticated subject (OIDC sub or api-key/runner identity), unifying UserProfile + Principal.subject

  // WHY — the intent stratum (the eval tracker, records/tracker.ts)
  "issue", // the unit of intent — the problem under evaluation (IssueRecord; key = record id)
  "project", // issues under one target date (ProjectRecord)
  "initiative", // the GOAL several projects work toward (InitiativeRecord)
  // The unit of improvement opened against an issue — an evolution campaign today, and the `change` grade a
  // coding session runs (docs/architecture/change-campaign-spec.md). Knowledge is pinned to it so what a
  // campaign TAUGHT is reachable from the request it served, not only from the code it changed
  // (EvolutionCampaignRecord; key = record id).
  "campaign",

  // UNDER TEST — the versioned eval subjects & configuration (registry entities keyed by (tenant, id, version))
  "harness", // the agent under test (process | service | command | agent)
  "dataset", // a harness-agnostic bundle of eval cases
  "case", // one eval case within a dataset (natural key: `${datasetId}@${datasetVersion}#${caseId}`)
  "judge", // a verdict scorer (model | code | harness)
  "rubric", // reusable verdict criteria referenced by judges
  "model", // a registered LLM/VLM connection (provider + model + api-key secret)
  "agent", // a conversational-agent configuration (instructions + mcp servers + adopted capabilities + model)
  "capability", // a published tool/code/skill adopted by agents

  // WHERE — execution infrastructure
  "runtime", // registered execution infra (local | nomad | k8s)
  "runner", // a paired self-hosted execution device
  "image", // a container image ref (case.image, harness pins, registry provenance)

  // WHEN — execution & outcomes
  "run", // a single eval case execution
  "scorecard", // a batch eval result (dataset × harness → aggregated Scorecard)
  "schedule", // a cron-triggered eval definition

  // ANALYSIS — classification & saved lenses
  "tag", // a free-label classifier shared across registry entities
  "metric", // a score dimension a scorecard/run measures ("cost", "answer_match", "judge:<id>")
  "view", // a saved scorecard-analysis lens

  // KNOWLEDGE & COMMS — text-bearing surfaces
  "skill", // a workspace instruction-library entry
  "knowledge", // a knowledge entry (KnowledgeEntryRecord) — a workspace-general assertion about other entities
  "comment", // a resource-discussion comment
  "agent_session", // a conversation between a member and everdict's own agent

  // INTEGRATION & EXTERNAL
  "repository", // an external Git repository ("owner/name") linked for CI triggers / GitHub App installs
  "trace_source", // a registered observability platform (otel | mlflow | langfuse | langsmith | phoenix)
  "secret", // a workspace/user credential referenced by name
  "browser_profile", // a saved login session injected into browser evals
] as const;

export const NodeTypeSchema = z.enum(NODE_TYPES);
export type NodeType = z.infer<typeof NodeTypeSchema>;
