// Front-door callback store — the persistence behind the multi-replica callback rendezvous
// (docs/architecture/completion-stream-callback.md). With several control planes, the agent's terminal
// POST /frontdoor-callback/:runId may land on a replica that isn't driving the run: deliver() writes the body
// here, and the driving replica's wait loop CLAIMS it (atomically — exactly one waiter consumes each body).
export interface CallbackStore {
  deliver(runId: string, body: unknown): Promise<void>;
  // Claim the oldest unconsumed body for the run (atomic across replicas). undefined = nothing yet.
  claim(runId: string): Promise<{ body: unknown } | undefined>;
}
