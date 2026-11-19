// One provider's model list, kept current without the console: fetched at start, every six
// hours, and right after the administrator changes how the provider is reached or signs it in.
// A sync stores what the provider answered and publishes what its auto-publish switch asks for;
// a failure is recorded on the provider and leaves the stored list as it was.
import { providerAccess } from './connectors/access';
import type { Connector } from './connectors/connector';
import { UpstreamFailure } from './connectors/connector';
import type { CredentialRenewals } from './connectors/tokens';
import { credentialUsable } from './inference/routes';
import type { ModelStore } from './modelStore';
import type { ProviderModelInput, ProviderRecord, ProviderStore } from './providerStore';

/**
 * How often the gateway refreshes every provider's model list. A policy value, not a measured
 * one: six hours.
 */
export const MODEL_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1_000;

/** What a failed sync records when the connector did not name the failure itself. */
const MODEL_LIST_FAILED = 'Model list refresh failed';

/** Tells a sync loop to wait `ms`, and rejects when `signal` aborts. */
export type SyncWait = (ms: number, signal: AbortSignal) => Promise<void>;

/** One sync's end: the provider answered, or it failed for the reason carried. */
export type SyncOutcome = { ok: true } | { ok: false; error: unknown };

/** What a model sync reaches; the tests give it a clock and a wait of their own. */
export interface ModelSyncDeps {
  providers: ProviderStore;
  models: ModelStore;
  /** The connector with this id, or null. */
  connector(id: string): Connector | null;
  /** The gateway's one renewal registry, shared with inference. */
  renewals: CredentialRenewals;
  now(): Date;
  /** Resolves after `ms`, or rejects when `signal` aborts. Defaults to a timer. */
  wait?: SyncWait;
}

/** Resolve after `ms`, or reject as soon as `signal` aborts; the timer never holds the process. */
function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, ms);
    timer.unref();
    function abort(): void {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** The model lists of every provider, fetched in the background. */
export class ModelSync {
  private readonly inFlight = new Map<string, Promise<SyncOutcome>>();
  private readonly controller = new AbortController();
  private readonly wait: SyncWait;
  private started = false;
  private closed = false;

  constructor(private readonly deps: ModelSyncDeps) {
    this.wait = deps.wait ?? delay;
  }

  /**
   * Sync every provider that can be asked, then again every `MODEL_SYNC_INTERVAL_MS` until
   * `close`. Callers do not wait for the first pass.
   */
  start(): void {
    if (this.started || this.closed) return;
    this.started = true;
    void this.run().catch((error: unknown) => {
      // Only the wait can end the loop this way; its timer is expected to work.
      console.error('Model sync stopped unexpectedly', error);
    });
  }

  /**
   * Sync one provider now. A sync requested while one is running for that provider joins it:
   * the provider is fetched once and every caller gets that one's end.
   */
  async refresh(providerId: string): Promise<SyncOutcome> {
    const running = this.inFlight.get(providerId);
    if (running) return running;
    const run = this.runSync(providerId).then(
      (): SyncOutcome => ({ ok: true }),
      (error: unknown): SyncOutcome => ({ ok: false, error }),
    );
    this.inFlight.set(providerId, run);
    try {
      return await run;
    } finally {
      if (this.inFlight.get(providerId) === run) this.inFlight.delete(providerId);
    }
  }

  /**
   * Ask for a background sync: no caller waits, and the provider records how it went. A
   * provider that cannot be asked (disabled, unknown connector, missing or refused credential)
   * is not asked. Does nothing once the gateway has closed.
   */
  trigger(providerId: string): void {
    if (this.closed) return;
    const provider = this.deps.providers.get(providerId);
    if (!provider || !this.askable(provider)) return;
    void this.refresh(providerId);
  }

  /** Sync every provider that can be asked; resolves when each has answered or failed. */
  async syncAll(): Promise<void> {
    await Promise.allSettled(this.askableProviders().map(({ id }) => this.refresh(id)));
  }

  /** Stop the timer; a fetch still in flight stores nothing when it answers. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.controller.abort();
  }

  /** Whether the gateway can ask this provider for its model list now. */
  private askable(provider: ProviderRecord): boolean {
    if (!provider.enabled) return false;
    const connector = this.deps.connector(provider.connector);
    return connector !== null && credentialUsable(provider, connector);
  }

  /** The providers the gateway can ask now: enabled, with a known connector and a usable credential. */
  private askableProviders(): ProviderRecord[] {
    return this.deps.providers.list().filter((provider) => this.askable(provider));
  }

  private async run(): Promise<void> {
    await this.syncAll();
    while (!this.controller.signal.aborted) {
      try {
        await this.wait(MODEL_SYNC_INTERVAL_MS, this.controller.signal);
      } catch (error) {
        // An aborted wait is `close`; anything else would leave the timer unable to run.
        if (this.controller.signal.aborted) return;
        throw error;
      }
      if (this.controller.signal.aborted) return;
      await this.syncAll();
    }
  }

  /** Fetch one provider's models and store them, unless it left, was disabled, or the app closed. */
  private async runSync(providerId: string): Promise<void> {
    const provider = this.deps.providers.get(providerId);
    if (!provider) return;
    const connector = this.deps.connector(provider.connector);
    if (!connector) return;
    const access = providerAccess(this.deps.providers, provider, this.deps.renewals);
    let models: ProviderModelInput[];
    try {
      models = await connector.models(access);
    } catch (error) {
      if (!this.closed) this.recordFailure(providerId, error);
      throw error;
    }
    // The provider left, was disabled, or the gateway closed while the list was being fetched:
    // that answer is stored nowhere.
    const current = this.deps.providers.get(providerId);
    if (this.closed || !current || !current.enabled) return;
    this.deps.providers.replaceModels(providerId, models, this.deps.now());
    this.deps.providers.recordModelsSynced(providerId, this.deps.now());
    if (current.autoPublish) this.publishDiscovered(providerId);
  }

  /**
   * Publish every discovered model of this provider that has no route here yet and speaks at
   * least one of the gateway's interfaces. A provider that said nothing about protocols is
   * published; one that says it speaks none is not.
   */
  private publishDiscovered(providerId: string): void {
    const published = new Set<string>();
    for (const model of this.deps.models.list()) {
      for (const route of model.routes) {
        if (route.providerId === providerId) published.add(route.upstreamModel);
      }
    }
    for (const model of this.deps.providers.models(providerId)) {
      if (model.protocols !== null && model.protocols.length === 0) continue;
      if (published.has(model.upstreamId)) continue;
      this.deps.models.publish(providerId, model.upstreamId, this.deps.now());
    }
  }

  /** Record why this provider could not answer; an unexpected error is logged without secrets. */
  private recordFailure(providerId: string, error: unknown): void {
    if (error instanceof UpstreamFailure) {
      this.deps.providers.recordModelsError(providerId, error.message);
      return;
    }
    this.deps.providers.recordModelsError(providerId, MODEL_LIST_FAILED);
    console.error(`Model list refresh failed for provider ${providerId}`);
  }
}
