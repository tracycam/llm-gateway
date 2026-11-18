// API key management routes.
import type {
  KeyCreateBody,
  KeyCreatedResponse,
  KeyPatchBody,
  KeyResponse,
  KeysResponse,
} from '../../protocol/gatewayApi';
import { jsonResponse } from '../http';
import type { ResetPeriod } from '../period';
import type { JsonObject } from '../protocols/json';
import type { AdminDeps } from './deps';
import { dispatch, type AdminRoute } from './dispatch';
import {
  boolean, InputError, integerAtLeast, nonNegativeNumberOrNull, optionalString, readBody, string,
} from './input';

function modelIds(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((id: unknown) => typeof id !== 'string' || id.trim() === '')) {
    throw new InputError('modelIds 无效');
  }
  const ids: string[] = value;
  if (new Set(ids).size !== ids.length) throw new InputError('modelIds 无效');
  return ids;
}

function resetPeriod(value: unknown): ResetPeriod | undefined {
  if (value === undefined) return undefined;
  if (value === 'none' || value === 'day' || value === 'week' || value === 'month') return value;
  throw new InputError('resetPeriod 无效');
}

function expiresAt(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return value;
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) throw new InputError('expiresAt 无效');
  return new Date(value).toISOString();
}

function limits(body: JsonObject, deps: AdminDeps): Omit<KeyPatchBody, 'name' | 'enabled'> {
  const restricted = boolean(body.restricted, 'restricted');
  const ids = modelIds(body.modelIds);
  const costLimit = body.costLimit === undefined
    ? undefined : nonNegativeNumberOrNull(body.costLimit, 'costLimit');
  const period = resetPeriod(body.resetPeriod);
  const concurrency = body.maxConcurrency === null
    ? null : integerAtLeast(body.maxConcurrency, 'maxConcurrency', 1);
  const expiry = expiresAt(body.expiresAt);
  if (ids?.some((id) => !deps.models.get(id))) throw new InputError('modelIds 无效');
  return {
    restricted,
    modelIds: ids,
    costLimit,
    resetPeriod: period,
    maxConcurrency: concurrency,
    expiresAt: expiry,
  };
}

function list(_req: Request, deps: AdminDeps): Response {
  return jsonResponse({ keys: deps.keys.list(deps.now()) } satisfies KeysResponse);
}

async function create(req: Request, deps: AdminDeps): Promise<Response> {
  const body = await readBody(req);
  const name = string(body.name, 'name');
  const input: KeyCreateBody = { ...limits(body, deps), name };
  const { token, ...key } = deps.keys.create(input, deps.now());
  return jsonResponse({ key, token } satisfies KeyCreatedResponse, 201);
}

async function update(req: Request, deps: AdminDeps, [id]: string[]): Promise<Response> {
  const body = await readBody(req);
  const name = optionalString(body.name, 'name');
  const enabled = boolean(body.enabled, 'enabled');
  const patch: KeyPatchBody = { ...limits(body, deps), name, enabled };
  const key = deps.keys.update(id, patch, deps.now());
  if (!key) throw new InputError('未找到密钥', 404);
  return jsonResponse({ key } satisfies KeyResponse);
}

function remove(_req: Request, deps: AdminDeps, [id]: string[]): Response {
  if (!deps.keys.delete(id)) throw new InputError('未找到密钥', 404);
  return new Response(null, { status: 204 });
}

function reset(_req: Request, deps: AdminDeps, [id]: string[]): Response {
  const key = deps.keys.resetUsage(id, deps.now());
  if (!key) throw new InputError('未找到密钥', 404);
  return jsonResponse({ key } satisfies KeyResponse);
}

const routes: readonly AdminRoute[] = [
  ['GET', /^\/api\/gateway\/keys$/, list],
  ['POST', /^\/api\/gateway\/keys$/, create],
  ['PATCH', /^\/api\/gateway\/keys\/([^/]+)$/, update],
  ['DELETE', /^\/api\/gateway\/keys\/([^/]+)$/, remove],
  ['POST', /^\/api\/gateway\/keys\/([^/]+)\/reset$/, reset],
];

/** Handle key management paths; return null for other paths. */
export function handleKeyRoute(req: Request, deps: AdminDeps): Promise<Response | null> {
  return dispatch(req, deps, routes);
}
