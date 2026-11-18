// One renewal per provider at a time: the property a rotating, single-use refresh token needs.
import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { providerAccess } from './access';
import type { ProviderAccess } from './connector';
import { CredentialRenewals, due } from './tokens';
import { ProviderStore } from '../providerStore';
import { migrate } from '../schema';
import { AuthorizationServer } from '../testing/authorizationServer';
import { fakeLoginConnector } from '../testing/loginConnector';

const NOW = new Date('2026-01-01T00:00:00Z');
const servers: AuthorizationServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

/** Access to a provider whose credential is whatever was stored, recording what it stores. */
function access(id: string, stored: string[]): ProviderAccess {
  return {
    id,
    baseUrl: null,
    credential: null,
    saveCredential: (credential) => { stored.push(credential); },
    rejectCredential: () => {},
    renewOnce: () => { throw new Error('not used here'); },
    model: () => null,
  };
}

test('rule B3: due is true inside the lead, at it and after the expiry, false outside it', () => {
  const at = (seconds: number): Date => new Date(NOW.getTime() + seconds * 1_000);
  expect(due(at(300), NOW)).toBe(true);
  expect(due(at(299), NOW)).toBe(true);
  expect(due(at(301), NOW)).toBe(false);
  expect(due(at(-1), NOW)).toBe(true);
  expect(due(at(300), NOW, 60)).toBe(false);
  expect(due(at(60), NOW, 60)).toBe(true);
  expect(due(null, NOW)).toBe(false);
});

test('rule B3: concurrent callers share one renewal and it is stored before they resume', async () => {
  const order: string[] = [];
  const provider = access('prv-one', []);
  provider.saveCredential = () => { order.push('stored'); };
  const renewals = new CredentialRenewals();
  let renewalsRun = 0;
  const renew = async (): Promise<string> => {
    renewalsRun += 1;
    order.push('renew');
    return 'credential-1';
  };
  const callers = Array.from({ length: 5 }, () =>
    renewals.fresh(provider, renew).then((credential) => {
      order.push('caller');
      return credential;
    }));
  expect(await Promise.all(callers)).toEqual(Array(5).fill('credential-1'));
  expect(renewalsRun).toBe(1);
  expect(order).toEqual(['renew', 'stored', 'caller', 'caller', 'caller', 'caller', 'caller']);
});

test('rule B3: twenty concurrent requests spend one rotating refresh token', async () => {
  const server = new AuthorizationServer({ tokenLifetime: 0 });
  servers.push(server);
  const db = new Database(':memory:');
  try {
    migrate(db);
    const providers = new ProviderStore(db);
    const provider = providers.create({
      name: 'login', connector: 'fake-login', baseUrl: null, autoPublish: false,
      credential: JSON.stringify({
        accessToken: 'spent-access', refreshToken: server.refreshToken,
        expiresAt: NOW.toISOString(),
      }),
    }, NOW);
    const { connector } = fakeLoginConnector({
      deviceEndpoint: server.deviceEndpoint,
      tokenEndpoint: server.tokenEndpoint,
      upstream: 'http://upstream.test',
      now: () => NOW,
    });
    const renewals = new CredentialRenewals();
    const targets = await Promise.all(Array.from({ length: 20 }, () =>
      connector.target(providerAccess(providers, provider, renewals), 'upstream', 'chat')));
    expect(server.refreshes).toBe(1);
    expect(server.tokenRequests().map((request) => request.form.grant_type))
      .toEqual(['refresh_token']);
    expect(new Set(targets.map((target) => target.headers.authorization)).size).toBe(1);
    expect(JSON.parse(providers.credential(provider.id)!)).toMatchObject({
      accessToken: server.accessToken, refreshToken: server.refreshToken,
    });
  } finally {
    db.close();
  }
});

test('rule B3: different providers renew independently', async () => {
  const renewals = new CredentialRenewals();
  const first = access('prv-one', []);
  const second = access('prv-two', []);
  const renew = async (name: string): Promise<string> => `${name}-credential`;
  const [one, two] = await Promise.all([
    renewals.fresh(first, () => renew('one')),
    renewals.fresh(second, () => renew('two')),
  ]);
  expect([one, two]).toEqual(['one-credential', 'two-credential']);
});

test('rule B3: a rejection reaches every waiter, stores nothing, and the next call renews', async () => {
  const stored: string[] = [];
  const provider = access('prv-one', stored);
  const renewals = new CredentialRenewals();
  let calls = 0;
  const failing = async (): Promise<string> => {
    calls += 1;
    throw new Error('authorization server unreachable');
  };
  const settled = await Promise.allSettled([
    renewals.fresh(provider, failing), renewals.fresh(provider, failing),
  ]);
  expect(settled.map((result) => result.status)).toEqual(['rejected', 'rejected']);
  expect(settled.every((result) =>
    result.status === 'rejected' && result.reason.message === 'authorization server unreachable'))
    .toBe(true);
  expect(calls).toBe(1);
  expect(stored).toEqual([]);
  expect(await renewals.fresh(provider, async () => 'credential-2')).toBe('credential-2');
  expect(stored).toEqual(['credential-2']);
  expect(calls).toBe(1);
});
