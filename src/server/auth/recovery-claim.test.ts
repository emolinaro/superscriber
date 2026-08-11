import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openAppDatabase, type AppDatabaseBundle } from "@/server/db/client";
import {
  createLocalUser,
  getUserByEmail,
  hasAnyActiveAdmin,
  hasAnyUsers,
} from "@/server/auth/service";
import {
  ADMIN_CLAIM_TOKEN_FILENAME,
  createRecoveryAdmin,
  consumeAdminClaimToken,
  ensureAdminClaimToken,
  RecoveryClaimError,
  readAdminClaimToken,
  recoveryClaimLimiter,
  resolveAdminClaimTokenPath,
  verifyAdminClaimToken,
} from "@/server/auth/recovery-claim";

const CLAIM_INPUT = {
  displayName: "Recovery Admin",
  email: "recovery@example.com",
  password: "correct horse battery staple",
};

describe("admin recovery claim", () => {
  let tempRoot = "";
  let bundle: AppDatabaseBundle;

  beforeEach(() => {
    tempRoot = mkdtempSync(join(tmpdir(), "superscriber-recovery-claim-"));
    process.env.SUPERSCRIBER_DB_PATH = join(tempRoot, "state.db");
    bundle = openAppDatabase(join(tempRoot, "state.db"));
  });

  afterEach(() => {
    bundle.sqlite.close();
    recoveryClaimLimiter.reset();
    rmSync(tempRoot, { recursive: true, force: true });
    delete process.env.SUPERSCRIBER_DB_PATH;
  });

  function seedNonAdminUser() {
    return createLocalUser(
      {
        displayName: "Uploader One",
        email: "uploader@example.com",
        password: "correct horse battery staple",
        role: "uploader",
      },
      bundle.db,
    );
  }

  function readTokenFromDisk() {
    return readFileSync(join(tempRoot, ADMIN_CLAIM_TOKEN_FILENAME), "utf8").trim();
  }

  describe("claim token file", () => {
    it("lives next to the database file", () => {
      expect(resolveAdminClaimTokenPath()).toBe(join(tempRoot, ADMIN_CLAIM_TOKEN_FILENAME));
    });

    it("is created operator-only readable and is idempotent across calls", () => {
      const first = ensureAdminClaimToken();
      const second = ensureAdminClaimToken();

      expect(first.path).toBe(join(tempRoot, ADMIN_CLAIM_TOKEN_FILENAME));
      expect(second.token).toBe(first.token);
      expect(readTokenFromDisk()).toBe(first.token);
      expect(first.token).toMatch(/^[0-9a-f]{32}$/);
      // 0600: only the appliance service account (and the host operator
      // acting as it) can read the claim proof.
      expect(statSync(first.path).mode & 0o777).toBe(0o600);
    });

    it("regenerates a fresh token after the file is removed", () => {
      const first = ensureAdminClaimToken();
      consumeAdminClaimToken();
      expect(existsSync(first.path)).toBe(false);

      const second = ensureAdminClaimToken();
      expect(second.token).not.toBe(first.token);

      // Consume on a missing file is a no-op.
      consumeAdminClaimToken();
      consumeAdminClaimToken();
    });

    it("recovers from an externally corrupted token file by replacing it", () => {
      const first = ensureAdminClaimToken();
      writeFileSync(first.path, "not-a-valid-token", "utf8");

      const regenerated = ensureAdminClaimToken();
      expect(regenerated.token).toMatch(/^[0-9a-f]{32}$/);
      expect(readTokenFromDisk()).toBe(regenerated.token);
    });

    it("verifies normalized input and refuses anything else", () => {
      const { token } = ensureAdminClaimToken();
      const spaced = `${token.slice(0, 4)}-${token.slice(4).toUpperCase()} `;

      expect(verifyAdminClaimToken(` ${spaced}`)).toBe(true);
      expect(verifyAdminClaimToken(token)).toBe(true);
      expect(verifyAdminClaimToken(token.replace(/.$/, token.endsWith("0") ? "1" : "0"))).toBe(
        false,
      );
      expect(verifyAdminClaimToken("")).toBe(false);

      consumeAdminClaimToken();
      expect(readAdminClaimToken()).toBeNull();
      expect(verifyAdminClaimToken(token)).toBe(false);
    });
  });

  describe("createRecoveryAdmin", () => {
    it("creates an active admin when users exist but no active admin remains", async () => {
      await seedNonAdminUser();
      const { token } = ensureAdminClaimToken();

      const claimed = await createRecoveryAdmin(
        { ...CLAIM_INPUT, claimToken: token },
        bundle,
      );

      expect(claimed.role).toBe("admin");
      expect(claimed.isActive).toBe(true);
      expect(await hasAnyActiveAdmin(bundle.db)).toBe(true);

      const reloaded = await getUserByEmail(CLAIM_INPUT.email.toUpperCase(), bundle.db);
      expect(reloaded?.id).toBe(claimed.id);
      // The claim proof is single-use.
      expect(existsSync(join(tempRoot, ADMIN_CLAIM_TOKEN_FILENAME))).toBe(false);
    });

    it("refuses when an active administrator already exists", async () => {
      await seedNonAdminUser();
      await createLocalUser(
        {
          displayName: "Admin One",
          email: "admin@example.com",
          password: "correct horse battery staple",
          role: "admin",
        },
        bundle.db,
      );
      const { token, path } = ensureAdminClaimToken();

      const error = await createRecoveryAdmin({ ...CLAIM_INPUT, claimToken: token }, bundle).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(RecoveryClaimError);
      expect((error as RecoveryClaimError).code).toBe("admin_exists");
      expect(await getUserByEmail(CLAIM_INPUT.email, bundle.db)).toBeNull();
      // The proof stays unconsumed: the claim never cleared the state gate.
      expect(existsSync(path)).toBe(true);
    });

    it("refuses when the appliance has no accounts at all", async () => {
      const { token } = ensureAdminClaimToken();

      const error = await createRecoveryAdmin({ ...CLAIM_INPUT, claimToken: token }, bundle).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(RecoveryClaimError);
      expect((error as RecoveryClaimError).code).toBe("requires_existing_users");
      expect(await hasAnyUsers(bundle.db)).toBe(false);
    });

    it("refuses a wrong claim token and inserts nothing", async () => {
      await seedNonAdminUser();
      ensureAdminClaimToken();

      const error = await createRecoveryAdmin(
        { ...CLAIM_INPUT, claimToken: "f".repeat(32) },
        bundle,
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RecoveryClaimError);
      expect(error).not.toBeNull();
      expect((error as RecoveryClaimError).code).toBe("claim_token_invalid");
      expect(await getUserByEmail(CLAIM_INPUT.email, bundle.db)).toBeNull();
      expect(await hasAnyActiveAdmin(bundle.db)).toBe(false);
    });

    it("refuses to claim over an existing account email", async () => {
      await seedNonAdminUser();
      const { token } = ensureAdminClaimToken();

      const error = await createRecoveryAdmin(
        { ...CLAIM_INPUT, email: "Uploader@Example.com", claimToken: token },
        bundle,
      ).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(RecoveryClaimError);
      expect((error as RecoveryClaimError).code).toBe("email_taken");
      expect(await hasAnyActiveAdmin(bundle.db)).toBe(false);
    });

    it("allows only one concurrent claim to succeed", async () => {
      await seedNonAdminUser();
      const { token } = ensureAdminClaimToken();

      const results = await Promise.allSettled([
        createRecoveryAdmin({ ...CLAIM_INPUT, claimToken: token }, bundle),
        createRecoveryAdmin(
          { ...CLAIM_INPUT, email: "second-recovery@example.com", claimToken: token },
          bundle,
        ),
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      const rejected = results.find((result) => result.status === "rejected");
      expect(rejected).toBeDefined();
      expect((rejected as PromiseRejectedResult).reason).toBeInstanceOf(RecoveryClaimError);

      const admins = bundle.db.query.users
        .findMany({
          where: (usersTable, { and, eq }) =>
            and(eq(usersTable.role, "admin"), eq(usersTable.isActive, true)),
        })
        .sync();
      expect(admins).toHaveLength(1);
    });
  });
});
