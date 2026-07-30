// Splits streamed output chunks into complete lines for incremental parsing (a stream-json line is the
// parse unit, but an ExecChunk boundary can land mid-line). push() buffers the trailing partial until the
// next chunk; end() flushes it. Single-consumer: the async iterator yields lines as they arrive.
export class ChunkLineQueue {
  private partial = "";
  private lines: string[] = [];
  private ended = false;
  private notify: (() => void) | undefined;

  push(chunk: string): void {
    this.partial += chunk;
    const parts = this.partial.split("\n");
    const rest = parts.pop();
    this.partial = rest ?? "";
    if (parts.length > 0) {
      this.lines.push(...parts);
      this.wake();
    }
  }

  end(): void {
    if (this.partial.length > 0) {
      this.lines.push(this.partial);
      this.partial = "";
    }
    this.ended = true;
    this.wake();
  }

  private wake(): void {
    const n = this.notify;
    this.notify = undefined;
    n?.();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    for (;;) {
      for (;;) {
        const line = this.lines.shift();
        if (line === undefined) break;
        yield line;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
    }
  }
}
