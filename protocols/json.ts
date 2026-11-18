// Reading JSON that came from outside: a client's request body, an upstream's answer.

export type JsonObject = Record<string, unknown>;

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The parsed value, or undefined when the text is not JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (err) {
    if (err instanceof SyntaxError) return undefined;
    throw err;
  }
}

/** The value when it is a finite number, else null. */
export function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
