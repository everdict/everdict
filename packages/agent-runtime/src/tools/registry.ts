import type { ToolDefinition } from "./definition.js";

export class ToolRegistry {
  private readonly tools: ToolDefinition[];

  constructor(tools: ToolDefinition[]) {
    this.tools = tools;
  }

  size(): number {
    return this.tools.length;
  }

  names(): string[] {
    return this.tools.map((t) => t.name);
  }

  has(name: string): boolean {
    return this.tools.some((t) => t.name === name);
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.find((t) => t.name === name);
  }

  list(): ReadonlyArray<ToolDefinition> {
    return this.tools;
  }
}
