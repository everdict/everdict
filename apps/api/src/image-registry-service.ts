import {
  BadRequestError,
  type ImageRegistryCoordinates,
  NotFoundError,
  type RegistryAuth,
  imageRegistryPrefix,
} from "@assay/core";
import type { WorkspaceSettings, WorkspaceSettingsStore } from "@assay/db";

// 워크스페이스 이미지 레지스트리(BYO, 복수) 서비스 — 하니스 이미지 분류 기준 + assay image push 발행 대상.
// 여러 개를 이름으로 등록하고, push 는 이름으로 선택(1개뿐이면 생략 가능), 분류/pull 인증은 전체를 host 매칭.
// 등록은 관리자(settings:write), 조회는 viewer+(harnesses:read — 분류는 하니스 읽기 관심사),
// push 자격증명 발급은 member+(images:push — 자격증명 '값' 유출은 별도 액션으로 정직하게 명명).
// 비밀은 SecretStore name-ref 만 저장/반환; 값은 pushCredentials 가 발급 시점에 resolve(비영속).
// HTTP 라우트와 MCP 도구가 이 코어를 공유. 설계: docs/architecture/workspace-image-registry.md

// 레지스트리 현황(비밀 없음 — 이름 참조/좌표만). imagePrefix = 클라이언트의 대상 ref 조립/분류용.
export interface ImageRegistryView {
  name: string;
  host: string;
  namespace?: string;
  username?: string;
  pullSecretName?: string;
  pushSecretName?: string;
  imagePrefix: string; // "host[/namespace]/"
}

