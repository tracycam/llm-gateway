// Shared management route dispatch and refusal handling.
import { errorResponse } from '../http';
import { StoreRefusal } from '../schema';
import type { AdminDeps } from './deps';
import { InputError, pathId } from './input';

/** A method, anchored pathname pattern and handler; captures are decoded path segments. */
export type AdminRoute = readonly [
  string,
  RegExp,
  (req: Request, deps: AdminDeps, params: string[]) => Promise<Response> | Response,
];

/** Match paths before methods and translate expected refusals. */
export async function dispatch(
  req: Request, deps: AdminDeps, routes: readonly AdminRoute[]
): Promise<Response | null> {
  try {
    const path = new URL(req.url).pathname;
    let matched = false;
    for (const [method, pattern, handler] of routes) {
      const match = path.match(pattern);
      if (!match) continue;
      const decoded = match.slice(1).map(pathId);
      if (decoded.some((id) => id === null)) continue;
      matched = true;
      if (method === req.method) {
        return await handler(req, deps, decoded.filter((id): id is string => id !== null));
      }
    }
    return matched ? errorResponse('方法不允许', 405) : null;
  } catch (error) {
    if (error instanceof InputError || error instanceof StoreRefusal) {
      return errorResponse(error.message, error.status);
    }
    throw error;
  }
}
