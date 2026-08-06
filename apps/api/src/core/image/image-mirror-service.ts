import { BadRequestError, type RegistryAuth } from "@everdict/contracts";
import { IMAGE_REPOSITORY_NAME, PLATFORM_IMAGE_NAMESPACE, imageRepositoryOf, pinDigest } from "@everdict/domain";
import {
  type ImageSource,
  type RegistryAccess,
  type RegistryWriter,
  copyImage,
  parseImageLocation,
  remoteImageSource,
  sourceReferenceOf,
} from "@everdict/images";

// Bring an image the deployment does not own INTO the registry everdict manages.
//
// Two callers, one operation. A WORKSPACE mirrors a base or a harness image so its evals stop depending on a
// public registry staying up, staying free, and not deleting the tag underneath them. The OPERATOR mirrors
// everdict's own api/web/agent/job-runner so a deployment can run with no reach to GHCR at all. The only
// difference is which namespace the bytes land in — and that difference is the isolation boundary, so it is
// decided here rather than by whatever the caller passed.
//
// Everything below `copyImage` is deliberately thin: the protocol work (blobs before the manifest, index →
// runnable child, skipping what the target already has) lives in @everdict/images, and the auth for reading
// the SOURCE is resolved by the caller's own registry credentials.

export interface MirrorImageInput {
  image: string; // the source reference, as its own registry addresses it (ghcr.io/acme/app:1.2, debian:stable-slim)
  name?: string; // repository name in the target namespace; default = the source's last path segment
  tag?: string; // default = the source's tag, or "latest"
}

export interface MirroredImage {
  image: string; // the managed ref, digest-pinned — what a spec should carry
  repository: string;
  tag: string;
  layers: number;
  copiedBlobs: number; // 0 = every blob was already here (a re-mirror of an unchanged image)
}

export interface ImageMirrorServiceDeps {
  endpoint: string; // the managed registry's client-facing host
  namespaceFor: (tenant: string) => string;
  writer: RegistryWriter;
  // The workspace's own registry credentials, used only if the SOURCE host matches one of them. A public
  // source needs none; a private one the workspace never registered fails with that registry's own 401,
  // which is the honest answer rather than a guess.
  pullAuthsFor?: (tenant: string) => Promise<RegistryAuth[]>;
  // How a source reference becomes readable bytes. Injected (defaulting to the real registry client) so the
  // service's own decisions — namespace, name, tag, which credential a host may see — are testable without a
  // network, and so a future source kind (a local tarball, another everdict) plugs in without touching this.
  sourceFor?: (image: string, auth?: RegistryAuth) => ImageSource;
}

// The repository name a source ref lands under when the caller did not choose one: its last path segment
// ("ghcr.io/everdict/everdict-job-runner" → "everdict-job-runner"), which is the name a human already uses
// for it.
function defaultNameFor(image: string): string {
  const repo = imageRepositoryOf(image);
  const segment = repo.slice(repo.lastIndexOf("/") + 1);
  return segment;
}

export class ImageMirrorService {
  constructor(private readonly deps: ImageMirrorServiceDeps) {}

  // Mirror into a WORKSPACE's namespace — what a member or an agent asks for (`images:push`).
  async mirrorForWorkspace(tenant: string, input: MirrorImageInput): Promise<MirroredImage> {
    const auths = this.deps.pullAuthsFor ? await this.deps.pullAuthsFor(tenant).catch(() => []) : [];
    return this.mirror(this.deps.namespaceFor(tenant), input, auths);
  }

  // Mirror into the PLATFORM's namespace — the operator bringing everdict's own images in so the deployment
  // stops depending on a public registry. Never reachable from a workspace-authenticated route: these images
  // are readable by every workspace, so letting a tenant write them would let one tenant hand every other
  // tenant an image of its choosing.
  async mirrorForPlatform(input: MirrorImageInput, auth?: RegistryAuth): Promise<MirroredImage> {
    return this.mirror(PLATFORM_IMAGE_NAMESPACE, input, auth ? [auth] : []);
  }

  private async mirror(namespace: string, input: MirrorImageInput, auths: RegistryAuth[]): Promise<MirroredImage> {
    const source = parseImageLocation(input.image);
    const name = input.name ?? defaultNameFor(input.image);
    if (!IMAGE_REPOSITORY_NAME.test(name))
      throw new BadRequestError(
        "BAD_REQUEST",
        { image: input.image, name },
        `'${name}' is not a usable repository name — pass name explicitly (lowercase letters, digits, '.', '_', '-').`,
      );
    const tag = input.tag ?? (source.reference.startsWith("sha256:") ? "latest" : source.reference);
    if (!/^[\w][\w.-]{0,127}$/.test(tag))
      throw new BadRequestError("BAD_REQUEST", { tag }, `'${tag}' is not a usable image tag.`);
    const repository = `${namespace}/${name}`;
    const access: RegistryAccess[] = [{ type: "repository", name: repository, actions: ["pull", "push"] }];
    // Only a credential for the SOURCE's own host is offered — handing a registry someone else's password is
    // how a mirror becomes a credential leak.
    const auth = auths.find((a) => a.host === source.base.replace(/^https?:\/\//, ""));
    const source_ = (this.deps.sourceFor ?? remoteImageSource)(input.image, auth);
    const copied = await copyImage(
      source_,
      this.deps.writer,
      { repository, reference: sourceReferenceOf(input.image), tag },
      access,
    );
    return {
      // Digest-pinned: a mirror exists to stop depending on a moving reference, so handing back a bare tag
      // would reintroduce exactly what it was meant to remove.
      image: pinDigest(`${this.deps.endpoint}/${repository}:${tag}`, copied.digest),
      repository,
      tag,
      layers: copied.layers,
      copiedBlobs: copied.copiedBlobs,
    };
  }
}
