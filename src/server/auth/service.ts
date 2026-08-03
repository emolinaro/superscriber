import { hash, compare } from "bcryptjs";
import { eq } from "drizzle-orm";
import { type AppUser, type Principal, type UserRole } from "@/domain/models";
import {
  getAppDb,
  getAppDbBundle,
  type AppDatabase,
  type AppDatabaseBundle,
} from "@/server/db/client";
import { users } from "@/server/db/schema";
import { localUserSchema, normalizeEmail } from "@/server/auth/validation";

function nowIso() {
  return new Date().toISOString();
}

function toAppUser(row: typeof users.$inferSelect): AppUser {
  return {
    id: row.id,
    email: row.email,
    displayName: row.displayName,
    role: row.role,
    isActive: row.isActive,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function insertLocalUserRow(
  params: {
    email: string;
    displayName: string;
    passwordHash: string;
    role: UserRole;
  },
  db: AppDatabase,
) {
  const timestamp = nowIso();

  db.insert(users)
    .values({
      id: crypto.randomUUID(),
      email: params.email,
      displayName: params.displayName,
      passwordHash: params.passwordHash,
      role: params.role,
      isActive: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .run();

  const created = db
    .select()
    .from(users)
    .where(eq(users.email, params.email))
    .get();

  if (!created) {
    throw new Error("The user was created but could not be reloaded.");
  }

  return toAppUser(created);
}

export function toPrincipal(user: AppUser): Principal {
  return {
    userId: user.id,
    email: user.email,
    displayName: user.displayName,
    role: user.role,
  };
}

export async function hasAnyUsers(db: AppDatabase = getAppDb()) {
  const result = db.select({ id: users.id }).from(users).limit(1).get();
  return Boolean(result);
}

export async function getUserById(id: string, db: AppDatabase = getAppDb()) {
  const row = db.select().from(users).where(eq(users.id, id)).get();
  return row ? toAppUser(row) : null;
}

export async function getUserByEmail(email: string, db: AppDatabase = getAppDb()) {
  const row = db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(email)))
    .get();

  return row ? toAppUser(row) : null;
}

export async function createLocalUser(
  input: {
    displayName: string;
    email: string;
    password: string;
    role: UserRole;
  },
  db: AppDatabase = getAppDb(),
) {
  const parsed = localUserSchema.parse({
    ...input,
    email: normalizeEmail(input.email),
  });

  const existing = db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, parsed.email))
    .get();

  if (existing) {
    throw new Error("An account with that email already exists.");
  }

  const passwordHash = await hash(parsed.password, 12);
  return insertLocalUserRow(
    {
      email: parsed.email,
      displayName: parsed.displayName,
      passwordHash,
      role: parsed.role,
    },
    db,
  );
}

export async function createBootstrapAdmin(
  input: {
    displayName: string;
    email: string;
    password: string;
  },
  bundle: AppDatabaseBundle = getAppDbBundle(),
) {
  const parsed = localUserSchema.parse({
    ...input,
    email: normalizeEmail(input.email),
    role: "admin",
  });
  const passwordHash = await hash(parsed.password, 12);

  const transaction = bundle.sqlite.transaction(() => {
    const existingUser = bundle.db.select({ id: users.id }).from(users).limit(1).get();
    if (existingUser) {
      throw new Error("First-run setup is already complete. Sign in with an existing account.");
    }

    return insertLocalUserRow(
      {
        email: parsed.email,
        displayName: parsed.displayName,
        passwordHash,
        role: "admin",
      },
      bundle.db,
    );
  });

  return transaction();
}

export async function verifyLocalCredentials(
  credentials: {
    email: string;
    password: string;
  },
  db: AppDatabase = getAppDb(),
) {
  const row = db
    .select()
    .from(users)
    .where(eq(users.email, normalizeEmail(credentials.email)))
    .get();

  // OIDC-only shadow users carry no local secret; credentials cannot match.
  if (!row || !row.isActive || !row.passwordHash) {
    return null;
  }

  const matches = await compare(credentials.password, row.passwordHash);
  if (!matches) {
    return null;
  }

  return toAppUser(row);
}
