import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { BoundedFetch, resolveIngestWatchBaseUrl } from "./ingest-watch-http";

const CHUNK_BYTES = 1024 * 1024;
const children = new Set<ChildProcessWithoutNullStreams>();
const servers = new Set<Server>();
const temporaryDirectories = new Set<string>();

type Gate = ReturnType<typeof createGate>;

type FakeAppOptions = {
  expireFirstCookieOnChunks?: boolean;
  finalizeWarning?: string;
  firstChunkGate?: Gate;
  firstSessionGate?: Gate;
  forceSessionRestart?: boolean;
  loseFirstChunkResponse?: boolean;
  loseFirstFinalizeResponse?: boolean;
  loseFirstSessionResponse?: boolean;
  signInGate?: Gate;
};

type FakeSession = {
  body: Record<string, unknown>;
  bytesReceived: number;
  finalized: boolean;
  id: string;
  idempotencyKey: string;
  warning: string | null;
};

type FakeApp = {
  baseUrl: string;
  chunks: Array<{ bytes: Buffer; cookie: string; sessionId: string; start: number }>;
  finalized: string[];
  inspectedSessions: string[];
  passwords: string[];
  sessionRequestKeys: string[];
  sessions: FakeSession[];
  signIns: number;
};

function createGate() {
  let announceArrival = () => {};
  let releaseWaiter = () => {};
  const entered = new Promise<void>((resolve) => {
    announceArrival = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseWaiter = resolve;
  });
  return {
    entered,
    arrive: async () => {
      announceArrival();
      await released;
    },
    release: releaseWaiter,
  };
}

async function readBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function sendJson(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  response.writeHead(status, {
    "content-type": "application/json",
    ...headers,
  });
  response.end(JSON.stringify(body));
}

