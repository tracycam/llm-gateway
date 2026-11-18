// A stub of the CLI chat proxy the Grok connector talks to after login: it lists models a test
// sets, answers the three inference paths, and records every request so a test can read the
// headers and the body that were sent. Reachable only on 127.0.0.1, one ephemeral port.

/** One request the stub received, as the tests assert on it. */
export interface GrokUpstreamRequest {
  method: string;
  path: string;
  headers: Headers;
  body: string;
}

/** One answer of a 200 inference request, per path. */
export interface GrokAnswers {
  chat: unknown;
  responses: unknown;
  messages: unknown;
}

const DEFAULT_ANSWERS: GrokAnswers = {
  chat: {
    id: 'chatcmpl-stub',
    object: 'chat.completion',
    created: 0,
    model: 'grok-4.6',
    choices: [{ index: 0, message: { role: 'assistant', content: 'served' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
  },
  responses: {
    id: 'resp-stub',
    object: 'response',
    created_at: 0,
    status: 'completed',
    model: 'grok-4.6',
    output: [{
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'served' }],
    }],
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  },
  messages: {
    id: 'msg-stub',
    type: 'message',
    role: 'assistant',
    model: 'grok-4.6',
    content: [{ type: 'text', text: 'served' }],
    stop_reason: 'end_turn',
    usage: { input_tokens: 3, output_tokens: 2 },
  },
};

/** What the stub starts with; every field can be changed between requests. */
export interface GrokUpstreamOptions {
  /** The `data` array `GET /models` answers with. */
  models?: unknown[];
  /** Status of `GET /models`; anything but 200 answers an error body. */
  modelsStatus?: number;
  /** Status of the three inference paths; anything but 200 answers an error body. */
  inferenceStatus?: number;
  /** The body answered when a status is not 200. */
  errorBody?: unknown;
  answers?: Partial<GrokAnswers>;
}

/** The inference paths the proxy serves, and the answer each one gets. */
const INFERENCE: Record<string, keyof GrokAnswers> = {
  '/chat/completions': 'chat',
  '/responses': 'responses',
  '/messages': 'messages',
};

/** A fake cli-chat-proxy. */
export class GrokUpstream {
  readonly base: string;
  readonly requests: GrokUpstreamRequest[] = [];
  models: unknown[];
  modelsStatus: number;
  inferenceStatus: number;
  errorBody: unknown;
  answers: GrokAnswers;
  private readonly server: ReturnType<typeof Bun.serve>;

  constructor(options: GrokUpstreamOptions = {}) {
    this.models = options.models ?? [];
    this.modelsStatus = options.modelsStatus ?? 200;
    this.inferenceStatus = options.inferenceStatus ?? 200;
    this.errorBody = options.errorBody ?? { error: 'refused' };
    this.answers = { ...DEFAULT_ANSWERS, ...options.answers };
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

  /** The requests received on one path. */
  on(path: string): GrokUpstreamRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  private async answer(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    this.requests.push({
      method: req.method,
      path,
      headers: req.headers,
      body: await req.text(),
    });
    if (path === '/models') {
      if (this.modelsStatus !== 200) {
        return Response.json(this.errorBody, { status: this.modelsStatus });
      }
      return Response.json({ data: this.models });
    }
    const kind = INFERENCE[path];
    if (kind === undefined) {
      return Response.json({ error: 'not found' }, { status: 404 });
    }
    if (this.inferenceStatus !== 200) {
      return Response.json(this.errorBody, { status: this.inferenceStatus });
    }
    return Response.json(this.answers[kind]);
  }
}
