// @everdict/contracts — knowledge-graph contracts.
//
// The type-agnostic mention spine that overlays a queryable graph on everdict's domain: NODE types + edge PREDICATES
// (closed, PR-gated vocabularies), the `KnowledgeNode` canonical projection, and the `Mention` / `EdgeMention` pair
// that records every observed reference. A faithful reinterpretation of digo-data's `travel_knowledge` mention layer
// for a domain whose entities already own canonical identity. Storage (KnowledgeStore), the graph algebra + node-id
// derivation (@everdict/domain), and the harvest/extract use-cases (@everdict/application-control) build on these.
// SSOT: docs/architecture/knowledge-graph.md.
export * from "./node-type.js";
export * from "./predicate.js";
export * from "./source-kind.js";
export * from "./knowledge-node.js";
export * from "./mention.js";
export * from "./edge-mention.js";
