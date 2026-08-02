const BASE_URL = new URL("https://superscriber.local");
const WORKSPACE_FALLBACK = "/workspace";
const ADMIN_SECTIONS = new Set(["accounts", "assignments", "policy"]);
const ALLOWED_QUERY_KEYS: Record<string, Set<string>> = {
  "/workspace": new Set([
    "tab",
    "query",
    "stage",
    "source",
    "assignmentUserId",
    "sort",
  ]),
  "/ingest": new Set(),
  "/administration": new Set([
    "section",
    "query",
    "assignmentStatus",
    "assignmentRole",
    "recordingId",
    "userId",
    "fromUtc",
    "toUtc",
  ]),
};

export function sanitizeReturnTo(value?: string | null) {
  const candidate = new URL(value ?? WORKSPACE_FALLBACK, BASE_URL);

  if (
    candidate.origin !== BASE_URL.origin ||
    candidate.username ||
    candidate.password ||
    !candidate.pathname.startsWith("/")
  ) {
    return WORKSPACE_FALLBACK;
  }

  const isRecordingPath = /^\/recordings\/[^/]+$/.test(candidate.pathname);
  const allowedKeys = isRecordingPath
    ? new Set(["revision", "actionMode"])
    : ALLOWED_QUERY_KEYS[candidate.pathname];

  if (!allowedKeys) {
    return WORKSPACE_FALLBACK;
  }

  if ([...candidate.searchParams.keys()].some((key) => !allowedKeys.has(key))) {
    return WORKSPACE_FALLBACK;
  }

  if (
    candidate.pathname === "/administration" &&
    candidate.searchParams.has("section") &&
    !ADMIN_SECTIONS.has(candidate.searchParams.get("section") ?? "")
  ) {
    return WORKSPACE_FALLBACK;
  }

  return `${candidate.pathname}${candidate.search}`;
}
