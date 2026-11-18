import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { Connector } from '../connectors/connector';
import { ModelStore } from '../modelStore';
import { ProviderStore } from '../providerStore';
import { migrate } from '../schema';
import { usableRoutes } from './routes';

const now = new Date('2026-01-01T00:00:00Z');

function fakeConnector(id: string): Connector {
  return {
    id,
    name: id,
    defaultBaseUrl: null,
    credential: 'api-key',
    async target() { throw new Error('unused'); },
    async models() { return []; },
  };
}

function setup() {
  const db = new Database(':memory:');
  migrate(db);
  const providers = new ProviderStore(db);
  const models = new ModelStore(db);
  const known = fakeConnector('fake');
  const connector = (id: string) => id === known.id ? known : null;
  return { db, providers, models, known, connector };
}

function addProvider(providers: ProviderStore, name: string, connector = 'fake') {
  return providers.create({
    name,
    connector,
    baseUrl: null,
    credential: null,
    autoPublish: false,
  }, now);
}

test('a disabled route is left out', () => {
  const { db, providers, models, connector } = setup();
  try {
    const provider = addProvider(providers, 'provider');
    const model = models.create({ name: 'model' }, now);
    const route = models.addRoute(model.id, { providerId: provider.id, upstreamModel: 'up' });
    models.updateRoute(route.id, { enabled: false });
    expect(usableRoutes(models.get(model.id)!, providers, connector)).toEqual([]);
  } finally {
    db.close();
  }
});

test('a route whose provider is disabled is left out', () => {
  const { db, providers, models, connector } = setup();
  try {
    const provider = addProvider(providers, 'provider');
    const model = models.create({ name: 'model' }, now);
    models.addRoute(model.id, { providerId: provider.id, upstreamModel: 'up' });
    providers.update(provider.id, { enabled: false });
    expect(usableRoutes(models.get(model.id)!, providers, connector)).toEqual([]);
  } finally {
    db.close();
  }
});

test('a route whose provider no longer exists is left out', () => {
  const { db, providers, models, connector } = setup();
  try {
    const provider = addProvider(providers, 'provider');
    const model = models.create({ name: 'model' }, now);
    models.addRoute(model.id, { providerId: provider.id, upstreamModel: 'up' });
    const stored = models.get(model.id)!;
    const orphaned = {
      ...stored,
      routes: stored.routes.map((route) => ({ ...route, providerId: 'prv-gone' })),
    };
    expect(usableRoutes(orphaned, providers, connector)).toEqual([]);
  } finally {
    db.close();
  }
});

test('a route whose provider names an unknown connector is left out', () => {
  const { db, providers, models, connector } = setup();
  try {
    const provider = addProvider(providers, 'provider', 'unknown');
    const model = models.create({ name: 'model' }, now);
    models.addRoute(model.id, { providerId: provider.id, upstreamModel: 'up' });
    expect(usableRoutes(models.get(model.id)!, providers, connector)).toEqual([]);
  } finally {
    db.close();
  }
});

test('the remaining routes keep the store order', () => {
  const { db, providers, models, known, connector } = setup();
  try {
    const first = addProvider(providers, 'first');
    const second = addProvider(providers, 'second');
    const third = addProvider(providers, 'third');
    const model = models.create({ name: 'model' }, now);
    for (const provider of [first, second, third]) {
      models.addRoute(model.id, { providerId: provider.id, upstreamModel: provider.name });
    }
    const stored = models.get(model.id)!;
    const usable = usableRoutes(stored, providers, connector);
    expect(usable.map(({ route }) => route.id)).toEqual(stored.routes.map((route) => route.id));
    expect(usable.map(({ provider }) => provider.id)).toEqual(stored.routes.map((route) => route.providerId));
    expect(usable.map(({ connector: used }) => used)).toEqual(stored.routes.map(() => known));
  } finally {
    db.close();
  }
});

