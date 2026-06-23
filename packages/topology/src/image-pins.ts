import { createHash } from "node:crypto";
import { BadRequestError, type ServiceHarnessSpec } from "@assay/core";

// 핀 맵을 결정적 문자열로(키 정렬) — 같은 핀이면 같은 해시, 다른 핀이면 다른 해시.
function stableStringify(pins: Record<string, string>): string {
  return JSON.stringify(Object.entries(pins).sort((a, b) => a[0].localeCompare(b[0])));
}

// per-dispatch 이미지 핀 적용(#5) — 서비스명 → 이미지 override. 핀이 있으면 warm 풀이 섞이지 않도록
// effective version 에 결정적 접미사(-pin-<hash>)를 붙여 별개 토폴로지 정체성으로 만든다
// (topologyJobId 가 id@version 키이므로 런타임을 건드리지 않고 warm 풀이 자동 분리된다 — instance 모델과 동일).
export function applyImagePins(spec: ServiceHarnessSpec, pins?: Record<string, string>): ServiceHarnessSpec {
  if (!pins || Object.keys(pins).length === 0) return spec;
  const names = new Set(spec.services.map((s) => s.name));
  for (const name of Object.keys(pins)) {
    if (!names.has(name)) {
      throw new BadRequestError(
        "BAD_REQUEST",
        { service: name, known: [...names] },
        `이미지 핀 대상 서비스 '${name}' 가 토폴로지에 없습니다.`,
      );
    }
  }
  const services = spec.services.map((s) => {
    const image = pins[s.name];
    return image ? { ...s, image } : s;
  });
  const suffix = createHash("sha1").update(stableStringify(pins)).digest("hex").slice(0, 8);
  return { ...spec, version: `${spec.version}-pin-${suffix}`, services };
}
