import { BrowserProfileRecordSchema } from "@everdict/contracts";
import type { FastifySchema } from "fastify";
import { z } from "zod";
import { errorResponses, toJsonSchema } from "../openapi.js";
import { CaptureBrowserProfileBodySchema } from "./request/capture-browser-profile.js";
import { CreateBrowserProfileBodySchema } from "./request/create-browser-profile.js";
import { RestoreBrowserProfileBodySchema } from "./request/restore-browser-profile.js";
import { UpdateBrowserProfileBodySchema } from "./request/update-browser-profile.js";

const profileIdParams = toJsonSchema(z.object({ id: z.string().describe("Browser profile id") }));
const profileResponse = toJsonSchema(BrowserProfileRecordSchema);
const listResponse = toJsonSchema(z.array(BrowserProfileRecordSchema));

// OpenAPI descriptors for the browser-profile routes (browser-profiles S2) — documentation only (rule api-layer).
const docs = {
  create: {
    summary: "Create a saved browser profile",
    description:
      "Creates a saved authenticated browser profile (a reusable login). Personal / self-scoped — owned by the " +
      "caller. Cookie capture (S3), geo proxy (S4), and eval injection (S5) build on it.",
    tags: ["browser-profile"],
    body: toJsonSchema(CreateBrowserProfileBodySchema),
    response: {
      200: { description: "The created profile", ...profileResponse },
      ...errorResponses(400, 401),
    },
  },
  list: {
    summary: "List your saved browser profiles",
    description: "The caller's own browser profiles (self-scoped; other owners' profiles are invisible).",
    tags: ["browser-profile"],
    response: {
      200: { description: "Your profiles", ...listResponse },
      ...errorResponses(401),
    },
  },
  get: {
    summary: "Get a saved browser profile",
    description: "A single profile the caller owns. 404 when it does not exist or belongs to another owner.",
    tags: ["browser-profile"],
    params: profileIdParams,
    response: {
      200: { description: "The profile", ...profileResponse },
      ...errorResponses(401, 404),
    },
  },
  update: {
    summary: "Update a saved browser profile",
    description: "Rename or update the declared cookie domains. Owner-only (404 otherwise).",
    tags: ["browser-profile"],
    params: profileIdParams,
    body: toJsonSchema(UpdateBrowserProfileBodySchema),
    response: {
      200: { description: "The updated profile", ...profileResponse },
      ...errorResponses(400, 401, 404),
    },
  },
  remove: {
    summary: "Delete a saved browser profile",
    description: "Deletes the profile and its stored login blob. Owner-only (404 otherwise).",
    tags: ["browser-profile"],
    params: profileIdParams,
    response: {
      204: { description: "Deleted" },
      ...errorResponses(401, 404),
    },
  },
  capture: {
    summary: "Capture a session's login into a profile",
    description:
      "Reads the cookies from the caller's active interactive browser session (S1) and stores them (encrypted) on " +
      "this profile, refreshing cookieDomains + capturedAt. An optional cookies selection narrows what is saved " +
      "(one login can set many unrelated cookies). Owner-only for both the profile and the session. 404 " +
      "when the profile isn't the caller's / not configured; 400 when the session isn't active or the selection " +
      "matches nothing.",
    tags: ["browser-profile"],
    params: profileIdParams,
    body: toJsonSchema(CaptureBrowserProfileBodySchema),
    response: {
      200: { description: "The updated profile (capturedAt set)", ...profileResponse },
      ...errorResponses(400, 401, 404),
    },
  },
  restore: {
    summary: "Seed a profile's saved login into a session (warm re-login)",
    description:
      "Decrypts this profile's saved cookies and seeds them into the caller's active interactive session so " +
      "re-logging in starts from the prior state instead of a blank browser. Owner-only for both the profile and " +
      "the session. A no-op for a profile with no login captured yet. Returns the domains the profile carries " +
      "(cookie values never cross the wire). 404 when the profile isn't the caller's / not configured; 400 when " +
      "the session isn't active.",
    tags: ["browser-profile"],
    params: profileIdParams,
    body: toJsonSchema(RestoreBrowserProfileBodySchema),
    response: {
      200: {
        description: "The domains the profile carries",
        ...toJsonSchema(z.object({ domains: z.array(z.string()) })),
      },
      ...errorResponses(400, 401, 404),
    },
  },
} satisfies Record<string, FastifySchema>;

export const browserProfileDocs: Record<keyof typeof docs, FastifySchema> = docs;
