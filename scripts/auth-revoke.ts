/**
 * Operator command: revoke sessions for a local user (incident response).
 *
 * Usage:
 *   SUPERSCRIBER_DB_PATH=/path/superscriber.db \
 *     npm run auth:revoke -- --user <user-id> --reason "Incident 2026-08 containment"
 *
 * Bumps users.auth_version and revokes all active session rows in one
 * transaction (plan section 7.3). Prints a short JSON summary.
 */

import { retireUserSessions } from "@/server/auth/session-registry";
import { openAppDatabase } from "@/server/db/client";

function usage(message?: string): never {
  if (message) {
    console.error(`error: ${message}`);
  }
  console.error("usage: auth-revoke.ts --user <user-id> --reason <text>");
  process.exit(64);
}

const args = process.argv.slice(2);
let userId = "";
let reason = "";
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === "--user") {
    userId = args[++index] ?? "";
  } else if (args[index] === "--reason") {
    reason = args[++index] ?? "";
  } else {
    usage(`unknown argument: ${args[index]}`);
  }
}
if (!userId || !reason) {
  usage("both --user and --reason are required");
}

const { db, sqlite } = openAppDatabase();
try {
  const user = sqlite
    .prepare(`SELECT id, is_active AS isActive FROM users WHERE id = ?`)
    .get(userId) as { id: string; isActive: number } | undefined;
  if (!user) {
    console.error(`error: no local user ${userId}`);
    process.exit(66);
  }

  const { revokedCount } = retireUserSessions({ userId, reason }, db);
  console.log(JSON.stringify({ userId, revokedCount, reason }));
} finally {
  sqlite.close();
}
