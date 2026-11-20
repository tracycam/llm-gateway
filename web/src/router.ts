// The console's pages live in the URL fragment, so a reload or a shared link opens the same
// page whatever path the gateway serves the console from.
import { useEffect, useState } from 'react';

export type Route =
  | { page: 'usage' }
  | { page: 'providers' }
  /** `refresh` asks the page to query the upstream once on arrival, as after adding it. */
  | { page: 'provider'; id: string; refresh?: boolean }
  | { page: 'models' }
  | { page: 'model'; id: string }
  | { page: 'keys' };

export type Section = 'usage' | 'providers' | 'models' | 'keys';

export function sectionOf(route: Route): Section {
  if (route.page === 'provider') return 'providers';
  if (route.page === 'model') return 'models';
  return route.page;
}

export function href(route: Route): string {
  switch (route.page) {
    case 'provider':
      return `#/providers/${encodeURIComponent(route.id)}${route.refresh ? '?refresh' : ''}`;
    case 'model':
      return `#/models/${encodeURIComponent(route.id)}`;
    default:
      return `#/${route.page}`;
  }
}

export function parseRoute(hash: string): Route {
  const [path, query = ''] = hash.replace(/^#\/?/, '').split('?');
  const [head, rawId] = path.split('/');
  let id: string | undefined;
  try {
    id = rawId ? decodeURIComponent(rawId) : undefined;
  } catch (failure) {
    // A fragment that is not valid percent-encoding names no record; fall back to the list.
    if (!(failure instanceof URIError)) throw failure;
  }
  if (head === 'providers') return id ? { page: 'provider', id, refresh: query === 'refresh' } : { page: 'providers' };
  if (head === 'models') return id ? { page: 'model', id } : { page: 'models' };
  if (head === 'keys') return { page: 'keys' };
  return { page: 'usage' };
}

export function navigate(route: Route, options: { replace?: boolean } = {}): void {
  if (options.replace) {
    window.history.replaceState(null, '', href(route));
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = href(route);
  }
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
