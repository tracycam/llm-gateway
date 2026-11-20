// Registry of available upstream connectors.
import type { Connector } from './connector';
import { aihub } from './aihub';
import { anthropicCompatible } from './anthropic';
import { copilot } from './copilot';
import { grok } from './grok';
import { openaiCompatible, openrouter } from './openai';
import { opencode, opencodeGo } from './opencode';

/** Connectors in the order the owner lists them where a provider is added. */
export const CONNECTORS: readonly Connector[] = [
  openaiCompatible, anthropicCompatible, grok, opencode, opencodeGo, copilot, openrouter, aihub,
];

/** Find a connector by its stable identifier. */
export function connectorById(id: string): Connector | null {
  return CONNECTORS.find((connector) => connector.id === id) ?? null;
}
