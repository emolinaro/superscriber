import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { adminUser, bootstrapAndLogin, logout } from "./support/appliance";

async function attachPageShot(testInfo: TestInfo, name: string, page: Page) {
  const body = await page.screenshot({ fullPage: false });
  await testInfo.attach(name, { body, contentType: "image/png" });
}

async function expectNoHorizontalOverflow(page: Page) {
  const widths = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(widths.scrollWidth).toBe(widths.clientWidth);
}

test.describe.serial("auth surface branding", () => {
  test("the sign-in hero carries the Superscriber wordmark at desktop and phone widths", async ({
    page,
  }, testInfo) => {
    await bootstrapAndLogin(page, adminUser);
    await logout(page);

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
    await attachPageShot(testInfo, "auth-branding-desktop", page);

    const brand = page.locator(".auth-hero__brand .superscriber-logo");
    await expect(brand).toBeVisible();
    await expect(brand).toHaveClass(/superscriber-logo-inverse superscriber-logo-lg/);
    await expect(brand.locator(".superscriber-logo-name")).toHaveAttribute(
      "aria-label",
      "Superscriber",
    );
    await expect(brand.locator(".superscriber-logo-mark")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    // The descriptor lives on the inverse tone over the deep-teal hero,
    // where its contrast passes WCAG AA (on the paper card it did not).
    await expect(brand.locator(".superscriber-logo-descriptor")).toBeVisible();

    // Branding must not disturb the existing surface behavior.
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();

    // The wordmark leads the hero, above the headline.
    const order = await page.evaluate(() => {
      const logo = document.querySelector(".auth-hero__brand .superscriber-logo");
      const heading = document.querySelector(".auth-hero__headline");
      if (!logo || !heading) return "missing";
      return logo.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING
        ? "logo-first"
        : "heading-first";
    });
    expect(order).toBe("logo-first");
    await expectNoHorizontalOverflow(page);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => document.fonts.ready);
    await attachPageShot(testInfo, "auth-branding-phone", page);
    await expect(brand).toBeVisible();
    const nameBox = await brand.locator(".superscriber-logo-name").boundingBox();
    const markBox = await brand.locator(".superscriber-logo-mark").boundingBox();
    expect(nameBox).not.toBeNull();
    expect(markBox).not.toBeNull();
    // The lockup stays on one line at phone width (the lg variant
    // top-aligns mark and wordmark under 760px instead of centers).
    expect(Math.abs(nameBox!.y - markBox!.y)).toBeLessThan(4);
    expect(nameBox!.x).toBeGreaterThan(markBox!.x + markBox!.width);
    await expectNoHorizontalOverflow(page);
  });
});
