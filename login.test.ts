// The one device-code login per provider: what it stores, what it shows and when it stops.
// The clock and the wait are the test's, so a poll happens only when a test asks for one.
import { afterEach, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { DeviceCode, DeviceLoginPoll, LoginConnector } from './connectors/connector';
import { LoginSessions, type LoginWait } from './login';
import { ProviderStore } from './providerStore';
import { migrate } from './schema';
import { AuthorizationServer, type PollStep } from './testing/authorizationServer';
import { fakeLoginConnector } from './testing/loginConnector';

const NOW = '2026-01-01T00:00:00Z';

const servers: AuthorizationServer[] = [];
const sessions: LoginSessions[] = [];
const databases: Database[] = [];
afterEach(() => {
  for (const login of sessions.splice(0)) login.close();
  for (const server of servers.splice(0)) server.close();
  for (const db of databases.splice(0)) db.close();
});

/** Waits for something the session does; the timeout is a guard, not a delay. */
async function until(what: string, condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(1);
  }
}

/** A clock the test moves, and a wait it releases: the session polls when the test says so. */
function driver() {
  let time = Date.parse(NOW);
  const pending = new Set<() => void>();
  const waits: number[] = [];
  let asked = 0;
  return {
    now: () => new Date(time),
    /** The intervals the session asked for, in order. */
    waits,
    waiting: () => pending.size > 0,
    wait: (ms: number, signal: AbortSignal): Promise<void> => new Promise<void>((resolve, reject) => {
      waits.push(ms);
      asked = ms;
      const go = (): void => {
        pending.delete(go);
        resolve();
      };
      pending.add(go);
      signal.addEventListener('abort', () => {
        pending.delete(go);
        reject(new Error('aborted'));
      }, { once: true });
    }),
    /** Move the clock by the interval the session asked for, then let it poll. */
    async tick(ms?: number): Promise<void> {
      await until('the session to wait', () => pending.size > 0);
      time += ms ?? asked;
      for (const go of [...pending]) go();
    },
  };
}

function setup(options: { steps?: PollStep[]; interval?: number; expiresIn?: number } = {}) {
  const server = new AuthorizationServer(options);
  servers.push(server);
  const db = new Database(':memory:');
  databases.push(db);
  migrate(db);
  const providers = new ProviderStore(db);
  const provider = providers.create({
    name: 'login', connector: 'fake-login', baseUrl: null, credential: null, autoPublish: false,
  }, new Date(NOW));
  const clock = driver();
  const { connector } = fakeLoginConnector({
    deviceEndpoint: server.deviceEndpoint,
    tokenEndpoint: server.tokenEndpoint,
    upstream: 'http://upstream.test',
    now: clock.now,
  });
  const logins = new LoginSessions({
    providers, connector: () => connector, fetch, now: clock.now, wait: clock.wait,
  });
  sessions.push(logins);
  return { server, providers, provider, clock, connector, logins };
}

/** A login whose code request and polls the test completes by hand, with no HTTP at all. */
function heldLogin(options: { holdStart?: boolean } = {}) {
  const polls: Array<(value: DeviceLoginPoll) => void> = [];
  const starts: Array<() => void> = [];
  const code: DeviceCode = {
    userCode: 'HELD-CODE',
    verificationUri: 'https://example.test/device',
    verificationUriComplete: null,
    expiresAt: new Date(Date.parse(NOW) + 600_000),
    interval: 1,
    secret: 'held-device-secret',
  };
  let startFailure: Error | null = null;
  const connector: LoginConnector = {
    id: 'held-login',
    name: 'Held login',
    defaultBaseUrl: null,
    credential: 'login',
    login: {
      start() {
        if (startFailure !== null) return Promise.reject(startFailure);
        if (options.holdStart === true) {
          return new Promise<DeviceCode>((resolve) => { starts.push(() => resolve(code)); });
        }
        return Promise.resolve(code);
      },
      poll() {
        return new Promise<DeviceLoginPoll>((resolve) => { polls.push(resolve); });
      },
    },
    async target() { throw new Error('unused'); },
    async models() { return []; },
  };
  return {
    connector, polls, starts, code,
    failStart(error: Error | null): void { startFailure = error; },
  };
}

