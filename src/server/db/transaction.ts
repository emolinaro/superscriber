import { eq, sql } from "drizzle-orm";
import { getAppDbBundle, type AppDatabase, type AppDatabaseBundle } from "@/server/db/client";
import { appStateMeta } from "@/server/db/schema";

export function runGovernedTransaction<T>(
  operation: (db: AppDatabase, now: string) => T,
  bundle: AppDatabaseBundle = getAppDbBundle(),
): T {
  return bundle.sqlite.transaction(() => {
    const result = operation(bundle.db, new Date().toISOString());
    bundle.db
      .update(appStateMeta)
      .set({ stateVersion: sql`${appStateMeta.stateVersion} + 1` })
      .where(eq(appStateMeta.id, 1))
      .run();
    return result;
  })();
}
