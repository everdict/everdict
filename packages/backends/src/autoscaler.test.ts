import { describe, expect, it } from "vitest";
import { Autoscaler, MutableSlots, aggregateLoad, desiredCapacity } from "./autoscaler.js";

const policy = { min: 1, max: 4 };

describe("desiredCapacity", () => {
  it("backlog 가 있으면 수요(inFlight+queued)만큼, max 로 클램프", () => {
    expect(desiredCapacity({ queued: 7, inFlight: 1 }, 1, policy)).toBe(4); // demand 8 → max 4
    expect(desiredCapacity({ queued: 2, inFlight: 1 }, 1, policy)).toBe(3);
  });
  it("완전 유휴면 min 으로", () => {
    expect(desiredCapacity({ queued: 0, inFlight: 0 }, 4, policy)).toBe(1);
    expect(desiredCapacity({ queued: 0, inFlight: 0 }, 4, { min: 0, max: 4 })).toBe(0); // scale-to-zero
  });
  it("과프로비전(진행중 < 현재, 대기 0)이면 진행중 수준으로 내려간다", () => {
    expect(desiredCapacity({ queued: 0, inFlight: 2 }, 4, policy)).toBe(2);
  });
});

describe("Autoscaler.tick", () => {
  it("backlog 가 생기면 즉시 업스케일하고 onChanged 로 스케줄러를 깨운다", async () => {
    const slots = new MutableSlots("nomad", 1);
    const scales: Array<[string, number, number]> = [];
    let poked = 0;
    const auto = new Autoscaler({
      signal: () => ({ queued: 7, inFlight: 1 }),
      targets: [slots],
      policy,
      onScale: (id, from, to) => scales.push([id, from, to]),
      onChanged: () => poked++,
    });
    await auto.tick();
    expect(slots.current()).toBe(4); // 1 → 4 즉시
    expect(scales).toEqual([["nomad", 1, 4]]);
    expect(poked).toBe(1);
  });

  it("다운스케일은 히스테리시스(연속 N틱) 이후에만 — 플래핑 방지", async () => {
    const slots = new MutableSlots("nomad", 4);
    const auto = new Autoscaler({
      signal: () => ({ queued: 0, inFlight: 0 }), // 유휴 → desired=min=1 < 4
      targets: [slots],
      policy: { min: 1, max: 4, scaleDownAfterTicks: 3 },
    });
    await auto.tick();
    expect(slots.current()).toBe(4); // 아직 (1틱)
    await auto.tick();
    expect(slots.current()).toBe(4); // 아직 (2틱)
    await auto.tick();
    expect(slots.current()).toBe(1); // 3틱 → 내려감
  });

  it("업스케일은 다운 카운터를 리셋한다", async () => {
    const slots = new MutableSlots("nomad", 2);
    let load = { queued: 0, inFlight: 0 };
    const auto = new Autoscaler({
      signal: () => load,
      targets: [slots],
      policy: { min: 1, max: 4, scaleDownAfterTicks: 2 },
    });
    await auto.tick(); // down 후보 1틱 (아직 2)
    load = { queued: 5, inFlight: 0 };
    await auto.tick(); // 업스케일 → 카운터 리셋, 4 로
    expect(slots.current()).toBe(4);
    load = { queued: 0, inFlight: 0 };
    await auto.tick(); // down 후보 1틱 (리셋되었으므로 아직 안 내려감)
    expect(slots.current()).toBe(4);
  });
});

describe("aggregateLoad", () => {
  it("백엔드별 in-flight 를 합산한다", () => {
    expect(aggregateLoad({ queued: 3, inFlight: { a: 2, b: 1 } })).toEqual({ queued: 3, inFlight: 3 });
  });
});
