export type ErrorCode =
  | "VALIDATION"
  | "NOT_FOUND"
  | "CONFLICT"
  | "UNPROCESSABLE"
  | "INTERNAL";

export class AppError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export function assert(condition: unknown, message: string, details?: unknown): asserts condition {
  if (!condition) throw new AppError("VALIDATION", message, details);
}

export function requireId(value: unknown, label: string): number {
  const id = typeof value === "string" ? Number(value) : value;
  assert(Number.isInteger(id) && (id as number) > 0, `${label} must be a positive integer`);
  return id as number;
}
