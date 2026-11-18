import path from 'node:path';
import { controlHeaders, isAuthorized, requireTokenConfig, sessionRoute } from '../server/auth';
import { VOL1_DIR, WEB_DIST_DIR as DEFAULT_WEB_DIST_DIR } from '../server/config';
import {
  errorResponse,
  jsonResponse,
  serveAppWebAsset,
} from '../server/apps/common';
import { handleAnthropicMessages } from './anthropicAdapter';
import { migrateGatewayDataDir } from './dataDir';
import { GatewayKeyRecord, GatewayStore } from './store';

const PORT = Number.parseInt(process.env.AIHUB_GATEWAY_PORT ?? '8000', 10);
const LISTEN = process.env.AIHUB_GATEWAY_LISTEN ?? '127.0.0.1';
requireTokenConfig(LISTEN);
const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-api-key, anthropic-version',
};
const CONTROL_URL = process.env.AIHUB_CONTROL_URL ?? 'http://127.0.0.1:4310';
const DATA_DIR = process.env.AIHUB_GATEWAY_DATA_DIR ?? path.join(VOL1_DIR, 'gateway');
const WEB_DIST_DIR = process.env.AIHUB_WEB_DIST_DIR ?? DEFAULT_WEB_DIST_DIR;

migrateGatewayDataDir(DATA_DIR, path.join(VOL1_DIR, 'apps', 'app-gateway'));
const store = new GatewayStore(DATA_DIR);

function extractToken(req: Request): string {
  const auth = req.headers.get('authorization') ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const xApiKey = req.headers.get('x-api-key') ?? '';
  return xApiKey.trim();
}

