import { BadRequestError } from "./errors.js";
import type { HarnessSpec } from "./harness-spec.js";

// 이미지 참조 분류 — 워크스페이스 레지스트리 관점에서 이 이미지가 "어디 것"인가.
// workspace  = 워크스페이스 레지스트리(host+namespace 일치) — 자격만 있으면 어디서든 pull 가능.
// external   = 명시 외부 호스트(ghcr.io/… 등) 또는 org/name 형태(docker.io 암시) — 공개/외부 소스.
// local      = 명시 루프백 호스트(localhost:5000/… 등) — 빌드/푸시된 머신에만 존재.
// unqualified= 단일 세그먼트 이름(spreadsheetbench:v1·postgres:16-alpine) — 로컬 데몬 빌드인지
//              Docker Hub library 인지 문법으로 판별 불가(모호함 자체를 클래스로 명명).
// placement 관점: local+unqualified = pull 보장 없음, workspace+external = pull 가능(인증 전제).
// 설계: docs/architecture/workspace-image-registry.md
export type ImageRefClass = "workspace" | "external" | "local" | "unqualified";

// 워크스페이스 레지스트리 좌표(비밀 없음) — WorkspaceSettings.imageRegistry 의 분류용 부분집합.
export interface ImageRegistryCoordinates {
  host: string; // 레지스트리 host[:port] — "ghcr.io" · "registry.acme.dev:5000"
  namespace?: string; // host 아래 경로 프리픽스 — "acme" → ghcr.io/acme/<name>:<tag>
}

// docker reference 문법으로 분해한 이미지 참조. host 는 첫 경로 컴포넌트가
// '.'/':' 를 포함하거나 "localhost" 일 때만 레지스트리 호스트다(docker 규칙 그대로).
export interface ParsedImageRef {
  host?: string;
  path: string; // host 뒤 이름 경로(태그/다이제스트 제외)
  tag?: string;
  digest?: string;
}

export function parseImageRef(ref: string): ParsedImageRef {
  const trimmed = ref.trim();
  if (!trimmed) throw new BadRequestError("BAD_REQUEST", undefined, "빈 이미지 참조는 분류할 수 없습니다");
  // 다이제스트(@sha256:…)를 먼저 떼어낸다 — 태그의 ':' 탐색과 섞이지 않도록.
  const atIndex = trimmed.indexOf("@");
  const digest = atIndex >= 0 ? trimmed.slice(atIndex + 1) : undefined;
  let rest = atIndex >= 0 ? trimmed.slice(0, atIndex) : trimmed;
  // 태그 = 마지막 '/' 뒤에 오는 ':' — 호스트 포트(localhost:5000/x)와 혼동 방지.
  const lastSlash = rest.lastIndexOf("/");
  const colonIndex = rest.indexOf(":", lastSlash + 1);
  const tag = colonIndex >= 0 ? rest.slice(colonIndex + 1) : undefined;
  rest = colonIndex >= 0 ? rest.slice(0, colonIndex) : rest;
  const firstSlash = rest.indexOf("/");
  const firstComponent = firstSlash >= 0 ? rest.slice(0, firstSlash) : rest;
  const isHost =
    firstSlash >= 0 && (firstComponent.includes(".") || firstComponent.includes(":") || firstComponent === "localhost");
  return {
    ...(isHost ? { host: firstComponent } : {}),
    path: isHost ? rest.slice(firstSlash + 1) : rest,
    ...(tag ? { tag } : {}),
    ...(digest ? { digest } : {}),
  };
}

// 루프백 호스트인가 — 이 레지스트리 참조는 그 머신 밖에선 의미가 없다.
function isLoopbackHost(host: string): boolean {
  const name = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":")[0];
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

export function classifyImageRef(ref: string, registry?: ImageRegistryCoordinates): ImageRefClass {
  const parsed = parseImageRef(ref);
  if (parsed.host) {
    if (isLoopbackHost(parsed.host)) return "local";
    if (
      registry &&
      parsed.host === registry.host &&
      (!registry.namespace || parsed.path === registry.namespace || parsed.path.startsWith(`${registry.namespace}/`))
    )
      return "workspace";
    return "external";
  }
  // 호스트 없음: org/name 은 docker.io 암시(외부), 단일 세그먼트는 모호(unqualified).
  return parsed.path.includes("/") ? "external" : "unqualified";
}

// 레지스트리 이미지 프리픽스 — "host[/namespace]/". 클라이언트가 대상 ref 를 조립할 때 쓴다.
export function imageRegistryPrefix(registry: ImageRegistryCoordinates): string {
  return registry.namespace ? `${registry.host}/${registry.namespace}/` : `${registry.host}/`;
}

// (resolve 된) 하니스 스펙이 참조하는 모든 이미지 — service 는 서비스별, command 는 디스패치 이미지.
export function collectHarnessImages(spec: HarnessSpec): string[] {
  if (spec.kind === "service") return spec.services.map((s) => s.image);
  if (spec.kind === "command") return spec.image ? [spec.image] : [];
  return []; // process — 이미지 참조 없음(코드 어댑터)
}

// pull 보장이 없는 이미지 경고 — 등록/검증 응답의 imageWarnings(warn-not-block, missingSecrets 관례와 동일).
export interface ImageWarning {
  image: string;
  class: Extract<ImageRefClass, "local" | "unqualified">;
}

export function imageWarnings(images: string[], registry?: ImageRegistryCoordinates): ImageWarning[] {
  const warnings: ImageWarning[] = [];
  for (const image of images) {
    const cls = classifyImageRef(image, registry);
    if (cls === "local" || cls === "unqualified") warnings.push({ image, class: cls });
  }
  return warnings;
}
