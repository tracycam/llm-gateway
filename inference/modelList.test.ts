import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Connector } from '../connectors/connector';
import { KeyStore } from '../keyStore';
import { ModelStore, type ModelRecord } from '../modelStore';
import type { Price } from '../pricing';
import { isObject } from '../protocols/json';
import { protocolModule, type Protocol } from '../protocols/protocol';
import { ProviderStore, type ProviderRecord } from '../providerStore';
import { migrate } from '../schema';
import { UsageStore } from '../usageStore';
import {
  handleModel,
  handleModelList,
  listShape,
  modelListResponse,
  modelResponse,
  type ListShape,
  type ModelListRequestDeps,
} from './modelList';

const start = new Date('2026-01-01T00:00:00Z');
const priced: Price = { input: 1, output: 2, cacheRead: null };
const unpriced: Price = { input: null, output: null, cacheRead: null };

interface Fixture {
  db: Database;
  models: ModelStore;
  providers: ProviderStore;
  keys: KeyStore;
  usage: UsageStore;
  deps: ModelListRequestDeps;
  provider: ProviderRecord;
}

function fixture(): Fixture {
  const db = new Database(':memory:');
  migrate(db);
  const providers = new ProviderStore(db);
  const models = new ModelStore(db);
  const keys = new KeyStore(db);
  const usage = new UsageStore(db);
  const fake: Connector = {
    id: 'fake',
    name: 'Fake',
    defaultBaseUrl: null,
    credential: 'api-key',
    async target() { throw new Error('unused'); },
    async models() { return []; },
  };
  const provider = providers.create({
    name: 'provider',
    connector: fake.id,
    baseUrl: null,
    credential: null,
    autoPublish: false,
  }, start);
  const deps: ModelListRequestDeps = {
    models,
    providers,
    keys,
    connector: (id) => id === fake.id ? fake : null,
    now: () => start,
  };
  return { db, models, providers, keys, usage, deps, provider };
}

/** A model with a route on the fixture's enabled provider. */
function readyModel(f: Fixture, name: string, seconds = 0, price = priced): ModelRecord {
  const createdAt = new Date(start.getTime() + seconds * 1000);
  const model = f.models.create({ name, price, contextLength: 100 }, createdAt);
  f.models.addRoute(model.id, { providerId: f.provider.id, upstreamModel: 'up' });
  return f.models.get(model.id)!;
}

/** The ids of a list body, whatever the shape. */
function listIds(body: unknown): unknown[] {
  if (!isObject(body) || !Array.isArray(body.data)) throw new Error('Not a model list');
  return body.data.map((item) => isObject(item) ? item.id : null);
}

/** The OpenRouter-enriched OpenAI object a fixture model with one route produces. */
function openaiShape(
  id: string,
  created: number,
  ownedBy: string,
  price: Price = priced,
  contextLength: number | null = 100,
) {
  const usd = (perMillion: number | null): string | null => {
    if (perMillion === null) return null;
    const text = (perMillion / 1_000_000).toFixed(18);
    return text === '0.000000000000000000' ? '0' : text.replace(/\.?0+$/, '');
  };
  return {
    id,
    object: 'model',
    created,
    owned_by: ownedBy,
    name: id,
    context_length: contextLength,
    pricing: {
      prompt: usd(price.input),
      completion: usd(price.output),
      input_cache_read: usd(price.cacheRead),
    },
    top_provider: { context_length: contextLength, max_completion_tokens: null },
    supported_protocols: [],
  };
}

test('listShape is OpenAI without an anthropic-version header', () => {
  expect(listShape(new Request('http://localhost/v1/models'))).toBe('openai');
});

test('listShape is Anthropic with an anthropic-version header', () => {
  const req = new Request('http://localhost/v1/models', {
    headers: { 'anthropic-version': '2023-06-01' },
  });
  expect(listShape(req)).toBe('anthropic');
});

test('listShape is Anthropic for any anthropic-version value', () => {
  for (const value of ['2024-10-22', '']) {
    const req = new Request('http://localhost/v1/models', {
      headers: { 'anthropic-version': value },
    });
    expect(listShape(req)).toBe('anthropic');
  }
});

