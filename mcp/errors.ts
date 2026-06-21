// ─────────────────────────────────────────────────────────────────────────────
// Hub MCP — typed errors. Plain erasable classes (no enums / parameter properties,
// which crash `node --experimental-strip-types`).
// ─────────────────────────────────────────────────────────────────────────────

/** Caller identity absent or malformed → fail closed. The MCP refuses rather than guessing. */
export class IdentityError extends Error {
  readonly code = 'identity';
  constructor(message: string) {
    super(message);
    this.name = 'IdentityError';
  }
}

/** Bad tool input: unknown metric/dimension, illegal run_select, out-of-range arg. */
export class ValidationError extends Error {
  readonly code = 'validation';
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/** A deferred surface (sales/settlement, write/action tools) that is intentionally not built. */
export class UnavailableError extends Error {
  readonly code = 'unavailable';
  constructor(message: string) {
    super(message);
    this.name = 'UnavailableError';
  }
}

export function errorCode(e: unknown): string {
  if (e instanceof IdentityError || e instanceof ValidationError || e instanceof UnavailableError) {
    return e.code;
  }
  return 'error';
}
