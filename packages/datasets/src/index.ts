// @everdict/datasets — external benchmark ingest. Barrel: mapping layer + source connectors + benchmark adapters/catalog.
// The mapping core is split into mapping.ts to avoid circular deps (catalog imports it directly; index only re-exports).
export * from "./catalog.js";
export * from "./diff.js";
export * from "./mapping.js";
export * from "./sources.js";
export * from "./spec.js";
