import { createHmac, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

// The gateway's administrator authentication: one admin token (`ADMIN_TOKEN`, or the earlier
// `AIHUB_ADMIN_TOKEN`), sent as a bearer token or exchanged at login for a session cookie. There
// are no accounts.

const LIFETIME = 7 * 24 * 60 * 60;
// Cookies are not scoped by port: a daemon on the same host has its own cookie name, so the
// two sessions do not overwrite each other.
const COOKIE = 'aihub_gateway_session';

/** The administrator token: `ADMIN_TOKEN`, or the name it had while it lived in a daemon. */
export function adminToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.ADMIN_TOKEN ?? env.AIHUB_ADMIN_TOKEN;
}

export function validateTokenConfig(listen: string, token: string | undefined): void {
  const loopback = listen === 'localhost' || listen === '::1' || (isIP(listen) === 4 && listen.startsWith('127.'));
  if (token !== undefined && token.length < 16) {
    throw new Error('ADMIN_TOKEN (or AIHUB_ADMIN_TOKEN) must be at least 16 characters');
  }
  if (!loopback && !token) {
    throw new Error('ADMIN_TOKEN (or AIHUB_ADMIN_TOKEN) is required for non-loopback listeners');
  }
}

export function requireTokenConfig(listen: string, token: string | undefined): void {
  try {
    validateTokenConfig(listen, token);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function equal(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function signature(token: string, exp: string): string {
  return createHmac('sha256', token).update(`aihub-session:${exp}`).digest('hex');
}

export function issueCookie(token: string, now = Date.now()): string {
  const exp = String(Math.floor(now / 1000) + LIFETIME);
  const value = `${exp}.${signature(token, exp)}`;
  return `${COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${LIFETIME}`;
}

export function clearCookie(): string {
  return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export function isAuthorized(
  req: Request,
  token = adminToken(),
  now = Date.now()
): boolean {
  if (token === undefined) return true;
  const bearer = req.headers.get('authorization');
  if (bearer?.startsWith('Bearer ') && equal(bearer.slice(7), token)) return true;

  const cookie = req.headers.get('cookie')
    ?.split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`));
  const match = cookie?.slice(COOKIE.length + 1).match(/^(\d+)\.([0-9a-f]{64})$/);
  if (!match || Number(match[1]) <= Math.floor(now / 1000)) return false;
  return equal(match[2], signature(token, match[1]));
}

export async function sessionRoute(
  req: Request,
  prefix: string,
  token = adminToken()
): Promise<Response | null> {
  const pathname = new URL(req.url).pathname;
  if (pathname === `${prefix}/session` && req.method === 'GET') {
    return Response.json({
      authRequired: token !== undefined,
      authenticated: isAuthorized(req, token),
    });
  }
  if (pathname === `${prefix}/logout` && req.method === 'POST') {
    return new Response(null, { status: 204, headers: { 'Set-Cookie': clearCookie() } });
  }
  if (pathname === `${prefix}/login` && req.method === 'POST') {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return Response.json({ error: '请求体无效' }, { status: 400 });
    }
    const given = body !== null && typeof body === 'object' && 'token' in body ? body.token : undefined;
    if (typeof given !== 'string') return Response.json({ error: '请求体无效' }, { status: 400 });
    if (token === undefined) return new Response(null, { status: 204 });
    if (!equal(given, token)) {
      return Response.json({ error: '令牌错误' }, { status: 401 });
    }
    return new Response(null, {
      status: 204,
      headers: { 'Set-Cookie': issueCookie(token) },
    });
  }
  return null;
}
