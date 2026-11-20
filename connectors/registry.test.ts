// Tests for connector metadata and registry lookup.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { CONNECTORS, connectorById } from './registry';

let server: ReturnType<typeof Bun.serve>;
beforeEach(() => {
  server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response() });
});
afterEach(() => { server.stop(true); });

const metadata = [
  ['openai-compatible', 'https://api.openai.com/v1', 'optional-api-key'],
  ['anthropic-compatible', 'https://api.anthropic.com', 'optional-api-key'],
  ['grok', 'https://cli-chat-proxy.grok.com/v1', 'login'],
  ['opencode', 'https://opencode.ai/inference', 'api-key'],
  ['opencode-go', 'https://opencode.ai/inference/go', 'api-key'],
  ['copilot', 'https://api.githubcopilot.com', 'login'],
  ['openrouter', 'https://openrouter.ai/api/v1', 'api-key'],
  ['aihub', null, 'optional-api-key'],
] as const;

const CREDENTIAL_HEADERS = ['authorization', 'x-api-key', 'api-key', 'cookie'];

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

test('no connector asks the client for a credential header', () => {
  for (const connector of CONNECTORS) {
    for (const name of connector.clientHeaders ?? []) {
      expect(CREDENTIAL_HEADERS).not.toContain(name.toLowerCase());
    }
  }
});

test('connectorById returns the registered connector', () => {
  expect(connectorById('openai-compatible')).toBe(CONNECTORS[0]);
});

test('the retired connector ids are not registered', () => {
  expect(connectorById('openai')).toBeNull();
  expect(connectorById('anthropic')).toBeNull();
  // The API-key xAI connector is retired; an xAI key is an openai-compatible provider now.
  expect(connectorById('xai')).toBeNull();
});

test('only a login connector can sign a provider in', () => {
  const login = CONNECTORS.filter((connector) => connector.credential === 'login');
  expect(login.map((connector) => connector.id)).toEqual(['grok', 'copilot']);
  for (const connector of login) expect(connector.login).toBeDefined();
  for (const connector of CONNECTORS) {
    if (connector.credential !== 'login') expect(connector.login).toBeUndefined();
  }
});

test('connectorById returns null for a missing id', () => {
  expect(connectorById('missing')).toBeNull();
});
