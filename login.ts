// The device-code logins this gateway runs: at most one per provider, each polled in the
// background until the administrator confirms it, refuses it or the code expires. One
// instance belongs to the app; the management routes start, report and cancel it, and
// `close` stops every timer the gateway holds.
import type { LoginStatus } from './shared/api';
import type { Connector, DeviceCode, DeviceLoginPoll, LoginConnector } from './connectors/connector';
import type { ProviderStore } from './providerStore';

/** RFC 8628: a server that asks to slow down adds 5 s to every later interval. */
const SLOW_DOWN_MS = 5_000;

/** The reason a login whose last poll got no answer ends with when its code runs out. */
const POLL_FAILED_REASON = '授权服务器无响应';

/** The reason a login ends with when a wait failed for a reason other than an abort. */
const INTERRUPTED_REASON = '登录会话中断';

/** A login that could not be started, in words fit to show. */
export class LoginFailure extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
    this.name = 'LoginFailure';
  }
}

/** A status that is still being polled; the only fields a client ever sees. */
type PendingLogin = Extract<LoginStatus, { state: 'pending' }>;

interface Running {
  /** Aborted when the session is replaced, cancelled, or the gateway closes. */
  controller: AbortController;
  status: PendingLogin;
}

/** How the login sessions reach the world; the tests give them a clock and a wait of their own. */
export interface LoginDeps {
  providers: ProviderStore;
  /** The connector with this id, or null. */
  connector(id: string): Connector | null;
  /** Outgoing HTTP to the authorization servers. */
  fetch: typeof fetch;
  now(): Date;
  /** Resolves after `ms`, or rejects when `signal` aborts. Defaults to a timer. */
  wait?: LoginWait;
  /**
   * Called after a login stored its credential, before the session reports `done`: the
   * gateway's model sync starts from here so a signed-in provider's models appear by themselves.
   */
  onGranted?(providerId: string): void;
}

/** Tells a session to wait `ms`, and rejects when `signal` aborts. */
export type LoginWait = (ms: number, signal: AbortSignal) => Promise<void>;

/** Resolve after `ms`, or reject as soon as `signal` aborts. */
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
    function abort(): void {
      clearTimeout(timer);
      reject(new Error('aborted'));
    }
    signal.addEventListener('abort', abort, { once: true });
  });
}

function pendingOf(code: DeviceCode): PendingLogin {
  return {
    state: 'pending',
    userCode: code.userCode,
    verificationUri: code.verificationUri,
    verificationUriComplete: code.verificationUriComplete,
    expiresAt: code.expiresAt.toISOString(),
    interval: code.interval,
  };
}

/** The failure's own words when it has them, else what a login that could not start says. */
function reasonOf(error: unknown): string {
  return error instanceof Error && error.message !== ''
    ? error.message : 'Authorization server unreachable';
}

/** The device-code logins of this gateway, one per provider. */
export class LoginSessions {
  private readonly running = new Map<string, Running>();
  /** Sessions that ended, kept until the next `start` or `cancel` so the console can show them. */
  private readonly finished = new Map<string, LoginStatus>();
  /** Supersedes a `start` whose device-code request is still out. */
  private readonly stamps = new Map<string, object>();
  private readonly wait: (ms: number, signal: AbortSignal) => Promise<void>;

  constructor(private readonly deps: LoginDeps) {
    this.wait = deps.wait ?? delay;
  }

  /**
   * Start a login for this provider, replacing any earlier session of it. Returns the new
   * session's status once the authorization server has issued the code.
   */
  public async start(providerId: string): Promise<LoginStatus> {
    const stamp = {};
    this.stamps.set(providerId, stamp);
    this.stop(providerId);
    this.finished.delete(providerId);
    const provider = this.deps.providers.get(providerId);
    if (!provider) throw new LoginFailure('未找到提供商', 404);
    const connector = this.deps.connector(provider.connector);
    if (!connector) throw new LoginFailure('connector 无效', 400);
    if (connector.credential !== 'login') throw new LoginFailure('该提供商不使用登录', 400);
    let code: DeviceCode;
    try {
      code = await connector.login.start(this.deps.fetch);
    } catch (error) {
      // The authorization server could not be asked, or refused to issue a code.
      throw new LoginFailure(reasonOf(error), 502);
    }
    // A newer start or a cancel arrived while the code was being asked for: this one is dropped.
    if (this.stamps.get(providerId) !== stamp) return this.status(providerId);
    const running: Running = { controller: new AbortController(), status: pendingOf(code) };
    this.running.set(providerId, running);
    void this.run(providerId, connector, code, running);
    return running.status;
  }

