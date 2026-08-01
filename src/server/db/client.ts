import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { runMigrations } from "@/server/db/migrations";
import * as schema from "@/server/db/schema";

const DEFAULT_DATABASE_PATH = join(process.cwd(), "data", "superscriber.db");

export type AppDatabase = BetterSQLite3Database<typeof schema>;
export type AppDatabaseBundle = {
  sqlite: Database.Database;
  db: AppDatabase;
};

let defaultBundle: AppDatabaseBundle | null = null;
const bundleByDb = new WeakMap<AppDatabase, AppDatabaseBundle>();

function resolveDatabasePath() {
  return process.env.SUPERSCRIBER_DB_PATH?.trim() || DEFAULT_DATABASE_PATH;
}

export function openAppDatabase(path = resolveDatabasePath()): AppDatabaseBundle {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }

  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  runMigrations(sqlite);

  const bundle = {
    sqlite,
    db: drizzle(sqlite, { schema }),
  } satisfies AppDatabaseBundle;

  bundleByDb.set(bundle.db, bundle);
  return bundle;
}

export function getAppDb() {
  if (!defaultBundle) {
    defaultBundle = openAppDatabase();
  }

  return defaultBundle.db;
}

export function getAppDbBundle() {
  if (!defaultBundle) {
    defaultBundle = openAppDatabase();
  }

  return defaultBundle;
}

export function lookupAppDbBundle(db: AppDatabase) {
  return bundleByDb.get(db) ?? null;
}

export function resetAppDatabaseForTests() {
  if (!defaultBundle) {
    return;
  }

  defaultBundle.sqlite.close();
  defaultBundle = null;
}
