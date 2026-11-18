import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import type {
  ModelCreateBody, ModelPatchBody, ModelRecord, Price, RouteCreateBody, RoutePatchBody, RouteRecord,
} from '../protocol/gatewayApi';
import { StoreRefusal } from './schema';

// `ModelRecord`, `RouteRecord` and the bodies cross the management API; protocol/gatewayApi.ts
// defines them once and this module re-exports them under their current names.
export type { ModelRecord, RouteRecord };
export type ModelInput = ModelCreateBody;
export type ModelPatch = ModelPatchBody;
export type RouteInput = RouteCreateBody;
export type RoutePatch = RoutePatchBody;

interface ModelRow {
  id: string;
  name: string;
  input_price: number | null;
  output_price: number | null;
  cache_read_price: number | null;
  context_length: number | null;
  enabled: number;
  created_at: string;
}
interface RouteRow {
  id: string;
  model_id: string;
  provider_id: string;
  provider_name: string;
  upstream_model: string;
  weight: number;
  enabled: number;
  input_price: number | null;
  output_price: number | null;
  cache_read_price: number | null;
}
interface DiscoveredRow {
  context_length: number | null;
  input_price: number | null;
  output_price: number | null;
  cache_read_price: number | null;
}

const routeSelect = `SELECT routes.*, providers.name AS provider_name FROM routes
  JOIN providers ON providers.id = routes.provider_id`;
const emptyPrice: Price = { input: null, output: null, cacheRead: null };

/**
 * The price a publish writes onto the new route of a model that already exists, or null to let the
 * route follow the model. A route price must be usable for costing, and it only earns its place
 * when it says something the model price does not.
 */
function publishedRoutePrice(discovered: Price, modelPrice: Price): Price | null {
  if (discovered.input === null || discovered.output === null) return null;
  const differs =
    discovered.input !== modelPrice.input ||
    discovered.output !== modelPrice.output ||
    discovered.cacheRead !== modelPrice.cacheRead;
  return differs ? discovered : null;
}

function mapRoute(row: RouteRow): RouteRecord {
  return {
    id: row.id,
    modelId: row.model_id,
    providerId: row.provider_id,
    providerName: row.provider_name,
    upstreamModel: row.upstream_model,
    weight: row.weight,
    enabled: row.enabled !== 0,
    price: row.input_price === null ? null : {
      input: row.input_price,
      output: row.output_price,
      cacheRead: row.cache_read_price,
    },
  };
}

export function priceOf(route: RouteRecord, model: ModelRecord): Price {
  return route.price ?? model.price;
}

export class ModelStore {
  constructor(private readonly db: Database) {}

  list(): ModelRecord[] {
    return this.db.query<ModelRow, []>('SELECT * FROM models ORDER BY created_at, id')
      .all().map((row) => this.mapModel(row));
  }

  get(id: string): ModelRecord | null {
    const row = this.db.query<ModelRow, [string]>('SELECT * FROM models WHERE id = ?').get(id);
    return row ? this.mapModel(row) : null;
  }

  byName(name: string): ModelRecord | null {
    const row = this.db.query<ModelRow, [string]>('SELECT * FROM models WHERE name = ?').get(name);
    return row ? this.mapModel(row) : null;
  }