/** Isolated stores and one held login; the wait is the driver's unless the test gives another. */
function heldSetup(options: { holdStart?: boolean; wait?: LoginWait } = {}) {
  const db = new Database(':memory:');
  databases.push(db);
  migrate(db);
  const providers = new ProviderStore(db);
  const provider = providers.create({
    name: 'held', connector: 'held-login', baseUrl: null, credential: null, autoPublish: false,
  }, new Date(NOW));
  const clock = driver();
  const held = heldLogin(options);
  const logins = new LoginSessions({
    providers, connector: () => held.connector, fetch, now: clock.now, wait: options.wait ?? clock.wait,
  });
  sessions.push(logins);
  return { providers, provider, clock, logins, ...held };
}

test('rule A3: the pending status carries the code, never the device code', async () => {
  const { server, provider, logins } = setup({ steps: ['pending'], interval: 2 });
  const status = await logins.start(provider.id);
  expect(status).toMatchObject({
    state: 'pending',
    userCode: 'TEST-CODE',
    verificationUri: 'https://example.test/device',
    verificationUriComplete: 'https://example.test/device?user_code=TEST-CODE',
    interval: 2,
  });
  expect(status.state === 'pending' && status.expiresAt).toBe('2026-01-01T00:30:00.000Z');
  expect(JSON.stringify(logins.status(provider.id))).not.toContain(server.deviceCode);
});

test('rule A3: a granted login stores the credential and clears the rejected mark', async () => {
  const { provider, providers, clock, logins, server } = setup({ steps: ['pending', 'grant'] });
  providers.rejectCredential(provider.id);
  await logins.start(provider.id);
  await clock.tick();
  await until('the pending poll', () => server.tokenRequests().length === 1);
  expect(logins.status(provider.id).state).toBe('pending');
  await clock.tick();
  await until('the login to finish', () => logins.status(provider.id).state !== 'pending');
  expect(logins.status(provider.id)).toEqual({ state: 'done' });
  expect(providers.get(provider.id)).toMatchObject({ hasCredential: true, credentialRejected: false });
  expect(providers.credential(provider.id)).toContain(server.refreshToken);
});

test('rule A3: a slow-down adds 5 s to every later interval', async () => {
  const { provider, clock, logins, server } = setup({
    steps: ['slow-down', 'pending', 'grant'], interval: 2,
  });
  await logins.start(provider.id);
  await clock.tick();
  await until('the slow-down poll', () => server.tokenRequests().length === 1);
  expect(logins.status(provider.id)).toMatchObject({ state: 'pending', interval: 7 });
  await clock.tick();
  await until('the pending poll', () => server.tokenRequests().length === 2);
  await clock.tick();
  await until('the login to finish', () => logins.status(provider.id).state === 'done');
  expect(clock.waits).toEqual([2_000, 7_000, 7_000]);
});

test('rule A3: a refused login fails with the reason the server gave', async () => {
  const { provider, clock, logins } = setup({ steps: ['denied'] });
  await logins.start(provider.id);
  await clock.tick();
  await until('the refusal', () => logins.status(provider.id).state === 'failed');
  expect(logins.status(provider.id)).toEqual({
    state: 'failed', reason: 'The administrator denied the request',
  });
});

test('rule A3: the code expires at expiresAt, with no poll after it', async () => {
  const { provider, providers, clock, logins, server } = setup({
    steps: ['pending'], interval: 4, expiresIn: 8,
  });
  await logins.start(provider.id);
  await clock.tick();
  await until('the pending poll', () => server.tokenRequests().length === 1);
  await clock.tick();
  await until('the expiry', () => logins.status(provider.id).state === 'expired');
  expect(logins.status(provider.id)).toEqual({ state: 'expired' });
  expect(server.tokenRequests()).toHaveLength(1);
  expect(providers.credential(provider.id)).toBeNull();
});

