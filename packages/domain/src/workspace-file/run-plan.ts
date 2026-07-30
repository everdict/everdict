import { shq } from "@everdict/contracts";

// WHAT it takes to run a workspace file: the image to run it in and the command to run it with. Pure policy —
// the extension decides the interpreter, and the image is only a DEFAULT (a caller passing a workspace
// environment image gets the same command against its own dependencies, which is the point of having them).
//
// The table is deliberately short. A language earns a row when running it is a single interpreter invocation;
// anything needing a build step (Go, Rust, Java) is a different feature, not a bigger table.

export interface FileRunPlan {
  image: string;
  command: string; // runs in the sandbox working directory, where the file has been placed under its own name
}

interface Interpreter {
  image: string;
  run: (file: string) => string;
}

const INTERPRETERS: Record<string, Interpreter> = {
  bash: { image: "debian:stable-slim", run: (f) => `bash ${f}` },
  cjs: { image: "node:22-alpine", run: (f) => `node ${f}` },
  cts: { image: "node:22-alpine", run: (f) => `node --experimental-strip-types ${f}` },
  js: { image: "node:22-alpine", run: (f) => `node ${f}` },
  mjs: { image: "node:22-alpine", run: (f) => `node ${f}` },
  mts: { image: "node:22-alpine", run: (f) => `node --experimental-strip-types ${f}` },
  py: { image: "python:3.13-slim", run: (f) => `python ${f}` },
  sh: { image: "debian:stable-slim", run: (f) => `bash ${f}` },
  ts: { image: "node:22-alpine", run: (f) => `node --experimental-strip-types ${f}` },
};

export function isRunnableFilePath(path: string): boolean {
  return interpreterFor(path) !== undefined;
}

// The plan for a path, or undefined when nothing in the table knows how to run it. `image` overrides the
// interpreter's default image but never the command — running a Python file stays `python <file>` whatever
// image it runs in.
export function fileRunPlanFor(path: string, image?: string): FileRunPlan | undefined {
  const interpreter = interpreterFor(path);
  if (interpreter === undefined) return undefined;
  const name = path.split("/").at(-1) ?? path;
  return { image: image ?? interpreter.image, command: interpreter.run(shq(`./${name}`)) };
}

function interpreterFor(path: string): Interpreter | undefined {
  const name = (path.split("/").at(-1) ?? "").toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined;
  return INTERPRETERS[name.slice(dot + 1)];
}
