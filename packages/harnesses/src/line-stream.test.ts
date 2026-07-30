import { describe, expect, it } from "vitest";
import { ChunkLineQueue } from "./line-stream.js";

async function collect(queue: ChunkLineQueue): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of queue) lines.push(line);
  return lines;
}

describe("ChunkLineQueue", () => {
  it("reassembles lines split across chunk boundaries", async () => {
    const queue = new ChunkLineQueue();
    queue.push('{"a"');
    queue.push(':1}\n{"b":2}\n{"c"');
    queue.push(":3}\n");
    queue.end();
    expect(await collect(queue)).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
  });

  it("flushes a trailing partial (no final newline) on end()", async () => {
    const queue = new ChunkLineQueue();
    queue.push("first\nlast-without-newline");
    queue.end();
    expect(await collect(queue)).toEqual(["first", "last-without-newline"]);
  });

  it("yields lines that arrive AFTER the consumer started waiting (live delivery)", async () => {
    const queue = new ChunkLineQueue();
    const collected = collect(queue);
    await new Promise((r) => setTimeout(r, 10)); // consumer is parked on an empty queue
    queue.push("late\n");
    queue.end();
    expect(await collected).toEqual(["late"]);
  });

  it("ends cleanly with no lines at all", async () => {
    const queue = new ChunkLineQueue();
    queue.end();
    expect(await collect(queue)).toEqual([]);
  });
});
