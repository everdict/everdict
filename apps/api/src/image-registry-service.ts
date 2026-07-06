import {
  BadRequestError,
  type ImageRegistryCoordinates,
  NotFoundError,
  type RegistryAuth,
  imageRegistryPrefix,
} from "@assay/core";
import type { WorkspaceSettings, WorkspaceSettingsStore } from "@assay/db";

// 워크스페이스 이미지 레지스트리(BYO) 서비스 — 하니스 이미지 분류 기준 + assay image push 발행 대상.
// 등록은 관리자(settings:write), 조회는 viewer+(harnesses:read — 분류는 하니스 읽기 관심사),
// push 자격증명 발급은 member+(images:push — 자격증명 '값' 유출은 별도 액션으로 정직하게 명명).
// 비밀은 SecretStore name-ref 만 저장/반환; 값은 pushCredentials 가 발급 시점에 resolve(비영속).
// HTTP 라우트와 MCP 도구가 이 코어를 공유. 설계: docs/architecture/workspace-image-registry.md

// 레지스트리 현황(비밀 없음 — 이름 참조/좌표만). imagePrefix = 클라이언트의 대상 ref 조립/분류용.
export interface ImageRegistryView {
  host: string;
  namespace?: string;
  username?: string;
  pullSecretName?: string;
  pushSecretName?: string;
  imagePrefix: string; // "host[/namespace]/"
}

// push 자격증명 — 호출자(assay image push / 에이전트)가 docker login+push 에 쓰고 버린다. 어디에도 영속 안 함.
export interface ImagePushCredentials {
  host: string;
  namespace?: string;
  username?: string;
  password: string; // pushSecretName 의 값(발급 시점 resolve)
  imagePrefix: string;
}

export interface ImageRegistryServiceDeps {
  settings: WorkspaceSettingsStore;
  secretsFor: (workspace: string) => Promise<Record<string, string>>; // 공유(workspace) 시크릿 티어
}

type ImageRegistrySettings = NonNullable<WorkspaceSettings["imageRegistry"]>;

function toView(reg: ImageRegistrySettings): ImageRegistryView {
  const coords: ImageRegistryCoordinates = {
    host: reg.host,
    ...(reg.namespace ? { namespace: reg.namespace } : {}),
  };
  return {
    host: reg.host,
    ...(reg.namespace ? { namespace: reg.namespace } : {}),
    ...(reg.username ? { username: reg.username } : {}),
    ...(reg.pullSecretName ? { pullSecretName: reg.pullSecretName } : {}),
    ...(reg.pushSecretName ? { pushSecretName: reg.pushSecretName } : {}),
    imagePrefix: imageRegistryPrefix(coords),
  };
}

export class ImageRegistryService {
  constructor(private readonly deps: ImageRegistryServiceDeps) {}

  async get(workspace: string): Promise<ImageRegistryView | undefined> {
    const reg = (await this.deps.settings.get(workspace))?.imageRegistry;
    return reg ? toView(reg) : undefined; // null(클리어됨) 또는 미설정
  }

  // 등록/갱신(관리자). PUT = 선언형 전체 교체(mattermost 의 부분 보존과 달리 — namespace 등 optional 제거 가능해야 한다).
  // 참조 시크릿 이름의 존재는 경고(missingSecrets)로만 드러낸다 — 시크릿은 나중에 넣을 수 있다(런타임 등록과 동일 관례).
  async set(
    workspace: string,
    input: {
      host: string;
      namespace?: string;
      username?: string;
      pullSecretName?: string;
      pushSecretName?: string;
    },
  ): Promise<{ config: ImageRegistryView; missingSecrets?: string[] }> {
    const next: ImageRegistrySettings = {
      host: input.host,
      ...(input.namespace ? { namespace: input.namespace } : {}),
      ...(input.username ? { username: input.username } : {}),
      ...(input.pullSecretName ? { pullSecretName: input.pullSecretName } : {}),
      ...(input.pushSecretName ? { pushSecretName: input.pushSecretName } : {}),
    };
    await this.deps.settings.set(workspace, { imageRegistry: next });
    const referenced = [input.pullSecretName, input.pushSecretName].filter((n): n is string => Boolean(n));
    let missingSecrets: string[] | undefined;
    if (referenced.length > 0) {
      const have = new Set(Object.keys(await this.deps.secretsFor(workspace)));
      const missing = referenced.filter((name) => !have.has(name));
      if (missing.length > 0) missingSecrets = missing;
    }
    return { config: toView(next), ...(missingSecrets ? { missingSecrets } : {}) };
  }

  // 해제(관리자). jsonb 병합 || 은 키 삭제 불가라 null 로 무효화한다(읽을 때 undefined 취급).
  async clear(workspace: string): Promise<void> {
    await this.deps.settings.set(workspace, { imageRegistry: null });
  }

  // pull 자격증명(디스패치 enrichment 용, best-effort) — pullSecretName 값을 resolve 해 RegistryAuth 로.
  // 미등록/pull 미구성/시크릿 부재면 undefined(주입만 생략 — pull 이 정말 필요하면 다운스트림 docker 가 명확히 실패).
  // 호출자: executeCase(job.registryAuth attach) + RuntimeDispatcher(topology 백엔드 빌드).
  async pullAuth(workspace: string): Promise<RegistryAuth | undefined> {
    const reg = (await this.deps.settings.get(workspace))?.imageRegistry;
    if (!reg?.pullSecretName) return undefined;
    const secrets = await this.deps.secretsFor(workspace);
    const password = secrets[reg.pullSecretName];
    if (password === undefined) return undefined;
    return { host: reg.host, ...(reg.username ? { username: reg.username } : {}), password };
  }

  // push 자격증명 발급(member+, images:push) — pushSecretName 값을 워크스페이스 시크릿에서 resolve 해 반환.
  // 호출자는 이 값으로 docker login+push 하고 버린다. 레지스트리 미등록=404 · push 미구성=400 · 시크릿 부재=404.
  async pushCredentials(workspace: string): Promise<ImagePushCredentials> {
    const reg = (await this.deps.settings.get(workspace))?.imageRegistry;
    if (!reg) throw new NotFoundError("NOT_FOUND", undefined, "이미지 레지스트리가 등록되지 않았습니다");
    if (!reg.pushSecretName)
      throw new BadRequestError(
        "BAD_REQUEST",
        undefined,
        "이미지 레지스트리에 push 시크릿(pushSecretName)이 구성되지 않았습니다",
      );
    const secrets = await this.deps.secretsFor(workspace);
    const password = secrets[reg.pushSecretName];
    if (password === undefined)
      throw new NotFoundError(
        "NOT_FOUND",
        { secretName: reg.pushSecretName },
        `push 시크릿 "${reg.pushSecretName}" 이 워크스페이스 SecretStore 에 없습니다`,
      );
    const view = toView(reg);
    return {
      host: view.host,
      ...(view.namespace ? { namespace: view.namespace } : {}),
      ...(view.username ? { username: view.username } : {}),
      password,
      imagePrefix: view.imagePrefix,
    };
  }
}
