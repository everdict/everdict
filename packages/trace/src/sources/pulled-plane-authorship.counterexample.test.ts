import { EVERDICT_ATTR } from "@everdict/contracts";
import { describe, expect, it } from "vitest";
import { spansToTraceEvents } from "./trace-source.js";

// ── A PRODUCER NAMED THE PLANE, AND THE PLATFORM PROJECTED IT AS ITS OWN RECORD ──────────────────
//
// `spansToEvents` reads `everdict.plane` off a span's attributes, and when it says `placement` it emits a
// `kind: "infra"` event — a record the PLATFORM authors, describing where a run was placed, with `unit` and
// `node` taken from the same attribute bag.
//
// That is right for spans the platform produced. The PULL path is different: `POST /scorecards/ingest/pull`
// fetches spans from a tenant's own observability platform and forwards the adapter's bag verbatim — the
// code's comment said so plainly, "keeping the merge here is honest about what we actually received". It is
// honest, and it was the whole problem: what we received came from whatever wrote spans to that platform,
// which includes the harness under test. Nothing stripped the field in between —
// `stripPlatformAuthoredFields` removes artifact refs and size fields and never touches span attributes, and
// `pnpm untrusted-ingress` asks which SCHEMA a door parses with, while here the schema is right and the
// danger lives in an attribute VALUE. Found by `pnpm scan` over `packages/domain`.
//
// The repair is the one the authorship law prescribes and not a validator: the platform's own attributes are
// stripped at the pull boundary, so a pulled trace cannot carry a placement plane at all. The platform said
// nothing about where that run was placed, and silence is the honest answer.

const pulled = (attrs: Record<string, unknown>) => [{ spanId: "s1", name: "agent step", startMs: 0, endMs: 5, attrs }];

describe("a pulled span cannot author a platform-owned projection", () => {
  it("refuses a forged placement plane, so no infra record is minted from producer attributes", () => {
    const events = spansToTraceEvents(
      pulled({
        [EVERDICT_ATTR.plane]: "placement",
        "k8s.pod.name": "attacker-pod",
        "k8s.node.name": "attacker-node",
      }),
    );
    // The forged plane must not become the platform's own record of where the run was placed.
    expect(events.some((e) => e.kind === "infra")).toBe(false);
    // What matters is PROMOTION, not presence: a producer keeping its own `k8s.*` attributes on its own span
    // is ordinary, and stripping them would be editing the trace we were asked to read. The defect was those
    // values being lifted into the platform's `unit` / `node` fields on a record the platform authors.
    for (const event of events) {
      expect(event).not.toHaveProperty("unit");
      expect(event).not.toHaveProperty("node");
      expect(event).not.toHaveProperty("scope", "placement");
    }
  });

  it("still projects the ordinary content a pulled span legitimately carries", () => {
    const events = spansToTraceEvents(
      pulled({ "gen_ai.operation.name": "chat", "gen_ai.request.model": "gpt-4o", "gen_ai.usage.input_tokens": 11 }),
    );
    // The repair must not swallow the lane it guards: a normal pulled span still becomes its event.
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).toContain("gpt-4o");
  });

  // ⚠️ SCOPE, STATED SO THE NEXT READER DOES NOT ASSUME MORE THAN WAS DECIDED. Only the PLANE is stripped
  // here. `everdict.cost.usd` is the other candidate — its own definition says the GenAI conventions stop at
  // tokens and leave cost to the platform, and the graders read it — but on the pull path the tenant's
  // observability platform is a plausible legitimate author of a price, which is not true of a placement
  // plane the platform alone assigns. Deciding that is a separate change with its own argument; asserting it
  // here would freeze a guess.
  it("leaves attributes whose authorship on the pull path is not settled", () => {
    const events = spansToTraceEvents(
      pulled({ [EVERDICT_ATTR.costUsd]: 0.42, "gen_ai.operation.name": "chat", "gen_ai.request.model": "m" }),
    );
    expect(events.length).toBeGreaterThan(0);
  });
});
