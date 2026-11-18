import { Database } from 'bun:sqlite';
import { randomBytes } from 'node:crypto';
import { StoreRefusal } from './schema';
import type { Protocol, ProviderPatchBody, ProviderRecord, ProviderModel } from '../protocol/gatewayApi';
import { parseJson } from './protocols/json';

// `ProviderRecord` and `ProviderModel` cross the management API; protocol/gatewayApi.ts defines
// them once.
export type { ProviderRecord, ProviderModel };

/** A model as its provider describes it. Null is "the provider did not say". */
export type ProviderModelInput = Omit<ProviderModel, 'fetchedAt'>;

/** What the store writes for a new provider: the API's body plus the credential as stored. */
export interface ProviderInput {
  name: string;
  connector: string;
  baseUrl: string | null;
  /** The credential as the gateway stores it, a JSON text only the connector reads. */
  credential: string | null;
  autoPublish: boolean;
}
/** The fields of a provider a patch may change; the credential has its own setter. */
export type ProviderPatch = Pick<ProviderPatchBody, 'name' | 'baseUrl' | 'enabled' | 'autoPublish'>;
interface ProviderRow {
  id: string;
  name: string;
  connector: string;
  base_url: string | null;
  enabled: number;
  auto_publish: number;
  has_credential: number;
  credential_rejected: number;
  created_at: string;
}
interface ProviderModelRow {
  upstream_id: string;
  context_length: number | null;
  max_output_tokens: number | null;
  input_price: number | null;
  output_price: number | null;
  cache_read_price: number | null;
  protocols: string | null;
  fetched_at: string;
}

/** Whether a stored value names a protocol the gateway speaks. */
function isProtocol(value: unknown): value is Protocol {
  return value === 'chat' || value === 'messages' || value === 'responses';
}

/**
 * The protocols a stored row names; null is "the provider did not say". Text that is not a JSON
 * array of the gateway's protocols is a corrupt row: it fails loudly rather than passing for a
 * provider that said nothing.
 */
function storedProtocols(
  text: string | null, providerId: string, upstreamId: string,
): Protocol[] | null {
  if (text === null) return null;
  const value: unknown = parseJson(text);
  if (Array.isArray(value) && value.every(isProtocol)) return value;
  throw new Error(`Corrupt protocols for provider ${providerId} model ${upstreamId}: ${text}`);
}

const selectProvider = `SELECT id, name, connector, base_url, enabled, auto_publish,
  credential IS NOT NULL AS has_credential, credential_rejected, created_at FROM providers`;

function mapProvider(row: ProviderRow): ProviderRecord {
  return {
    id: row.id,
    name: row.name,
    connector: row.connector,
    baseUrl: row.base_url,
    enabled: row.enabled !== 0,
    autoPublish: row.auto_publish !== 0,
    hasCredential: row.has_credential !== 0,
    credentialRejected: row.credential_rejected !== 0,
    createdAt: row.created_at,
  };
}

export class ProviderStore {
  constructor(private readonly db: Database) {}

  list(): ProviderRecord[] {
    return this.db.query<ProviderRow, []>(`${selectProvider} ORDER BY created_at, id`).all().map(mapProvider);
  }

  get(id: string): ProviderRecord | null {
    const row = this.db.query<ProviderRow, [string]>(`${selectProvider} WHERE id = ?`).get(id);
    return row ? mapProvider(row) : null;
  }

  create(input: ProviderInput, now: Date): ProviderRecord {
    const id = `prv-${randomBytes(4).toString('hex')}`;
    this.ensureNameAvailable(input.name);
    this.db.query(`INSERT INTO providers (id, name, connector, base_url, credential, auto_publish, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, input.name, input.connector, input.baseUrl,
      input.credential, Number(input.autoPublish), now.toISOString());
    return this.get(id)!;
  }

  update(id: string, patch: ProviderPatch): ProviderRecord | null {
    const existing = this.get(id);
    if (!existing) return null;
    if (patch.name !== undefined) this.ensureNameAvailable(patch.name, id);
    this.db.query('UPDATE providers SET name = ?, base_url = ?, enabled = ?, auto_publish = ? WHERE id = ?')
      .run(patch.name ?? existing.name, patch.baseUrl === undefined ? existing.baseUrl : patch.baseUrl,
        Number(patch.enabled ?? existing.enabled), Number(patch.autoPublish ?? existing.autoPublish), id);
    return this.get(id);
  }

  /**
   * Replaces the stored credential; null removes it. A credential just stored is never one the
   * provider has refused, so the rejected mark is cleared either way.
   */
  setCredential(id: string, credential: string | null): boolean {
    return this.db.query(
      'UPDATE providers SET credential = ?, credential_rejected = 0 WHERE id = ?'
    ).run(credential, id).changes > 0;
  }

  /**
   * Marks the stored credential as refused by the provider: its routes leave routing until a
   * new credential is stored. Returns false for an unknown provider.
   */
  rejectCredential(id: string): boolean {
    return this.db.query(
      'UPDATE providers SET credential_rejected = 1 WHERE id = ?'
    ).run(id).changes > 0;
  }

  credential(id: string): string | null {
    const row = this.db.query<{ credential: string | null }, [string]>(
      'SELECT credential FROM providers WHERE id = ?'
    ).get(id);
    return row?.credential ?? null;
  }

  delete(id: string): boolean {
    return this.db.query('DELETE FROM providers WHERE id = ?').run(id).changes > 0;
  }

  replaceModels(id: string, models: ProviderModelInput[], now: Date): void {
    this.db.transaction(() => {
      this.db.query('DELETE FROM provider_models WHERE provider_id = ?').run(id);
      const insert = this.db.query(`INSERT INTO provider_models (provider_id, upstream_id, context_length,
        max_output_tokens, input_price, output_price, cache_read_price, protocols, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      for (const model of models) {
        insert.run(id, model.upstreamId, model.contextLength, model.maxOutputTokens, model.price.input,
          model.price.output, model.price.cacheRead,
          model.protocols === null ? null : JSON.stringify(model.protocols), now.toISOString());
      }
    })();
  }

  models(id: string): ProviderModel[] {
    return this.db.query<ProviderModelRow, [string]>(
      'SELECT * FROM provider_models WHERE provider_id = ? ORDER BY upstream_id'
    )
      .all(id).map((row) => ({
        upstreamId: row.upstream_id,
        contextLength: row.context_length,
        maxOutputTokens: row.max_output_tokens,
        price: {
          input: row.input_price,
          output: row.output_price,
          cacheRead: row.cache_read_price,
        },
        protocols: storedProtocols(row.protocols, id, row.upstream_id),
        fetchedAt: row.fetched_at,
      }));
  }

  private ensureNameAvailable(name: string, except = ''): void {
    const found = this.db.query<{ id: string }, [string, string]>(
      'SELECT id FROM providers WHERE name = ? AND id != ?'
    ).get(name, except);
    if (found) {
      throw new StoreRefusal('名称已存在');
    }
  }
}
