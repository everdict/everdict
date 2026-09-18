import type { FastifySchema } from "fastify";

export const metaDocs: Record<"deployment", FastifySchema> = {
  deployment: {
    summary: "What this deployment is built from",
    description:
      "The commit this control plane's image was built from, and when the process started. `commit` is null " +
      "when the image carries no stamp — which is a real answer ('I do not know what I am built from'), not " +
      "a fallback to the image tag. Unauthenticated: a caller deciding whether to trust a contract must not " +
      "need a credential to find out. Compare it against your checkout with `git merge-base --is-ancestor " +
      "<commit> HEAD`: succeeding while `<commit>` is not HEAD means the deployment is BEHIND your code. " +
      "(Containment alone is the wrong test — a commit behind yours is one you have.)",
    tags: ["meta"],
  },
};
