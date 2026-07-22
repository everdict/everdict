import { describe, expect, it } from "vitest";
import { bakeDockerfile, bakeImage, bakeTargetRef } from "./image-bake.js";

describe("bakeDockerfile (managed case.image agent bootstrap)", () => {
  it("generates the multi-stage agent wrap: agent node+dist copied in, agent as entrypoint", () => {
    const df = bakeDockerfile("browseruse-eval:0.13.3");
    expect(df).toContain("FROM everdict-job-runner:slim AS agent");
    expect(df).toContain("FROM browseruse-eval:0.13.3");
    expect(df).toContain("COPY --from=agent /usr/local/bin/node /usr/local/bin/node");
    expect(df).toContain("COPY --from=agent /app /everdict-job-runner");
    expect(df).toContain('ENTRYPOINT ["node", "/everdict-job-runner/dist/main.js"]');
    expect(df).toContain("CMD []"); // the base image's CMD must not leak into the agent's argv
    expect(df).toContain("libstdc++6"); // node's non-libc shared-lib dep, missing on slim python/debian bases
  });

  it("honors a custom job-runner image", () => {
    expect(bakeDockerfile("base:1", "reg.example.com/everdict-job-runner:v2")).toContain(
      "FROM reg.example.com/everdict-job-runner:v2 AS agent",
    );
  });
});

describe("bakeTargetRef", () => {
  it("appends -agent to the base tag, preserving host/path", () => {
    expect(bakeTargetRef("browseruse-eval:0.13.3")).toBe("browseruse-eval:0.13.3-agent");
    expect(bakeTargetRef("ghcr.io/acme/sbench:v1")).toBe("ghcr.io/acme/sbench:v1-agent");
    expect(bakeTargetRef("plain-image")).toBe("plain-image:latest-agent"); // tagless → latest
  });
});

describe("bakeImage", () => {
  it("writes the generated Dockerfile to a temp dir, builds the baked tag, and cleans up", async () => {
    const dockerCalls: string[][] = [];
    const logs: string[] = [];
    const target = await bakeImage("browseruse-eval:0.13.3", {
      io: {
        log: (m) => logs.push(m),
        docker: async (args) => {
          dockerCalls.push(args);
        },
      },
    });
    expect(target).toBe("browseruse-eval:0.13.3-agent");
    expect(dockerCalls).toHaveLength(1);
    const [build, dashT, tag, dir] = dockerCalls[0] ?? [];
    expect(build).toBe("build");
    expect(dashT).toBe("-t");
    expect(tag).toBe("browseruse-eval:0.13.3-agent");
    expect(dir).toContain("everdict-bake-"); // temp build context (removed in finally)
    expect(logs[0]).toContain("docker build");
  });

  it("an explicit --tag wins over the derived one", async () => {
    const target = await bakeImage("base:1", {
      tag: "my-eval:managed",
      io: { log: () => {}, docker: async () => {} },
    });
    expect(target).toBe("my-eval:managed");
  });
});
