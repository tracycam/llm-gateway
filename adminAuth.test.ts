import { expect, test } from 'bun:test';
import { isAuthorized, issueCookie, sessionRoute, validateTokenConfig } from './adminAuth';

const TOKEN = 'administrator-token-123456';
const NOW = Date.parse('2026-11-18T00:00:00Z');
const WEEK = 7 * 24 * 60 * 60 * 1000;

const withCookie = (setCookie: string) =>
  new Request('http://localhost/', { headers: { cookie: setCookie.split(';')[0] } });
const withBearer = (value: string) =>
  new Request('http://localhost/', { headers: { authorization: `Bearer ${value}` } });

function call(method: string, path: string, body?: string, cookie?: string): Promise<Response | null> {
  const headers: Record<string, string> = cookie === undefined ? {} : { cookie };
  return sessionRoute(new Request(`http://localhost${path}`, { method, body, headers }), '/api/gateway', TOKEN);
}

test('the admin token as a bearer token is accepted', () => {
  expect(isAuthorized(withBearer(TOKEN), TOKEN)).toBe(true);
});

test('a bearer token that only starts with the admin token is refused', () => {
  expect(isAuthorized(withBearer(`${TOKEN}extra`), TOKEN)).toBe(false);
});

test('a request with no credential is refused', () => {
  expect(isAuthorized(new Request('http://localhost/'), TOKEN)).toBe(false);
});

test('without an admin token every request is accepted', () => {
  expect(isAuthorized(new Request('http://localhost/'), undefined)).toBe(true);
});

test('a session cookie is accepted until it expires, one week after it was issued', () => {
  const cookie = issueCookie(TOKEN, NOW);
  expect(isAuthorized(withCookie(cookie), TOKEN, NOW + WEEK - 1000)).toBe(true);
  expect(isAuthorized(withCookie(cookie), TOKEN, NOW + WEEK)).toBe(false);
});

test('a session cookie issued under one admin token is refused under another', () => {
  const cookie = issueCookie(TOKEN, NOW);
  expect(isAuthorized(withCookie(cookie), 'another-admin-token-123456', NOW)).toBe(false);
});

test('a session cookie with a later expiry and the old signature is refused', () => {
  const [name, value] = issueCookie(TOKEN, NOW).split(';')[0].split('=');
  const [expiry, signature] = value.split('.');
  const forged = `${name}=${Number(expiry) + 1000}.${signature}`;
  expect(isAuthorized(withCookie(forged), TOKEN, NOW)).toBe(false);
});

test("the daemon's cookie name is not a gateway session", () => {
  const daemonCookie = issueCookie(TOKEN, NOW).replace('aihub_gateway_session=', 'aihub_session=');
  expect(isAuthorized(withCookie(daemonCookie), TOKEN, NOW)).toBe(false);
});

test('login with the admin token sets an HttpOnly, SameSite=Strict gateway cookie that is a session', async () => {
  const response = (await call('POST', '/api/gateway/login', JSON.stringify({ token: TOKEN })))!;
  const cookie = response.headers.get('set-cookie')!;
  expect(response.status).toBe(204);
  expect(cookie).toStartWith('aihub_gateway_session=');
  expect(cookie).toContain('HttpOnly; SameSite=Strict');
  expect(isAuthorized(withCookie(cookie), TOKEN)).toBe(true);
});

test('login with a wrong token is 401 and sets no cookie', async () => {
  const response = (await call('POST', '/api/gateway/login', JSON.stringify({ token: 'wrong-token-0123456789' })))!;
  expect(response.status).toBe(401);
  expect(response.headers.get('set-cookie')).toBeNull();
});

test('login with a body that is not {token: string} is 400', async () => {
  for (const body of ['not json', '[]', 'null', '{}', '{"token": 7}']) {
    expect([body, (await call('POST', '/api/gateway/login', body))!.status]).toEqual([body, 400]);
  }
});

test('session reports whether a login is required and whether this request is logged in', async () => {
  const cookie = issueCookie(TOKEN).split(';')[0];
  expect(await (await call('GET', '/api/gateway/session'))!.json()).toEqual({ authRequired: true, authenticated: false });
  expect(await (await call('GET', '/api/gateway/session', undefined, cookie))!.json()).toEqual({
    authRequired: true,
    authenticated: true,
  });
});

test('logout clears the gateway cookie', async () => {
  const cleared = (await call('POST', '/api/gateway/logout'))!.headers.get('set-cookie')!;
  expect(cleared).toStartWith('aihub_gateway_session=;');
  expect(cleared).toContain('Max-Age=0');
});

test('a path that is not a session route is not handled', async () => {
  expect(await call('GET', '/api/gateway/providers')).toBeNull();
});

test('a listener that is not loopback requires an admin token', () => {
  expect(() => validateTokenConfig('0.0.0.0', undefined)).toThrow('required');
  expect(() => validateTokenConfig('192.168.1.5', undefined)).toThrow('required');
  expect(() => validateTokenConfig('0.0.0.0', TOKEN)).not.toThrow();
});

test('a loopback listener needs no admin token', () => {
  for (const listen of ['127.0.0.1', '127.0.0.2', 'localhost', '::1']) {
    expect(() => validateTokenConfig(listen, undefined)).not.toThrow();
  }
});

test('an admin token shorter than 16 characters is refused on any listener', () => {
  expect(() => validateTokenConfig('127.0.0.1', 'short')).toThrow('16');
});
