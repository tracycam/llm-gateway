// Validation at the management API boundary.
import type { Price } from '../pricing';
import { isObject, type JsonObject } from '../protocols/json';

/** A rejected management request. */
export class InputError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
  }
}

/** Parse a JSON object, rejecting arrays and other JSON values. */
export async function readBody(req: Request): Promise<JsonObject> {
  let value: unknown;
  try {
    value = await req.json();
  } catch (error) {
    if (error instanceof SyntaxError) throw new InputError('请求体无效');
    throw error;
  }
  if (!isObject(value)) throw new InputError('请求体无效');
  return value;
}

/** Read a nonempty string. */
export function string(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new InputError(`${field} 无效`);
  return value;
}

/** Read an optional nonempty string. */
export function optionalString(value: unknown, field: string): string | undefined {
  return value === undefined ? undefined : string(value, field);
}

/** Read an optional boolean without coercion. */
export function boolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new InputError(`${field} 无效`);
  return value;
}

/** Read an optional integer at or above the minimum. */
export function integerAtLeast(value: unknown, field: string, minimum: number): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new InputError(`${field} 无效`);
  }
  return value;
}

/** Read a finite nonnegative number or null. */
export function nonNegativeNumberOrNull(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new InputError(`${field} 无效`);
  return value;
}

/** Read a complete price object. An unknown key is ignored, as everywhere in a body. */
export function price(value: unknown, field = 'price'): Price {
  if (!isObject(value)) throw new InputError(`${field} 无效`);
  return {
    input: nonNegativeNumberOrNull(value.input, `${field}.input`),
    output: nonNegativeNumberOrNull(value.output, `${field}.output`),
    cacheRead: nonNegativeNumberOrNull(value.cacheRead, `${field}.cacheRead`),
  };
}

/** Decode one path segment, rejecting encoded slashes and invalid escapes. */
export function pathId(segment: string): string | null {
  try {
    const id = decodeURIComponent(segment);
    return id.includes('/') ? null : id;
  } catch (error) {
    if (error instanceof URIError) return null;
    throw error;
  }
}
