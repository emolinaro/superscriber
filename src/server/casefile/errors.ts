export const CASEFILE_COMMAND_ERROR_CODES = [
  "VALIDATION_ERROR",
  "ACTION_MODE_REQUIRED",
  "ACTION_MODE_EXPIRED",
  "ACTION_MODE_FORBIDDEN",
  "ACTION_MODE_ENDED",
] as const;

export type ErrorCode = (typeof CASEFILE_COMMAND_ERROR_CODES)[number];

export type CasefileConflictSnapshot = {
  recordingId: string;
  currentRevisionId: string | null;
  pendingRevisionId: string | null;
  approvedRevisionId: string | null;
};

export class CasefileCommandError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly fieldErrors?: Record<string, string>,
    readonly latest?: CasefileConflictSnapshot,
  ) {
    super(message);
    this.name = "CasefileCommandError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
