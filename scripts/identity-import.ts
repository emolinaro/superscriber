/**
 * Operator command: dry-run or apply an Authentik identity link mapping
 * (plan section 4.3).
 *
 * Usage:
 *   SUPERSCRIBER_DB_PATH=/path/superscriber.db \
 *     npx tsx scripts/identity-import.ts --file mapping.json --dry-run
 *
 *   SUPERSCRIBER_DB_PATH=/path/superscriber.db \
 *     npx tsx scripts/identity-import.ts --file mapping.json --apply --linked-by <operator-user-id>
 *
 * The mapping file is a JSON array of entries:
 *   [{ "userId", "issuer", "subject", "changeReason", "expectedRole"? }, ...]
 *
 * It must never contain email addresses; matching is exact on
 * (issuer, subject) -> local user id. Apply runs inside a fresh dry-run gate
 * and a single transaction; one redacted security event is recorded per
 * linked user.
 */

import { readFileSync } from "node:fs";
import {
  applyIdentityImport,
  dryRunIdentityImport,
  identityImportSchema,
} from "@/server/auth/identity-import";
import { openAppDatabase } from "@/server/db/client";

function usage(message?: string): never {
  if (message) {
    console.error(`error: ${message}`);
  }
  console.error(
    "usage: identity-import.ts --file <mapping.json> (--dry-run | --apply) [--linked-by <userId>]",
  );
  process.exit(64);
}

function parseArgs(argv: string[]) {
  let file = "";
  let dryRun = false;
  let apply = false;
  let linkedBy: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--file") {
      file = argv[++index] ?? "";
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--apply") {
      apply = true;
    } else if (arg === "--linked-by") {
      linkedBy = argv[++index] ?? null;
    } else {
      usage(`unknown argument: ${arg}`);
    }
  }

  if (!file) {
    usage("missing --file");
  }
  if (dryRun === apply) {
    usage("choose exactly one of --dry-run or --apply");
  }

  return { file, apply, linkedBy };
}

function main() {
  const { file, apply, linkedBy } = parseArgs(process.argv.slice(2));

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    console.error(`error: cannot read/parse mapping file ${file}: ${(error as Error).message}`);
    process.exit(65);
  }

  const entries = identityImportSchema.parse(raw);
  const { db, sqlite } = openAppDatabase();

  try {
    const report = dryRunIdentityImport(entries, db);
    console.log(JSON.stringify(report, null, 2));

    if (!apply) {
      process.exit(report.ok ? 0 : 2);
    }

    if (!report.ok) {
      console.error("refusing to apply: dry-run reported problems (see report above).");
      process.exit(2);
    }

    const result = applyIdentityImport(entries, { linkedByUserId: linkedBy }, db);
    console.log(`applied ${result.applied} identity link(s).`);
  } finally {
    sqlite.close();
  }
}

main();
