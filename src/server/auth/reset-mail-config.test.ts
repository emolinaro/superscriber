import { describe, expect, it } from "vitest";
import { loadResetMailConfig } from "@/server/auth/reset-mail-config";

const SMTP_ENV = {
  SUPERSCRIBER_RESET_MAIL_MODE: "smtp",
  SUPERSCRIBER_RESET_MAIL_SMTP_HOST: "mail.example.test",
  SUPERSCRIBER_RESET_MAIL_SMTP_PORT: "587",
  SUPERSCRIBER_RESET_MAIL_FROM_ADDRESS: "reset@example.test",
  SUPERSCRIBER_RESET_MAIL_PASSWORD_FILE: "/run/secrets/reset-mail-password",
};

describe("loadResetMailConfig", () => {
  it("defaults to none when the mode is unset or none", () => {
    expect(loadResetMailConfig({})).toEqual({ mode: "none" });
    expect(loadResetMailConfig({ SUPERSCRIBER_RESET_MAIL_MODE: "none" })).toEqual({
      mode: "none",
    });
  });

  it("loads a complete smtp configuration", () => {
    expect(loadResetMailConfig(SMTP_ENV)).toEqual({
      mode: "smtp",
      host: "mail.example.test",
      port: 587,
      fromAddress: "reset@example.test",
      username: null,
      passwordFile: "/run/secrets/reset-mail-password",
      baseUrl: null,
    });
  });

  it("loads optional username and base url", () => {
    expect(
      loadResetMailConfig({
        ...SMTP_ENV,
        SUPERSCRIBER_RESET_MAIL_USERNAME: "mailer",
        SUPERSCRIBER_RESET_MAIL_BASE_URL: "https://app.example",
      }),
    ).toMatchObject({ username: "mailer", baseUrl: "https://app.example" });
  });

  it("rejects unknown modes and malformed smtp configurations", () => {
    expect(() =>
      loadResetMailConfig({ SUPERSCRIBER_RESET_MAIL_MODE: "sendgrid" }),
    ).toThrow(/supports only/);
    expect(() =>
      loadResetMailConfig({ ...SMTP_ENV, SUPERSCRIBER_RESET_MAIL_SMTP_PORT: "not-a-port" }),
    ).toThrow(/SMTP_PORT/);
    const missingHost: Record<string, string | undefined> = { ...SMTP_ENV };
    delete missingHost.SUPERSCRIBER_RESET_MAIL_SMTP_HOST;
    expect(() => loadResetMailConfig(missingHost)).toThrow(/requires/);
  });
});