test('an enabled model with a usable route is listed', async () => {
  const f = fixture();
  try {
    readyModel(f, 'zeta');
    readyModel(f, 'alpha', 10);
    const key = f.keys.create({ name: 'key' }, start);
    const response = modelListResponse(key, 'openai', f.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      object: 'list',
      data: [
        openaiShape('zeta', 1767225600, 'provider'),
        openaiShape('alpha', 1767225610, 'provider'),
      ],
    });
  } finally {
    f.db.close();
  }
});

test('created is the creation time in whole seconds', async () => {
  const f = fixture();
  try {
    readyModel(f, 'model', 5);
    const key = f.keys.create({ name: 'key' }, start);
    const body = await modelListResponse(key, 'openai', f.deps).json();
    expect(body).toEqual({
      object: 'list',
      data: [openaiShape('model', 1767225605, 'provider')],
    });
  } finally {
    f.db.close();
  }
});

test('a disabled model is not listed', async () => {
  const f = fixture();
  try {
    const model = readyModel(f, 'model');
    f.models.update(model.id, { enabled: false });
    const key = f.keys.create({ name: 'key' }, start);
    expect(await modelListResponse(key, 'openai', f.deps).json()).toEqual({ object: 'list', data: [] });
  } finally {
    f.db.close();
  }
});

test('a model without a usable route is not listed', async () => {
  const f = fixture();
  try {
    const model = readyModel(f, 'model');
    const route = model.routes[0];
    f.models.updateRoute(route.id, { enabled: false });
    const key = f.keys.create({ name: 'key' }, start);
    expect(await modelListResponse(key, 'openai', f.deps).json()).toEqual({ object: 'list', data: [] });
  } finally {
    f.db.close();
  }
});

test('a model forbidden to the key is not listed', async () => {
  const f = fixture();
  try {
    const allowed = readyModel(f, 'allowed');
    readyModel(f, 'forbidden', 10);
    const key = f.keys.create({ name: 'key', restricted: true, modelIds: [allowed.id] }, start);
    expect(await modelListResponse(key, 'openai', f.deps).json()).toEqual({
      object: 'list',
      data: [openaiShape('allowed', 1767225600, 'provider')],
    });
  } finally {
    f.db.close();
  }
});

test('a model with no price is not listed for a key with a cost limit', async () => {
  const f = fixture();
  try {
    readyModel(f, 'model', 0, unpriced);
    const key = f.keys.create({ name: 'key', costLimit: 5 }, start);
    expect(await modelListResponse(key, 'openai', f.deps).json()).toEqual({ object: 'list', data: [] });
  } finally {
    f.db.close();
  }
});

test('a route price makes an unpriced model usable for a key with a cost limit', async () => {
  const f = fixture();
  try {
    const model = readyModel(f, 'model', 0, unpriced);
    f.models.updateRoute(model.routes[0].id, { price: priced });
    const key = f.keys.create({ name: 'key', costLimit: 5 }, start);
    expect(await modelListResponse(key, 'openai', f.deps).json()).toEqual({
      object: 'list',
      data: [openaiShape('model', 1767225600, 'provider', unpriced)],
    });
  } finally {
    f.db.close();
  }
});

test('an incomplete route price hides a priced model from a key with a cost limit', async () => {
  const f = fixture();
  try {
    const model = readyModel(f, 'model');
    f.models.updateRoute(model.routes[0].id, { price: { ...priced, output: null } });
    const key = f.keys.create({ name: 'key', costLimit: 5 }, start);
    expect(await modelListResponse(key, 'openai', f.deps).json()).toEqual({ object: 'list', data: [] });
  } finally {
    f.db.close();
  }
});

