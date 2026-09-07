import { describe, expect, it } from "vitest";
import { memberEventFieldsSchema } from "./server.js";

// ── A MEMBER COULD SILENCE ONE NAMED AGENT BY NAMING IT ──────────────────────────────────────────
//
// `causedBy` is the activation loop guard's key. `agent-activation.ts` skips an agent whose id prefixes it:
//
//     if (event.causedBy?.startsWith(`agent:${entry.id}:`)) continue;
//
// so an agent never wakes on its own effects. The PLATFORM stamps that string where it means something — a
// checkpoint verifier, a record's creator, an agent-authored workspace-file publish.
//
// `POST /agent/events` has two branches — an internal-token one and a member-authenticated one — and both
// parsed one schema that carried `causedBy`. So any workspace member could post
// `causedBy: "agent:<id>:anything"` and suppress that agent's activation for that event. Nothing errors,
// nothing is logged as a refusal, and the agent simply does not react: a denial of service against one named
// agent, spelled as a well-formed request, available to anyone who can call the endpoint at all.
//
// It is the authorship law — a field the platform authors, riding on a document a producer submits, then
// acted on — and `pnpm untrusted-ingress` cannot see it: that check asks which schema a door parses with,
// and here the schema was the door's own, faithfully carrying a field it should never have accepted from
// that caller. Found by `pnpm scan` over files nobody had touched.

// ⚠️ WHAT THIS TEST DOES AND DOES NOT PROVE, stated because the difference matters. It pins the member
// SURFACE: the field is absent from the shape, so a later edit that adds it back fails here. Against the
// pre-fix source it fails only because the export did not exist — the schema was a local inside
// `buildServer` — so it is a regression guard rather than a reproduction of the original request. What ties
// the surface to the door is one line in `server.ts` (`const eventFieldsSchema = memberEventFieldsSchema`),
// and a door-level counterexample would need an `AgentActivator` with a registry and a key store, whose
// setup would be most of the test. The narrower assertion is the one that stays true when that setup
// changes.
describe("the member event surface cannot author a platform field", () => {
  it("strips a forged causedBy instead of forwarding it to the loop guard", () => {
    const parsed = memberEventFieldsSchema.parse({
      kind: "scorecard.completed",
      message: "sc-1 finished",
      causedBy: "agent:agt_victim:forged",
    });
    // The forged value must not survive the door. Everything downstream reads `causedBy` off this object.
    expect(parsed).not.toHaveProperty("causedBy");
    expect(JSON.stringify(parsed)).not.toContain("agt_victim");
  });

  it("still carries every field a member is entitled to send", () => {
    const parsed = memberEventFieldsSchema.parse({
      kind: "run.failed",
      message: "run r-9 failed",
      source: "run r-9",
      eventId: "ev-9",
      subject: { type: "run", id: "r-9" },
      payload: { attempt: 2 },
    });
    expect(parsed).toEqual({
      kind: "run.failed",
      message: "run r-9 failed",
      source: "run r-9",
      eventId: "ev-9",
      subject: { type: "run", id: "r-9" },
      payload: { attempt: 2 },
    });
  });

  // The field is absent from the SHAPE, not merely stripped from one payload — so a later edit that adds it
  // back to the member surface fails here rather than at a customer.
  it("declares no platform-authored field on the member surface", () => {
    expect(Object.keys(memberEventFieldsSchema.shape)).not.toContain("causedBy");
  });
});
