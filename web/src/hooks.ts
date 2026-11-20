import { useCallback, useEffect, useRef, useState, type DependencyList } from 'react';
import { ApiRequestError } from './api';

/** The reason to show for a failed request: the server's own text when it gave one. */
export function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  if (error instanceof TypeError) return '无法连接服务';
  return error instanceof Error ? error.message : String(error);
}

export interface Loaded<T> {
  /** The last answer; kept while a reload is in flight and when a reload fails. */
  data: T | null;
  /** Why the last load failed; null after one that worked. */
  error: string | null;
  /** True while a request is in flight. */
  loading: boolean;
  reload: () => Promise<void>;
}

/** Load on mount and whenever `deps` change; a slower, older answer never replaces a newer one. */
export function useLoad<T>(load: () => Promise<T>, deps: DependencyList): Loaded<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const latest = useRef(0);
  const loader = useRef(load);
  loader.current = load;

  const reload = useCallback(async () => {
    const ticket = ++latest.current;
    setLoading(true);
    try {
      const next = await loader.current();
      if (ticket !== latest.current) return;
      setData(next);
      setError(null);
    } catch (failure) {
      if (ticket !== latest.current) return;
      setError(errorText(failure));
    } finally {
      if (ticket === latest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    return () => {
      latest.current += 1;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, error, loading, reload };
}

export interface Action {
  pending: boolean;
  /** The reason the last run failed; cleared when the next run starts. */
  error: string | null;
  /** Run a mutation; a second call while one is in flight does nothing. True when it worked. */
  run: (task: () => Promise<void>) => Promise<boolean>;
  clearError: () => void;
}

/** One mutation at a time, with its pending state and the reason it failed. */
export function useAction(): Action {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  const run = useCallback(async (task: () => Promise<void>) => {
    if (busy.current) return false;
    busy.current = true;
    setPending(true);
    setError(null);
    try {
      await task();
      return true;
    } catch (failure) {
      setError(errorText(failure));
      return false;
    } finally {
      busy.current = false;
      setPending(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return { pending, error, run, clearError };
}

export interface RowActions {
  /** True while a mutation of that row is in flight. */
  isPending: (id: string) => boolean;
  /** Run a mutation of one row; a second call for the same row while pending does nothing. */
  run: (id: string, task: () => Promise<void>, onError: (reason: string) => void) => Promise<void>;
}

/** Mutations made from a table's rows (a switch, a publish button): one at a time per row. */
export function useRowActions(): RowActions {
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set());
  const busy = useRef(new Set<string>());

  const run = useCallback(async (
    id: string, task: () => Promise<void>, onError: (reason: string) => void,
  ) => {
    if (busy.current.has(id)) return;
    busy.current.add(id);
    setPending(new Set(busy.current));
    try {
      await task();
    } catch (failure) {
      onError(errorText(failure));
    } finally {
      busy.current.delete(id);
      setPending(new Set(busy.current));
    }
  }, []);

  const isPending = useCallback((id: string) => pending.has(id), [pending]);
  return { isPending, run };
}

/** Call `tick` every `ms` while the page is visible, and once when it becomes visible again. */
export function useVisibleInterval(tick: () => void, ms: number): void {
  const current = useRef(tick);
  current.current = tick;
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') current.current();
    }, ms);
    const onVisible = () => {
      if (document.visibilityState === 'visible') current.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ms]);
}
