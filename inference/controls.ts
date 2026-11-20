// The OpenRouter-style routing controls a request may carry: a fallback list of model names and
// provider preferences. Both are stripped from the body before any upstream sees it.

import type { UsableRoute } from './routes';
import { priceOf, type ModelRecord } from '../modelStore';
import { isObject, type JsonObject } from '../protocols/json';

/** At most this many candidate models in one `models` list. */
export const MAX_MODELS = 5;

/** Provider preferences of one request, matched against provider names. */
export interface ProviderPreferences {
  /** Providers to try first, in this order; null when the client gave no order. */
  order: string[] | null;
  /** When non-null, only these providers may serve. */
  only: string[] | null;
  /** Providers that may not serve. */
  ignore: string[] | null;
  /** False tries exactly one route of the first candidate. */
  allowFallbacks: boolean;
  /** Sort by effective input + output price; null when the client gave no sort. */
  sort: 'price' | null;
}

/** Validated routing controls. */
export interface RoutingControls {
  /** Model names to try in order, deduplicated; the first is the primary. */
  candidates: string[];
  /** Provider preferences, or null when the body named none. */
  provider: ProviderPreferences | null;
}

/** A refusal of malformed routing controls: the client's 400. */
export interface ControlsRefusal {
  message: string;
  param: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

function stringList(value: unknown, param: string): string[] | ControlsRefusal {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    return { message: 'Expected an array of non-empty strings', param };
  }
  return value;
}

function providerPreferences(value: unknown): ProviderPreferences | ControlsRefusal {
  if (!isObject(value)) return { message: 'Expected an object', param: 'provider' };
  const order = value.order === undefined ? null : stringList(value.order, 'provider.order');
  if (order !== null && !Array.isArray(order)) return order;
  const only = value.only === undefined ? null : stringList(value.only, 'provider.only');
  if (only !== null && !Array.isArray(only)) return only;
  const ignore = value.ignore === undefined ? null : stringList(value.ignore, 'provider.ignore');
  if (ignore !== null && !Array.isArray(ignore)) return ignore;
  if (value.allow_fallbacks !== undefined && typeof value.allow_fallbacks !== 'boolean') {
    return { message: 'Expected a boolean', param: 'provider.allow_fallbacks' };
  }
  if (value.sort !== undefined && value.sort !== 'price') {
    return { message: "Expected 'price'", param: 'provider.sort' };
  }
  return {
    order: order as string[] | null,
    only: only as string[] | null,
    ignore: ignore as string[] | null,
    allowFallbacks: value.allow_fallbacks !== false,
    sort: value.sort === 'price' ? 'price' : null,
  };
}

/**
 * Read and validate `model`, `models` and `provider`. A malformed list is a 400 naming it; the
 * caller removes `models` and `provider` from the body afterwards.
 */
export function routingControls(
  body: JsonObject,
): { controls: RoutingControls } | { refusal: ControlsRefusal } {
  let models: string[] = [];
  if (body.models !== undefined) {
    if (!Array.isArray(body.models) || body.models.length < 1 || body.models.length > MAX_MODELS
      || !body.models.every(isNonEmptyString)) {
      return {
        refusal: { message: `Expected 1 to ${MAX_MODELS} non-empty model names`, param: 'models' },
      };
    }
    if (new Set(body.models).size !== body.models.length) {
      return { refusal: { message: 'Expected unique model names', param: 'models' } };
    }
    models = body.models;
  }
  if (body.model !== undefined && !isNonEmptyString(body.model)) {
    return { refusal: { message: 'Expected a non-empty model', param: 'model' } };
  }
  const primary = isNonEmptyString(body.model) ? body.model : models[0];
  if (primary === undefined) {
    return { refusal: { message: 'Expected a non-empty model', param: 'model' } };
  }
  let provider: ProviderPreferences | null = null;
  if (body.provider !== undefined) {
    const parsed = providerPreferences(body.provider);
    if (!('allowFallbacks' in parsed)) return { refusal: parsed };
    provider = parsed;
  }
  return {
    controls: {
      candidates: [...new Set([primary, ...models])],
      provider,
    },
  };
}

/** The effective input + output price of a route; null unless both are known. */
function effectivePrice(route: UsableRoute, model: ModelRecord): number | null {
  const price = priceOf(route.route, model);
  if (price.input === null || price.output === null) return null;
  return price.input + price.output;
}

/**
 * The routes provider preferences leave, in the order they are to be tried. `sequential` is
 * true when an order or a price sort was given: the caller then picks in list order instead of
 * the weighted least-load rule, while still respecting cooldowns and capacity.
 */
export function providerRoutes(
  routes: UsableRoute[],
  preferences: ProviderPreferences | null,
  model: ModelRecord,
): { routes: UsableRoute[]; sequential: boolean } {
  if (preferences === null) return { routes, sequential: false };
  const { only, ignore, order, sort, allowFallbacks } = preferences;
  let filtered = routes.filter(({ provider }) =>
    (only === null || only.includes(provider.name)) && (ignore === null || !ignore.includes(provider.name)));
  if (sort === 'price') {
    filtered = filtered
      .map((route, index) => ({ route, index, price: effectivePrice(route, model) }))
      .sort((a, b) => {
        if (a.price === null && b.price === null) return a.index - b.index;
        if (a.price === null) return 1;
        if (b.price === null) return -1;
        return a.price - b.price || a.index - b.index;
      })
      .map(({ route }) => route);
  }
  if (order !== null && order.length > 0) {
    const rank = new Map(order.map((name, index) => [name, index]));
    const listed = filtered
      .filter(({ provider }) => rank.has(provider.name))
      .sort((a, b) => rank.get(a.provider.name)! - rank.get(b.provider.name)!);
    filtered = allowFallbacks
      ? [...listed, ...filtered.filter(({ provider }) => !rank.has(provider.name))]
      : listed;
  }
  if (!allowFallbacks) filtered = filtered.slice(0, 1);
  return { routes: filtered, sequential: sort !== null || (order !== null && order.length > 0) };
}
