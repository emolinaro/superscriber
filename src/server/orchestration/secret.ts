import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

const SECRET_FILE = join(process.cwd(), "data", "engine.secret");

export function resolveEngineSharedSecret() {
  const fromEnv = process.env.SUPERSCRIBER_ENGINE_SHARED_SECRET;
  if (fromEnv) {
    return fromEnv;
  }

  if (existsSync(SECRET_FILE)) {
    return readFileSync(SECRET_FILE, "utf8").trim();
  }

  mkdirSync(join(process.cwd(), "data"), { recursive: true });
  const generated = randomBytes(32).toString("hex");
  writeFileSync(SECRET_FILE, generated, { encoding: "utf8", mode: 0o600 });
  return generated;
}
