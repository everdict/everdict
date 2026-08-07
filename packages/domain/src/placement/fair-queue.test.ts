import { describe, expect, it } from "vitest";
import { FairQueue } from "./fair-queue.js";

interface Item {
  tenant: string;
  id: string;
}
const q = (weightFor?: (t: string) => number) => new FairQueue<Item>({ tenantOf: (i) => i.tenant, weightFor });
const ids = (items: Item[]) => items.map((i) => i.id);

describe("FairQueue (WFQ)", () => {
  it("with equal weights, alternates between tenants (one tenant's bulk submission can't monopolize)", () => {
    const fq = q();
    fq.enqueue({ tenant: "A", id: "A0" });
    fq.enqueue({ tenant: "A", id: "A1" });
    fq.enqueue({ tenant: "A", id: "A2" });
    fq.enqueue({ tenant: "B", id: "B0" }); // even arriving late
    // vf: A0=1,A1=2,A2=3 / B0=1 → A0,B0 tie (input order), then A1,A2
    expect(ids(fq.ordered())).toEqual(["A0", "B0", "A1", "A2"]);
  });

  it("a higher-weight tenant is pulled more often", () => {
    const fq = q((t) => (t === "A" ? 2 : 1));
    fq.enqueue({ tenant: "A", id: "A0" }); // 0.5
    fq.enqueue({ tenant: "A", id: "A1" }); // 1.0
    fq.enqueue({ tenant: "A", id: "A2" }); // 1.5
    fq.enqueue({ tenant: "B", id: "B0" }); // 1.0
    expect(ids(fq.ordered())).toEqual(["A0", "A1", "B0", "A2"]);
  });

  it("an idle tenant can't accrue credit (the virtual clock advances)", () => {
    const fq = q();
    for (const id of ["A0", "A1", "A2"]) {
      fq.enqueue({ tenant: "A", id });
    }
    // Drain A in order → vclock advances to 3
    for (const id of ["A0", "A1", "A2"]) {
      const head = fq.ordered()[0];
      expect(head?.id).toBe(id);
      if (head) fq.remove(head);
    }
    // Now a new tenant C and A arrive at the same time → C doesn't monopolize priority for having been idle;
    // both start from the vclock (=3) reference, so it's fair in input order.
    fq.enqueue({ tenant: "C", id: "C0" }); // max(3,0)+1 = 4
    fq.enqueue({ tenant: "A", id: "A3" }); // max(3,3)+1 = 4
    expect(ids(fq.ordered())).toEqual(["C0", "A3"]);
  });

  it("stays in (vf, seq) order after removing a middle item and enqueuing more", () => {
    const fq = q();
    const a0 = { tenant: "A", id: "A0" }; // vf 1
    const b0 = { tenant: "B", id: "B0" }; // vf 1
    const a1 = { tenant: "A", id: "A1" }; // vf 2
    fq.enqueue(a0);
    fq.enqueue(b0);
    fq.enqueue(a1);
    expect(ids(fq.ordered())).toEqual(["A0", "B0", "A1"]);

    expect(fq.remove(b0)).toBe(true); // remove from the middle → advances the virtual clock to b0.vf
    expect(ids(fq.ordered())).toEqual(["A0", "A1"]);

    const b1 = { tenant: "B", id: "B1" }; // vf = max(vclock=1, lastVf[B]=1)+1 = 2 → ties A1 (earlier seq) → after it
    fq.enqueue(b1);
    expect(ids(fq.ordered())).toEqual(["A0", "A1", "B1"]);
  });

  it("promote moves an item to the fair-order front while keeping the sorted invariant", () => {
    const fq = q();
    const a0 = { tenant: "A", id: "A0" };
    const b0 = { tenant: "B", id: "B0" };
    const a1 = { tenant: "A", id: "A1" };
    fq.enqueue(a0);
    fq.enqueue(b0);
    fq.enqueue(a1);
    expect(ids(fq.ordered())).toEqual(["A0", "B0", "A1"]);

    expect(fq.promote(a1)).toBe(true);
    expect(ids(fq.ordered())).toEqual(["A1", "A0", "B0"]);

    // Fairness bookkeeping is untouched: a later enqueue lands by its own vf, never in front of the promoted head.
    fq.enqueue({ tenant: "B", id: "B1" });
    expect(ids(fq.ordered())[0]).toBe("A1");
    expect(ids(fq.ordered())).toContain("B1");
  });

  it("promote is a no-op true for the head and false for an unknown item; repeats stack newest-first", () => {
    const fq = q();
    const a0 = { tenant: "A", id: "A0" };
    const a1 = { tenant: "A", id: "A1" };
    const a2 = { tenant: "A", id: "A2" };
    fq.enqueue(a0);
    fq.enqueue(a1);
    fq.enqueue(a2);
    expect(fq.promote(a0)).toBe(true); // already the front
    expect(ids(fq.ordered())).toEqual(["A0", "A1", "A2"]);
    expect(fq.promote({ tenant: "A", id: "ghost" })).toBe(false);

    fq.promote(a1);
    fq.promote(a2); // promoted later → ahead of the earlier promotion
    expect(ids(fq.ordered())).toEqual(["A2", "A1", "A0"]);
  });

  it("observes per-tenant queue counts via queuedByTenant", () => {
    const fq = q();
    fq.enqueue({ tenant: "A", id: "A0" });
    fq.enqueue({ tenant: "A", id: "A1" });
    fq.enqueue({ tenant: "B", id: "B0" });
    expect(fq.queuedByTenant()).toEqual({ A: 2, B: 1 });
    expect(fq.size).toBe(3);
  });
});
