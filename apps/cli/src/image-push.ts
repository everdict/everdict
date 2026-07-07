import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BadRequestError, UpstreamError, dockerAuthConfigJson, parseImageRef } from "@everdict/core";
import { z } from "zod";

const pexecFile = promisify(execFile);

// everdict image push — 로컬 빌드 이미지를 워크스페이스 레지스트리로 발행한다.
// 컨트롤플레인에서 push 자격증명을 발급받아(POST /workspace/image-registries/push-credentials[?name=], images:push)
// 이 머신의 docker 로 tag+push. 레지스트리가 여러 개면 --registry <name> 으로 선택(1개뿐이면 생략 가능). 자격증명은 임시 DOCKER_CONFIG 디렉터리에만 쓰고 끝나면 지운다
// (~/.docker/config.json 을 읽지도 쓰지도 않음). 설계: docs/architecture/workspace-image-registry.md

// push 자격증명 응답(비영속) — 컨트롤플레인 계약과 동일 형태.
const PushCredentialsSchema = z.object({
  name: z.string().min(1).optional(), // 발급된 레지스트리 이름(복수 레지스트리 식별용)
  host: z.string().min(1),
  namespace: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1),
  imagePrefix: z.string().min(1),
});
export type PushCredentials = z.infer<typeof PushCredentialsSchema>;

// 대상 ref 조립 — imagePrefix("host[/namespace]/") 아래로, name/tag 는 로컬 ref 에서 기본값을 얻는다.
// 예: prefix=ghcr.io/acme/ + local=spreadsheetbench:v1 → ghcr.io/acme/spreadsheetbench:v1
export function buildImageTargetRef(imagePrefix: string, localRef: string, name?: string, tag?: string): string {
  const parsed = parseImageRef(localRef);
  const segments = parsed.path.split("/");
  const defaultName = segments[segments.length - 1];
  if (!defaultName)
    throw new BadRequestError("BAD_REQUEST", { localRef }, "로컬 이미지 참조에서 이름을 얻지 못했습니다");
  const finalName = name ?? defaultName;
  const finalTag = tag ?? parsed.tag ?? "latest";
  return `${imagePrefix}${finalName}:${finalTag}`;
}

// 임시 DOCKER_CONFIG 용 config.json — core dockerAuthConfigJson(pull 경로와 같은 빌더)에 위임.
export function buildDockerAuthConfig(credentials: Pick<PushCredentials, "host" | "username" | "password">): string {
  return dockerAuthConfigJson({
    host: credentials.host,
    ...(credentials.username ? { username: credentials.username } : {}),
    password: credentials.password,
  });
}

// 컨트롤플레인에서 push 자격증명 발급 — 실패는 에러 봉투 message 를 그대로 살려 사용자에게 보인다.
export async function fetchPushCredentials(
  apiUrl: string,
  apiKey: string,
  registry?: string,
): Promise<PushCredentials> {
  const url = new URL("/workspace/image-registries/push-credentials", apiUrl);
  if (registry) url.searchParams.set("name", registry);
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${apiKey}` } });
  } catch (e) {
    throw new UpstreamError("UPSTREAM_ERROR", { url: url.toString() }, `컨트롤플레인 연결 실패: ${String(e)}`);
  }
  const body = (await res.json().catch(() => ({}))) as { credentials?: unknown; message?: string };
  if (!res.ok)
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { status: res.status },
      body.message ?? `push 자격증명 발급 실패(HTTP ${res.status})`,
    );
  return PushCredentialsSchema.parse(body.credentials);
}

interface ImagePushIo {
  log: (message: string) => void;
  docker: (args: string[], env?: Record<string, string>) => Promise<void>;
}

const defaultDocker = async (args: string[], env?: Record<string, string>): Promise<void> => {
  try {
    // 진행 출력은 버퍼로 받되 실패 시 stderr 를 살려 보여준다(푸시는 수 분 걸릴 수 있어 무소음이 아님을 로그로 안내).
    await pexecFile("docker", args, { env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    const stderr = e instanceof Error && "stderr" in e ? String((e as { stderr?: unknown }).stderr ?? "") : "";
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { args: args.join(" ") },
      `docker ${args[0]} 실패: ${stderr || String(e)}`,
    );
  }
};

// tag → 임시 DOCKER_CONFIG 로그인 파일 → push → 정리(finally). 성공 시 발행된 ref 를 돌려준다.
export async function pushImage(
  credentials: PushCredentials,
  localRef: string,
  opts: { name?: string; tag?: string; io?: ImagePushIo } = {},
): Promise<string> {
  const io: ImagePushIo = opts.io ?? { log: (m) => console.error(m), docker: defaultDocker };
  const target = buildImageTargetRef(credentials.imagePrefix, localRef, opts.name, opts.tag);
  io.log(`▶ docker tag ${localRef} ${target}`);
  await io.docker(["tag", localRef, target]);
  const configDir = await mkdtemp(join(tmpdir(), "everdict-docker-"));
  try {
    await writeFile(join(configDir, "config.json"), buildDockerAuthConfig(credentials), { mode: 0o600 });
    io.log(`▶ docker push ${target} (자격증명: 임시 DOCKER_CONFIG, 종료 후 삭제)`);
    await io.docker(["--config", configDir, "push", target]);
  } finally {
    await rm(configDir, { recursive: true, force: true });
  }
  return target;
}

// everdict image push <local-ref> [--registry R] [--name N] [--tag T] [--api-url URL] [--api-key ak_…]
export async function imagePushCommand(localRef: string | undefined, flags: Map<string, string>): Promise<void> {
  if (!localRef)
    throw new BadRequestError(
      "BAD_REQUEST",
      undefined,
      "발행할 로컬 이미지 참조가 필요합니다 — everdict image push <ref>",
    );
  const apiUrl = flags.get("api-url") ?? process.env.EVERDICT_API_URL ?? "http://localhost:8787";
  const apiKey = flags.get("api-key") ?? process.env.EVERDICT_API_KEY;
  if (!apiKey)
    throw new BadRequestError("BAD_REQUEST", undefined, "--api-key <ak_…> (또는 EVERDICT_API_KEY) 가 필요합니다");
  const credentials = await fetchPushCredentials(apiUrl, apiKey, flags.get("registry"));
  const target = await pushImage(credentials, localRef, { name: flags.get("name"), tag: flags.get("tag") });
  console.error("✓ 발행 완료 — 하니스 핀/서비스 이미지로 이 참조를 쓰세요:");
  console.log(target);
}
