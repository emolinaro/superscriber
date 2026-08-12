// local-deploy-bootstrap: idempotent database initialization for the
// operator bootstrap. Opens (and thereby creates, when missing) the SQLite
// database at SUPERSCRIBER_DB_PATH - or the repo default - and runs the full
// repo migration chain, exactly as the app does on startup. Safe to re-run:
// applied migrations are skipped via the schema_migrations ledger.
//
// Usage: SUPERSCRIBER_DB_PATH=<path> npx tsx scripts/ensure-db.ts

import { openAppDatabase, resolveDatabasePath } from "@/server/db/client";
import { LATEST_SCHEMA_VERSION } from "@/server/db/migrations";

function main() {
  const path = resolveDatabasePath();
  const bundle = openAppDatabase(path);
  const applied = bundle.sqlite
    .prepare("SELECT COUNT(*) AS count FROM schema_migrations")
    .get() as { count: number };
  bundle.sqlite.close();

  console.log(
    `Database ready at ${path}: schema version ${LATEST_SCHEMA_VERSION} (${applied.count} migrations applied).`,
  );
}

main();