function openaiError(message: string, status = 401, type = 'authentication_error'): Response {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

async function fetchControlModels(): Promise<Array<Record<string, unknown>>> {
  try {
    const res = await fetch(`${CONTROL_URL}/api/v1/internal/models`, {
      headers: controlHeaders(),
      signal: AbortSignal.timeout(3_000),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { data?: Array<Record<string, unknown>> };
    return Array.isArray(data.data) ? data.data : [];
  } catch (err) {
    console.warn('[LLM Gateway] Failed to query control plane models:', err);
    return [];
  }
}

async function proxyOpenAIChat(
  req: Request,
  key: GatewayKeyRecord | 'anonymous'
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return openaiError('Request body must be valid JSON', 400, 'invalid_request_error');
  }

  const reqModel = typeof body.model === 'string' && body.model.trim() ? body.model.trim() : 'auto';
  const isStream = body.stream === true;
  const startedAt = performance.now();
  const upstreamAbort = new AbortController();
  const onAbort = () => upstreamAbort.abort();
  req.signal.addEventListener('abort', onAbort, { once: true });

  let upstream: Response;
  try {
    upstream = await fetch(`${CONTROL_URL}/api/v1/internal/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...controlHeaders() },
      body: JSON.stringify(body),
      signal: upstreamAbort.signal,
    });
  } catch (err) {
    req.signal.removeEventListener('abort', onAbort);
    store.recordRequest({
      protocol: 'openai',
      model: reqModel,
      key,
      promptTokens: 0,
      completionTokens: 0,
      ttftMs: null,
      latencyMs: performance.now() - startedAt,
      status: 502,
    });
    const msg = err instanceof Error ? err.message : String(err);
    return openaiError(`Upstream connection failed: ${msg}`, 502, 'upstream_error');
  }

  if (!upstream.ok || !upstream.body) {
    req.signal.removeEventListener('abort', onAbort);
    const text = await upstream.text();
    store.recordRequest({
      protocol: 'openai',
      model: reqModel,
      key,
      promptTokens: 0,
      completionTokens: 0,
      ttftMs: null,
      latencyMs: performance.now() - startedAt,
      status: upstream.status,
    });
    return new Response(text || JSON.stringify({ error: { message: `HTTP ${upstream.status}` } }), {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  if (!isStream) {
    try {
      const text = await upstream.text();
      const parsed = JSON.parse(text) as {
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      store.recordRequest({
        protocol: 'openai',
        model: parsed.model ?? reqModel,
        key,
        promptTokens: parsed.usage?.prompt_tokens ?? 0,
        completionTokens: parsed.usage?.completion_tokens ?? 0,
        ttftMs: null,
        latencyMs: performance.now() - startedAt,
        status: 200,
      });
      return new Response(text, {
        status: 200,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
        },
      });
    } finally {
      req.signal.removeEventListener('abort', onAbort);
    }
  }

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let lineBuf = '';
  let ttftMs: number | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let resolvedModel = reqModel;
  let recorded = false;

  const finalize = (status = 200) => {
    if (recorded) return;
    recorded = true;
    req.signal.removeEventListener('abort', onAbort);
    store.recordRequest({
      protocol: 'openai',
      model: resolvedModel,
      key,
      promptTokens,
      completionTokens,
      ttftMs,
      latencyMs: performance.now() - startedAt,
      status,
    });
  };

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          finalize(200);
          controller.close();
          return;
        }
        if (value) {
          lineBuf += decoder.decode(value, { stream: true });
          let nl = lineBuf.indexOf('\n');
          while (nl !== -1) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (line.startsWith('data:') && line !== 'data: [DONE]') {
              if (ttftMs === null) ttftMs = performance.now() - startedAt;
              try {
                const ev = JSON.parse(line.slice(5).trim()) as {
                  model?: string;
                  usage?: { prompt_tokens?: number; completion_tokens?: number };
                };
                if (ev.model) resolvedModel = ev.model;
                if (ev.usage) {
                  promptTokens = ev.usage.prompt_tokens ?? promptTokens;
                  completionTokens = ev.usage.completion_tokens ?? completionTokens;
                }
              } catch {
                // Ignore partial/non-JSON comment line
              }
            }
            nl = lineBuf.indexOf('\n');
          }
          controller.enqueue(value);
        }
      } catch (err) {
        finalize(502);
        controller.error(err);
      }
    },
    cancel() {
      upstreamAbort.abort();
      finalize(499);
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

const server = Bun.serve({
  port: PORT,
  hostname: LISTEN,
  idleTimeout: 255,
  async fetch(req) {
    const { pathname } = new URL(req.url);
    const session = await sessionRoute(req, '/api/gateway');
    if (session) return session;
    if (pathname.startsWith('/api/') && !isAuthorized(req)) return errorResponse('未登录', 401);
    if (pathname.startsWith('/v1/') && req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    if (pathname === '/healthz' && req.method === 'GET') {
      return jsonResponse({ status: 'ok', port: PORT });
    }

    // OpenAI & Anthropic External APIs (/v1/*)
    if (pathname.startsWith('/v1/')) {
      const key = store.verifyToken(extractToken(req));
      if (!key) {
        return openaiError('Invalid or missing API key', 401, 'authentication_error');
      }

      if (pathname === '/v1/models' && req.method === 'GET') {
        const models = await fetchControlModels();
        return Response.json({ object: 'list', data: models }, { headers: CORS_HEADERS });
      }

      if (pathname.startsWith('/v1/models/') && req.method === 'GET') {
        const target = decodeURIComponent(pathname.slice('/v1/models/'.length));
        const models = await fetchControlModels();
        const found = models.find((m) => m.id === target || m.root === target);
        return found
          ? Response.json(found, { headers: CORS_HEADERS })
          : openaiError(`Model '${target}' not found`, 404, 'not_found_error');
      }

      if (pathname === '/v1/chat/completions' && req.method === 'POST') {
        return proxyOpenAIChat(req, key);
      }

      if (pathname === '/v1/completions' && req.method === 'POST') {
        let body: Record<string, unknown>;
        try {
          body = (await req.json()) as Record<string, unknown>;
        } catch {
          return openaiError('Invalid JSON body', 400, 'invalid_request_error');
        }
        const promptText = Array.isArray(body.prompt)
          ? String(body.prompt[0] ?? '')
          : String(body.prompt ?? '');
        const adaptedReq = new Request(req.url, {
          method: 'POST',
          headers: req.headers,
          signal: req.signal,
          body: JSON.stringify({
            ...body,
            messages: [{ role: 'user', content: promptText }],
            stream: false,
          }),
        });
        const chatRes = await proxyOpenAIChat(adaptedReq, key);
        if (!chatRes.ok) return chatRes;
        const chatData = (await chatRes.json()) as {
          id?: string;
          created?: number;
          model?: string;
          choices?: Array<{ finish_reason?: string; message?: { content?: string } }>;
          usage?: Record<string, unknown>;
        };
        return Response.json({
          id: chatData.id ?? `cmpl-${Date.now().toString(36)}`,
          object: 'text_completion',
          created: chatData.created ?? Math.floor(Date.now() / 1000),
          model: chatData.model ?? body.model ?? 'auto',
          choices: [
            {
              index: 0,
              text: chatData.choices?.[0]?.message?.content ?? '',
              finish_reason: chatData.choices?.[0]?.finish_reason ?? 'stop',
            },
          ],
          usage: chatData.usage,
        }, { headers: CORS_HEADERS });
      }

      if (pathname === '/v1/messages' && req.method === 'POST') {
        const startedAt = performance.now();
        return handleAnthropicMessages(req, CONTROL_URL, (m) => {
          store.recordRequest({
            protocol: 'anthropic',
            model: m.model,
            key,
            promptTokens: m.promptTokens,
            completionTokens: m.completionTokens,
            ttftMs: m.ttftMs,
            latencyMs: performance.now() - startedAt,
            status: m.status,
          });
        });
      }

      return openaiError(`Unsupported route: ${req.method} ${pathname}`, 404, 'not_found_error');
    }

    // Gateway Management Endpoints (/api/gateway/*)
    if (pathname === '/api/gateway/state' && req.method === 'GET') {
      const models = await fetchControlModels();
      return jsonResponse({
        port: PORT,
        config: store.getConfig(),
        models,
        totals: store.getTotals(),
        keys: store.listKeys(),
        logs: store.listLogs(),
      });
    }

    if (pathname === '/api/gateway/config' && req.method === 'PATCH') {
      const body = (await req.json()) as { requireAuth?: boolean };
      if (typeof body.requireAuth !== 'boolean') {
        return errorResponse('requireAuth must be boolean');
      }
      return jsonResponse({ config: store.setRequireAuth(body.requireAuth) });
    }

    if (pathname === '/api/gateway/keys' && req.method === 'POST') {
      let body: unknown;
      try { body = await req.json(); } catch {
        return errorResponse('Request body must be valid JSON');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body) ||
          ('name' in body && typeof body.name !== 'string')) {
        return errorResponse('name must be a string');
      }
      const name = 'name' in body && typeof body.name === 'string' ? body.name : '新密钥';
      return jsonResponse({ key: store.createKey(name) }, 201);
    }

    const delKey = pathname.match(/^\/api\/gateway\/keys\/([^/]+)$/);
    if (delKey && req.method === 'DELETE') {
      const removed = store.deleteKey(decodeURIComponent(delKey[1]));
      return removed ? jsonResponse({ ok: true }) : errorResponse('Key not found', 404);
    }

    if (pathname === '/api/gateway/logs' && req.method === 'DELETE') {
      store.clearLogs();
      return jsonResponse({ ok: true });
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      const asset = serveAppWebAsset(pathname, 'gateway.html', WEB_DIST_DIR);
      if (asset) return asset;
    }

    return errorResponse('Not Found', 404);
  },
});

console.log(`[LLM API Gateway] Listening on http://${LISTEN}:${server.port} (control=${CONTROL_URL})`);

const shutdown = () => {
  server.stop(true);
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
