import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
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
  firstChunkGate?: Gate;
  firstSessionGate?: Gate;
  loseFirstFinalizeResponse?: boolean;
};

type FakeApp = {
  baseUrl: string;
  chunks: Array<{ bytes: Buffer; cookie: string; sessionId: string; start: number }>;
  finalized: string[];
  inspectedSessions: string[];
  passwords: string[];
  sessions: Array<{ body: Record<string, unknown>; id: string }>;
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
    sessions: [],
    signIns: 0,
  };
  let firstChunkGated = false;
  let finalizeResponseLost = false;

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
        sendJson(response, 200, { url: "/workspace" }, {
          "set-cookie": `authjs.session-token=token-${state.signIns}; Path=/; HttpOnly`,
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/ingest/sessions") {
        const body = JSON.parse((await readBody(request)).toString("utf8")) as Record<string, unknown>;
        const id = `session-${state.sessions.length + 1}`;
        state.sessions.push({ body, id });
        if (state.sessions.length === 1 && options.firstSessionGate) {
          await options.firstSessionGate.arrive();
        }
        sendJson(response, 200, { ok: true, status: { sessionId: id } });
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
        state.chunks.push({
          bytes,
          cookie,
          sessionId: chunkMatch[1],
          start: Number(request.headers["x-superscriber-byte-start"]),
        });
        if (!firstChunkGated && chunkMatch[1] === "session-1" && options.firstChunkGate) {
          firstChunkGated = true;
          await options.firstChunkGate.arrive();
        }
        sendJson(response, 200, { ok: true });
        return;
      }

      const finalizeMatch = url.pathname.match(/^\/api\/ingest\/sessions\/([^/]+)\/finalize$/);
      if (request.method === "POST" && finalizeMatch) {
        await readBody(request);
        state.finalized.push(finalizeMatch[1]);
        if (options.loseFirstFinalizeResponse && !finalizeResponseLost) {
          finalizeResponseLost = true;
          response.destroy();
          return;
        }
        sendJson(response, 200, { ok: true });
        return;
      }

      const statusMatch = url.pathname.match(/^\/api\/ingest\/sessions\/([^/]+)$/);
      if (request.method === "GET" && statusMatch) {
        const sessionId = statusMatch[1];
        const finalized = state.finalized.includes(sessionId);
        state.inspectedSessions.push(sessionId);
        sendJson(response, 200, {
          ok: true,
          status: {
            sessionId,
            state: finalized ? "verified" : "receiving",
            integrityState: finalized ? "verifying" : "pending",
            nextAction: finalized ? "none" : "finalize",
          },
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
