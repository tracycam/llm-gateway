// Registry of available upstream connectors.
import type { Connector } from './connector';
import { anthropicCompatible } from './anthropic';
import { openaiCompatible, openrouter, xai } from './openai';
import { opencode, opencodeGo } from './opencode';

/** Connectors in administrator-facing order. */
export const CONNECTORS: readonly Connector[] = [
  openaiCompatible, anthropicCompatible, xai, opencode, opencodeGo, openrouter,
];

/** Find a connector by its stable identifier. */
export function connectorById(id: string): Connector | null {
  return CONNECTORS.find((connector) => connector.id === id) ?? null;
}