async function startFakeApp(options: FakeAppOptions = {}) {
  const state: FakeApp = {
    baseUrl: "",
    chunks: [],
    finalized: [],
    inspectedSessions: [],
    passwords: [],
    sessionRequestKeys: [],
    sessions: [],
    signIns: 0,
  };
  let firstChunkGated = false;
  let chunkResponseLost = false;
  let finalizeResponseLost = false;
  let sessionResponseLost = false;
  let signInGated = false;

  function sessionStatus(session: FakeSession) {
    const bytesExpected = Number(session.body.fileSize);
    return {
      sessionId: session.id,
      state: session.finalized ? "verified" : "receiving",
      integrityState: session.finalized ? "verifying" : "pending",
      bytesReceived: session.bytesReceived,
      bytesExpected,
      warning: session.warning,
      nextAction: session.finalized
        ? "none"
        : options.forceSessionRestart
          ? "restart"
          : session.bytesReceived === bytesExpected
            ? "finalize"
            : "resume",
    };
  }

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "GET" && url.pathname === "/api/auth/csrf") {
        sendJson(response, 200, { csrfToken: "watch-test-csrf" }, {
          "set-cookie": "authjs.csrf-token=watch-test-csrf; Path=/; HttpOnly",
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/auth/callback/credentials") {
        const credentials = new URLSearchParams((await readBody(request)).toString("utf8"));
        state.signIns += 1;
        state.passwords.push(credentials.get("password") ?? "");
        if (!signInGated && options.signInGate) {
          signInGated = true;
          await options.signInGate.arrive();
        }
        sendJson(response, 200, { url: "/workspace" }, {
          "set-cookie": `authjs.session-token=token-${state.signIns}; Path=/; HttpOnly`,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/ingest/sessions") {
        const body = JSON.parse((await readBody(request)).toString("utf8")) as Record<string, unknown>;
        const header = request.headers["x-superscriber-idempotency-key"];
        const idempotencyKey = Array.isArray(header) ? header[0] : (header ?? "");
        state.sessionRequestKeys.push(idempotencyKey);
        let session = idempotencyKey
          ? state.sessions.find((candidate) => candidate.idempotencyKey === idempotencyKey)
          : undefined;
        if (!session) {
          session = {
            body,
            bytesReceived: 0,
            finalized: false,
            id: `session-${state.sessions.length + 1}`,
            idempotencyKey,
            warning: null,
          };
          state.sessions.push(session);
        }
        if (state.sessions.length === 1 && options.firstSessionGate) {
          await options.firstSessionGate.arrive();
        }
        if (options.loseFirstSessionResponse && !sessionResponseLost) {
          sessionResponseLost = true;
          response.destroy();
          return;
        }
        sendJson(response, 200, { ok: true, status: sessionStatus(session) });
        return;
      }

      const chunkMatch = url.pathname.match(/^\/api\/ingest\/sessions\/([^/]+)\/chunk$/);
      if (request.method === "PUT" && chunkMatch) {
        const bytes = await readBody(request);
        const cookie = request.headers.cookie ?? "";
        if (options.expireFirstCookieOnChunks && cookie.includes("token-1")) {
          sendJson(response, 401, { error: "Authentication expired." });
          return;
        }
        const session = state.sessions.find((candidate) => candidate.id === chunkMatch[1]);
        if (!session) {
          sendJson(response, 404, { error: "Upload session not found." });
          return;
        }
        const start = Number(request.headers["x-superscriber-byte-start"]);
        if (start !== session.bytesReceived) {
          sendJson(response, 409, { error: `Expected byte offset ${session.bytesReceived}.` });
          return;
        }
        state.chunks.push({
          bytes,
          cookie,
          sessionId: chunkMatch[1],
          start,
        });
        session.bytesReceived += bytes.length;
        if (!firstChunkGated && chunkMatch[1] === "session-1" && options.firstChunkGate) {
          firstChunkGated = true;
          await options.firstChunkGate.arrive();
        }
        if (options.loseFirstChunkResponse && !chunkResponseLost) {
          chunkResponseLost = true;
          response.destroy();
          return;
        }
        sendJson(response, 200, { ok: true, status: sessionStatus(session) });
        return;
      }

      const finalizeMatch = url.pathname.match(/^\/api\/ingest\/sessions\/([^/]+)\/finalize$/);
      if (request.method === "POST" && finalizeMatch) {
        await readBody(request);
        const session = state.sessions.find((candidate) => candidate.id === finalizeMatch[1]);
        if (!session) {
          sendJson(response, 404, { error: "Upload session not found." });
          return;
        }
        session.finalized = true;
        session.warning = options.finalizeWarning ?? null;
        if (!state.finalized.includes(finalizeMatch[1])) {
          state.finalized.push(finalizeMatch[1]);
        }
        if (options.loseFirstFinalizeResponse && !finalizeResponseLost) {
          finalizeResponseLost = true;
          response.destroy();
          return;
        }
        sendJson(response, 200, {
          ok: true,
          status: {
            ...sessionStatus(session),
            warning: options.finalizeWarning,
          },
        });
        return;
      }

      const statusMatch = url.pathname.match(/^\/api\/ingest\/sessions\/([^/]+)$/);
      if (request.method === "GET" && statusMatch) {
        const sessionId = statusMatch[1];
        const session = state.sessions.find((candidate) => candidate.id === sessionId);
        state.inspectedSessions.push(sessionId);
        if (!session) {
          sendJson(response, 404, { error: "Upload session not found." });
          return;
        }
        sendJson(response, 200, {
          ok: true,
          status: sessionStatus(session),
        });
        return;
      }

      sendJson(response, 404, { error: `Unexpected ${request.method} ${url.pathname}` });
    })().catch((error) => {
      sendJson(response, 500, { error: (error as Error).message });
    });
  });
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake app did not bind a TCP port.");
  }
  state.baseUrl = `http://localhost:${address.port}`;
  return state;
}

async function makeWatchDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "superscriber-ingest-watch-test-"));
  temporaryDirectories.add(directory);
  return directory;
}

