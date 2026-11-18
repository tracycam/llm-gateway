// The stub authorization server of the Grok tests: `authorizationServer.ts` answers the device
// flow and its rotating, single-use refresh tokens, and this wrapper adds what xAI also sends —
// the `id_token` whose claims name the user — and the knobs xAI's grant may leave out.
// Reachable only on 127.0.0.1, one ephemeral port per instance.
import { isObject, parseJson, type JsonObject } from '../protocols/json';
import { AuthorizationServer } from './authorizationServer';
import type { StubOptions, StubRequest } from './authorizationServer';

/** The claims a grant's `id_token` carries; the connector reads `sub` and `email` from it. */
export interface GrokIdentity {
  sub: string;
  email?: string;
}

export interface GrokAuthorizationOptions extends StubOptions {
  /** The `id_token` every grant carries; omitted means the grants carry none. */
  identity?: GrokIdentity;
  /** Answer grants without `expires_in`, as a server that states the lifetime only in the JWT. */
  omitExpiresIn?: boolean;
  /** Answer grants without `refresh_token`, as the official client expects may happen. */
  omitRefreshToken?: boolean;
  /** Status of every refresh grant instead of the stub's answer; 200 forwards as usual. */
  refreshStatus?: number;
}

/** An unsigned JWT carrying these claims; only a token's payload is ever read here. */
export function jwtOf(claims: JsonObject): string {
  const part = (value: JsonObject): string =>
    Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.`;
}

/** The device-code grant of `authorizationServer.ts`, with the fields xAI sends as well. */
export class GrokAuthorizationServer {
  /** The stub that runs the flow, rotates the tokens and refuses a token used twice. */
  readonly oauth: AuthorizationServer;
  readonly base: string;
  readonly deviceEndpoint: string;
  readonly tokenEndpoint: string;
  identity: GrokIdentity | null;
  omitExpiresIn: boolean;
  omitRefreshToken: boolean;
  refreshStatus: number;
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor(options: GrokAuthorizationOptions = {}) {
    this.oauth = new AuthorizationServer(options);
    this.identity = options.identity ?? null;
    this.omitExpiresIn = options.omitExpiresIn ?? false;
    this.omitRefreshToken = options.omitRefreshToken ?? false;
    this.refreshStatus = options.refreshStatus ?? 200;
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => this.answer(req),
    });
    this.base = `http://127.0.0.1:${this.server.port}`;
    this.deviceEndpoint = `${this.base}/oauth2/device/code`;
    this.tokenEndpoint = `${this.base}/oauth2/token`;
  }

  /** Stop both listeners. */
  close(): void {
    this.server.stop(true);
    this.oauth.close();
  }

  /** Every request the authorization server received. */
  get requests(): StubRequest[] {
    return this.oauth.requests;
  }

  /** Refresh grants served, successful or not. */
  get refreshes(): number {
    return this.oauth.refreshes;
  }

  get accessToken(): string {
    return this.oauth.accessToken;
  }

  get refreshToken(): string {
    return this.oauth.refreshToken;
  }

  /** The device code the last login asked for; a secret that must reach no response. */
  get deviceCode(): string {
    return this.oauth.deviceCode;
  }

  /** The requests the token endpoint received. */
  tokenRequests(): StubRequest[] {
    return this.oauth.tokenRequests();
  }

  private async answer(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    // The RFC 8628 and OAuth paths xAI serves, on the inner stub's own two paths.
    const inner = path === '/oauth2/device/code' ? '/device' : path === '/oauth2/token' ? '/token' : null;
    if (inner === null) return Response.json({ error: 'not_found' }, { status: 404 });
    const form = new URLSearchParams(await req.text());
    if (form.get('grant_type') === 'refresh_token' && this.refreshStatus !== 200) {
      return Response.json({ error: 'server_error' }, { status: this.refreshStatus });
    }
    const forwarded = await fetch(`${this.oauth.base}${inner}`, {
      method: req.method,
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      redirect: 'error',
    });
    const text = await forwarded.text();
    const body = parseJson(text);
    if (!isObject(body) || typeof body.access_token !== 'string') {
      return new Response(text, {
        status: forwarded.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    const granted: JsonObject = { ...body };
    if (this.omitExpiresIn) delete granted.expires_in;
    if (this.omitRefreshToken) delete granted.refresh_token;
    if (this.identity !== null) {
      const claims: JsonObject = { sub: this.identity.sub };
      if (this.identity.email !== undefined) claims.email = this.identity.email;
      granted.id_token = jwtOf(claims);
    }
    return Response.json(granted, { status: forwarded.status });
  }
}