test('a key over its cost limit still sees its models', async () => {
  const f = fixture();
  try {
    const model = readyModel(f, 'model');
    const key = f.keys.create({ name: 'key', costLimit: 1 }, start);
    f.usage.record({
      protocol: 'chat',
      key: { id: key.id, name: key.name },
      model: { id: model.id, name: model.name },
      provider: { id: f.provider.id, name: f.provider.name },
      upstreamModel: 'up',
      status: 200,
      usage: null,
      cost: 2,
      ttftMs: null,
      latencyMs: 1,
      error: null,
    }, start);
    const limited = f.keys.get(key.id, start)!;
    expect(f.keys.overLimit(limited)).toBe(true);
    expect(await modelListResponse(limited, 'openai', f.deps).json()).toEqual({
      object: 'list',
      data: [openaiShape('model', 1767225600, 'provider')],
    });
  } finally {
    f.db.close();
  }
});

test('the list keeps the store order', async () => {
  const f = fixture();
  try {
    readyModel(f, 'zeta');
    readyModel(f, 'alpha', 10);
    const key = f.keys.create({ name: 'key' }, start);
    const body: unknown = await modelListResponse(key, 'openai', f.deps).json();
    expect(listIds(body)).toEqual(['zeta', 'alpha']);
  } finally {
    f.db.close();
  }
});

test('one model is the OpenAI object the list shows', async () => {
  const f = fixture();
  try {
    readyModel(f, 'model');
    const key = f.keys.create({ name: 'key' }, start);
    const response = modelResponse(key, 'model', 'openai', f.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual(openaiShape('model', 1767225600, 'provider'));
  } finally {
    f.db.close();
  }
});

test('an unknown model is 404 in the OpenAI shape', async () => {
  const f = fixture();
  try {
    const key = f.keys.create({ name: 'key' }, start);
    const response = modelResponse(key, 'absent', 'openai', f.deps);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error: { message: 'Model not found', type: 'invalid_request_error', code: null, param: null },
    });
  } finally {
    f.db.close();
  }
});

test("the list is Anthropic's with an anthropic-version header", async () => {
  const f = fixture();
  try {
    readyModel(f, 'model');
    const key = f.keys.create({ name: 'key' }, start);
    const req = new Request('http://localhost/v1/models', {
      headers: { 'anthropic-version': '2023-06-01' },
    });
    const response = modelListResponse(key, listShape(req), f.deps);
    expect(await response.json()).toEqual({
      data: [{
        type: 'model',
        id: 'model',
        display_name: 'model',
        created_at: '2026-01-01T00:00:00.000Z',
      }],
      has_more: false,
      first_id: 'model',
      last_id: 'model',
    });
  } finally {
    f.db.close();
  }
});

test('the Anthropic list carries display names and creation times', async () => {
  const f = fixture();
  try {
    readyModel(f, 'zeta');
    readyModel(f, 'alpha', 10);
    const key = f.keys.create({ name: 'key' }, start);
    expect(await modelListResponse(key, 'anthropic', f.deps).json()).toEqual({
      data: [
        {
          type: 'model',
          id: 'zeta',
          display_name: 'zeta',
          created_at: '2026-01-01T00:00:00.000Z',
        },
        {
          type: 'model',
          id: 'alpha',
          display_name: 'alpha',
          created_at: '2026-01-01T00:00:10.000Z',
        },
      ],
      has_more: false,
      first_id: 'zeta',
      last_id: 'alpha',
    });
  } finally {
    f.db.close();
  }
});

test('an empty Anthropic list has null first_id and last_id', async () => {
  const f = fixture();
  try {
    const key = f.keys.create({ name: 'key' }, start);
    expect(await modelListResponse(key, 'anthropic', f.deps).json()).toEqual({
      data: [],
      has_more: false,
      first_id: null,
      last_id: null,
    });
  } finally {
    f.db.close();
  }
});

test('one model is the Anthropic object the list shows', async () => {
  const f = fixture();
  try {
    readyModel(f, 'model');
    const key = f.keys.create({ name: 'key' }, start);
    const response = modelResponse(key, 'model', 'anthropic', f.deps);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      type: 'model',
      id: 'model',
      display_name: 'model',
      created_at: '2026-01-01T00:00:00.000Z',
    });
  } finally {
    f.db.close();
  }
});

