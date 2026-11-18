// A stub OAuth authorization server for tests: it issues device codes, answers polls as a test
// scripts it, and rotates refresh tokens the way xAI and ChatGPT do — a token used twice is
// refused with `400 invalid_grant`, which is the property single-flight renewal protects.
// Reachable only on 127.0.0.1, one ephemeral port per instance.
import type { JsonObject } from '../protocols/json';

/** What the next device-code poll answers; the last step repeats. */
export type PollStep =
  | 'pending'
  /** RFC 8628's `slow_down`. */
  | 'slow-down'
  | 'denied'
  | 'expired'
  /** The administrator confirmed: the grant answers tokens. */
  | 'grant'
  /** A 5xx: the code may still be confirmed, and the caller is expected to try again. */
  | 'failure'
  /** Any other error member, as a server this gateway does not know would send it. */
  | { error: string; description?: string };

/** One request the stub received, as the tests assert on it. */
export interface StubRequest {
  /** `/device`, `/token` or another path. */
  path: string;
  /** The form body, decoded. */
  form: Record<string, string>;
  headers: Headers;
}

/** How a state other than a grant is reported: the RFC's 400 (and xAI) or GitHub's 200 body. */
export type PollEncoding = 'status' | 'body';

/** What the stub starts as; every field can be changed between polls. */
export interface StubOptions {
  steps?: PollStep[];
  encoding?: PollEncoding;
  deviceCode?: string;
  userCode?: string;
  expiresIn?: number;
  /** Seconds the device endpoint says to wait between polls. */
  interval?: number;
  accessToken?: string;
  refreshToken?: string;
  /** Seconds the granted access token lasts; 0 makes every later renewal due at once. */
  tokenLifetime?: number;
}

const DESCRIPTIONS: Record<'pending' | 'slow-down' | 'denied' | 'expired', [string, string]> = {
  pending: ['authorization_pending', 'The administrator has not confirmed the code yet'],
  'slow-down': ['slow_down', 'Poll less often'],
  denied: ['access_denied', 'The administrator denied the request'],
  expired: ['expired_token', 'The code has expired'],
};

/** A device-code authorization server whose polls and refresh grants a test scripts. */
export class AuthorizationServer {
  readonly base: string;
  readonly deviceEndpoint: string;
  readonly tokenEndpoint: string;
  readonly requests: StubRequest[] = [];
  steps: PollStep[];
  encoding: PollEncoding;
  deviceCode: string;
  userCode: string;
  expiresIn: number;
  interval: number;
  accessToken: string;
  /** The refresh token the next grant answers with; every grant rotates both tokens. */
  refreshToken: string;
  tokenLifetime: number;
  /** Refresh grants served, successful or not. */
  refreshes = 0;
  private readonly valid = new Set<string>();
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor(options: StubOptions = {}) {
    this.steps = options.steps ?? ['grant'];
    this.encoding = options.encoding ?? 'status';
    this.deviceCode = options.deviceCode ?? 'device-code-secret-0001';
    this.userCode = options.userCode ?? 'TEST-CODE';
    this.expiresIn = options.expiresIn ?? 1800;
    this.interval = options.interval ?? 0;
    this.accessToken = options.accessToken ?? 'access-token-0001';
    this.refreshToken = options.refreshToken ?? 'refresh-token-0001';
    this.tokenLifetime = options.tokenLifetime ?? 3600;
    this.valid.add(this.refreshToken);
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => this.answer(req),
    });
    this.base = `http://127.0.0.1:${this.server.port}`;
    this.deviceEndpoint = `${this.base}/device`;
    this.tokenEndpoint = `${this.base}/token`;
  }

  /** Stop the listener. */
  close(): void {
    this.server.stop(true);
  }

  /** The requests the token endpoint received. */
  tokenRequests(): StubRequest[] {
    return this.requests.filter((request) => request.path === '/token');
  }

  private async answer(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const form = Object.fromEntries(new URLSearchParams(await req.text()));
    this.requests.push({ path, form, headers: req.headers });
    if (path === '/device') return this.deviceAnswer();
    if (path === '/token') return this.tokenAnswer(form);
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  private deviceAnswer(): Response {
    return Response.json({
      device_code: this.deviceCode,
      user_code: this.userCode,
      verification_uri: 'https://example.test/device',
      verification_uri_complete: `https://example.test/device?user_code=${this.userCode}`,
      expires_in: this.expiresIn,
      interval: this.interval,
    });
  }

  private tokenAnswer(form: Record<string, string>): Response {
    if (form.grant_type === 'refresh_token') return this.refreshAnswer(form);
    if (form.device_code !== this.deviceCode) return this.error('invalid_grant', 'Unknown device code');
    const step: PollStep = this.steps.length > 1 ? this.steps.shift()! : this.steps[0] ?? 'grant';
    if (typeof step === 'object') return this.error(step.error, step.description ?? 'No description');
    if (step === 'grant') return Response.json(this.grant());
    if (step === 'failure') return Response.json({ error: 'server_error' }, { status: 503 });
    const [error, description] = DESCRIPTIONS[step]!;
    return this.error(error, description);
  }

  private refreshAnswer(form: Record<string, string>): Response {
    this.refreshes += 1;
    const token = form.refresh_token ?? '';
    if (!this.valid.delete(token)) {
      return this.error('invalid_grant', 'Refresh token already used');
    }
    this.accessToken = `access-token-${String(this.refreshes + 1).padStart(4, '0')}`;
    this.refreshToken = `refresh-token-${String(this.refreshes + 1).padStart(4, '0')}`;
    this.valid.add(this.refreshToken);
    return Response.json(this.grant());
  }

  private grant(): JsonObject {
    return {
      access_token: this.accessToken,
      refresh_token: this.refreshToken,
      token_type: 'Bearer',
      expires_in: this.tokenLifetime,
    };
  }

  /** A refusal in the encoding this stub was told to use. */
  private error(error: string, description: string): Response {
    const body = { error, error_description: description };
    return Response.json(body, { status: this.encoding === 'status' ? 400 : 200 });
  }
}
