// Usage and request log management routes.
import type {
  LogsResponse,
  TotalsResponse,
  UsageByDayResponse,
  UsageByKeyResponse,
  UsageByModelResponse,
  UsageByProviderResponse,
} from '../shared/api';
import { jsonResponse } from '../http';
import type { DayRange } from '../usageStore';
import type { AdminDeps } from './deps';
import { dispatch, type AdminRoute } from './dispatch';
import { InputError } from './input';

function day(value: string | null, field: string): string | undefined {
  if (value === null) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new InputError(`${field} 无效`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new InputError(`${field} 无效`);
  }
  return value;
}

function usage(req: Request, deps: AdminDeps): Response {
  const query = new URL(req.url).searchParams;
  const by = query.get('by');
  if (by !== 'model' && by !== 'key' && by !== 'day' && by !== 'provider') throw new InputError('by 无效');
  const from = day(query.get('from'), 'from');
  const to = day(query.get('to'), 'to');
  if (from && to && from > to) throw new InputError('from 无效');
  const range: DayRange = { from, to };
  const model = query.get('model');
  const key = query.get('key');
  if (by === 'provider') {
    if (!model) throw new InputError('model 无效');
    return jsonResponse({ rows: deps.usage.byProvider(model, range) } satisfies UsageByProviderResponse);
  }
  if (by === 'model') {
    return jsonResponse({ rows: deps.usage.byModel(range) } satisfies UsageByModelResponse);
  }
  if (by === 'key') return jsonResponse({ rows: deps.usage.byKey(range) } satisfies UsageByKeyResponse);
  const rows = deps.usage.byDay(range, { modelId: model ?? undefined, keyId: key ?? undefined });
  return jsonResponse({ rows } satisfies UsageByDayResponse);
}

function totals(_req: Request, deps: AdminDeps): Response {
  return jsonResponse({ totals: deps.usage.totals() } satisfies TotalsResponse);
}

function logs(_req: Request, deps: AdminDeps): Response {
  return jsonResponse({ logs: deps.usage.logs() } satisfies LogsResponse);
}

function clearLogs(_req: Request, deps: AdminDeps): Response {
  deps.usage.clearLogs();
  return new Response(null, { status: 204 });
}

const routes: readonly AdminRoute[] = [
  ['GET', /^\/api\/gateway\/usage$/, usage],
  ['GET', /^\/api\/gateway\/usage\/totals$/, totals],
  ['GET', /^\/api\/gateway\/logs$/, logs],
  ['DELETE', /^\/api\/gateway\/logs$/, clearLogs],
];

/** Handle usage and log paths; return null for other paths. */
export function handleUsageRoute(req: Request, deps: AdminDeps): Promise<Response | null> {
  return dispatch(req, deps, routes);
}
