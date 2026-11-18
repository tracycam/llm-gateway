// In-memory dependencies for management route tests.
import { Database } from 'bun:sqlite';
import { UpstreamFailure, type Connector } from '../connectors/connector';
import { ModelStore } from '../modelStore';
import { ProviderStore } from '../providerStore';
import { migrate } from '../schema';
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
