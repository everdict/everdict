import { RunService } from "@everdict/application-control";
import type { Dispatcher } from "@everdict/backends";
import { InMemoryRunStore, InMemorySecretStore, InMemoryWorkspaceSettingsStore, generatedCipher } from "@everdict/db";
import {
  InMemoryHarnessInstanceRegistry,
  InMemoryHarnessTemplateRegistry,
  InMemoryModelRegistry,
  InMemoryRuntimeRegistry,
} from "@everdict/registry";
import { describe, expect, it } from "vitest";
import { SecretUsageService } from "../../core/secret/secret-usage-service.js";
import { buildServer } from "../../server.js";

const unusedDispatcher: Dispatcher = {
  async dispatch() {
    throw new Error("dispatcher is unused in secret-usage tests");
  },
};

async function build(withUsage: boolean) {
  const secrets = new InMemorySecretStore(generatedCipher());
  const models = new InMemoryModelRegistry();
  const settings = new InMemoryWorkspaceSettingsStore();
  // A workspace secret referenced by a model, plus an orphan secret referenced nowhere.
  await secrets.set("acme", "OPENAI_API_KEY", "sk-live", "");
  await secrets.set("acme", "ORPHAN_KEY", "unused", "");
  await models.register("acme", {
    id: "gpt",
    version: "1.0.0",
    provider: "openai",
    model: "gpt-5",
    apiKeySecret: "OPENAI_API_KEY",
    tags: [],
  });
  await settings.set("acme", { mattermost: { botTokenSecretName: "MM_BOT" } });
  await secrets.set("acme", "MM_BOT", "xoxb", "");

  const service = new RunService({ dispatcher: unusedDispatcher, store: new InMemoryRunStore() });
  return buildServer({
    service,
    ...(withUsage
      ? {
          secretUsageService: new SecretUsageService({
            secrets,
            models,
            harnesses: new InMemoryHarnessInstanceRegistry(new InMemoryHarnessTemplateRegistry()),
            runtimes: new InMemoryRuntimeRegistry(),
            settings,
          }),
        }
      : {}),
  });
}

const H = { "x-everdict-tenant": "acme" };
type Usage = { name: string; scope: string; refs: Array<{ kind: string; field: string; label: string }> };

describe("GET /secrets/usage", () => {
  it("returns 404 when secret usage is not configured", async () => {
    const res = await (await build(false)).inject({ method: "GET", url: "/secrets/usage", headers: H });
    expect(res.statusCode).toBe(404);
  });

  it("annotates each workspace secret with its live reference sites", async () => {
    const res = await (await build(true)).inject({ method: "GET", url: "/secrets/usage", headers: H });
    expect(res.statusCode).toBe(200);
    const usages = res.json() as Usage[];
    const openai = usages.find((u) => u.name === "OPENAI_API_KEY");
    expect(openai?.refs).toContainEqual({
      kind: "model",
      field: "api-key",
      label: "gpt",
      resourceId: "gpt",
      version: "1.0.0",
    });
    const mm = usages.find((u) => u.name === "MM_BOT");
    expect(mm?.refs).toContainEqual({ kind: "mattermost", field: "bot-token", label: "Mattermost" });
  });

  it("reports a referenced-nowhere secret as an orphan (refs = [])", async () => {
    const res = await (await build(true)).inject({ method: "GET", url: "/secrets/usage", headers: H });
    const usages = res.json() as Usage[];
    const orphan = usages.find((u) => u.name === "ORPHAN_KEY");
    expect(orphan).toBeDefined();
    expect(orphan?.refs).toEqual([]);
  });
});
