const DISPATCH_FAILURE_PREFIX = "Backend dispatch failed: ";

export function persistedDispatchFailure(detail: string) {
  return `${DISPATCH_FAILURE_PREFIX}${detail}`;
}

export function dispatchWarningFromLastError(lastError: string | null) {
  if (!lastError?.startsWith(DISPATCH_FAILURE_PREFIX)) {
    return null;
  }
  return `Upload stored, but backend dispatch failed: ${lastError.slice(DISPATCH_FAILURE_PREFIX.length)}`;
}
