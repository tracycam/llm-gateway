// The shared device-code flow: what it sends, and what each answer of the token endpoint means
// in both ways these servers report it.
import { afterEach, expect, test } from 'bun:test';
import type { DeviceLogin } from './connector';
import { deviceCodeLogin } from './deviceCode';
import { AuthorizationServer, type StubOptions } from '../testing/authorizationServer';

const NOW = new Date('2026-01-01T00:00:00Z');
const servers: AuthorizationServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

function setup(options: StubOptions = {}): { server: AuthorizationServer; login: DeviceLogin } {
  const server = new AuthorizationServer(options);
  servers.push(server);
  const login = deviceCodeLogin({
    deviceEndpoint: server.deviceEndpoint,
    tokenEndpoint: server.tokenEndpoint,
    clientId: 'client-1',
    scope: 'read:user',
    extraForm: { referrer: 'gateway' },
    headers: { 'x-test': 'yes' },
    now: () => NOW,
  }, (body) => typeof body.access_token === 'string' ? `credential:${body.access_token}` : null);
  return { server, login };
}

test('rule A2: the code is asked for form-encoded with client id, scope and extra fields', async () => {
  const { server, login } = setup({ expiresIn: 600, interval: 3 });
  const code = await login.start(fetch);
  expect(code).toMatchObject({
    userCode: 'TEST-CODE',
    verificationUri: 'https://example.test/device',
    verificationUriComplete: 'https://example.test/device?user_code=TEST-CODE',
    interval: 3,
    secret: server.deviceCode,
  });
  expect(code.expiresAt.getTime()).toBe(NOW.getTime() + 600_000);
  const device = server.requests[0];
  expect(device.path).toBe('/device');
  expect(device.form).toEqual({ client_id: 'client-1', scope: 'read:user', referrer: 'gateway' });
  expect(device.headers.get('content-type')).toContain('application/x-www-form-urlencoded');
  expect(device.headers.get('accept')).toBe('application/json');
  expect(device.headers.get('x-test')).toBe('yes');
});

test('rule A2: the poll is form-encoded with the device grant and the device code', async () => {
  const { server, login } = setup();
  const code = await login.start(fetch);
  await login.poll(code, fetch);
  const polled = server.tokenRequests()[0];
  expect(polled.form).toEqual({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: server.deviceCode,
    client_id: 'client-1',
    referrer: 'gateway',
  });
  expect(polled.headers.get('accept')).toBe('application/json');
});

for (const encoding of ['status', 'body'] as const) {
  test(`rule A2: a pending poll is pending with the ${encoding} encoding`, async () => {
    const { login } = setup({ steps: ['pending'], encoding });
    const code = await login.start(fetch);
    expect(await login.poll(code, fetch)).toEqual({ status: 'pending' });
  });

  test(`rule A2: a slow_down poll asks for a slower poll with the ${encoding} encoding`, async () => {
    const { login } = setup({ steps: ['slow-down'], encoding });
    const code = await login.start(fetch);
    expect(await login.poll(code, fetch)).toEqual({ status: 'slow-down' });
  });

  test(`rule A2: a denied poll is refused with its description, ${encoding} encoding`, async () => {
    const { login } = setup({ steps: ['denied'], encoding });
    const code = await login.start(fetch);
    expect(await login.poll(code, fetch)).toEqual({
      status: 'refused', reason: 'The administrator denied the request',
    });
  });

  test(`rule A2: an expired poll is refused with its description, ${encoding} encoding`, async () => {
    const { login } = setup({ steps: ['expired'], encoding });
    const code = await login.start(fetch);
    expect(await login.poll(code, fetch)).toEqual({ status: 'refused', reason: 'The code has expired' });
  });
}

test("rule A2: an unknown error is refused with the server's description", async () => {
  const { login } = setup({ steps: [{ error: 'invalid_client', description: 'The client is unknown' }] });
  const code = await login.start(fetch);
  expect(await login.poll(code, fetch)).toEqual({
    status: 'refused', reason: 'The client is unknown',
  });
});

test('rule A2: a 5xx poll rejects so the caller can ask again', async () => {
  const { login } = setup({ steps: ['failure'] });
  const code = await login.start(fetch);
  await expect(login.poll(code, fetch)).rejects.toThrow('server_error');
});

test('rule A2: a start the server refuses rejects with its description', async () => {
  const server = new AuthorizationServer();
  servers.push(server);
  const login = deviceCodeLogin({
    deviceEndpoint: `${server.base}/nowhere`,
    tokenEndpoint: server.tokenEndpoint,
    clientId: 'client-1',
    scope: null,
    now: () => NOW,
  }, () => null);
  await expect(login.start(fetch)).rejects.toThrow('not_found');
});

test("rule A2: the grant's body reaches the credential mapper", async () => {
  const { server, login } = setup({ steps: ['grant'], accessToken: 'granted-access' });
  const code = await login.start(fetch);
  expect(await login.poll(code, fetch)).toEqual({
    status: 'granted', credential: `credential:${server.accessToken}`,
  });
});

test('rule A2: a grant carrying no token is refused rather than stored', async () => {
  const server = new AuthorizationServer({ steps: ['grant'] });
  servers.push(server);
  const login = deviceCodeLogin({
    deviceEndpoint: server.deviceEndpoint,
    tokenEndpoint: server.tokenEndpoint,
    clientId: 'client-1',
    scope: null,
    now: () => NOW,
  }, () => null);
  const code = await login.start(fetch);
  expect(await login.poll(code, fetch)).toEqual({
    status: 'refused', reason: 'The authorization server answered no token',
  });
});
