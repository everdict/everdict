// Type surface for the /evaluate argument parser (the action stays plain ESM; tests import it under TS).
export interface EvaluateOverrides {
  cases?: { ids?: string[]; tags?: string[]; limit?: number };
  trials?: number;
  concurrency?: number;
  retries?: number;
  runtime?: string;
  traceSink?: string;
}
export declare function parseEvaluateArgs(body: unknown): { overrides: EvaluateOverrides; warnings: string[] };
