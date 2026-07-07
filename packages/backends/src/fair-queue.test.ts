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

  it("observes per-tenant queue counts via queuedByTenant", () => {
    const fq = q();
    fq.enqueue({ tenant: "A", id: "A0" });
    fq.enqueue({ tenant: "A", id: "A1" });
    fq.enqueue({ tenant: "B", id: "B0" });
    expect(fq.queuedByTenant()).toEqual({ A: 2, B: 1 });
    expect(fq.size).toBe(3);
  });
});
