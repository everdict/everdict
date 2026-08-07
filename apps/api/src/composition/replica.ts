import { randomUUID } from "node:crypto";

// WHO this control-plane process is (docs/architecture/multi-replica.md). Minted per BOOT, never derived from
// a hostname or a pod name: a restarted replica must not inherit its own previous identity, or it would look
// alive to the leader lease and to boot recovery while the work of its predecessor sits unclaimed.
//
// EVERDICT_REPLICA_ID exists for operators who want the identity in their own logs to match ours; it is a
// label, not a lock, and a deployment that pins the SAME value on two replicas breaks both of the guarantees
// above — which is why the default is random.
export const REPLICA_ID = process.env.EVERDICT_REPLICA_ID ?? `cp-${randomUUID().slice(0, 12)}`;

// The role every singleton control-plane loop is elected for. One lease, one leader: the loops are cheap and
// splitting them across replicas would only trade a simple invariant for a scheduling problem nobody has.
export const CONTROL_PLANE_ROLE = "control-plane";
