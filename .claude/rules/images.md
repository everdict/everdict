---
paths: "packages/images/**"
description: "Managed image-store adapters — registry clients, not object storage. Read when editing image copy/mirroring/provenance."
---
# Image-store rules (push)

`@everdict/images` holds the adapters behind the `WorkspaceImages` port (`@everdict/application-control`).
Design SSOT: `docs/architecture/managed-image-store.md`.

- **A registry client is not object storage.** These adapters do not belong in `@everdict/storage`: an OCI
  registry has manifests, digests, tags and mount/copy semantics that an object store has none of, and the
  two ports answer different questions.
- **An image is identified by its DIGEST, never by its tag.** `repo:latest` names different bytes on Tuesday
  and Thursday, and an execution manifest that records the tag records a request rather than a world
  (`imageResolved`, `NO_IMAGE`). A copy/mirror path carries the digest through; a path that cannot resolve one
  reports `unresolved` WITH a reason, never silence.
- **Everdict references images; it does not build them.** A case's image must already exist somewhere the
  runtime can pull from — `resolveImage` throws rather than inventing a build step.
- Cross-tenant pull is a POLICY decision made above this package (`crossTenantPull`), never a default of an
  adapter: two workspaces sharing a registry host are not two workspaces sharing images.
