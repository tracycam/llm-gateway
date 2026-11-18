// Who a request is: the API key it presents, checked by the store. A browser cookie is never one.

import type { KeyRecord, KeyStore } from '../keyStore';

/**
 * The API key a request presents: `Authorization: Bearer <key>`, else `x-api-key`.
 * A cookie is never one.
 */
export function presentedKey(req: Request): string | null {
  const authorization = req.headers.get('authorization');
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i);
  const token = bearer?.[1] ?? req.headers.get('x-api-key');
  if (!token) return null;
  return token;
}

/** The key record of a request, or null when it presents none or the store refuses it. */
export function authenticate(req: Request, keys: KeyStore, now: Date): KeyRecord | null {
  const token = presentedKey(req);
  if (token === null) return null;
  const result = keys.verify(token, now);
  return 'key' in result ? result.key : null;
}
