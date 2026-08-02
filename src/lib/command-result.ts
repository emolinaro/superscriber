import { type CasefileConflictSnapshot, CasefileCommandError, type ErrorCode as CasefileErrorCode } from "@/server/casefile/errors";

export type ErrorCode = CasefileErrorCode | "AUTH_EXPIRED" | "INTERNAL_ERROR";

export type CommandResult<T> =
  | {
      ok: true;
      data: T;
      notice?: string;
    }
  | {
      ok: false;
      code: ErrorCode;
      message: string;
      fieldErrors?: Record<string, string>;
      latest?: CasefileConflictSnapshot;
      correlationId?: string;
    };

export type FocusTarget = "retain" | "case-state";

export function authExpiredResult<T>(): CommandResult<T> {
  return {
    ok: false,
    code: "AUTH_EXPIRED",
    message: "Session expired. Sign in again to continue.",
  };
}

export function toCommandResultError<T>(error: unknown): CommandResult<T> {
  if (error instanceof CasefileCommandError) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
      ...(error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
      ...(error.latest ? { latest: error.latest } : {}),
    };
  }

  return {
    ok: false,
    code: "INTERNAL_ERROR",
    message: "Something went wrong. Try again.",
    correlationId: crypto.randomUUID(),
  };
}
