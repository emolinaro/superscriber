import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const SECRET_FILE = join("data", "auth.secret");

export function resolveAuthSecret() {
  const fromEnv = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (fromEnv) {
    return fromEnv;
  }

  if (existsSync(SECRET_FILE)) {
    return readFileSync(SECRET_FILE, "utf8").trim();
  }

  mkdirSync("data", { recursive: true });
  const generated = randomBytes(48).toString("hex");
  writeFileSync(SECRET_FILE, generated, { encoding: "utf8", mode: 0o600 });
  return generated;
}
