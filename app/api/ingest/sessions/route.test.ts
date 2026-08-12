import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/server/session", () => ({
  getActivePrincipal: vi.fn(),
}));

vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
}));

import { getActivePrincipal } from "@/server/session";
import { TIER_DOWNLOADS } from "@/server/models/tier-downloads";
import type { Principal } from "@/domain/models";

let uploaderPrincipal: Principal;

function callPost(body: unknown, idempotencyKey?: string) {
  return import("./route").then(({ POST }) =>
    POST(
      new Request("http://localhost/api/ingest/sessions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(idempotencyKey
            ? { "x-superscriber-idempotency-key": idempotencyKey }
            : {}),
        },
        body: JSON.stringify(body),
      }),
    ),
  );
}

// demo-model-tier-picker: the route double-checks the pick against actual
// provisioned host artifacts, so a forged or stale client cannot pin a
// recording to a tier the worker cannot run.
describe("ingest session route (demo-model-tier-picker)", () => {
  let tempRoot: string;
  let modelRoot: string;

  beforeEach(async () => {
    tempRoot = mkdtempSync(join(tmpdir(), "superscriber-ingest-route-"));
    modelRoot = join(tempRoot, "models");
    process.env.SUPERSCRIBER_DB_PATH = join(tempRoot, "test.db");
    process.env.SUPERSCRIBER_UPLOAD_TMP_DIR = join(tempRoot, "uploads");
    process.env.SUPERSCRIBER_MEDIA_DIR = join(tempRoot, "media");
    process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR = modelRoot;
    mkdirSync(modelRoot, { recursive: true });

    // Dynamic imports pair with the resetModules() in afterEach so the db
    // client module state matches the fresh env for this test.
    const { createLocalUser, toPrincipal } =
      await import("@/server/auth/service");
    uploaderPrincipal = toPrincipal(
      await createLocalUser({
        displayName: "Uploader",
        email: "uploader@example.com",
        password: "password123",
        role: "uploader",
      }),
    );
  });

  afterEach(async () => {
    const { resetAppDatabaseForTests } = await import("@/server/db/client");
    resetAppDatabaseForTests();
    delete process.env.SUPERSCRIBER_DB_PATH;
    delete process.env.SUPERSCRIBER_UPLOAD_TMP_DIR;
    delete process.env.SUPERSCRIBER_MEDIA_DIR;
    delete process.env.SUPERSCRIBER_TRANSCRIBE_MODEL_DIR;
    rmSync(tempRoot, { recursive: true, force: true });
    vi.resetAllMocks();
    vi.resetModules();
  });

  function provision(tierId: string) {
    const dir = join(modelRoot, tierId);
    mkdirSync(dir, { recursive: true });
    for (const file of TIER_DOWNLOADS[tierId].files) {
      writeFileSync(
        join(dir, file),
        file === "config.json" ? "{}" : "artifact",
      );
    }
  }

  const VALID_BODY = {
    title: "Tiered interview",
    languageHint: "english",
    source: "upload",
    fileName: "clip.wav",
    mimeType: "audio/wav",
    fileSize: 16,
  };

  it("refuses a tier with no provisioned artifacts on this host", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue(uploaderPrincipal);

    const response = await callPost({
      ...VALID_BODY,
      transcriptModel: "large-v3",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as {
      error?: string;
      fieldErrors?: Record<string, string>;
    };
    expect(body.error).toBe(
      "Transcription model 'large-v3' is not provisioned on this host.",
    );
    expect(body.fieldErrors?.transcriptModel).toContain("not provisioned");

    const { readState } = await import("@/server/store");
    expect(
      readState().recordings.some(
        (entry) => entry.title === "Tiered interview",
      ),
    ).toBe(false);
  });

  it("refuses a tier name outside the catalog entirely", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue(uploaderPrincipal);

    const response = await callPost({
      ...VALID_BODY,
      transcriptModel: "gpt-4-audio",
    });
    expect(response.status).toBe(400);
  });

  it("persists a provisioned tier on the recording and keeps default picks null", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue(uploaderPrincipal);
    provision("tiny");

    const response = await callPost({ ...VALID_BODY, transcriptModel: "tiny" });
    expect(response.status).toBe(200);
    const created = (await response.json()) as {
      status: { recordingId: string };
    };

    const { readState } = await import("@/server/store");
    const recording = readState().recordings.find(
      (entry) => entry.id === created.status.recordingId,
    );
    expect(recording?.transcriptModel).toBe("tiny");

    const defaultResponse = await callPost({
      ...VALID_BODY,
      title: "Plain interview",
    });
    expect(defaultResponse.status).toBe(200);
    const createdDefault = (await defaultResponse.json()) as {
      status: { recordingId: string };
    };
    const recordingDefault = readState().recordings.find(
      (entry) => entry.id === createdDefault.status.recordingId,
    );
    expect(recordingDefault?.transcriptModel).toBeNull();
  });

  it("returns the same session for a repeated idempotency key", async () => {
    vi.mocked(getActivePrincipal).mockResolvedValue(uploaderPrincipal);
    const idempotencyKey = "watch-run-1:stable-content-digest";

    const firstResponse = await callPost(VALID_BODY, idempotencyKey);
    const secondResponse = await callPost(VALID_BODY, idempotencyKey);
    expect(firstResponse.status).toBe(200);
    expect(secondResponse.status).toBe(200);
    const first = (await firstResponse.json()) as {
      status: { sessionId: string };
    };
    const second = (await secondResponse.json()) as {
      status: { sessionId: string };
    };

    expect(second.status.sessionId).toBe(first.status.sessionId);
    const { readState } = await import("@/server/store");
    expect(
      readState().recordings.filter(
        (entry) => entry.title === VALID_BODY.title,
      ),
    ).toHaveLength(1);
  });
});
