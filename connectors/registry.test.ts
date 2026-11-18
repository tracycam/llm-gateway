// Tests for connector metadata and registry lookup.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { CONNECTORS, connectorById } from './registry';

let server: ReturnType<typeof Bun.serve>;
beforeEach(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
});
afterEach(() => { server.stop(true); });

const metadata = [
  ['openai', 'https://api.openai.com/v1', 'api-key'],
  ['anthropic', 'https://api.anthropic.com', 'api-key'],
  ['openrouter', 'https://openrouter.ai/api/v1', 'api-key'],
  ['xai', 'https://api.x.ai/v1', 'api-key'],
  ['openai-compatible', null, 'optional-api-key'],
] as const;

for (const [id, base, credential] of metadata) {
  test(`${id} exposes its default base`, () => {
    expect(connectorById(id)?.defaultBaseUrl).toBe(base);
  });
  test(`${id} exposes its credential kind`, () => {
    expect(connectorById(id)?.credential).toBe(credential);
  });
}

test('registry preserves connector order and rejects unknown ids', () => {
  expect(CONNECTORS.map((connector) => connector.id)).toEqual(metadata.map(([id]) => id));
  expect(connectorById('unknown')).toBeNull();
});

test('connector ids are unique', () => {
  expect(new Set(CONNECTORS.map((connector) => connector.id)).size).toBe(CONNECTORS.length);
});

test('connectorById returns the registered connector', () => {
  expect(connectorById('openai')).toBe(CONNECTORS[0]);
});

test('connectorById returns null for a missing id', () => {
  expect(connectorById('missing')).toBeNull();
});
