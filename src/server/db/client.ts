import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { runMigrations } from "@/server/db/migrations";
import * as schema from "@/server/db/schema";

const DEFAULT_DATABASE_PATH = join(/*turbopackIgnore: true*/ process.cwd(), "data", "superscriber.db");

export type AppDatabase = BetterSQLite3Database<typeof schema>;
export type AppDatabaseBundle = {
  sqlite: Database.Database;
  db: AppDatabase;
};

let defaultBundle: AppDatabaseBundle | null = null;
const bundleByDb = new WeakMap<AppDatabase, AppDatabaseBundle>();

export function resolveDatabasePath() {
  return process.env.SUPERSCRIBER_DB_PATH?.trim() || DEFAULT_DATABASE_PATH;
}

// Location for the forensic snapshots the destructive governance controls
// (ledger reset, recording purge) write before any row is deleted. Lives
// next to the database file so it survives with the appliance data volume
// and inherits the same file permissions discipline as the data directory.
export function resolveLedgerSnapshotDir() {
  if (process.env.SUPERSCRIBER_LEDGER_SNAPSHOT_DIR?.trim()) {
    return process.env.SUPERSCRIBER_LEDGER_SNAPSHOT_DIR.trim();
  }

  const dbPath = resolveDatabasePath();
  const baseDir = dbPath === ":memory:" ? join(process.cwd(), "data") : dirname(dbPath);
  return join(baseDir, "ledger-snapshots");
}

// Directory that accompanies the database file on the appliance volume; the
// recovery claim proof and ledger snapshots live here so they inherit the
// data directory's file-permission discipline.
export function resolveDatabaseDir() {
  const dbPath = resolveDatabasePath();
  return dbPath === ":memory:" ? join(process.cwd(), "data") : dirname(dbPath);
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
