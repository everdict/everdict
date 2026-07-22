export interface TokenBudget {
  maxTokens: number;
  consumed: number;
}

export function thresholdReached(b: TokenBudget, threshold = 0.9): boolean {
  return b.maxTokens > 0 && b.consumed >= b.maxTokens * threshold;
}
