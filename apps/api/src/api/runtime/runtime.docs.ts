import { VersionTagsBodySchema } from "@everdict/application-control";
import { RuntimeSpecSchema } from "@everdict/contracts";
import { InspectRuntimeResultSchema } from "@everdict/contracts/wire";
import { ProbeRuntimeResultSchema } from "@everdict/contracts/wire";
import { RegisterRuntimeResultSchema } from "@everdict/contracts/wire";
import { RuntimeListResponseSchema } from "@everdict/contracts/wire";
import { RuntimeResponseSchema } from "@everdict/contracts/wire";
import { ValidateRuntimeResultSchema } from "@everdict/contracts/wire";
import type { FastifySchema } from "fastify";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { SetVersionTagsResultSchema } from "./response/set-version-tags-result.js";

// OpenAPI descriptors for the runtime routes — doc-only (rule api-layer): the no-op compilers in server.ts
// make attaching these behavior-free; validation stays in the handlers.

const idVersionParams = {
  type: "object",
  properties: {
    id: { type: "string", description: "Runtime id" },
    version: { type: "string", description: 'Runtime version (reads accept "latest")' },
  },
  required: ["id", "version"],
};

const docs = {
  register: {
    summary: "Register a runtime version",
    description:
      "Registers workspace-owned execution infra (kind local | nomad | k8s; no secrets in the spec — cluster " +
      "credentials are SecretStore references). Requires runtimes:write (viewer+ — role-independent, every " +
      "member registers their workspace's infra). Versions are immutable — re-registering the same (id, version) " +
      "with different content is 409. Reads resolve workspace-owned first with a _shared fallback.",
    tags: ["runtime"],
    body: toJsonSchema(RuntimeSpecSchema),
    response: {
      201: { description: "Registered", ...toJsonSchema(RegisterRuntimeResultSchema) },
      ...errorResponses(400, 401, 403, 404, 409),
    },
  },
  validate: {
    summary: "Dry-run validate a runtime spec",
    description:
      "Validates schema + reports existing versions/collision and whether referenced secrets " +
      "(authSecret/kubeconfigSecret) exist in this workspace's SecretStore (missingSecrets is a warning, not a " +
      "failure). Requires runtimes:write (viewer+). Validation failures are reported as ok:false in a 200 " +
      "response, not as 4xx. No live connection is made — use probe for that.",
    tags: ["runtime"],
    body: toJsonSchema(RuntimeSpecSchema),
    response: {
      200: {
        description: "Validation outcome (ok:true | ok:false + errors)",
        ...toJsonSchema(ValidateRuntimeResultSchema),
      },
      ...errorResponses(401, 403, 404),
    },
  },
  probe: {
    summary: "Probe a runtime (live connection test)",
    description:
      "Unlike validate (schema-only), actually connects to the cluster to confirm reachability/auth — no job is " +
      "run. The control plane resolves credentials from the workspace's secrets and uses them only as auth " +
      "headers (never exposed to the agent). Requires runtimes:write (viewer+, gated before live I/O).",
    tags: ["runtime"],
    body: toJsonSchema(RuntimeSpecSchema),
    response: {
      200: {
        description: "Probe outcome (reachable or classified failure)",
        ...toJsonSchema(ProbeRuntimeResultSchema),
      },
      ...errorResponses(400, 401, 403, 404),
    },
  },
  list: {
    summary: "List runtimes",
    description:
      "Lists this workspace's runtimes plus _shared first-party entries (workspace-owned first, _shared " +
      "fallback). Requires runtimes:read (viewer+).",
    tags: ["runtime"],
    response: {
      200: { description: "Runtime list entries", ...toJsonSchema(RuntimeListResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  get: {
    summary: "Get a runtime version",
    description:
      'The full RuntimeSpec for one version. version may be "latest" (semver-latest). Requires runtimes:read ' +
      "(viewer+). Another workspace's runtime reads 404 — no existence leak.",
    tags: ["runtime"],
    params: idVersionParams,
    response: {
      200: { description: "RuntimeSpec", ...toJsonSchema(RuntimeResponseSchema) },
      ...errorResponses(401, 403, 404),
    },
  },
  inspect: {
    summary: "Inspect a runtime (live cluster view)",
    description:
      "A read-only live view of the cluster behind a registered nomad/k8s runtime: composition (nodes/" +
      "datacenters), concurrent capacity, the live everdict workload placed on it, and any pool shared stores. " +
      "Unlike probe (reachability only) this enumerates the cluster; it still runs no job and mutates nothing. " +
      "Credentials are resolved from the workspace's secrets and used only as auth headers. A partial-cluster " +
      "failure degrades to `warnings` rather than an error. Requires runtimes:read (viewer+). A local runtime or " +
      "another workspace's runtime is 404.",
    tags: ["runtime"],
    params: idVersionParams,
    response: {
      200: {
        description: "Live cluster view (reachable, or a classified failure)",
        ...toJsonSchema(InspectRuntimeResultSchema),
      },
      ...errorResponses(401, 403, 404),
    },
  },
  setVersionTags: {
    summary: "Replace a runtime version's tags",
    description:
      "Whole-array PUT of free-form version labels (empty array = clear) — mutable registry metadata outside the " +
      "immutable spec. Requires runtimes:write (viewer+). Targets tenant-owned versions only — _shared or " +
      "another workspace's versions are 404.",
    tags: ["runtime"],
    params: idVersionParams,
    body: toJsonSchema(VersionTagsBodySchema),
    response: {
      200: { description: "Normalized tags after replacement", ...toJsonSchema(SetVersionTagsResultSchema) },
      ...errorResponses(400, 401, 403, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

// Widened re-export (team convention): the descriptors' literal response keys would otherwise make Fastify
// narrow reply.code() in the handlers — the FastifySchema value type keeps the doc attachment behavior-free.
export const runtimeDocs: Record<keyof typeof docs, FastifySchema> = docs;
