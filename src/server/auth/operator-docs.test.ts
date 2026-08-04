import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DOCS_DIR = join(process.cwd(), "docs", "operators");

const EXPECTED_DOCS = [
  "authentik-oidc.md",
  "identity-linking.md",
  "break-glass.md",
  "auth-outage.md",
  "auth-rollback.md",
  "key-and-certificate-rotation.md",
  "no-mail-profile.md",
];

function readDocs() {
  const files = readdirSync(DOCS_DIR).filter((file) => file.endsWith(".md"));
  return files.map((file) => ({ file, content: readFileSync(join(DOCS_DIR, file), "utf8") }));
}

describe("operator runbooks", () => {
  it("cover every required runbook", () => {
    const docs = readDocs();
    for (const required of EXPECTED_DOCS) {
      expect(docs.map((doc) => doc.file), `missing ${required}`).toContain(required);
    }
  });

  it("references only npm scripts that exist", () => {
    const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };

    for (const doc of readDocs()) {
      const commands = doc.content.match(/npm run ([a-z:-]+)/g) ?? [];
      for (const command of commands) {
        const script = command.replace("npm run ", "").trim();
        expect(packageJson.scripts, `${doc.file} references missing script "${script}"`).toHaveProperty(script);
      }
    }
  });

  it("contains no secret material or email addresses", () => {
    for (const doc of readDocs()) {
      expect(doc.content, doc.file).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
      expect(doc.content, doc.file).not.toMatch(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
      expect(doc.content, doc.file).not.toMatch(/password\s*[:=]\s*[^\s<"`]/i);
    }
  });

  it("keeps the no-mail guarantee scannable from the repo", () => {
    const profileDoc = readDocs().find((doc) => doc.file === "no-mail-profile.md");
    expect(profileDoc?.content).toContain("no-mail");

    const packageJson = readFileSync(join(process.cwd(), "package.json"), "utf8");
    expect(packageJson).not.toMatch(/nodemailer|smtp|sendmail|mailgun/i);
  });

  it("documents the drill record format without credential material", () => {
    const breakGlass = readDocs().find((doc) => doc.file === "break-glass.md");
    for (const field of ["date_utc", "custodian_roles", "result", "session_id", "corrective_action"]) {
      expect(breakGlass?.content).toContain(field);
    }
  });
});