function startWatcher(directory: string, baseUrl?: string, password = "long-enough-test-password") {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    SUPERSCRIBER_INGEST_WATCH_DIR: directory,
    SUPERSCRIBER_INGEST_WATCH_EMAIL: "watcher@example.test",
    SUPERSCRIBER_INGEST_WATCH_PASSWORD: password,
  };
  if (baseUrl) {
    env.SUPERSCRIBER_APP_BASE_URL = baseUrl;
  } else {
    delete env.SUPERSCRIBER_APP_BASE_URL;
  }
  const child = spawn(process.execPath, ["--import", "tsx", "scripts/ingest-watch-entry.ts"], {
    cwd: process.cwd(),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  return {
    child,
    output: () => output,
  };
}

async function waitFor(predicate: () => boolean, description: string, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function waitForExit(child: ChildProcessWithoutNullStreams, timeoutMs = 3_000) {
  await waitFor(
    () => child.exitCode !== null || child.signalCode !== null,
    "watcher process to exit",
    timeoutMs,
  );
  children.delete(child);
}

async function waitUntilWatching(watcher: ReturnType<typeof startWatcher>) {
  await waitFor(
    () => watcher.output().includes("[ingest-watch] watching"),
    `watcher startup\n${watcher.output()}`,
    3_000,
  );
}

afterEach(async () => {
  for (const child of children) {
    child.kill("SIGKILL");
  }
  await Promise.all([...children].map((child) => waitForExit(child).catch(() => {})));
  children.clear();
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  servers.clear();
  await Promise.all([...temporaryDirectories].map((directory) => rm(directory, { force: true, recursive: true })));
  temporaryDirectories.clear();
});

test("resolves the default app URL without claiming its port", () => {
  expect(resolveIngestWatchBaseUrl(undefined)).toBe("http://localhost:3000");
  expect(resolveIngestWatchBaseUrl("http://example.test/")).toBe("http://example.test");
});

test("times out a request that never returns a response", async () => {
  const server = createServer(() => {});
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Stalled test server did not bind a TCP port.");
  }

  const boundedFetch = new BoundedFetch(50);

  await expect(boundedFetch.request(`http://localhost:${address.port}`)).rejects.toThrow(
    "request timed out after 50 ms",
  );
});

test("isolates an unreadable file and continues the same sweep", async () => {
  const app = await startFakeApp();
  const directory = await makeWatchDirectory();
  const watcher = startWatcher(directory, app.baseUrl);
  await waitUntilWatching(watcher);

  const unreadable = join(directory, "a-unreadable.wav");
  await writeFile(unreadable, "cannot read this");
  await chmod(unreadable, 0o000);
  await writeFile(join(directory, "b-good.wav"), "ingest this file");

  await waitFor(
    () => watcher.output().includes("FAILED a-unreadable.wav") && watcher.output().includes("queued b-good.wav"),
    `isolated failure and later ingest\n${watcher.output()}`,
    5_000,
  );

  expect(app.finalized).toEqual(["session-1"]);
  await chmod(unreadable, 0o600);
  watcher.child.kill("SIGTERM");
  await waitForExit(watcher.child);
}, 8_000);

test("renews expired auth and uploads video in bounded chunks", async () => {
  const app = await startFakeApp({ expireFirstCookieOnChunks: true });
  const directory = await makeWatchDirectory();
  const watcher = startWatcher(directory, app.baseUrl);
  await waitUntilWatching(watcher);
  const bytes = Buffer.alloc(CHUNK_BYTES + 19, 0x5a);

  await writeFile(join(directory, "meeting.mp4"), bytes);
  await waitFor(() => app.finalized.length === 1, `authenticated video finalize\n${watcher.output()}`, 6_000);

  expect(app.signIns).toBe(2);
  expect(app.sessions).toHaveLength(1);
  expect(app.sessions[0].body.mimeType).toBe("video/mp4");
  expect(app.chunks.map((chunk) => chunk.start)).toEqual([0, CHUNK_BYTES]);
  expect(app.chunks.every((chunk) => chunk.bytes.length <= CHUNK_BYTES)).toBe(true);
  expect(Buffer.concat(app.chunks.map((chunk) => chunk.bytes))).toEqual(bytes);
  watcher.child.kill("SIGTERM");
  await waitForExit(watcher.child);
}, 10_000);

test("preserves password whitespace when signing in", async () => {
  const app = await startFakeApp();
  const directory = await makeWatchDirectory();
  const password = "  long-enough-test-password  ";
  const watcher = startWatcher(directory, app.baseUrl, password);

  await waitUntilWatching(watcher);

  expect(app.passwords).toEqual([password]);
  watcher.child.kill("SIGTERM");
  await waitForExit(watcher.child);
}, 8_000);

test("serializes sweep triggers and remembers completed path fingerprints", async () => {
  const firstChunkGate = createGate();
  const app = await startFakeApp({ firstChunkGate });
  const directory = await makeWatchDirectory();
  const watcher = startWatcher(directory, app.baseUrl);
  await waitUntilWatching(watcher);
  const bytes = Buffer.from("same watched content");

  await writeFile(join(directory, "clip.wav"), bytes);
  await firstChunkGate.entered;
  await writeFile(join(directory, "poke-one.ignore"), "one");
  await new Promise((resolve) => setTimeout(resolve, 1_350));
  await writeFile(join(directory, "poke-two.ignore"), "two");
  await new Promise((resolve) => setTimeout(resolve, 250));
  firstChunkGate.release();
  await waitFor(() => app.finalized.length > 0, `first ingest finalize\n${watcher.output()}`);

  await writeFile(join(directory, "copy.wav"), bytes);
  const duplicateLine = "skip copy.wav: duplicate content already ingested this run";
  await waitFor(() => watcher.output().includes(duplicateLine), `cross-name dedupe\n${watcher.output()}`);
  await new Promise((resolve) => setTimeout(resolve, 2_500));

  expect(app.sessions).toHaveLength(1);
  expect(watcher.output().split(duplicateLine).length - 1).toBe(1);
  watcher.child.kill("SIGTERM");
  await waitForExit(watcher.child);
}, 12_000);

test("does not finalize bytes from a file modified after hashing", async () => {
  const firstSessionGate = createGate();
  const app = await startFakeApp({ firstSessionGate });
  const directory = await makeWatchDirectory();
  const watcher = startWatcher(directory, app.baseUrl);
  await waitUntilWatching(watcher);
  const original = Buffer.alloc(CHUNK_BYTES + 13, 0x11);
  const replacement = Buffer.alloc(original.length, 0x22);
  const path = join(directory, "changing.wav");

  await writeFile(path, original);
  await firstSessionGate.entered;
  await writeFile(path, replacement);
  firstSessionGate.release();
  await waitFor(
    () => app.sessions.length >= 2 && app.finalized.length >= 1,
    `retry after source mutation\n${watcher.output()}`,
    7_000,
  );

  expect(app.finalized).not.toContain("session-1");
  expect(app.finalized).toContain("session-2");
  expect(Buffer.concat(app.chunks.filter((chunk) => chunk.sessionId === "session-2").map((chunk) => chunk.bytes))).toEqual(
    replacement,
  );
  watcher.child.kill("SIGTERM");
  await waitForExit(watcher.child);
}, 11_000);

test("reconciles a lost finalize response without creating another session", async () => {
  const app = await startFakeApp({ loseFirstFinalizeResponse: true });
  const directory = await makeWatchDirectory();
  const watcher = startWatcher(directory, app.baseUrl);
  await waitUntilWatching(watcher);

  await writeFile(join(directory, "finalize-loss.wav"), "finalize exactly once");
  await waitFor(
    () => watcher.output().includes("queued finalize-loss.wav"),
    `finalize reconciliation\n${watcher.output()}`,
    7_000,
  );

  expect(app.sessions).toHaveLength(1);
  expect(app.finalized).toEqual(["session-1"]);
  expect(app.inspectedSessions).toEqual(["session-1"]);
  watcher.child.kill("SIGTERM");
  await waitForExit(watcher.child);
}, 11_000);

test("reuses one upload session after its creation response is lost", async () => {
  const app = await startFakeApp({ loseFirstSessionResponse: true });
  const directory = await makeWatchDirectory();
  const watcher = startWatcher(directory, app.baseUrl);
  await waitUntilWatching(watcher);

  await writeFile(join(directory, "session-loss.wav"), "one governed recording");
  await waitFor(
    () => watcher.output().includes("queued session-loss.wav"),
    `session creation recovery\n${watcher.output()}`,
    7_000,
  );

  expect(app.sessions).toHaveLength(1);
  expect(app.sessionRequestKeys.length).toBeGreaterThanOrEqual(2);
  expect(app.sessionRequestKeys.every(Boolean)).toBe(true);
  expect(new Set(app.sessionRequestKeys).size).toBe(1);
  expect(app.finalized).toEqual(["session-1"]);
  watcher.child.kill("SIGTERM");
  await waitForExit(watcher.child);
}, 11_000);

test("resumes committed chunks after their response is lost", async () => {
  const app = await startFakeApp({ loseFirstChunkResponse: true });
  const directory = await makeWatchDirectory();
  const watcher = startWatcher(directory, app.baseUrl);
  await waitUntilWatching(watcher);
  const bytes = Buffer.alloc(CHUNK_BYTES + 23, 0x73);

  await writeFile(join(directory, "chunk-loss.wav"), bytes);
  await waitFor(
    () => watcher.output().includes("queued chunk-loss.wav"),
    `chunk response recovery\n${watcher.output()}`,
    8_000,
  );

  expect(app.sessions).toHaveLength(1);
  expect(app.chunks.map((chunk) => chunk.start)).toEqual([0, CHUNK_BYTES]);
  expect(Buffer.concat(app.chunks.map((chunk) => chunk.bytes))).toEqual(bytes);
  expect(app.finalized).toEqual(["session-1"]);
  watcher.child.kill("SIGTERM");
  await waitForExit(watcher.child);
}, 12_000);

test("never finalizes transient file bytes after a lost chunk response", async () => {
  const firstSessionGate = createGate();
  const app = await startFakeApp({ firstSessionGate, loseFirstChunkResponse: true });
  const directory = await makeWatchDirectory();
  const watcher = startWatcher(directory, app.baseUrl);
  await waitUntilWatching(watcher);
  const original = Buffer.alloc(CHUNK_BYTES + 29, 0x31);
  const transient = Buffer.alloc(original.length, 0x42);
  const path = join(directory, "changing-back.wav");

  await writeFile(path, original);
  await firstSessionGate.entered;
  await writeFile(path, transient);
  firstSessionGate.release();
  await waitFor(
    () => app.chunks.length > 0 || watcher.output().includes("FAILED changing-back.wav"),
    `transient upload detection\n${watcher.output()}`,
    5_000,
  );
  await writeFile(path, original);
  await waitFor(
    () =>
      app.finalized.length > 0 ||
      watcher.output().includes("a prior upload of these bytes changed in flight"),
    `transient upload refusal\n${watcher.output()}`,
    8_000,
  );

  expect(app.sessions).toHaveLength(1);
  expect(app.finalized).toEqual([]);
  watcher.child.kill("SIGTERM");
  await waitForExit(watcher.child);
}, 14_000);

test("reports a finalize warning without retrying durable bytes", async () => {
  const warning = "Backend dispatch unavailable.";
  const app = await startFakeApp({ finalizeWarning: warning });
  const directory = await makeWatchDirectory();
  const watcher = startWatcher(directory, app.baseUrl);
  await waitUntilWatching(watcher);

  await writeFile(join(directory, "warning.wav"), "durable before dispatch");
  await waitFor(
    () => watcher.output().includes(`WARNING warning.wav: ${warning}`),
    `finalize warning\n${watcher.output()}`,
    6_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 2_500));

  expect(app.sessions).toHaveLength(1);
  expect(app.finalized).toEqual(["session-1"]);
  watcher.child.kill("SIGTERM");
  await waitForExit(watcher.child);
}, 10_000);

