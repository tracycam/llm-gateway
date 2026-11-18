// Registry of available upstream connectors.
import type { Connector } from './connector';
import { anthropic } from './anthropic';
import { openai, openaiCompatible, openrouter, xai } from './openai';
import { opencode, opencodeGo } from './opencode';

/** Connectors in administrator-facing order. */
export const CONNECTORS: readonly Connector[] = [
  openai, anthropic, openrouter, xai, opencode, opencodeGo, openaiCompatible,
];

/** Find a connector by its stable identifier. */
export function connectorById(id: string): Connector | null {
  return CONNECTORS.find((connector) => connector.id === id) ?? null;
}
