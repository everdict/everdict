import { z } from "zod";

// The closed vocabulary of knowledge-graph EDGE predicates — the typed relationships between two nodes.
//
// The everdict reinterpretation of digo-data's `travel_knowledge` `PREDICATES` frozenset. Same design locks: the
// vocabulary is CLOSED and PR-gated (inventing a predicate is a code change), the edge_mention wire stays type-agnostic
// (predicate-specific keys live in `edge_attrs` jsonb, not in per-predicate columns), and the direction convention is
// fixed: an edge points FROM the dependent/referencing node TO the referenced node (subject depends on / refers to
// object). E.g. `scorecard -[evaluates]-> harness`, `entity -[created_by]-> user`, `agent -[adopts]-> capability`.
//
// The `typical (subject → object)` notes below are the conventional shapes the harvesters emit; they are guidance, not
// wire enforcement — per-predicate validation lives downstream (the domain reduce layer), keeping this vocabulary the
// single extension axis. See docs/architecture/knowledge-graph.md §predicate vocabulary.
export const PREDICATES = [
  // PROVENANCE — who made / owns / scopes a node
  "created_by", // any node → user (the creator subject; RunRecord.createdBy, ScorecardRecord.createdBy, spec owner, …)
  "member_of", // user → workspace (edge_attrs.role: admin|member|viewer|…) — replaces a standalone membership node
  "in_workspace", // any node → workspace (tenant scoping; derivable from node.tenant, materialised for hub traversal)

  // INTENT — the tracker stratum (issue as hub). An issue POINTS AT what verifies/resolved it (links live on the
  // issue record), so the direction convention holds: the issue is the referencing subject.
  "verified_by", // issue → harness | dataset | judge | scorecard | run | view (an IssueLink; note in edge_attrs)
  "resolved_by", // issue → scorecard (resolution.scorecardId — the closing evidence AND the regression baseline)
  "part_of", // issue → project | cycle; project → initiative; initiative → parent initiative; team → parent team
  "belongs_to", // issue | cycle | project | registry spec → team (team scoping; `in_workspace` stays the tenant hub)
  "assigned_to", // issue → user (assignee); project | initiative → user with edge_attrs.role: "lead"
  "born_from", // versioned capability → issue | project | initiative | scorecard | run (CapabilityOrigin.from —
  // why a registered version exists at all; edge_attrs carries {via, agentId?})

  // EVAL COMPOSITION — how an evaluation is wired together
  "evaluates", // scorecard | run → harness (the agent under test)
  "uses_dataset", // scorecard | schedule → dataset
  "includes_case", // dataset → case
  "covers_case", // run → case (the case this run executed)
  "applies_judge", // scorecard | schedule → judge
  "uses_rubric", // judge → rubric
  "uses_model", // judge | harness | agent | schedule → model
  "runs_on", // scorecard | run | judge → runtime (execution placement)
  "placed_on", // run → runner (self-hosted device placement)
  "child_of", // run → scorecard (fan-out child of a batch); issue → issue (a sub-issue's parent pointer)
  "fired_by", // scorecard → schedule (origin.scheduleId — a schedule-triggered batch)

  // RESULTS & MEASUREMENT
  "measures", // scorecard | run → metric (edge_attrs: value/pass/mean/passRate)
  "compared_to", // scorecard → scorecard (a diff: baseline ↔ candidate)
  "supersedes", // scorecard → scorecard (a rerun that superseded a prior batch)

  // LINEAGE — version & derivation history
  "succeeds", // entity@vN → entity@vN-1 (immutable-version lineage)
  "derived_from", // dataset → dataset | harness-instance → template (producedBy / recipe provenance)

  // AGENT & COMMUNICATION
  "adopts", // agent → capability (an adopted capability pin)
  "references", // agent_session | agent_message → any node (a user-turn @-mention — see AgentReference)
  "discusses", // comment → the resource it is attached to (resourceType/resourceId)
  "reply_to", // comment → comment (a threaded reply)
  "mentions", // comment | agent_message → user (an @user mention)

  // KNOWLEDGE — the claim stratum's deliberately GENERIC grammar. The structural predicates above stay specific
  // because they mirror deterministic FKs; a claim's specificity lives in the knowledge NODE's content instead
  // (reification), so two predicates suffice. See docs/architecture/knowledge-graph.md §knowledge layer.
  "about", // skill | knowledge → any node (what a procedure documents / what a claim concerns — version-pinned)
  "evidenced_by", // knowledge → scorecard | run | comment | agent_session (the observation backing a claim)

  // INTEGRATION
  "triggers", // repository → harness (a CI link: repo PR/merge fires this harness)
  "connects_repo", // workspace → repository (a GitHub App install / CI repo link)
  "pins_image", // harness → image (a harness-instance pin / pinOverride)
  "runs_image", // case | run → image (case.image the compute ran)
  "exports_to", // harness → trace_source (judged detail exported to this observability platform)
  "pulls_from", // harness → trace_source (case trace pulled from this observability platform)
  "uses_secret", // any node → secret (a credential reference by name — the secret-usage graph)
  "uses_browser_profile", // harness | run → browser_profile (an injected login session)

  // CLASSIFICATION
  "tagged_with", // any node → tag (a free-label classifier)
] as const;

export const PredicateSchema = z.enum(PREDICATES);
export type Predicate = z.infer<typeof PredicateSchema>;

// The cross-predicate polarity of an edge observation. Mirrors digo-data's `polarity` (promoted to a first-class field
// from `edge_attrs`): a NEGATED observation ("this scorecard regressed against baseline", "this run did NOT cover the
// case") must survive to the graph so the reduce layer surfaces contradictions instead of averaging them into false
// consensus — dropping negated edges is the anti-pattern. `mixed` marks a subject with both affirmed and negated
// evidence across sources.
export const EDGE_POLARITIES = ["affirmed", "negated", "mixed"] as const;
export const EdgePolaritySchema = z.enum(EDGE_POLARITIES);
export type EdgePolarity = z.infer<typeof EdgePolaritySchema>;