test('an unknown model is 404 in the Anthropic shape', async () => {
  const f = fixture();
  try {
    const key = f.keys.create({ name: 'key' }, start);
    const response = modelResponse(key, 'absent', 'anthropic', f.deps);
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      type: 'error',
      error: { type: 'not_found_error', message: 'Model not found' },
    });
  } finally {
    f.db.close();
  }
});

test('a model not listed for the key answers like a missing one', async () => {
  const f = fixture();
  try {
    const allowed = readyModel(f, 'allowed');
    const disabled = readyModel(f, 'disabled');
    f.models.update(disabled.id, { enabled: false });
    readyModel(f, 'forbidden');
    const key = f.keys.create({ name: 'key', restricted: true, modelIds: [allowed.id] }, start);
    const shapes: ListShape[] = ['openai', 'anthropic'];
    for (const shape of shapes) {
      const missing = await modelResponse(key, 'absent', shape, f.deps);
      const missingBody = await missing.text();
      for (const name of ['disabled', 'forbidden']) {
        const response = await modelResponse(key, name, shape, f.deps);
        expect(response.status).toBe(missing.status);
        expect(await response.text()).toBe(missingBody);
      }
    }
  } finally {
    f.db.close();
  }
});

test('a request without a key is 401 in the OpenAI shape', async () => {
  const f = fixture();
  try {
    const response = handleModelList(new Request('http://localhost/v1/models'), f.deps);
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error: { message: 'Invalid API key', type: 'authentication_error', code: null, param: null },
    });
  } finally {
    f.db.close();
  }
});

test('a request without a key is 401 in the Anthropic shape', async () => {
  const f = fixture();
  try {
    const req = new Request('http://localhost/v1/models', {
      headers: { 'anthropic-version': '2023-06-01' },
    });
    const response = handleModelList(req, f.deps);
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      type: 'error',
      error: { type: 'authentication_error', message: 'Invalid API key' },
    });
  } finally {
    f.db.close();
  }
});

test('a disabled key is 401 from the list', async () => {
  const f = fixture();
  try {
    readyModel(f, 'model');
    const key = f.keys.create({ name: 'key' }, start);
    f.keys.update(key.id, { enabled: false }, start);
    const req = new Request('http://localhost/v1/models', {
      headers: { authorization: `Bearer ${key.token}` },
    });
    const response = handleModelList(req, f.deps);
    expect(response.status).toBe(401);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual({
      error: { message: 'Invalid API key', type: 'authentication_error', code: null, param: null },
    });
  } finally {
    f.db.close();
  }
});

test('a valid key gets the list modelListResponse gives', async () => {
  const f = fixture();
  try {
    readyModel(f, 'model');
    const key = f.keys.create({ name: 'key' }, start);
    const req = new Request('http://localhost/v1/models', {
      headers: { authorization: `Bearer ${key.token}` },
    });
    const response = handleModelList(req, f.deps);
    const expected = modelListResponse(key, 'openai', f.deps);
    expect(response.status).toBe(expected.status);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual(await expected.json());
  } finally {
    f.db.close();
  }
});

test('a valid key gets the model modelResponse gives', async () => {
  const f = fixture();
  try {
    readyModel(f, 'model');
    const key = f.keys.create({ name: 'key' }, start);
    const req = new Request('http://localhost/v1/models/model', {
      headers: { authorization: `Bearer ${key.token}` },
    });
    const response = handleModel(req, 'model', f.deps);
    const expected = modelResponse(key, 'model', 'openai', f.deps);
    expect(response.status).toBe(expected.status);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual(await expected.json());
  } finally {
    f.db.close();
  }
});

test('a valid key gets the 404 modelResponse gives for an unknown model', async () => {
  const f = fixture();
  try {
    readyModel(f, 'model');
    const key = f.keys.create({ name: 'key' }, start);
    const req = new Request('http://localhost/v1/models/absent', {
      headers: { authorization: `Bearer ${key.token}` },
    });
    const response = handleModel(req, 'absent', f.deps);
    const expected = modelResponse(key, 'absent', 'openai', f.deps);
    expect(response.status).toBe(expected.status);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.json()).toEqual(await expected.json());
  } finally {
    f.db.close();
  }
});

