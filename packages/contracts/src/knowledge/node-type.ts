import { z } from "zod";

// The closed vocabulary of knowledge-graph NODE types — the everdict domain entities a mention can point at.
//
// This is the everdict reinterpretation of the digo-data `travel_knowledge` `ENTITY_TYPES` frozenset: a single
// TYPE-AGNOSTIC mention spine (`node_type` enum + `node_attrs` jsonb) instead of one table per entity type. The
// crucial difference from UGC extraction is that everdict's domain entities ALREADY carry stable canonical identity
// (`(tenant, id, version)` for registry entities, a UUID for result records, a subject for users), so a `node` is a
// lightweight canonical projection of an existing record rather than a surface form resolved after the fact.
//
// GOVERNANCE: this vocabulary is CLOSED and PR-gated — inventing a node type is a code change, never a runtime value.
// Because the mention/edge_mention spine is type-agnostic, adding a type is a one-line enum extension plus a harvester
// (no schema change, no downstream table), the same cheap extension axis digo-data used to grow 14 → 17 entities. See
// docs/architecture/knowledge-graph.md §node vocabulary.
export const NODE_TYPES = [
  // WHO — actors
  "workspace", // the tenant / trust-zone root that scopes every other node
  "user", // an authenticated subject (OIDC sub or api-key/runner identity), unifying UserProfile + Principal.subject

  // WHY — the intent stratum (the eval tracker, records/tracker.ts + team.ts + cycle.ts). The ISSUE is the graph's
  // hub: it gathers the capabilities that verify it (`verified_by`), the scorecard that closed it (`resolved_by`),
  // and its place in the plan (`part_of` / `child_of` / `belongs_to`) — so the massive resource strata hang off the
  // problem they exist to answer, not the other way round.
  "issue", // the unit of intent — the problem under evaluation (IssueRecord; key = record id, identifier in attrs)
  "project", // issues under one target date (ProjectRecord)
  "initiative", // the GOAL several projects work toward (InitiativeRecord)

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
  "tag", // a free-label classifier shared across registry entities (the everdict analog of digo `theme`)
  "metric", // a score dimension a scorecard/run measures ("cost", "answer_match", "judge:<id>")
  "view", // a saved scorecard-analysis lens

  // KNOWLEDGE & COMMS — text-bearing surfaces that are also first-class nodes
  "skill", // a workspace instruction-library entry
  "knowledge", // a reified claim (KnowledgeEntryRecord) — a workspace-general assertion about other nodes
  "comment", // a resource-discussion comment (participates in threads + authorship + @-mentions)
  "agent_session", // a conversation between a member and everdict's own agent

  // INTEGRATION & EXTERNAL
  "repository", // an external Git repository ("owner/name") linked for CI triggers / GitHub App installs
  "trace_source", // a registered observability platform (otel | mlflow | langfuse | langsmith | phoenix)
  "secret", // a workspace/user credential referenced by name (makes "who uses this secret" a graph query)
  "browser_profile", // a saved login session injected into browser evals
] as const;

export const NodeTypeSchema = z.enum(NODE_TYPES);
export type NodeType = z.infer<typeof NodeTypeSchema>;
