import { BadRequestError, type HarnessInstanceSpec } from "@everdict/core";
import type { HarnessInstanceRegistry } from "@everdict/registry";
import { z } from "zod";

// durable 재핀(re-pin) — 기준 인스턴스의 pins 위에 요청 핀을 병합해 "새 인스턴스 버전"으로 등록한다.
// CI(dev/main 머지)가 자기 서비스 슬롯만 갈아끼우는 headless 경로: 웹의 "새 버전 만들기(re-pin)" 플로우와 동일 의미.
// 멱등: 병합 결과가 기준과 동일하면 등록 없이 unchanged 로 응답(같은 커밋 재발사에 버전 스팸 없음).
// 설계: docs/architecture/github-actions-trigger.md (D2).

export const RepinBodySchema = z.object({
  // 슬롯→이미지 ref. 모노레포 CI 는 바뀐 서비스들을 한 호출에 담아 정확히 버전 하나(vN+1)만 만든다.
  pins: z.record(z.string().min(1)).refine((p) => Object.keys(p).length > 0, "pins 가 비어 있습니다."),
  version: z.string().min(1).optional(), // 명시 버전(예: "dev-<sha>"). 미지정이면 자동(semver patch bump / -r<n>)
  base: z.string().min(1).optional(), // 기준 인스턴스 버전(기본 latest)
  // 기본은 digest 핀 강제(@sha256:…) — tag 는 움직여서 스코어카드 재현성/리더보드 비교가 깨진다. 명시 opt-out 만 허용.
  allowTags: z.boolean().default(false),
});
export type RepinBody = z.infer<typeof RepinBodySchema>;

export interface RepinResult {
  workspace: string;
  id: string;
  version: string; // 등록된(또는 unchanged 인 기준) 인스턴스 버전
  base: string; // 병합 기준이 된 인스턴스 버전
  unchanged: boolean; // true = 병합 결과가 기준과 동일 → 등록 생략(멱등)
  pins: Record<string, string>; // 병합 후 전체 pins
}

const DIGEST_RE = /@sha256:[0-9a-f]{64}$/;

// 자동 버전: 기준이 semver 면 patch bump(충돌 시 계속 +1), 아니면 "-r<n>" 접미사. 명시 version 이 항상 우선.
function nextVersion(base: string, taken: ReadonlySet<string>): string {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(base);
  if (m) {
    let patch = Number(m[3]) + 1;
    while (taken.has(`${m[1]}.${m[2]}.${patch}`)) patch += 1;
    return `${m[1]}.${m[2]}.${patch}`;
  }
  let n = 2;
  while (taken.has(`${base}-r${n}`)) n += 1;
  return `${base}-r${n}`;
}

export async function repinHarnessImages(
  instances: HarnessInstanceRegistry,
  tenant: string,
  subject: string | undefined,
  id: string,
  body: RepinBody,
): Promise<RepinResult> {
  if (!body.allowTags) {
    for (const [slot, image] of Object.entries(body.pins)) {
      if (!DIGEST_RE.test(image)) {
        throw new BadRequestError(
          "BAD_REQUEST",
          { slot, image },
          `핀 '${slot}' 이 digest 형식이 아닙니다(@sha256:… 필요). tag 는 움직여 재현성이 깨집니다 — 의도라면 allowTags:true.`,
        );
      }
    }
  }

  const base = await instances.getInstance(tenant, id, body.base ?? "latest"); // 없으면 404
  // 병합 결과가 resolve 가능한지(알 수 없는 슬롯/핀 누락) 등록 전에 검증 — 실패 시 아무것도 등록하지 않는다.
  await instances.resolveWithPins(tenant, id, base.version, body.pins);

  const merged = { ...base.pins, ...body.pins };
  const unchanged = Object.keys(merged).every((k) => base.pins[k] === merged[k]);
  if (unchanged && body.version === undefined) {
    return { workspace: tenant, id, version: base.version, base: base.version, unchanged: true, pins: merged };
  }

  const taken = new Set(await instances.versions(tenant, id));
  const version = body.version ?? nextVersion(base.version, taken);
  const next: HarnessInstanceSpec = { ...base, version, pins: merged };
  await instances.register(tenant, next, subject); // 동일 내용 재등록=no-op, 다른 내용 같은 버전=409(불변)
  return { workspace: tenant, id, version, base: base.version, unchanged: false, pins: merged };
}