test('rule A3: a second start stops the first, which never polls or stores', async () => {
  const { provider, clock, logins, server } = setup({ steps: ['grant'] });
  await logins.start(provider.id);
  await until('the first wait', () => clock.waiting());
  await logins.start(provider.id);
  await until('the second wait', () => clock.waiting());
  await clock.tick();
  await until('the login to finish', () => logins.status(provider.id).state === 'done');
  expect(server.tokenRequests()).toHaveLength(1);
});

test('rule A3: cancel stops a pending session and forgets it', async () => {
  const { provider, providers, clock, logins, server } = setup({ steps: ['pending'] });
  await logins.start(provider.id);
  await until('the wait', () => clock.waiting());
  logins.cancel(provider.id);
  expect(logins.status(provider.id)).toEqual({ state: 'none' });
  expect(clock.waiting()).toBe(false);
  expect(providers.credential(provider.id)).toBeNull();
  expect(server.tokenRequests()).toHaveLength(0);
});

test('rule A3: close leaves no waiter and no poll behind', async () => {
  const { provider, clock, logins, server } = setup({ steps: ['pending'] });
  await logins.start(provider.id);
  await until('the wait', () => clock.waiting());
  logins.close();
  expect(logins.status(provider.id)).toEqual({ state: 'none' });
  expect(clock.waiting()).toBe(false);
  expect(server.tokenRequests()).toHaveLength(0);
});

test('rule A3: a poll that fails is asked again at the next interval', async () => {
  const { provider, clock, logins, server } = setup({ steps: ['failure', 'grant'] });
  await logins.start(provider.id);
  await clock.tick();
  await until('the failed poll', () => server.tokenRequests().length === 1);
  expect(logins.status(provider.id).state).toBe('pending');
  await clock.tick();
  await until('the login to finish', () => logins.status(provider.id).state === 'done');
  expect(server.tokenRequests()).toHaveLength(2);
});

test('rule A3: a provider removed while pending stores nothing at its next poll', async () => {
  const { provider, providers, clock, logins, server } = setup({ steps: ['grant'] });
  await logins.start(provider.id);
  await until('the wait', () => clock.waiting());
  providers.delete(provider.id);
  await clock.tick();
  await until('the session to end', () => logins.status(provider.id).state === 'none');
  expect(server.tokenRequests()).toHaveLength(1);
  expect(providers.get(provider.id)).toBeNull();
  expect(logins.status(provider.id)).toEqual({ state: 'none' });
});

test('rule A3: the status after a grant names no token', async () => {
  const { provider, clock, logins, server } = setup({ steps: ['grant'] });
  await logins.start(provider.id);
  await clock.tick();
  await until('the login to finish', () => logins.status(provider.id).state === 'done');
  const shown = JSON.stringify(logins.status(provider.id));
  expect(shown).not.toContain(server.deviceCode);
  expect(shown).not.toContain(server.accessToken);
  expect(shown).not.toContain(server.refreshToken);
});

test('rule A3: a grant that arrives after cancel is not stored', async () => {
  const f = heldSetup();
  await f.logins.start(f.provider.id);
  await f.clock.tick();
  await until('the poll', () => f.polls.length === 1);
  f.logins.cancel(f.provider.id);
  f.polls[0]({ status: 'granted', credential: '{"accessToken":"late"}' });
  await Bun.sleep(1);
  expect(f.providers.credential(f.provider.id)).toBeNull();
  expect(f.logins.status(f.provider.id)).toEqual({ state: 'none' });
});

test('rule A3: a grant that arrives after close is not stored', async () => {
  const f = heldSetup();
  await f.logins.start(f.provider.id);
  await f.clock.tick();
  await until('the poll', () => f.polls.length === 1);
  f.logins.close();
  f.polls[0]({ status: 'granted', credential: '{"accessToken":"late"}' });
  await Bun.sleep(1);
  expect(f.providers.credential(f.provider.id)).toBeNull();
  expect(f.logins.status(f.provider.id)).toEqual({ state: 'none' });
});

