import { describe, expect, it } from "vitest";
import { FairQueue } from "./fair-queue.js";

interface Item {
  tenant: string;
  id: string;
}
const q = (weightFor?: (t: string) => number) => new FairQueue<Item>({ tenantOf: (i) => i.tenant, weightFor });
const ids = (items: Item[]) => items.map((i) => i.id);

describe("FairQueue (WFQ)", () => {
  it("동일 가중치면 테넌트 간을 번갈아 뽑는다 (한 테넌트의 대량 제출이 독점 못 함)", () => {
    const fq = q();
    fq.enqueue({ tenant: "A", id: "A0" });
    fq.enqueue({ tenant: "A", id: "A1" });
    fq.enqueue({ tenant: "A", id: "A2" });
    fq.enqueue({ tenant: "B", id: "B0" }); // 늦게 와도
    // vf: A0=1,A1=2,A2=3 / B0=1 → A0,B0 동률(입력순), 이후 A1,A2
    expect(ids(fq.ordered())).toEqual(["A0", "B0", "A1", "A2"]);
  });

  it("가중치가 큰 테넌트가 더 자주 뽑힌다", () => {
    const fq = q((t) => (t === "A" ? 2 : 1));
    fq.enqueue({ tenant: "A", id: "A0" }); // 0.5
    fq.enqueue({ tenant: "A", id: "A1" }); // 1.0
    fq.enqueue({ tenant: "A", id: "A2" }); // 1.5
    fq.enqueue({ tenant: "B", id: "B0" }); // 1.0
    expect(ids(fq.ordered())).toEqual(["A0", "A1", "B0", "A2"]);
  });

  it("쉬던 테넌트는 크레딧을 쌓지 못한다 (가상 시계가 전진)", () => {
    const fq = q();
    for (const id of ["A0", "A1", "A2"]) {
      fq.enqueue({ tenant: "A", id });
    }
    // A 를 순서대로 소진 → vclock 이 3 까지 전진
    for (const id of ["A0", "A1", "A2"]) {
      const head = fq.ordered()[0];
      expect(head?.id).toBe(id);
      if (head) fq.remove(head);
    }
    // 이제 새 테넌트 C 와 A 가 동시에 도착 → C 가 오래 쉬었다고 우선권을 독식하지 않고
    // 둘 다 vclock(=3) 기준에서 출발하므로 입력 순서대로 공정.
    fq.enqueue({ tenant: "C", id: "C0" }); // max(3,0)+1 = 4
    fq.enqueue({ tenant: "A", id: "A3" }); // max(3,3)+1 = 4
    expect(ids(fq.ordered())).toEqual(["C0", "A3"]);
  });

  it("queuedByTenant 로 테넌트별 대기 수를 관측한다", () => {
    const fq = q();
    fq.enqueue({ tenant: "A", id: "A0" });
    fq.enqueue({ tenant: "A", id: "A1" });
    fq.enqueue({ tenant: "B", id: "B0" });
    expect(fq.queuedByTenant()).toEqual({ A: 2, B: 1 });
    expect(fq.size).toBe(3);
  });
});
