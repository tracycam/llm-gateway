// A stub GitHub and GitHub Copilot API for tests: the device-code endpoints, the account's user
// document, the model list and the three inference routes, each scriptable per test. It listens
// on 127.0.0.1 only, one ephemeral port per instance; a connector under test is given these hosts,
// so no request can reach github.com or api.githubcopilot.com.
import type { JsonObject } from '../protocols/json';

/** What the next device-code poll answers; the last step repeats. */
export type CopilotPollStep =
  | 'pending'
  | 'denied'
  /** The administrator confirmed: the grant answers the token. */
  | 'grant';

/** One request the stub received, as the tests assert on it. */
export interface CopilotStubRequest {
  method: string;
  path: string;
  headers: Headers;
  /** The request body as text: form-encoded for the device endpoints, JSON for inference. */
  body: string;
}

export interface CopilotStubOptions {
  steps?: CopilotPollStep[];
  /**
   * What the user document's `endpoints.api` answers: a base URL, `null` to name no endpoints at
   * all, or `undefined` (the default) to name this stub's own base.
   */
  apiBase?: string | null;
  /** Status of `GET /copilot_internal/user`; 200 unless a test scripts a failure. */
  userStatus?: number;
  /** The user document's `chat_enabled`; true unless a test scripts a denial. */
  chatEnabled?: boolean;
  /** The `data` array of `GET /models`. */
  models?: unknown[];
  /** Status of `GET /models`. */
  modelsStatus?: number;
  /** Status of every inference route; 200 unless a test scripts a refusal. */
  inferenceStatus?: number;
  accessToken?: string;
  deviceCode?: string;
  userCode?: string;
  /** Seconds the device endpoint says to wait between polls. */
  interval?: number;
}

const CHAT_ANSWER: JsonObject = {
  id: 'chatcmpl-stub',
  object: 'chat.completion',
  created: 0,
  model: 'upstream-model',
  choices: [{ index: 0, message: { role: 'assistant', content: 'served' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
};

const MESSAGES_ANSWER: JsonObject = {
  id: 'msg-stub',
  type: 'message',
  role: 'assistant',
  model: 'upstream-model',
  content: [{ type: 'text', text: 'served' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 3, output_tokens: 2 },
};

const RESPONSES_ANSWER: JsonObject = {
  id: 'resp-stub',
  object: 'response',
  status: 'completed',
  model: 'upstream-model',
  output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'served' }] }],
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
};

/** A device-code and Copilot API server whose answers a test scripts. */
export class CopilotStub {
  readonly requests: CopilotStubRequest[] = [];
  steps: CopilotPollStep[];
  apiBase: string | null | undefined;
  userStatus: number;
  chatEnabled: boolean;
  models: unknown[];
  modelsStatus: number;
  inferenceStatus: number;
  accessToken: string;
  deviceCode: string;
  userCode: string;
  interval: number;
  /** The base of this stub; what the connector's hosts are pointed at. */
  readonly base: string;
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor(options: CopilotStubOptions = {}) {
    this.steps = options.steps ?? ['grant'];
    this.apiBase = options.apiBase;
    this.userStatus = options.userStatus ?? 200;
    this.chatEnabled = options.chatEnabled ?? true;
    this.models = options.models ?? [];
    this.modelsStatus = options.modelsStatus ?? 200;
    this.inferenceStatus = options.inferenceStatus ?? 200;
    this.accessToken = options.accessToken ?? 'gho_copilot_token_0001';
    this.deviceCode = options.deviceCode ?? 'device-code-secret-0001';
    this.userCode = options.userCode ?? 'TEST-CODE';
    this.interval = options.interval ?? 0;
    this.server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (req) => this.answer(req),
    });
    this.base = `http://127.0.0.1:${this.server.port}`;
  }

  /** Stop the listener. */
  close(): void {
    this.server.stop(true);
  }

  /** The requests that reached one path, in order. */
  requestsTo(path: string): CopilotStubRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  private async answer(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    const body = await req.text();
    this.requests.push({ method: req.method, path, headers: req.headers, body });
    if (req.method === 'POST' && path === '/login/device/code') return this.deviceAnswer();
    if (req.method === 'POST' && path === '/login/oauth/access_token') return this.tokenAnswer(body);
    if (req.method === 'GET' && path === '/copilot_internal/user') return this.userAnswer();
    if (req.method === 'GET' && path === '/models') return this.modelsAnswer(req.headers);
    if (req.method === 'POST' && path === '/chat/completions') return this.inferenceAnswer(CHAT_ANSWER);
    if (req.method === 'POST' && path === '/responses') return this.inferenceAnswer(RESPONSES_ANSWER);
    if (req.method === 'POST' && path === '/v1/messages') return this.inferenceAnswer(MESSAGES_ANSWER);
    return Response.json({ error: 'not_found' }, { status: 404 });
  }

  private deviceAnswer(): Response {
    return Response.json({
      device_code: this.deviceCode,
      user_code: this.userCode,
      verification_uri: 'https://example.test/device',
      verification_uri_complete: `https://example.test/device?user_code=${this.userCode}`,
      expires_in: 1800,
      interval: this.interval,
    });
  }

  /**
   * GitHub reports a poll that is not a grant in a 200 body, which is the encoding the shared
   * device-code reader accepts next to the RFC's 400 (`gateway/connectors/deviceCode.ts`).
   */
  private tokenAnswer(body: string): Response {
    const deviceCode = new URLSearchParams(body).get('device_code');
    if (deviceCode !== this.deviceCode) {
      return Response.json({ error: 'invalid_grant', error_description: 'Unknown device code' });
    }
    const step = this.steps.length > 1 ? this.steps.shift()! : this.steps[0] ?? 'grant';
    if (step === 'pending') {
      return Response.json({
        error: 'authorization_pending',
        error_description: 'The administrator has not confirmed the code yet',
      });
    }
    if (step === 'denied') {
      return Response.json({
        error: 'access_denied',
        error_description: 'The user has denied your application access.',
      });
    }
    return Response.json({
      access_token: this.accessToken,
      token_type: 'bearer',
      scope: 'read:user',
    });
  }

  private userAnswer(): Response {
    if (this.userStatus !== 200) {
      return Response.json({ message: 'stub user document failure' }, { status: this.userStatus });
    }
    const api = this.apiBase === undefined ? this.base : this.apiBase;
    return Response.json({
      chat_enabled: this.chatEnabled,
      endpoints: api === null ? {} : { api },
    });
  }

  private modelsAnswer(headers: Headers): Response {
    if (this.modelsStatus !== 200) {
      // An upstream that echoes the credential it was sent: the connector must redact it.
      const sent = headers.get('authorization') ?? 'no authorization';
      return Response.json({ error: `stub model list failure for ${sent}` },
        { status: this.modelsStatus });
    }
    return Response.json({ object: 'list', data: this.models });
  }

  private inferenceAnswer(answer: JsonObject): Response {
    if (this.inferenceStatus !== 200) {
      return Response.json({ error: { message: 'stub inference failure' } },
        { status: this.inferenceStatus });
    }
    return Response.json(answer);
  }
}