  /** Where the provider's login stands; never the device code and never a token. */
  public status(providerId: string): LoginStatus {
    return this.running.get(providerId)?.status
      ?? this.finished.get(providerId)
      ?? { state: 'none' };
  }

  /** Stop a pending session: the provider's login is no longer running or remembered. */
  public cancel(providerId: string): void {
    this.stamps.delete(providerId);
    this.stop(providerId);
    this.finished.delete(providerId);
  }

  /** Stop every session; the app calls this on close so no timer outlives the gateway. */
  public close(): void {
    for (const running of this.running.values()) running.controller.abort();
    this.running.clear();
    this.finished.clear();
    this.stamps.clear();
  }

  /** Poll one session until it is granted, refused, superseded or expired. */
  private async run(
    providerId: string, connector: LoginConnector, code: DeviceCode, running: Running,
  ): Promise<void> {
    const signal = running.controller.signal;
    let intervalMs = Math.max(0, code.interval) * 1_000;
    let lastPollFailed = false;
    try {
      while (true) {
        // The provider was deleted: its login stops here and stores nothing.
        if (this.deps.providers.get(providerId) === null) {
          this.forget(providerId, running);
          return;
        }
        if (this.expired(code)) return this.expire(providerId, running, lastPollFailed);
        try {
          await this.wait(intervalMs, signal);
        } catch (error) {
          // The wait rejects on an abort, which ends the session quietly; any other failure is
          // this session's end and must not reject the promise `start` did not await.
          if (signal.aborted) return;
          this.settle(providerId, running, { state: 'failed', reason: INTERRUPTED_REASON });
          return;
        }
        if (signal.aborted) return;
        if (this.expired(code)) return this.expire(providerId, running, lastPollFailed);
        let polled: DeviceLoginPoll;
        try {
          polled = await connector.login.poll(code, this.deps.fetch);
        } catch (error) {
          // A network failure or a 5xx: the code may still be confirmed, so ask again at the
          // next interval. If the code then runs out, the session says the server never answered.
          if (signal.aborted) return;
          lastPollFailed = true;
          continue;
        }
        lastPollFailed = false;
        // The session was cancelled, replaced or closed while this request was in flight: the
        // credential it carries belongs to a login that is no longer wanted.
        if (signal.aborted) return;
        if (polled.status === 'pending') continue;
        if (polled.status === 'slow-down') {
          intervalMs += SLOW_DOWN_MS;
          running.status = { ...running.status, interval: intervalMs / 1_000 };
          continue;
        }
        if (polled.status === 'refused') {
          this.settle(providerId, running, { state: 'failed', reason: polled.reason });
          return;
        }
        // The provider was deleted while its code was being confirmed: nothing is stored.
        if (this.deps.providers.get(providerId) === null) {
          this.forget(providerId, running);
          return;
        }
        this.deps.providers.setCredential(providerId, polled.credential);
        this.deps.onGranted?.(providerId);
        this.settle(providerId, running, { state: 'done' });
        return;
      }
    } catch (error) {
      // A store failure or anything else unexpected would reject a promise nobody awaits; the
      // session ends as interrupted and the error is reported instead of swallowed.
      this.settle(providerId, running, { state: 'failed', reason: INTERRUPTED_REASON });
      console.error(`Login session for provider ${providerId} failed`, error);
    } finally {
      this.forget(providerId, running);
    }
  }

  /** End a session whose code ran out: expired, or failed when the last poll got no answer. */
  private expire(providerId: string, running: Running, lastPollFailed: boolean): void {
    this.settle(providerId, running, lastPollFailed
      ? { state: 'failed', reason: POLL_FAILED_REASON }
      : { state: 'expired' });
  }

  private expired(code: DeviceCode): boolean {
    return this.deps.now().getTime() >= code.expiresAt.getTime();
  }

  /** Record a session's outcome, unless it was replaced: a replaced session decides nothing. */
  private settle(providerId: string, running: Running, status: LoginStatus): void {
    if (!this.forget(providerId, running)) return;
    this.finished.set(providerId, status);
  }

  /** Drop this session's slot; false when a later session already holds it. */
  private forget(providerId: string, running: Running): boolean {
    if (this.running.get(providerId) !== running) return false;
    this.running.delete(providerId);
    return true;
  }

  private stop(providerId: string): void {
    const running = this.running.get(providerId);
    if (!running) return;
    this.running.delete(providerId);
    running.controller.abort();
  }
}
