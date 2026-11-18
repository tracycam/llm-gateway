// In-memory dependencies for management route tests.
import { Database } from 'bun:sqlite';
import { UpstreamFailure, type Connector } from '../connectors/connector';
import { KeyStore } from '../keyStore';
import { ModelStore } from '../modelStore';
import { ProviderStore } from '../providerStore';
import { migrate } from '../schema';
import { UsageStore } from '../usageStore';
import type { UsageEntry } from '../usageStore';
import type { AdminDeps } from './deps';

/** Create isolated real stores and a configurable connector. */
export function fixture(): {
  db: Database;
  deps: AdminDeps;
  connector: Connector;
  state: { failure: Error | null };
} {
  const db = new Database(':memory:');
  migrate(db);
  const state: { failure: Error | null } = { failure: null };
  const connector: Connector = {
    id: 'fake',
    name: 'Fake',
    defaultBaseUrl: 'https://example.com',
    credential: 'api-key',
    async target() { throw new Error('unused'); },
    async models() {
      if (state.failure) throw state.failure;
      return [{
        upstreamId: 'upstream',
        contextLength: 100,
        maxOutputTokens: null,
        price: { input: null, output: null, cacheRead: null, cacheWrite: null },
      }];
    },
  };
  const deps: AdminDeps = {
    providers: new ProviderStore(db),
    models: new ModelStore(db),
    keys: new KeyStore(db),
    usage: new UsageStore(db),
    connector: (id) => id === connector.id ? connector : null,
    connectors: () => [connector],
    now: () => new Date('2026-01-01T00:00:00Z'),
  };
  return { db, deps, connector, state };
}

/** Construct a request to a management path. */
export function request(path: string, method = 'GET', body?: unknown): Request {
  return new Request(`http://localhost/api/gateway${path}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** A connector error suitable for returning to the administrator. */
export function upstreamFailure(): UpstreamFailure {
  return new UpstreamFailure('上游拒绝了凭证', 401);
}

/** An accounted request with predictable usage and cost. */
export function usageEntry(keyId: string, modelId: string, providerId = 'p'): UsageEntry {
  return {
    protocol: 'openai',
    key: { id: keyId, name: 'key' },
    model: { id: modelId, name: 'model' },
    provider: { id: providerId, name: 'provider' },
    upstreamModel: 'upstream',
    status: 200,
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 2, cacheWriteTokens: 1 },
    cost: 2,
    ttftMs: null,
    latencyMs: 100,
    error: null,
  };
}
