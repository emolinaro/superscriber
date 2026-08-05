/**
 * Operator command: break-glass designation ceremonies.
 *
 * Designate (zero to one designation):
 *   SUPERSCRIBER_DB_PATH=/path/superscriber.db \
 *     npm run break-glass:designate -- --user <admin-id> --reason "..."
 *
 * Atomic transfer (old custodian's local path disabled, sessions revoked,
 * pointer moved):
 *   SUPERSCRIBER_DB_PATH=/path/superscriber.db \
 *     npm run break-glass:transfer -- --user <admin-id> --reason "..."
 */

import {
  designateBreakGlassUser,
  transferBreakGlassDesignation,
} from "@/server/auth/break-glass";
import { openAppDatabase } from "@/server/db/client";

function usage(message?: string): never {
  if (message) {
    console.error(`error: ${message}`);
  }
  console.error("usage: break-glass.ts (designate|transfer) --user <admin-user-id> --reason <text>");
  process.exit(64);
}

const args = process.argv.slice(2);
const command = args.shift();
if (command !== "designate" && command !== "transfer") {
  usage("expected designate or transfer");
}

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
  if (command === "designate") {
    const result = designateBreakGlassUser({ userId, changeReason: reason }, db);
    console.log(JSON.stringify({ designated: result.breakGlassUserId }));
  } else {
    const result = transferBreakGlassDesignation({ newUserId: userId, changeReason: reason }, db);
    console.log(JSON.stringify({ transferred: result.breakGlassUserId }));
  }
} finally {
  sqlite.close();
}
