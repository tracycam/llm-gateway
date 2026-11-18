// Per-key admission and notifications. Pure state: no I/O, timers or clock.

/** A client left while waiting. */
export class Abandoned extends Error {}

interface Waiter {
  limit: number | null;
  signal: AbortSignal;
  abort: () => void;
  resolve: (release: () => void) => void;
}

interface State {
  running: number;
  waiters: Waiter[];
}

export class Admission {
  private readonly states = new Map<string, State>();

  /**
   * Take a place or wait in arrival order. On release, each head waiter's own limit
   * decides whether it fits. An unlimited request never waits, even behind a queue.
   */
  public enter(id: string, limit: number | null, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(new Abandoned());
    let state = this.states.get(id);
    if (!state) {
      state = { running: 0, waiters: [] };
      this.states.set(id, state);
    }
    if (limit === null || (state.waiters.length === 0 && state.running < limit)) {
      return Promise.resolve(this.grant(id, state));
    }
    const current = state;
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        limit, signal, resolve,
        abort: () => {
          signal.removeEventListener('abort', waiter.abort);
          current.waiters.splice(current.waiters.indexOf(waiter), 1);
          reject(new Abandoned());
          this.drain(id, current);
        },
      };
      current.waiters.push(waiter);
      signal.addEventListener('abort', waiter.abort);
    });
  }

  public running(id: string): number {
    return this.states.get(id)?.running ?? 0;
  }

  public waiting(id: string): number {
    return this.states.get(id)?.waiters.length ?? 0;
  }

  /** Number of ids with running or waiting requests. */
  public size(): number {
    return this.states.size;
  }

  private grant(id: string, state: State): () => void {
    state.running += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      state.running -= 1;
      this.drain(id, state);
    };
  }

  private drain(id: string, state: State): void {
    while (state.waiters.length > 0) {
      const waiter = state.waiters[0];
      if (waiter.limit !== null && state.running >= waiter.limit) break;
      state.waiters.shift();
      waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.resolve(this.grant(id, state));
    }
    if (state.running === 0 && state.waiters.length === 0) this.states.delete(id);
  }
}

interface NotificationWaiter {
  signal: AbortSignal;
  abort: () => void;
  resolve: () => void;
}

/** Lets tasks sleep until a change is announced. */
export class Notifier {
  private readonly waiters = new Set<NotificationWaiter>();

  public wait(signal: AbortSignal): Promise<void> {
    if (signal.aborted) return Promise.reject(new Abandoned());
    return new Promise((resolve, reject) => {
      const waiter: NotificationWaiter = {
        signal, resolve,
        abort: () => {
          signal.removeEventListener('abort', waiter.abort);
          this.waiters.delete(waiter);
          reject(new Abandoned());
        },
      };
      this.waiters.add(waiter);
      signal.addEventListener('abort', waiter.abort);
    });
  }

  /** Wake only the tasks already waiting. */
  public notify(): void {
    for (const waiter of this.waiters) {
      this.waiters.delete(waiter);
      waiter.signal.removeEventListener('abort', waiter.abort);
      waiter.resolve();
    }
  }

  public waiting(): number {
    return this.waiters.size;
  }
}
