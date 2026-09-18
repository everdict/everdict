import type { FastifySchema } from "fastify";

export const metaDocs: Record<"deployment", FastifySchema> = {
  deployment: {
    summary: "What this deployment is built from",
    description:
      "The commit this control plane's image was built from, and when the process started. `commit` is null " +
      "when the image carries no stamp — which is a real answer ('I do not know what I am built from'), not " +
      "a fallback to the image tag. Unauthenticated: a caller deciding whether to trust a contract must not " +
      "need a credential to find out. Compare it against your checkout — a commit yours does not contain " +
      "means the contracts you are being handed are OLDER than your code.",
    tags: ["meta"],
  },
};
