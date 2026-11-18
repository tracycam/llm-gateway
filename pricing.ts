import type { Price } from '../protocol/gatewayApi';

// `Price` crosses the management API; protocol/gatewayApi.ts defines it once and this module
// re-exports it under its current name.
export type { Price };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function costOf(usage: Usage | null, price: Price): number | null {
  if (usage === null || price.input === null || price.output === null) return null;
  return (
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * (price.cacheRead ?? price.input) +
    usage.cacheWriteTokens * (price.cacheWrite ?? price.input)
  ) / 1_000_000;
}
