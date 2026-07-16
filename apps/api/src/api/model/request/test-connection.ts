import { ModelSpecSchema } from "@everdict/contracts";

// POST /models/test-connection body — the connection subset needed to fire a dummy completion (id/version/tags/
// description are irrelevant to reaching the model). apiKeySecret is the NAME of a workspace/personal secret; its value
// is resolved server-side just before the probe (never sent from the client). Derived from ModelSpecSchema so the probe
// validates exactly the connection fields a real dispatch would use.
export const TestModelConnectionBodySchema = ModelSpecSchema.pick({
  provider: true,
  model: true,
  baseUrl: true,
  apiKeySecret: true,
  params: true,
});
