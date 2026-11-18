// A request that cannot be expressed in the upstream's protocol. The client gets a 400 that
// names the field: a translation never drops or bends something that changes what the
// answer means.

export interface Refused {
  refused: {
    /** Why, in words fit to show the client. */
    message: string;
    /** The field at fault, as a dotted path into the request body. */
    param: string;
  };
}

export function refuse(param: string, reason: string): Refused {
  return { refused: { message: reason, param } };
}

export function isRefused(value: unknown): value is Refused {
  return value !== null && typeof value === 'object' && 'refused' in value;
}
