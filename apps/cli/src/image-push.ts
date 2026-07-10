import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { BadRequestError, UpstreamError } from "@everdict/contracts";
import { dockerAuthConfigJson, parseImageRef } from "@everdict/domain";
import { z } from "zod";

const pexecFile = promisify(execFile);

// everdict image push — publish a locally built image to the workspace registry.
// Mint push credentials from the control plane (POST /workspace/image-registries/push-credentials[?name=], images:push)
// and tag+push with this machine's docker. When there are multiple registries, select one with --registry <name> (omit if there is only one). Credentials are written only to a temporary DOCKER_CONFIG directory and deleted when done
// (~/.docker/config.json is neither read nor written). Design: docs/architecture/workspace-image-registry.md

// push credentials response (non-persistent) — same shape as the control-plane contract.
const PushCredentialsSchema = z.object({
  name: z.string().min(1).optional(), // minted registry name (to identify one of multiple registries)
  host: z.string().min(1),
  namespace: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  password: z.string().min(1),
  imagePrefix: z.string().min(1),
});
export type PushCredentials = z.infer<typeof PushCredentialsSchema>;

// Assemble the target ref — under imagePrefix ("host[/namespace]/"), name/tag default from the local ref.
// e.g. prefix=ghcr.io/acme/ + local=spreadsheetbench:v1 → ghcr.io/acme/spreadsheetbench:v1
export function buildImageTargetRef(imagePrefix: string, localRef: string, name?: string, tag?: string): string {
  const parsed = parseImageRef(localRef);
  const segments = parsed.path.split("/");
  const defaultName = segments[segments.length - 1];
  if (!defaultName)
    throw new BadRequestError("BAD_REQUEST", { localRef }, "could not derive a name from the local image reference");
  const finalName = name ?? defaultName;
  const finalTag = tag ?? parsed.tag ?? "latest";
  return `${imagePrefix}${finalName}:${finalTag}`;
}

// config.json for the temporary DOCKER_CONFIG — delegates to core dockerAuthConfigJson (the same builder as the pull path).
export function buildDockerAuthConfig(credentials: Pick<PushCredentials, "host" | "username" | "password">): string {
  return dockerAuthConfigJson({
    host: credentials.host,
    ...(credentials.username ? { username: credentials.username } : {}),
    password: credentials.password,
  });
}

// Mint push credentials from the control plane — on failure, surface the error-envelope message verbatim to the user.
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
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { url: url.toString() },
      `failed to reach the control plane: ${String(e)}`,
    );
  }
  const body = (await res.json().catch(() => ({}))) as { credentials?: unknown; message?: string };
  if (!res.ok)
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { status: res.status },
      body.message ?? `failed to mint push credentials (HTTP ${res.status})`,
    );
  return PushCredentialsSchema.parse(body.credentials);
}

interface ImagePushIo {
  log: (message: string) => void;
  docker: (args: string[], env?: Record<string, string>) => Promise<void>;
}

const defaultDocker = async (args: string[], env?: Record<string, string>): Promise<void> => {
  try {
    // buffer the progress output but surface stderr on failure (a push can take several minutes, so the log makes clear it is not silent).
    await pexecFile("docker", args, { env: { ...process.env, ...env }, maxBuffer: 16 * 1024 * 1024 });
  } catch (e) {
    const stderr = e instanceof Error && "stderr" in e ? String((e as { stderr?: unknown }).stderr ?? "") : "";
    throw new UpstreamError(
      "UPSTREAM_ERROR",
      { args: args.join(" ") },
      `docker ${args[0]} failed: ${stderr || String(e)}`,
    );
  }
};

// tag → temporary DOCKER_CONFIG login file → push → cleanup (finally). On success, returns the published ref.
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
    io.log(`▶ docker push ${target} (credentials: temporary DOCKER_CONFIG, deleted when done)`);
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
      "a local image reference to publish is required — everdict image push <ref>",
    );
  const apiUrl = flags.get("api-url") ?? process.env.EVERDICT_API_URL ?? "http://localhost:8787";
  const apiKey = flags.get("api-key") ?? process.env.EVERDICT_API_KEY;
  if (!apiKey)
    throw new BadRequestError("BAD_REQUEST", undefined, "--api-key <ak_…> (or EVERDICT_API_KEY) is required");
  const credentials = await fetchPushCredentials(apiUrl, apiKey, flags.get("registry"));
  const target = await pushImage(credentials, localRef, { name: flags.get("name"), tag: flags.get("tag") });
  console.error("✓ Published — use this reference as a harness pin / service image:");
  console.log(target);
}