test("reports a persisted finalize warning after its response is lost", async () => {
  const warning = "Backend dispatch unavailable after durable storage.";
  const app = await startFakeApp({
    finalizeWarning: warning,
    loseFirstFinalizeResponse: true,
  });
  const directory = await makeWatchDirectory();
  const watcher = startWatcher(directory, app.baseUrl);
  await waitUntilWatching(watcher);

  await writeFile(join(directory, "warning-loss.wav"), "durable before response loss");
  await waitFor(
    () => watcher.output().includes(`WARNING warning-loss.wav: ${warning}`),
    `persisted finalize warning\n${watcher.output()}`,
    7_000,
  );

  expect(app.sessions).toHaveLength(1);
  expect(app.finalized).toEqual(["session-1"]);
  watcher.child.kill("SIGTERM");
  await waitForExit(watcher.child);
}, 11_000);

test("does not rehash a blocked fingerprint until the file changes", async () => {
  const app = await startFakeApp({ forceSessionRestart: true });
  const directory = await makeWatchDirectory();
  const watcher = startWatcher(directory, app.baseUrl);
  await waitUntilWatching(watcher);
  const path = join(directory, "restart.wav");
  const failure = "requires a restart";

  await writeFile(path, "first blocked version");
  await waitFor(
    () => watcher.output().includes(failure),
    `first blocked fingerprint\n${watcher.output()}`,
    5_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  expect(watcher.output().split(failure).length - 1).toBe(1);

  await writeFile(path, "changed blocked version");
  await waitFor(
    () => watcher.output().split(failure).length - 1 === 2,
    `changed blocked fingerprint\n${watcher.output()}`,
    5_000,
  );
  expect(app.sessions).toHaveLength(2);
  watcher.child.kill("SIGTERM");
  await waitForExit(watcher.child);
}, 13_000);

test("falls back to polling when native watch setup fails", async () => {
  const signInGate = createGate();
  const app = await startFakeApp({ signInGate });
  const directory = await makeWatchDirectory();
  const watcher = startWatcher(directory, app.baseUrl);

  await signInGate.entered;
  await rm(directory, { recursive: true });
  signInGate.release();
  await waitFor(
    () => watcher.output().includes("watch setup failed; continuing with polling"),
    `native watch fallback\n${watcher.output()}`,
    5_000,
  );
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "polling.wav"), "poll this file");
  await waitFor(
    () => watcher.output().includes("queued polling.wav"),
    `polling recovery\n${watcher.output()}`,
    6_000,
  );

  expect(app.finalized).toEqual(["session-1"]);
  watcher.child.kill("SIGTERM");
  await waitForExit(watcher.child);
}, 12_000);

test("aborts a stalled ingest request during termination", async () => {
  const firstChunkGate = createGate();
  const app = await startFakeApp({ firstChunkGate });
  const directory = await makeWatchDirectory();
  const watcher = startWatcher(directory, app.baseUrl);
  await waitUntilWatching(watcher);

  await writeFile(join(directory, "shutdown.wav"), "finish before shutdown");
  await firstChunkGate.entered;
  watcher.child.kill("SIGTERM");
  try {
    await waitForExit(watcher.child);
  } finally {
    firstChunkGate.release();
  }
  expect(app.finalized).toEqual([]);
}, 9_000);
