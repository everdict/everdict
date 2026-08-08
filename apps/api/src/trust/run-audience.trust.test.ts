import type { RunRecord } from "@everdict/contracts";
import { PgRunStore } from "@everdict/db";
import { runAudience } from "@everdict/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TRUST_PG_ENABLED, type TrustPg, openTrustPg, trustId } from "./trust-context.js";

// Trust suite (docs/trust-certification.md) — TRUST-24.
//
// ONE ACTIVATION, ONE AUDIENCE. A headless agent run's session is created visibility:"workspace" by design
// (fleet observability); the run ledger must answer the SAME way, or one work item's evidence is
// workspace-readable through the session door and creator-only through the run door. The invariant is the
// agreement of TWO independent implementations — the domain's runAudience and the Pg list SQL's restatement
// of it (which must filter BEFORE the LIMIT) — and only a real Postgres proves the SQL half: an in-memory
// twin calls the domain function and would agree with any predicate, including a wrong one.
const describeTrust = TRUST_PG_ENABLED ? describe : describe.skip;

describeTrust("TRUST-24 — a headless activation's run row answers like its session door", () => {
  let pg: TrustPg;
  let tenant: string;
  let runs: PgRunStore;

  const run = (id: string, cls: "background" | "interactive"): RunRecord => ({
    id,
    tenant,
    harness: { id: "watcher", version: "1" },
    caseId: "issue.created",
    status: "succeeded",
    createdBy: "alice",
    kind: "agent",
    class: cls,
    origin: {
      cause: cls === "background" ? "event" : "member",
      actor: "alice",
      executor: "agent:watcher",
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  beforeAll(async () => {
    pg = await openTrustPg();
    tenant = trustId("trust-audience");
    runs = new PgRunStore(pg.client);
    await runs.create(run(trustId("headless"), "background"));
    await runs.create(run(trustId("chat"), "interactive"));
  });
  afterAll(async () => {
    if (tenant) await pg.client.query("DELETE FROM everdict_runs WHERE tenant = $1", [tenant]);
    await pg?.close();
  });

  it("a non-creator member sees the headless run and NOT the chat turn — in SQL, before the LIMIT", async () => {
    const bobSees = await runs.list(tenant, { viewer: "bob", limit: 10 });
    expect(bobSees.map((r) => r.class).sort()).toEqual(["background"]); // fleet observability, not alice's chat
    // And the two implementations agree — the domain decision over the same rows says the same thing.
    const all = await runs.list(tenant);
    const domainVisible = all.filter((r) => {
      const audience = runAudience(r);
      return audience.scope === "workspace" || audience.subject === "bob";
    });
    expect(domainVisible.map((r) => r.id).sort()).toEqual(bobSees.map((r) => r.id).sort());
  });

  it("the creator still sees both — the interactive turn stays exactly one member's", async () => {
    const aliceSees = await runs.list(tenant, { viewer: "alice", limit: 10 });
    expect(aliceSees.map((r) => r.class).sort()).toEqual(["background", "interactive"]);
  });
});
