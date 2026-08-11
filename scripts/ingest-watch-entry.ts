#!/usr/bin/env tsx
/**
 * demo-bulk-ingest: watched-volume auto-ingest sidecar.
 *
 * SUPERSCRIBER_INGEST_WATCH_DIR=<mounted folder> -> every stable file added
 * (paste, rsync, render) enters the SAME governed path as a manual upload:
 * session -> chunks -> finalize, attributed to a dedicated identity
 * (SUPERSCRIBER_INGEST_WATCH_EMAIL; provisioned as an uploader account).
 *
 * Contract: the watcher NEVER dies on a bad file - per-file failures are
 * logged and isolated, duplicates (same content bytes) are logged once and
 * skipped, unsupported formats are refused up-front. Partially-written files
 * are retried every poll until their filesystem fingerprint settles.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, statSync, watch, type FSWatcher, type Stats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { BoundedFetch, resolveIngestWatchBaseUrl } from "./ingest-watch-http";

const WATCH_DIR = process.env.SUPERSCRIBER_INGEST_WATCH_DIR?.trim() || "";
const BASE_URL = resolveIngestWatchBaseUrl(process.env.SUPERSCRIBER_APP_BASE_URL);
const EMAIL = process.env.SUPERSCRIBER_INGEST_WATCH_EMAIL?.trim() || "ingest-service@demo.local";
const PASSWORD = process.env.SUPERSCRIBER_INGEST_WATCH_PASSWORD ?? "";

const MIME_TYPES = new Map([
  [".wav", "audio/wav"],
  [".mp3", "audio/mpeg"],
  [".m4a", "audio/mp4"],
  [".aac", "audio/aac"],
  [".ogg", "audio/ogg"],
  [".oga", "audio/ogg"],
  [".flac", "audio/flac"],
  [".opus", "audio/opus"],
  [".webm", "audio/webm"],
  [".mp4", "video/mp4"],
  [".mov", "video/quicktime"],
  [".mkv", "video/x-matroska"],
  [".mpg", "video/mpeg"],
  [".mpeg", "video/mpeg"],
]);
const CHUNK_BYTES = 1 * 1024 * 1024;
const STABLE_MS = 1_200;
const POLL_MS = 750;
const AUTH_RETRY_MS = 5_000;

type Candidate = { changedAt: number; fingerprint: string };
type UploadSessionStatus = {
  bytesExpected: number;
  bytesReceived: number;
  integrityState: string;
  nextAction: "resume" | "restart" | "finalize" | "none";
  sessionId: string;
  state: string;
  warning?: string | null;
};
const candidates = new Map<string, Candidate>();
const blockedPaths = new Map<string, string>();
const completedPaths = new Map<string, string>();
const done = new Set<string>();
const sessionsByDigest = new Map<string, string>();
const unresumableDigests = new Set<string>();
const refused = new Set<string>();
const retryWakeups = new Set<() => void>();
const http = new BoundedFetch();
const runId = randomUUID();
let cookie = "";
let stopping = false;
let watcher: FSWatcher | null = null;
let pollTimer: NodeJS.Timeout | null = null;
let sweepRequested = false;
let activeSweep: Promise<void> | null = null;
let shutdownPromise: Promise<void> | null = null;

function log(line: string, ...rest: unknown[]) {
  console.log(`[ingest-watch] ${line}`, ...rest);
}

function fileFingerprint(stats: Stats) {
  return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(":");
}

function mimeTypeFor(name: string) {
  return MIME_TYPES.get(extname(name).toLowerCase()) ?? null;
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

async function waitForAuthRetry() {
  if (stopping) {
    return false;
  }
  return new Promise<boolean>((resolveWait) => {
    let timer: NodeJS.Timeout;
    let settled = false;
    const finish = (retry: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      retryWakeups.delete(cancel);
      resolveWait(retry);
    };
    const cancel = () => finish(false);
    timer = setTimeout(() => finish(!stopping), AUTH_RETRY_MS);
    retryWakeups.add(cancel);
  });
}

async function signIn() {
  while (!stopping) {
    try {
      const csrfResponse = await http.request(`${BASE_URL}/api/auth/csrf`);
      if (!csrfResponse.ok) {
        throw new Error(`csrf HTTP ${csrfResponse.status}`);
      }
      const csrfCookie = (csrfResponse.headers.get("set-cookie") ?? "").split(";")[0];
      const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };
      const signed = await http.request(`${BASE_URL}/api/auth/callback/credentials`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: csrfCookie,
        },
        body: new URLSearchParams({
          csrfToken,
          email: EMAIL,
          password: PASSWORD,
          json: "true",
        }),
      });
      const setCookie = signed.headers.get("set-cookie") ?? "";
      const sessionCookie = setCookie
        .split(/,(?=[^;]*?=)/)
        .map((piece) => piece.split(";")[0])
        .filter((piece) => /session-token=.+/.test(piece));
      if (sessionCookie.length > 0) {
        cookie = sessionCookie.join("; ");
        log(`signed in as ${EMAIL}`);
        return;
      }
      log("sign-in refused; retrying in 5s (check the watch identity account)");
    } catch (error) {
      if (stopping) {
        break;
      }
      log("app not reachable yet; retrying in 5s", errorMessage(error));
    }
    if (!(await waitForAuthRetry())) {
      break;
    }
  }
  throw new Error("sign-in interrupted by shutdown");
}

function fetchWithCookie(path: string, init: RequestInit) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  return http.request(`${BASE_URL}${path}`, {
    ...init,
    headers,
  });
}

async function request(path: string, init: RequestInit) {
  if (stopping) {
    throw new Error("watcher shutting down");
  }
  if (!cookie) {
    await signIn();
  }
  const response = await fetchWithCookie(path, init);
  if (response.status !== 401) {
    return response;
  }
  cookie = "";
  log("session expired; renewing watch identity credentials");
  await signIn();
  return fetchWithCookie(path, init);
}

async function readChunk(handle: FileHandle, buffer: Buffer, position: number, totalSize: number) {
  const length = Math.min(buffer.length, totalSize - position);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  if (bytesRead === 0) {
    throw new Error("file changed while it was being read");
  }
  return buffer.subarray(0, bytesRead);
}

async function hashFile(handle: FileHandle, buffer: Buffer, size: number) {
  const hash = createHash("sha256");
  for (let offset = 0; offset < size;) {
    const chunk = await readChunk(handle, buffer, offset, size);
    hash.update(chunk);
    offset += chunk.length;
  }
  return hash.digest("hex");
}

async function livePathMatches(path: string, expectedFingerprint: string) {
  try {
    return fileFingerprint(await stat(path)) === expectedFingerprint;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function withLiveFile<T>(
  path: string,
  expectedFingerprint: string,
  operation: (handle: FileHandle, stats: Stats) => Promise<T>,
) {
  const handle = await open(path, "r");
  try {
    const stats = await handle.stat();
    if (fileFingerprint(stats) !== expectedFingerprint) {
      return null;
    }
    const result = await operation(handle, stats);
    if (
      fileFingerprint(await handle.stat()) !== expectedFingerprint ||
      !(await livePathMatches(path, expectedFingerprint))
    ) {
      return null;
    }
    return result;
  } finally {
    await handle.close();
  }
}

function isDurablyFinalized(status: UploadSessionStatus) {
  return (
    status.nextAction === "none" &&
    (status.integrityState === "verified" || status.integrityState === "verifying" || status.state === "verified")
  );
}

async function readSessionStatus(response: Response, operation: string) {
  const payload = (await response.json().catch(() => ({}))) as {
    error?: string;
    message?: string;
    status?: UploadSessionStatus;
  };
  if (!response.ok) {
    throw new Error(payload.error ?? payload.message ?? `${operation} HTTP ${response.status}`);
  }
  const status = payload.status;
  if (
    !status?.sessionId ||
    !Number.isInteger(status.bytesReceived) ||
    !Number.isInteger(status.bytesExpected) ||
    status.bytesReceived < 0 ||
    status.bytesExpected < 0
  ) {
    throw new Error(`${operation} response did not include a valid session status`);
  }
  return status;
}

async function loadSessionStatus(sessionId: string) {
  const response = await request(`/api/ingest/sessions/${sessionId}`, {
    method: "GET",
    cache: "no-store",
  });
  if (response.status === 404) {
    return null;
  }
  return readSessionStatus(response, "session status");
}

function noteFinalized(digest: string, name: string, warning?: string | null) {
  done.add(digest);
  if (warning) {
    log(`WARNING ${name}: ${warning}`);
  }
  log(`queued ${name} for governed transcription`);
  return true;
}

async function reconcileFinalizeFailure(sessionId: string, digest: string, name: string, failure: unknown) {
  try {
    const status = await loadSessionStatus(sessionId);
    if (status && isDurablyFinalized(status)) {
      return noteFinalized(digest, name, status.warning);
    }
  } catch (reconciliationError) {
    throw new Error(
      `${errorMessage(failure)}; finalize reconciliation failed: ${errorMessage(reconciliationError)}`,
    );
  }
  throw failure;
}

async function finalizeSession(sessionId: string, digest: string, name: string) {
  sessionsByDigest.set(digest, sessionId);
  try {
    const response = await request(`/api/ingest/sessions/${sessionId}/finalize`, {
      method: "POST",
    });
    const status = await readSessionStatus(response, "finalize");
    return noteFinalized(digest, name, status.warning);
  } catch (error) {
    return reconcileFinalizeFailure(sessionId, digest, name, error);
  }
}

async function getOrCreateSession(digest: string, body: Record<string, unknown>) {
  const knownSessionId = sessionsByDigest.get(digest);
  if (knownSessionId) {
    const status = await loadSessionStatus(knownSessionId);
    if (status) {
      return { resumed: true, status };
    }
    sessionsByDigest.delete(digest);
  }

  const response = await request("/api/ingest/sessions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-superscriber-idempotency-key": `${runId}:${digest}`,
    },
    body: JSON.stringify(body),
  });
  const status = await readSessionStatus(response, "session");
  sessionsByDigest.set(digest, status.sessionId);
  return {
    resumed: status.bytesReceived > 0 || status.nextAction === "finalize",
    status,
  };
}

async function ingestFile(path: string, expectedFingerprint: string) {
  const name = basename(path);
  const initial = await withLiveFile(path, expectedFingerprint, async (handle, stats) => {
    const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, stats.size));
    const digest = stats.size > 0 ? await hashFile(handle, buffer, stats.size) : "";
    return { buffer, digest, size: stats.size };
  });
  if (!initial) {
    log(`defer ${name}: live file changed before ingest started`);
    return false;
  }
  if (initial.size === 0) {
    log(`skip ${name}: zero bytes (partial write?)`);
    return true;
  }

  const { buffer, digest, size } = initial;
  if (done.has(digest)) {
    log(`skip ${name}: duplicate content already ingested this run`);
    return true;
  }
  if (unresumableDigests.has(digest)) {
    blockedPaths.set(name, expectedFingerprint);
    throw new Error("a prior upload of these bytes changed in flight; restart the watcher before retrying");
  }

  const title = name.replace(/\.[^.]*$/, "") || name;
  log(`ingesting ${name} (${size} bytes, sha256 ${digest.slice(0, 12)})`);
  const session = await getOrCreateSession(digest, {
    title,
    languageHint: process.env.SUPERSCRIBER_INGEST_WATCH_LANGUAGE?.trim() || "english",
    source: "upload",
    fileName: name,
    mimeType: mimeTypeFor(name),
    fileSize: size,
    transcriptModel: process.env.SUPERSCRIBER_TRANSCRIBE_MODEL?.trim() || null,
  });
  const { status } = session;
  if (session.resumed) {
    const resumedDigest = await withLiveFile(
      path,
      expectedFingerprint,
      (handle) => hashFile(handle, buffer, size),
    );
    if (resumedDigest !== digest) {
      unresumableDigests.add(digest);
      blockedPaths.set(name, expectedFingerprint);
      throw new Error("file changed before upload resume; restart the watcher before retrying");
    }
  }
  if (isDurablyFinalized(status)) {
    return noteFinalized(digest, name, status.warning);
  }
  if (status.nextAction === "restart") {
    unresumableDigests.add(digest);
    blockedPaths.set(name, expectedFingerprint);
    throw new Error(`session ${status.sessionId} requires a restart`);
  }
  if (status.nextAction === "none") {
    throw new Error(`session ${status.sessionId} is not resumable or durably finalized`);
  }
  if (status.bytesExpected !== size || status.bytesReceived > size) {
    throw new Error(`session ${status.sessionId} does not match the watched file size`);
  }

  let offset = status.bytesReceived;
  while (offset < size) {
    const chunk = await withLiveFile(
      path,
      expectedFingerprint,
      (handle) => readChunk(handle, buffer, offset, size),
    );
    if (!chunk) {
      unresumableDigests.add(digest);
      blockedPaths.set(name, expectedFingerprint);
      throw new Error("file changed during upload; restart the watcher before retrying");
    }
    const chunkResponse = await request(`/api/ingest/sessions/${status.sessionId}/chunk`, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "x-superscriber-byte-start": String(offset),
      },
      body: chunk as unknown as BodyInit,
    });
    const chunkStatus = await readSessionStatus(chunkResponse, "chunk");
    if (
      chunkStatus.sessionId !== status.sessionId ||
      chunkStatus.bytesReceived <= offset ||
      chunkStatus.bytesReceived > size
    ) {
      throw new Error(`session ${status.sessionId} returned an invalid committed byte offset`);
    }
    offset = chunkStatus.bytesReceived;
  }

  const uploadedDigest = await withLiveFile(
    path,
    expectedFingerprint,
    (handle) => hashFile(handle, buffer, size),
  );
  if (uploadedDigest !== digest) {
    unresumableDigests.add(digest);
    blockedPaths.set(name, expectedFingerprint);
    throw new Error("file changed during upload; restart the watcher before retrying");
  }
  return finalizeSession(status.sessionId, digest, name);
}

async function processCandidate(name: string) {
  const full = join(WATCH_DIR, name);
  try {
    const stats = statSync(full);
    if (!stats.isFile()) {
      candidates.delete(name);
      blockedPaths.delete(name);
      return;
    }
    if (!mimeTypeFor(name)) {
      candidates.delete(name);
      if (!refused.has(name)) {
        refused.add(name);
        log(`refuse ${name}: unsupported format for the governed engine`);
      }
      return;
    }

    const fingerprint = fileFingerprint(stats);
    if (blockedPaths.get(name) === fingerprint) {
      candidates.delete(name);
      return;
    }
    blockedPaths.delete(name);
    if (completedPaths.get(name) === fingerprint) {
      candidates.delete(name);
      return;
    }
    const previous = candidates.get(name);
    if (!previous || previous.fingerprint !== fingerprint) {
      candidates.set(name, { fingerprint, changedAt: Date.now() });
      return;
    }
    if (Date.now() - previous.changedAt < STABLE_MS) {
      return;
    }

    candidates.delete(name);
    if (await ingestFile(full, fingerprint)) {
      completedPaths.set(name, fingerprint);
    }
  } catch (error) {
    candidates.delete(name);
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    log(`FAILED ${name}: ${errorMessage(error)} (batch continues)`);
  }
}

async function sweep() {
  const names = readdirSync(WATCH_DIR);
  const residentNames = new Set(names);
  for (const name of names) {
    if (stopping) {
      break;
    }
    await processCandidate(name);
  }
  for (const name of candidates.keys()) {
    if (!residentNames.has(name)) {
      candidates.delete(name);
    }
  }
  for (const name of completedPaths.keys()) {
    if (!residentNames.has(name)) {
      completedPaths.delete(name);
    }
  }
  for (const name of blockedPaths.keys()) {
    if (!residentNames.has(name)) {
      blockedPaths.delete(name);
    }
  }
  for (const name of refused) {
    if (!residentNames.has(name)) {
      refused.delete(name);
    }
  }
}

function scheduleSweep() {
  if (stopping) {
    return;
  }
  sweepRequested = true;
  if (activeSweep) {
    return;
  }
  activeSweep = (async () => {
    while (sweepRequested && !stopping) {
      sweepRequested = false;
      try {
        await sweep();
      } catch (error) {
        log("sweep error", errorMessage(error));
      }
    }
  })().finally(() => {
    activeSweep = null;
    if (sweepRequested && !stopping) {
      scheduleSweep();
    }
  });
}

function schedulePoll() {
  if (stopping) {
    return;
  }
  pollTimer = setTimeout(() => {
    pollTimer = null;
    scheduleSweep();
    schedulePoll();
  }, POLL_MS);
}

function shutdown() {
  if (shutdownPromise) {
    return shutdownPromise;
  }
  shutdownPromise = (async () => {
    stopping = true;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
    watcher?.close();
    watcher = null;
    http.abortAll();
    for (const wake of retryWakeups) {
      wake();
    }
    retryWakeups.clear();
    await activeSweep;
  })();
  return shutdownPromise;
}

async function main() {
  if (!WATCH_DIR) {
    log("SUPERSCRIBER_INGEST_WATCH_DIR is not set; exiting.");
    return;
  }
  if (!PASSWORD) {
    log("SUPERSCRIBER_INGEST_WATCH_PASSWORD is not set; exiting.");
    process.exitCode = 1;
    return;
  }
  mkdirSync(WATCH_DIR, { recursive: true });
  process.once("SIGINT", () => {
    void shutdown();
  });
  process.once("SIGTERM", () => {
    void shutdown();
  });
  try {
    await signIn();
  } catch (error) {
    if (stopping) {
      return;
    }
    throw error;
  }
  if (stopping) {
    return;
  }

  try {
    const fileWatcher = watch(WATCH_DIR, { persistent: true }, scheduleSweep);
    fileWatcher.on("error", (error) => {
      log("watch error; continuing with polling", errorMessage(error));
      fileWatcher.close();
      if (watcher === fileWatcher) {
        watcher = null;
      }
    });
    watcher = fileWatcher;
  } catch (error) {
    log("watch setup failed; continuing with polling", errorMessage(error));
  }
  log(`watching ${resolve(WATCH_DIR)} as ${EMAIL} via ${BASE_URL}`);
  scheduleSweep();
  schedulePoll();
}

void main().catch((error) => {
  log("fatal watcher error", errorMessage(error));
  process.exitCode = 1;
});