test('a usable route after a disabled route is still returned', () => {
  const { db, providers, models, connector } = setup();
  try {
    const provider = addProvider(providers, 'provider');
    const model = models.create({ name: 'model' }, now);
    const first = models.addRoute(model.id, { providerId: provider.id, upstreamModel: 'first' });
    models.addRoute(model.id, { providerId: provider.id, upstreamModel: 'second' });
    models.updateRoute(first.id, { enabled: false });
    const usable = usableRoutes(models.get(model.id)!, providers, connector);
    expect(usable.map(({ route }) => route.upstreamModel)).toEqual(['second']);
  } finally {
    db.close();
  }
});

test("a usable route after a disabled provider's route is still returned", () => {
  const { db, providers, models, connector } = setup();
  try {
    const disabled = addProvider(providers, 'disabled');
    const enabled = addProvider(providers, 'enabled');
    const model = models.create({ name: 'model' }, now);
    models.addRoute(model.id, { providerId: disabled.id, upstreamModel: 'first' });
    models.addRoute(model.id, { providerId: enabled.id, upstreamModel: 'second' });
    providers.update(disabled.id, { enabled: false });
    const usable = usableRoutes(models.get(model.id)!, providers, connector);
    expect(usable.map(({ route }) => route.upstreamModel)).toEqual(['second']);
  } finally {
    db.close();
  }
});

test('a usable route after an unknown connector route is still returned', () => {
  const { db, providers, models, connector } = setup();
  try {
    const unknown = addProvider(providers, 'unknown', 'unknown');
    const known = addProvider(providers, 'known');
    const model = models.create({ name: 'model' }, now);
    models.addRoute(model.id, { providerId: unknown.id, upstreamModel: 'first' });
    models.addRoute(model.id, { providerId: known.id, upstreamModel: 'second' });
    const usable = usableRoutes(models.get(model.id)!, providers, connector);
    expect(usable.map(({ route }) => route.upstreamModel)).toEqual(['second']);
  } finally {
    db.close();
  }
});

test('a model without routes gives an empty list', () => {
  const { db, providers, models, connector } = setup();
  try {
    const model = models.create({ name: 'model' }, now);
    expect(usableRoutes(model, providers, connector)).toEqual([]);
  } finally {
    db.close();
  }
});

/** A connector the gateway signs a provider in with; its login is never used here. */
function loginConnector(id: string): Connector {
  return {
    id,
    name: id,
    defaultBaseUrl: null,
    credential: 'login',
    login: {
      async start() { throw new Error('unused'); },
      async poll() { throw new Error('unused'); },
    },
    async target() { throw new Error('unused'); },
    async models() { return []; },
  };
}

test('rule B2: a rejected provider is left out and the second route serves the model', () => {
  const { db, providers, models } = setup();
  try {
    const rejected = addProvider(providers, 'rejected');
    const healthy = addProvider(providers, 'healthy');
    const model = models.create({ name: 'model' }, now);
    models.addRoute(model.id, { providerId: rejected.id, upstreamModel: 'first' });
    models.addRoute(model.id, { providerId: healthy.id, upstreamModel: 'second' });
    providers.rejectCredential(rejected.id);
    const usable = usableRoutes(models.get(model.id)!, providers, (id) => id === 'fake'
      ? fakeConnector('fake') : null);
    expect(usable.map(({ route }) => route.upstreamModel)).toEqual(['second']);
  } finally {
    db.close();
  }
});

test('rule B2: a login provider without a credential is left out until it has one', () => {
  const db = new Database(':memory:');
  try {
    migrate(db);
    const providers = new ProviderStore(db);
    const models = new ModelStore(db);
    const login = loginConnector('login');
    const provider = providers.create({
      name: 'login', connector: login.id, baseUrl: null, credential: null, autoPublish: false,
    }, now);
    const model = models.create({ name: 'model' }, now);
    models.addRoute(model.id, { providerId: provider.id, upstreamModel: 'up' });
    const found = (id: string) => id === login.id ? login : null;
    expect(usableRoutes(models.get(model.id)!, providers, found)).toEqual([]);
    providers.setCredential(provider.id, '{"accessToken":"a"}');
    expect(usableRoutes(models.get(model.id)!, providers, found).map(({ provider }) => provider.id))
      .toEqual([provider.id]);
  } finally {
    db.close();
  }
});