test('rule B2: the model list leaves out a model whose only route is rejected', async () => {
  const f = fixture();
  try {
    const model = readyModel(f, 'model');
    const other = f.providers.create({
      name: 'other', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
    }, start);
    f.models.addRoute(model.id, { providerId: other.id, upstreamModel: 'up' });
    const key = f.keys.create({ name: 'key' }, start);
    f.providers.rejectCredential(f.provider.id);
    expect(await modelListResponse(key, 'openai', f.deps).json()).toEqual({
      object: 'list',
      data: [openaiShape('model', 1767225600, 'other')],
    });
    f.providers.rejectCredential(other.id);
    expect(await modelListResponse(key, 'openai', f.deps).json()).toEqual({ object: 'list', data: [] });
  } finally {
    f.db.close();
  }
});

/** Store what one provider discovered for a model, as a refresh would. */
function discover(
  f: Fixture, providerId: string, upstreamId: string,
  protocols: Protocol[] | null, maxOutputTokens: number | null = null,
): void {
  f.providers.replaceModels(providerId, [{
    upstreamId, contextLength: 4096, maxOutputTokens, price: priced, protocols,
  }], start);
}

test('supported_protocols is the union over usable routes, and disagreeing limits are null', async () => {
  const f = fixture();
  try {
    const model = f.models.create({ name: 'model', price: priced }, start);
    f.models.addRoute(model.id, { providerId: f.provider.id, upstreamModel: 'up' });
    discover(f, f.provider.id, 'up', ['chat'], 4096);
    const other = f.providers.create({
      name: 'other', connector: 'fake', baseUrl: null, credential: null, autoPublish: false,
    }, start);
    f.models.addRoute(model.id, { providerId: other.id, upstreamModel: 'up' });
    discover(f, other.id, 'up', ['responses'], 8192);
    const key = f.keys.create({ name: 'key' }, start);
    expect(await modelListResponse(key, 'openai', f.deps).json()).toEqual({
      object: 'list',
      data: [{
        ...openaiShape('model', 1767225600, 'gateway', priced, null),
        top_provider: { context_length: null, max_completion_tokens: null },
        supported_protocols: ['chat', 'responses'],
      }],
    });
  } finally {
    f.db.close();
  }
});

test('one discovered provider model names max_completion_tokens and what it speaks', async () => {
  const f = fixture();
  try {
    readyModel(f, 'model');
    discover(f, f.provider.id, 'up', ['chat', 'responses'], 8192);
    const key = f.keys.create({ name: 'key' }, start);
    expect(await modelResponse(key, 'model', 'openai', f.deps).json()).toEqual({
      ...openaiShape('model', 1767225600, 'provider'),
      top_provider: { context_length: 100, max_completion_tokens: 8192 },
      supported_protocols: ['chat', 'responses'],
    });
  } finally {
    f.db.close();
  }
});

test('pricing is a decimal USD-per-token string without an exponent, and zero stays zero', async () => {
  const f = fixture();
  try {
    const price = { input: 0.5, output: 0, cacheRead: 2.5 };
    f.models.create({ name: 'model', price, contextLength: 100 }, start);
    f.models.addRoute(f.models.byName('model')!.id, { providerId: f.provider.id, upstreamModel: 'up' });
    const key = f.keys.create({ name: 'key' }, start);
    expect(await modelResponse(key, 'model', 'openai', f.deps).json()).toMatchObject({
      pricing: {
        prompt: '0.0000005',
        completion: '0',
        input_cache_read: '0.0000025',
      },
    });
  } finally {
    f.db.close();
  }
});

test('an unknown model price is null in every pricing field', async () => {
  const f = fixture();
  try {
    readyModel(f, 'model', 0, unpriced);
    const key = f.keys.create({ name: 'key' }, start);
    expect(await modelResponse(key, 'model', 'openai', f.deps).json()).toMatchObject({
      pricing: { prompt: null, completion: null, input_cache_read: null },
      top_provider: { context_length: 100, max_completion_tokens: null },
    });
  } finally {
    f.db.close();
  }
});
