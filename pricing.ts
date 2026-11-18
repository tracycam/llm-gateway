import type { Price } from '../protocol/gatewayApi';

// `Price` crosses the management API; protocol/gatewayApi.ts defines it once and this module
// re-exports it under its current name.
export type { Price };

/** What one request used, in the three kinds the gateway bills: input, output, cache read. */
export interface Usage {
  /** Input tokens that were not read from a cache; cache writes are counted here. */
  inputTokens: number;
  outputTokens: number;
  /** Input tokens read from a cache. Disjoint from `inputTokens`. */
  cacheReadTokens: number;
}

export function costOf(usage: Usage | null, price: Price): number | null {
  if (usage === null || price.input === null || price.output === null) return null;
  return (
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheReadTokens * (price.cacheRead ?? price.input)
  ) / 1_000_000;
}