test('rule A3: a grant that arrives after the session was replaced is not stored', async () => {
  const f = heldSetup();
  await f.logins.start(f.provider.id);
  await f.clock.tick();
  await until('the first poll', () => f.polls.length === 1);
  await f.logins.start(f.provider.id);
  await f.clock.tick();
  await until('the second poll', () => f.polls.length === 2);
  f.polls[0]({ status: 'granted', credential: '{"accessToken":"first"}' });
  await Bun.sleep(1);
  expect(f.providers.credential(f.provider.id)).toBeNull();
  f.polls[1]({ status: 'granted', credential: '{"accessToken":"second"}' });
  await until('the second session to finish', () => f.logins.status(f.provider.id).state === 'done');
  expect(f.providers.credential(f.provider.id)).toBe('{"accessToken":"second"}');
});

test('rule A3: a start that fails forgets the outcome of the session before it', async () => {
  const f = heldSetup();
  await f.logins.start(f.provider.id);
  await f.clock.tick();
  await until('the poll', () => f.polls.length === 1);
  f.polls[0]({ status: 'granted', credential: '{"accessToken":"first"}' });
  await until('the login to finish', () => f.logins.status(f.provider.id).state === 'done');
  f.failStart(new Error('authorization server unreachable'));
  await expect(f.logins.start(f.provider.id)).rejects.toThrow('authorization server unreachable');
  expect(f.logins.status(f.provider.id)).toEqual({ state: 'none' });

  f.failStart(null);
  await f.logins.start(f.provider.id);
  await f.clock.tick();
  await until('the second poll', () => f.polls.length === 2);
  f.polls[1]({ status: 'refused', reason: 'The administrator denied the request' });
  await until('the refusal', () => f.logins.status(f.provider.id).state === 'failed');
  f.failStart(new Error('authorization server unreachable'));
  await expect(f.logins.start(f.provider.id)).rejects.toThrow('authorization server unreachable');
  expect(f.logins.status(f.provider.id)).toEqual({ state: 'none' });
});

test('rule A3: a start overtaken while its code request is out creates no session', async () => {
  const f = heldSetup({ holdStart: true });
  const first = f.logins.start(f.provider.id);
  const second = f.logins.start(f.provider.id);
  await until('both code requests', () => f.starts.length === 2);
  f.starts[1]();
  const secondStatus = await second;
  expect(secondStatus).toMatchObject({ state: 'pending', userCode: 'HELD-CODE' });
  f.starts[0]();
  expect(await first).toEqual(secondStatus);
  expect(f.logins.status(f.provider.id)).toEqual(secondStatus);
  await f.clock.tick();
  await until('the poll', () => f.polls.length === 1);
  await Bun.sleep(1);
  expect(f.polls).toHaveLength(1);
});

test('rule A3: a code that expires after a failed last poll fails rather than expires', async () => {
  const f = setup({ steps: ['failure'], interval: 4, expiresIn: 8 });
  await f.logins.start(f.provider.id);
  await f.clock.tick();
  await until('the failed poll', () => f.server.tokenRequests().length === 1);
  await f.clock.tick();
  await until('the end', () => f.logins.status(f.provider.id).state !== 'pending');
  expect(f.logins.status(f.provider.id)).toEqual({ state: 'failed', reason: '授权服务器无响应' });
});

test('rule A3: a wait that fails without an abort ends the session as failed', async () => {
  // A wait that rejects without an abort is a known end, not an unexpected failure: it is
  // settled without reaching the session's last-resort report.
  const logged = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const f = heldSetup({ wait: () => Promise.reject(new Error('timer broke')) });
    await f.logins.start(f.provider.id);
    await until('the failure', () => f.logins.status(f.provider.id).state === 'failed');
    expect(f.logins.status(f.provider.id)).toEqual({ state: 'failed', reason: '登录会话中断' });
    expect(logged).not.toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
});
