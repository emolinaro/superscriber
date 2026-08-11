#!/usr/bin/env tsx
/**
 * demo-bulk-ingest: watched-volume auto-ingest sidecar.
 *
 * SUPERSCRIBER_INGEST_WATCH_DIR=<mounted folder> -> every stable file added
 * (paste, rsync, render) enters the SAME governed path as a manual upload:
 * session -> chunks -> finalize, attributed to a dedicated demo identity
 * (SUPERSCRIBER_INGEST_WATCH_EMAIL; provisioned as an uploader account).
 *
 * Contract: the watcher NEVER dies on a bad file - per-file failures are
 * logged and isolated, duplicates (same content bytes) are logged once and
 * skipped, unsupported formats are refused up-front. Partially-written files
 * are retried every poll until their size settles.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync, watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const WATCH_DIR = process.env.SUPERSCRIBER_INGEST_WATCH_DIR?.trim() || "";
const BASE_URL = (process.env.SUPERSCRIBER_APP_BASE_URL ?? "http://localhost:3145").replace(/\/$/, "");
const EMAIL = process.env.SUPERSCRIBER_INGEST_WATCH_EMAIL?.trim() || "ingest-service@demo.local";
const PASSWORD = process.env.SUPERSCRIBER_INGEST_WATCH_PASSWORD?.trim() || "";

const SUPPORTED = new Set([
  ".wav", ".mp3", ".m4a", ".aac", ".ogg", ".oga", ".flac", ".opus", ".webm",
  ".mp4", ".mov", ".mkv", ".mpg", ".mpeg",
]);
const CHUNK_BYTES = 1 * 1024 * 1024;
const STABLE_MS = 1_200;
const POLL_MS = 750;

type InFlight = { size: number; changedAt: number };
const candidates = new Map<string, InFlight>();
const done = new Map<string, number>(); // sha256 -> timestamp
const refused = new Set<string>(); // refuse loudly once per file name
let cookie = "";

function log(line: string, ...rest: unknown[]) {
  console.log(`[ingest-watch] ${line}`, ...rest);
}

function isSupported(name: string) {
  const dot = name.lastIndexOf(".");
  return dot >= 0 && SUPPORTED.has(name.slice(dot).toLowerCase());
}

async function signIn() {
  for (;;) {
    try {
      const csrfResponse = await fetch(`${BASE_URL}/api/auth/csrf`);
      const csrfCookie = (csrfResponse.headers.get("set-cookie") ?? "").split(";")[0];
      const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };
      const signed = await fetch(`${BASE_URL}/api/auth/callback/credentials`, {
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
      await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
    } catch (error) {
      log("app not reachable yet; retrying in 5s", (error as Error).message);
      await new Promise((resolveWait) => setTimeout(resolveWait, 5_000));
    }
  }
}

async function request(path: string, init: RequestInit) {
  return fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      cookie,
      ...(init.headers ?? {}),
    },
  });
}

async function ingestFile(path: string) {
  const name = basename(path);
  const bytes = await readFile(path);

  if (bytes.length === 0) {
    log(`skip ${name}: zero bytes (partial write?)`);
    return;
  }

  const digest = createHash("sha256").update(bytes).digest("hex");
  if (done.has(digest)) {
    log(`skip ${name}: duplicate content already ingested this run`);
    return;
  }

  const title = name.replace(/\.[^.]*$/, "") || name;
  log(`ingesting ${name} (${bytes.length} bytes, sha256 ${digest.slice(0, 12)})`);

  try {
    if (!cookie) {
      cookie = "";
      await signIn();
    }

    const sessionResponse = await request("/api/ingest/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title,
        languageHint: process.env.SUPERSCRIBER_INGEST_WATCH_LANGUAGE?.trim() || "english",
        source: "upload",
        fileName: name,
        mimeType: null,
        fileSize: bytes.length,
        transcriptModel: process.env.SUPERSCRIBER_TRANSCRIBE_MODEL?.trim() || null,
      }),
    });
    const sessionPayload = await sessionResponse.json();
    if (!sessionResponse.ok) {
      throw new Error(sessionPayload.error ?? sessionPayload.message ?? `session HTTP ${sessionResponse.status}`);
    }
    const sessionId = sessionPayload.status.sessionId as string;

    for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
      const chunk = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.length));
      const chunkResponse = await request(`/api/ingest/sessions/${sessionId}/chunk`, {
        method: "PUT",
        headers: {
          "content-type": "application/octet-stream",
          "x-superscriber-byte-start": String(offset),
        },
        body: new Uint8Array(chunk) as unknown as BodyInit,
      });
      if (!chunkResponse.ok) {
        throw new Error(`chunk HTTP ${chunkResponse.status}`);
      }
    }

    const finalizeResponse = await request(`/api/ingest/sessions/${sessionId}/finalize`, {
      method: "POST",
    });
    if (!finalizeResponse.ok) {
      throw new Error(`finalize HTTP ${finalizeResponse.status}`);
    }

    done.set(digest, Date.now());
    log(`queued ${name} for governed transcription`);
  } catch (error) {
    log(`FAILED ${name}: ${(error as Error).message} (batch continues)`);
  }
}

async function sweep() {
  for (const name of readdirSync(WATCH_DIR)) {
    const full = join(WATCH_DIR, name);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (!stats.isFile()) {
      continue;
    }
    if (!isSupported(name)) {
      if (!refused.has(name)) {
        refused.add(name);
        log(`refuse ${name}: unsupported format for the governed engine`);
      }
      continue;
    }
    const previous = candidates.get(name);
    if (!previous || previous.size !== stats.size) {
      candidates.set(name, { size: stats.size, changedAt: Date.now() });
      continue;
    }
    if (Date.now() - previous.changedAt < STABLE_MS) {
      continue;
    }
    candidates.delete(name);
    await ingestFile(full);
  }
}

async function main() {
  if (!WATCH_DIR) {
    log("SUPERSCRIBER_INGEST_WATCH_DIR is not set; exiting.");
    process.exit(0);
  }
  mkdirSync(WATCH_DIR, { recursive: true });
  await signIn();

  const sweepLoop = () => {
    void sweep().then(() => setTimeout(sweepLoop, POLL_MS));
  };
  const watcher: FSWatcher = watch(WATCH_DIR, { persistent: true }, () => {
    // Event edges just refresh candidates; the poll loop owns state.
    void sweep().catch((error) => log("sweep error", (error as Error).message));
  });

  log(`watching ${resolve(WATCH_DIR)} as ${EMAIL} via ${BASE_URL}`);
  sweepLoop();
  process.on("SIGINT", () => watcher.close());
  process.on("SIGTERM", () => watcher.close());
}

void main();
