// The OpenRouter-compatible account routes: what one key spent, and what one of its requests did.

import type { KeyStore } from '../keyStore';
import { protocolModule } from '../protocols/protocol';
import type { UsageStore } from '../usageStore';
import { authenticate } from './auth';

/** Services the account routes read. */
export interface AccountDeps {
  keys: KeyStore;
  usage: UsageStore;
  now(): Date;
}

function json(payload: unknown, status = 200): Response {
  return Response.json(payload, { status });
}

function openaiError(status: number, message: string, param?: string): Response {
  return json(protocolModule('chat').errorBody(status, message, param), status);
}

/** `{ data: { ... } }` for GET /v1/generation. */
export interface GenerationAnswer {
  data: {
    id: string;
    model: string;
    provider_name: string | null;
    upstream_model: string | null;
    protocol: string;
    status: number;
    tokens_prompt: number | null;
    tokens_completion: number | null;
    native_tokens_cached: number | null;
    total_cost: number | null;
    latency: number;
    ttft: number | null;
    created_at: string;
    error: string | null;
  };
}

/** `{ data: { ... } }` for GET /v1/key and GET /v1/auth/key. */
export interface KeyAnswer {
  data: {
    label: string;
    limit: number | null;
    limit_remaining: number | null;
    limit_reset: string;
    usage: number;
    usage_total: number;
    max_concurrency: number | null;
    expires_at: string | null;
    is_free_tier: false;
  };
}

/**
 * GET /v1/generation?id=gen-...: one request of the presenting key. Only the last 200 requests
 * are retained, so an id that rotated out answers 404 exactly like an unknown one, and another
 * key's id is never visible.
 */
export function handleGeneration(req: Request, deps: AccountDeps): Response {
  const key = authenticate(req, deps.keys, deps.now());
  if (!key) return openaiError(401, 'Invalid API key');
  const id = new URL(req.url).searchParams.get('id');
  if (id === null || id.trim() === '') return openaiError(400, 'Expected an id', 'id');
  const row = deps.usage.generation(id, key.id);
  if (!row) return openaiError(404, 'Generation not found');
  const answer: GenerationAnswer = {
    data: {
      id: row.requestId,
      model: row.modelName,
      provider_name: row.providerName,
      upstream_model: row.upstreamModel,
      protocol: row.protocol,
      status: row.status,
      tokens_prompt: row.inputTokens,
      tokens_completion: row.outputTokens,
      native_tokens_cached: row.cacheReadTokens,
      total_cost: row.cost,
      latency: row.latencyMs,
      ttft: row.ttftMs,
      created_at: row.timestamp,
      error: row.error,
    },
  };
  return json(answer);
}

/** GET /v1/key and GET /v1/auth/key: the presenting key's limits and spend. */
export function handleKeyInfo(req: Request, deps: AccountDeps): Response {
  const key = authenticate(req, deps.keys, deps.now());
  if (!key) return openaiError(401, 'Invalid API key');
  const answer: KeyAnswer = {
    data: {
      label: key.name,
      limit: key.costLimit,
      limit_remaining: key.costLimit === null
        ? null
        : Math.max(0, key.costLimit - key.periodCost),
      limit_reset: key.resetPeriod,
      usage: key.periodCost,
      usage_total: key.totalCost,
      max_concurrency: key.maxConcurrency,
      expires_at: key.expiresAt,
      is_free_tier: false,
    },
  };
  return json(answer);
}