  create(input: ModelInput, now: Date): ModelRecord {
    this.ensureNameAvailable(input.name);
    const id = `mdl-${randomBytes(4).toString('hex')}`;
    const price = input.price ?? emptyPrice;
    this.db.query(`INSERT INTO models (id, name, input_price, output_price, cache_read_price,
      context_length, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, input.name, price.input, price.output, price.cacheRead,
        input.contextLength ?? null, now.toISOString());
    return this.get(id)!;
  }

  update(id: string, patch: ModelPatch): ModelRecord | null {
    const old = this.get(id);
    if (!old) return null;
    if (patch.name !== undefined) this.ensureNameAvailable(patch.name, id);
    const price = patch.price ?? old.price;
    this.db.query(`UPDATE models SET name = ?, input_price = ?, output_price = ?, cache_read_price = ?,
      context_length = ?, enabled = ? WHERE id = ?`)
      .run(patch.name ?? old.name, price.input, price.output, price.cacheRead,
        patch.contextLength === undefined ? old.contextLength : patch.contextLength,
        Number(patch.enabled ?? old.enabled), id);
    return this.get(id);
  }

  delete(id: string): boolean {
    return this.db.query('DELETE FROM models WHERE id = ?').run(id).changes > 0;
  }

  addRoute(modelId: string, input: RouteInput): RouteRecord {
    const id = `rte-${randomBytes(4).toString('hex')}`;
    this.db.query(`INSERT INTO routes (id, model_id, provider_id, upstream_model, weight,
      input_price, output_price, cache_read_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, modelId, input.providerId, input.upstreamModel, input.weight ?? 1,
        input.price?.input ?? null, input.price?.output ?? null,
        input.price?.cacheRead ?? null);
    return this.route(id)!;
  }

  updateRoute(id: string, patch: RoutePatch): RouteRecord | null {
    const old = this.route(id);
    if (!old) return null;
    const price = patch.price;
    const replacePrice = Number(price !== undefined);
    this.db.query(`UPDATE routes SET weight = ?, enabled = ?,
      input_price = CASE WHEN ? THEN ? ELSE input_price END,
      output_price = CASE WHEN ? THEN ? ELSE output_price END,
      cache_read_price = CASE WHEN ? THEN ? ELSE cache_read_price END WHERE id = ?`)
      .run(patch.weight ?? old.weight, Number(patch.enabled ?? old.enabled),
        replacePrice, price?.input ?? null, replacePrice, price?.output ?? null,
        replacePrice, price?.cacheRead ?? null, id);
    return this.route(id);
  }

  removeRoute(id: string): boolean {
    return this.db.query('DELETE FROM routes WHERE id = ?').run(id).changes > 0;
  }

  publish(providerId: string, upstreamId: string, now: Date): RouteRecord {
    return this.db.transaction(() => {
      const discovered = this.db.query<DiscoveredRow, [string, string]>(
        'SELECT * FROM provider_models WHERE provider_id = ? AND upstream_id = ?'
      ).get(providerId, upstreamId);
      if (!discovered) throw new StoreRefusal('未找到提供商模型', 404);
      const discoveredPrice: Price = {
        input: discovered.input_price,
        output: discovered.output_price,
        cacheRead: discovered.cache_read_price,
      };
      const model = this.byName(upstreamId) ?? this.create({
        name: upstreamId,
        contextLength: discovered.context_length,
        price: discoveredPrice,
      }, now);
      const existing = this.db.query<RouteRow, [string, string, string]>(`${routeSelect}
        WHERE routes.model_id = ? AND routes.provider_id = ? AND routes.upstream_model = ?`)
        .get(model.id, providerId, upstreamId);
      if (existing) return mapRoute(existing);
      // A model this publish has just created carries the discovered price itself, so its
      // route gets none; a later provider's price is the route's own when it differs.
      const price = publishedRoutePrice(discoveredPrice, model.price);
      return this.addRoute(model.id, {
        providerId,
        upstreamModel: upstreamId,
        ...(price === null ? {} : { price }),
      });
    })();
  }

  private route(id: string): RouteRecord | null {
    const row = this.db.query<RouteRow, [string]>(`${routeSelect} WHERE routes.id = ?`).get(id);
    return row ? mapRoute(row) : null;
  }

  private mapModel(row: ModelRow): ModelRecord {
    return {
      id: row.id,
      name: row.name,
      price: {
        input: row.input_price,
        output: row.output_price,
        cacheRead: row.cache_read_price,
      },
      contextLength: row.context_length,
      enabled: row.enabled !== 0,
      createdAt: row.created_at,
      // `routes` has no creation column: rowid grows with insertion, which is the order the
      // design gives a model's routes. The only VACUUM is in the version-1 migration, before
      // this table exists, so it never renumbers these rows.
      routes: this.db.query<RouteRow, [string]>(
        `${routeSelect} WHERE routes.model_id = ? ORDER BY routes.rowid`
      ).all(row.id).map(mapRoute),
    };
  }

  private ensureNameAvailable(name: string, except = ''): void {
    const found = this.db.query<{ id: string }, [string, string]>(
      'SELECT id FROM models WHERE name = ? AND id != ?'
    ).get(name, except);
    if (found) {
      throw new StoreRefusal('名称已存在');
    }
  }
}
