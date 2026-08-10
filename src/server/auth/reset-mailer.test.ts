import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("nodemailer", () => ({
  createTransport: vi.fn(() => ({ sendMail: vi.fn(async () => ({})) })),
}));

import { createTransport } from "nodemailer";
import { buildResetMailMessage, sendPasswordResetEmail } from "@/server/auth/reset-mailer";

const PASSWORD_FILE = join(tmpdir(), "reset-mail-password-test");

const CONFIG = {
  mode: "smtp" as const,
  host: "mail.example.test",
  port: 587,
  fromAddress: "reset@example.test",
  username: "mailer",
  passwordFile: PASSWORD_FILE,
  baseUrl: null,
};

beforeAll(() => {
  writeFileSync(PASSWORD_FILE, "pw\n");
});

describe("reset mailer", () => {
  it("builds the single transactional template with link and expiry only", () => {
    const message = buildResetMailMessage({
      resetUrl: "https://app.example/reset/abc",
      expiresAtIso: "2026-08-10T13:00:00.000Z",
    });
    expect(message.subject).toBe("Superscriber password reset");
    expect(message.text).toContain("https://app.example/reset/abc");
    expect(message.text).toContain("2026-08-10T13:00:00.000Z");
    expect(message.text).toContain("contact your administrator");
  });

  it("sends through smtp without implicit TLS for submission ports", async () => {
    const sendMail = vi.fn(async () => ({}));
    vi.mocked(createTransport).mockReturnValueOnce({ sendMail } as never);

    await sendPasswordResetEmail(CONFIG, {
      to: "user@example.test",
      resetUrl: "https://app.example/reset/abc",
      expiresAtIso: "2026-08-10T13:00:00.000Z",
    });

    expect(createTransport).toHaveBeenCalledWith(
      expect.objectContaining({ host: "mail.example.test", port: 587, secure: false }),
    );
    expect(sendMail).toHaveBeenCalledWith(
      expect.objectContaining({ from: "reset@example.test", to: "user@example.test" }),
    );
    const sent = (sendMail.mock.calls as unknown as Array<[{ text: string }]>)[0]![0];
    expect(sent.text).toContain("https://app.example/reset/abc");
  });

  it("uses implicit TLS on port 465", async () => {
    const sendMail = vi.fn(async () => ({}));
    vi.mocked(createTransport).mockReturnValueOnce({ sendMail } as never);

    await sendPasswordResetEmail(
      { ...CONFIG, port: 465 },
      { to: "user@example.test", resetUrl: "https://app.example/reset/abc", expiresAtIso: "x" },
    );

    expect(createTransport).toHaveBeenCalledWith(expect.objectContaining({ secure: true }));
  });
});
