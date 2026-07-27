import type { HarvestResult } from "@everdict/domain";
import type { KnowledgeStore } from "../ports/knowledge-store.js";

// Persist a harvester's output into the knowledge store — the thin control-plane use-case that ties a pure domain
// projector (e.g. `harvestScorecard`) to the store port. Idempotent by construction (the store keys by id/nodeId), so
// call sites can re-ingest on every record write without accumulating duplicates. The order (nodes → mentions →
// edges) is not significant: edges reference nodes by derived id, which is stable whether or not the node row exists
// yet. Deliberately trivial — the projection intelligence lives in the domain harvesters; this only writes.
export async function ingestHarvest(store: KnowledgeStore, result: HarvestResult): Promise<void> {
  await store.putNodes(result.nodes);
  await store.putMentions(result.mentions);
  await store.putEdges(result.edges);
}
