import { eq, sql } from "drizzle-orm";
import {
  getAppDbBundle,
  type AppDatabase,
  type AppDatabaseBundle,
} from "@/server/db/client";
import { appStateMeta } from "@/server/db/schema";

function governedBody<T>(
  operation: (db: AppDatabase, now: string) => T,
  bundle: AppDatabaseBundle,
) {
  const result = operation(bundle.db, new Date().toISOString());
  const versionUpdate = bundle.db
    .update(appStateMeta)
    .set({ stateVersion: sql`${appStateMeta.stateVersion} + 1` })
    .where(eq(appStateMeta.id, 1))
    .run();

  if (versionUpdate.changes !== 1) {
    throw new Error(
      "Governed transaction could not advance the application state version.",
    );
  }

  return result;
}

export function runGovernedTransaction<T>(
  operation: (db: AppDatabase, now: string) => T,
  bundle: AppDatabaseBundle = getAppDbBundle(),
): T {
  return bundle.sqlite.transaction(() => governedBody(operation, bundle))();
}

export function runImmediateGovernedTransaction<T>(
  operation: (db: AppDatabase, now: string) => T,
  bundle: AppDatabaseBundle = getAppDbBundle(),
): T {
  return bundle.sqlite
    .transaction(() => governedBody(operation, bundle))
    .immediate();
}