// push 자격증명 — 호출자(assay image push / 에이전트)가 docker login+push 에 쓰고 버린다. 어디에도 영속 안 함.
export interface ImagePushCredentials {
  name: string;
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

type ImageRegistryEntry = NonNullable<WorkspaceSettings["imageRegistries"]>[number];

function toView(reg: ImageRegistryEntry): ImageRegistryView {
  const coords: ImageRegistryCoordinates = {
    host: reg.host,
    ...(reg.namespace ? { namespace: reg.namespace } : {}),
  };
  return {
    name: reg.name,
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

  // 현재 목록 — imageRegistries(복수)가 없으면 레거시 단수(imageRegistry)를 name="default" 로 승계해 읽는다.
  private async entries(workspace: string): Promise<ImageRegistryEntry[]> {
    const s = await this.deps.settings.get(workspace);
    if (s?.imageRegistries) return s.imageRegistries;
    return s?.imageRegistry ? [{ name: "default", ...s.imageRegistry }] : [];
  }

  async list(workspace: string): Promise<ImageRegistryView[]> {
    return (await this.entries(workspace)).map(toView);
  }

  // 분류용 좌표(비밀 없음) — 하니스 등록/검증의 imageWarnings 가 전체 레지스트리를 대상으로 host 매칭.
  async coordinates(workspace: string): Promise<ImageRegistryCoordinates[]> {
    return (await this.entries(workspace)).map((r) => ({
      host: r.host,
      ...(r.namespace ? { namespace: r.namespace } : {}),
    }));
  }

  // 등록/갱신(관리자, name 기준 upsert — 선언형 전체 교체: optional 필드 제거 가능해야 한다).
  // 첫 쓰기에서 레거시 단수 필드를 목록으로 승계하고 null 청산한다(이후 읽기는 imageRegistries 만).
  // 참조 시크릿 이름의 존재는 경고(missingSecrets)로만 드러낸다 — 시크릿은 나중에 넣을 수 있다.
  async upsert(
    workspace: string,
    input: {
      name: string;
      host: string;
      namespace?: string;
      username?: string;
      pullSecretName?: string;
      pushSecretName?: string;
    },
  ): Promise<{ config: ImageRegistryView; missingSecrets?: string[] }> {
    const entry: ImageRegistryEntry = {
      name: input.name,
      host: input.host,
      ...(input.namespace ? { namespace: input.namespace } : {}),
      ...(input.username ? { username: input.username } : {}),
      ...(input.pullSecretName ? { pullSecretName: input.pullSecretName } : {}),
      ...(input.pushSecretName ? { pushSecretName: input.pushSecretName } : {}),
    };
    const current = await this.entries(workspace);
    const next = [...current.filter((r) => r.name !== input.name), entry];
    await this.deps.settings.set(workspace, { imageRegistries: next, imageRegistry: null });
    const referenced = [input.pullSecretName, input.pushSecretName].filter((n): n is string => Boolean(n));
    let missingSecrets: string[] | undefined;
    if (referenced.length > 0) {
      const have = new Set(Object.keys(await this.deps.secretsFor(workspace)));
      const missing = referenced.filter((name) => !have.has(name));
      if (missing.length > 0) missingSecrets = missing;
    }
    return { config: toView(entry), ...(missingSecrets ? { missingSecrets } : {}) };
  }

  // 해제(관리자, 이름 지정).
  async remove(workspace: string, name: string): Promise<void> {
    const next = (await this.entries(workspace)).filter((r) => r.name !== name);
    await this.deps.settings.set(workspace, { imageRegistries: next, imageRegistry: null });
  }

  // pull 자격증명(디스패치 enrichment 용, best-effort) — pull 이 구성된 레지스트리 전부를 RegistryAuth 로.
  // 소비자(executeCase/디스패처)가 잡 이미지의 host 와 매칭해 하나를 고른다. 시크릿 부재 항목은 조용히 제외
  // (주입만 생략 — pull 이 정말 필요하면 다운스트림 docker 가 명확히 실패).
  async pullAuths(workspace: string): Promise<RegistryAuth[]> {
    const entries = await this.entries(workspace);
    const secrets = entries.some((r) => r.pullSecretName) ? await this.deps.secretsFor(workspace) : {};
    const auths: RegistryAuth[] = [];
    for (const reg of entries) {
      if (!reg.pullSecretName) continue;
      const password = secrets[reg.pullSecretName];
      if (password === undefined) continue;
      auths.push({ host: reg.host, ...(reg.username ? { username: reg.username } : {}), password });
    }
    return auths;
  }

  // push 자격증명 발급(member+, images:push) — name 으로 선택; 생략은 레지스트리가 정확히 1개일 때만 허용.
  // 레지스트리 없음/이름 불일치=404 · 복수인데 이름 생략=400 · push 미구성=400 · 시크릿 부재=404.
  async pushCredentials(workspace: string, name?: string): Promise<ImagePushCredentials> {
    const entries = await this.entries(workspace);
    if (entries.length === 0)
      throw new NotFoundError("NOT_FOUND", undefined, "이미지 레지스트리가 등록되지 않았습니다");
    let reg: ImageRegistryEntry | undefined;
    if (name !== undefined) {
      reg = entries.find((r) => r.name === name);
      if (!reg) throw new NotFoundError("NOT_FOUND", { name }, `등록되지 않은 레지스트리입니다: ${name}`);
    } else if (entries.length === 1) {
      reg = entries[0];
    } else {
      throw new BadRequestError(
        "BAD_REQUEST",
        { registries: entries.map((r) => r.name) },
        `레지스트리가 여러 개입니다 — 이름을 지정하세요: ${entries.map((r) => r.name).join(", ")}`,
      );
    }
    if (!reg) throw new NotFoundError("NOT_FOUND", undefined, "이미지 레지스트리가 등록되지 않았습니다");
    if (!reg.pushSecretName)
      throw new BadRequestError(
        "BAD_REQUEST",
        { name: reg.name },
        `레지스트리 "${reg.name}" 에 push 시크릿(pushSecretName)이 구성되지 않았습니다`,
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
      name: view.name,
      host: view.host,
      ...(view.namespace ? { namespace: view.namespace } : {}),
      ...(view.username ? { username: view.username } : {}),
      password,
      imagePrefix: view.imagePrefix,
    };
  }
}
