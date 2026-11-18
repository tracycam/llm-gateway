// What only shows when a route is caught in the middle: the daemon here answers the identity
// request when the test lets it. Everything else about the routes is in nodes.integration.test.ts.
import { afterEach, beforeEach, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import fs from 'node:fs';
import { tempDir } from '../server/testing/fixtures';
import { Cluster, NodeRecord } from './cluster';
import { openGatewayDatabase } from './database';
import { handleNodeRoute } from './nodeRoutes';
import { NodeStore } from './nodeStore';
import { migrate } from './schema';
import { FakeDaemon } from './testing/fakeDaemon';

let dir: string;
let db: Database;
let daemon: FakeDaemon;
let store: NodeStore;
let cluster: Cluster;
let node: NodeRecord;

beforeEach(async () => {
  dir = tempDir();
  daemon = new FakeDaemon();
  daemon.token = 'node-token-0123456789';
  daemon.start();
  db = openGatewayDatabase(dir);
  migrate(db);
  store = new NodeStore(db);
  node = {
    id: 'node-1',
    name: 'machine',
    url: daemon.url,
    token: daemon.token,
    nodeId: daemon.identity.nodeId,
    createdAt: '2026-11-18T00:00:00.000Z',
  };
  store.insert(node);
  cluster = new Cluster(store.list());
  // Past the link's own identity request, so the ones counted below are the routes'.
  while (!cluster.get('node-1')!.online) await Bun.sleep(2);
});

afterEach(async () => {
  await cluster.close();
  db.close();
  await daemon.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

function call(method: string, pathname: string, body?: unknown): Promise<Response> {
  const request = new Request(`http://gateway${pathname}`, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return handleNodeRoute(request, cluster, store);
}

/** Holds the daemon's identity answers; returns the function that lets them go. */
function holdIdentity(): () => void {
  const gate = Promise.withResolvers<void>();
  daemon.identityGate = gate.promise;
  return gate.resolve;
}

async function untilIdentityRequested(count: number): Promise<void> {
  while (daemon.authorizations.length < count) await Bun.sleep(2);
}

test('a node removed while its new token is being checked is not brought back', async () => {
  const asked = daemon.authorizations.length;
  const release = holdIdentity();
  daemon.token = 'new-token-0123456789';
  const changing = call('PATCH', '/api/gateway/nodes/node-1', { token: 'new-token-0123456789' });
  await untilIdentityRequested(asked + 1);
  expect((await call('DELETE', '/api/gateway/nodes/node-1')).status).toBe(200);
  release();

  expect((await changing).status).toBe(404);
  expect(store.list()).toEqual([]);
  expect(cluster.list()).toEqual([]);
});

test('a rename made while a new token is being checked is kept', async () => {
  const asked = daemon.authorizations.length;
  const release = holdIdentity();
  daemon.token = 'new-token-0123456789';
  const changing = call('PATCH', '/api/gateway/nodes/node-1', { token: 'new-token-0123456789' });
  await untilIdentityRequested(asked + 1);
  expect((await call('PATCH', '/api/gateway/nodes/node-1', { name: 'renamed' })).status).toBe(200);
  release();

  expect((await changing).status).toBe(200);
  expect(store.list()).toEqual([{ ...node, name: 'renamed', token: 'new-token-0123456789' }]);
});

test('the same daemon registered twice at once is stored once', async () => {
  cluster.remove('node-1');
  store.delete('node-1');
  const asked = daemon.authorizations.length;
  const release = holdIdentity();
  const register = () => call('POST', '/api/gateway/nodes', { name: 'twice', url: daemon.url, token: daemon.token });
  const both = [register(), register()];
  await untilIdentityRequested(asked + 2);
  release();

  expect((await Promise.all(both)).map((response) => response.status).sort()).toEqual([201, 409]);
  expect(store.list()).toHaveLength(1);
});
