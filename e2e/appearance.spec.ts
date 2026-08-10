import AxeBuilder from "@axe-core/playwright";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import {
  expect,
  test,
  type Locator,
  type Page,
  type TestInfo,
} from "@playwright/test";
import { adminUser, bootstrapAndLogin } from "./support/appliance";

// Four rendering states the appearance system must keep at WCAG AA:
// explicit Light, explicit Dark, System on a light OS, System on a dark OS.
// Explicit choices run against the OPPOSITE OS setting to prove the explicit
// contract wins over the media query in both directions.
const STATES = [
  { name: "explicit-light", stored: "light", os: "dark" },
  { name: "explicit-dark", stored: "dark", os: "light" },
  { name: "system-light-os", stored: null, os: "light" },
  { name: "system-dark-os", stored: null, os: "dark" },
] as const;

const VIEWPORTS = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "phone", width: 390, height: 844 },
] as const;

const DARK_BONE = "#131918";
const LIGHT_BONE = "#f7f3ea";

async function evidenceScreenshot(
  page: Page,
  testInfo: TestInfo,
  name: string,
) {
  const dir = process.env.APPEARANCE_EVIDENCE_DIR?.trim();
  const path = dir ? join(dir, `${name}.png`) : undefined;
  if (dir) await mkdir(dir, { recursive: true });
  const body = await page.screenshot({ path, fullPage: true });
  await testInfo.attach(name, { body, contentType: "image/png" });
}

type Rgba = { r: number; g: number; b: number; a: number };

function channelToLinear(value: number) {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function luminance({ r, g, b }: Rgba) {
  return (
    0.2126 * channelToLinear(r) +
    0.7152 * channelToLinear(g) +
    0.0722 * channelToLinear(b)
  );
}

function contrastRatio(a: Rgba, b: Rgba) {
  const l1 = luminance(a);
  const l2 = luminance(b);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

function clamp255(value: number) {
  return Math.min(255, Math.max(0, value));
}

function parseColor(input: string): Rgba {
  const trimmed = input.trim();

  // Legacy comma form: rgb(r, g, b) / rgba(r, g, b, a)
  const comma = trimmed.match(
    /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/,
  );
  if (comma) {
    return {
      r: Number(comma[1]),
      g: Number(comma[2]),
      b: Number(comma[3]),
      a: comma[4] === undefined ? 1 : Number(comma[4]),
    };
  }

  // Modern space form: rgb(r g b / a)
  const space = trimmed.match(
    /^rgba?\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*(?:\/\s*([\d.]+)%?\s*)?\)$/,
  );
  if (space) {
    return {
      r: Number(space[1]),
      g: Number(space[2]),
      b: Number(space[3]),
      a: space[4] === undefined ? 1 : Number(space[4]),
    };
  }

  // Resolved color-mix fills: color(srgb r g b / a) with 0-1 floats.
  const srgb = trimmed.match(
    /^color\(\s*srgb\s+(-?[\d.eE]+)\s+(-?[\d.eE]+)\s+(-?[\d.eE]+)\s*(?:\/\s*([\d.eE]+)%?\s*)?\)$/,
  );
  if (srgb) {
    return {
      r: clamp255(Math.round(Number(srgb[1]) * 255)),
      g: clamp255(Math.round(Number(srgb[2]) * 255)),
      b: clamp255(Math.round(Number(srgb[3]) * 255)),
      a: srgb[4] === undefined ? 1 : Number(srgb[4]),
    };
  }

  throw new Error(`unparsed color: ${input}`);
}

function compositeOver(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (top.r * top.a + bottom.r * bottom.a * (1 - top.a)) / a,
    g: (top.g * top.a + bottom.g * bottom.a * (1 - top.a)) / a,
    b: (top.b * top.a + bottom.b * bottom.a * (1 - top.a)) / a,
    a,
  };
}

function effectiveColorsInPage(target: HTMLElement) {
  const fg = getComputedStyle(target).color;
  const layers: string[] = [];
  let node: HTMLElement | null = target;
  while (node) {
    const value = getComputedStyle(node).backgroundColor;
    if (value && parseFloat(value.split(",").pop() ?? "1") !== 0) {
      layers.push(value);
    }
    node = node.parentElement;
  }
  layers.push("rgb(255,255,255)"); // the canvas base
  return { fg, layers };
}

// WCAG contrast ratio of the locator's text color against the effective
// background it sits on (ancestor fills composited, translucency honored).
async function measuredContrast(locator: Locator) {
  const data = await locator.evaluate(
    effectiveColorsInPage as (el: HTMLElement) => { fg: string; layers: string[] },
  );
  let effective: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  for (let i = data.layers.length - 1; i >= 0; i -= 1) {
    effective = compositeOver(parseColor(data.layers[i]!), effective);
  }
  return {
    ratio: contrastRatio(parseColor(data.fg), effective),
    fg: data.fg,
    background: data.layers.join(" over "),
  };
}

async function expectContrast(
  locator: Locator,
  label: string,
  minimum = 4.5,
) {
  await expect(locator, label).toBeVisible();
  const result = await measuredContrast(locator);
  expect(
    result.ratio,
    `${label}: text ${result.fg} on ${result.background}`,
  ).toBeGreaterThanOrEqual(minimum);
}

async function applyState(
  page: Page,
  state: (typeof STATES)[number],
  viewport: (typeof VIEWPORTS)[number],
) {
  // Pin the server copy to the state being rendered: the hook re-POSTs a
  // divergent local choice, so leftover explicit picks from an earlier state
  // would otherwise flip a system state to the wrong rendering.
  const reset = await page.request.post("/api/preferences/theme", {
    data: { themePreference: state.stored ?? "system" },
  });
  expect(reset.ok(), `server theme reset for ${state.name}`).toBe(true);
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.emulateMedia({ colorScheme: state.os });
  await page.evaluate((stored) => {
    if (stored === null) {
      window.localStorage.removeItem("superscriber.theme");
    } else {
      window.localStorage.setItem("superscriber.theme", stored);
    }
  }, state.stored);
  await page.reload();
  await page.waitForLoadState("networkidle");
}

async function expectRenderedMode(page: Page, expected: "light" | "dark") {
  await expect
    .poll(async () =>
      page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--color-bone")
          .trim(),
      ),
    )
    .toBe(expected === "dark" ? DARK_BONE : LIGHT_BONE);
}

test.describe.serial("appearance system", () => {
  test("keeps WCAG AA contrast on the sign-in surface in all four states", async ({
    browser,
  }, testInfo) => {
    test.slow();
    test.setTimeout(240_000);

    for (const state of STATES) {
      for (const viewport of VIEWPORTS) {
        const context = await browser.newContext({
          viewport: { width: viewport.width, height: viewport.height },
          colorScheme: state.os,
        });
        // Pre-paint state: this mirrors the boot copy the layout inline
        // script reads on a real device.
        if (state.stored) {
          await context.addInitScript((value) => {
            window.localStorage.setItem("superscriber.theme", value);
          }, state.stored);
        }
        const page = await context.newPage();
        await page.goto("/");
        await page.waitForLoadState("networkidle");
        await page.evaluate(() => document.fonts.ready);

        const dark = (state.stored ?? state.os) === "dark";

        // The boot script must resolve the exact rendering contract.
        await expect
          .poll(async () =>
            page.evaluate(() =>
              document.documentElement.getAttribute("data-theme"),
            ),
          )
          .toBe(state.stored);
        await expectRenderedMode(page, dark ? "dark" : "light");

        // axe color-contrast gate for this state.
        const results = await new AxeBuilder({ page })
          .withRules(["color-contrast"])
          .analyze();
        expect(
          results.violations,
          `${state.name} ${viewport.name} axe color-contrast`,
        ).toEqual([]);

        // Named regression pair: the white-on-teal primary action must ride
        // the on-primary role so dark's pale teal never strands white text.
        await expectContrast(
          page.locator(".button-primary").first(),
          `${state.name} ${viewport.name} primary action`,
        );

        await evidenceScreenshot(
          page,
          testInfo,
          `sign-in-${state.name}-${viewport.name}`,
        );
        await context.close();
      }
    }
  });

  test("persists the chosen appearance across reloads and devices", async ({
    page,
  }) => {
    await bootstrapAndLogin(page, adminUser);

    // Fresh device: no local copy, server says system.
    expect(
      await page.evaluate(() =>
        window.localStorage.getItem("superscriber.theme"),
      ),
    ).toBeNull();

    await page.getByRole("button", { name: "Open account menu" }).click();
    await expect(page.getByRole("radio", { name: "System" })).toBeChecked();

    const persisted = page.waitForRequest(
      (request) =>
        request.url().includes("/api/preferences/theme") &&
        request.method() === "POST",
    );
    await page.getByRole("radio", { name: "Dark" }).click();
    const request = await persisted;
    expect(request.postDataJSON()).toEqual({ themePreference: "dark" });
    await expect(page.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(
      await page.evaluate(() =>
        document.documentElement.getAttribute("data-theme"),
      ),
    ).toBe("dark");
    expect(
      await page.evaluate(() =>
        window.localStorage.getItem("superscriber.theme"),
      ),
    ).toBe("dark");

    // Reload: the boot copy applies dark before first paint.
    await page.reload();
    await expectRenderedMode(page, "dark");

    // New device: the local copy is gone; the server copy re-seeds it.
    await page.evaluate(() =>
      window.localStorage.removeItem("superscriber.theme"),
    );
    await page.reload();
    await expectRenderedMode(page, "dark");
    expect(
      await page.evaluate(() =>
        window.localStorage.getItem("superscriber.theme"),
      ),
    ).toBe("dark");

    // Back to System: the explicit attribute is removed and the OS decides.
    await page.getByRole("button", { name: "Open account menu" }).click();
    await page.getByRole("radio", { name: "System" }).click();
    await expect
      .poll(async () =>
        page.evaluate(() =>
          document.documentElement.hasAttribute("data-theme"),
        ),
      )
      .toBe(false);
    await page.emulateMedia({ colorScheme: "dark" });
    await expectRenderedMode(page, "dark");
    await page.emulateMedia({ colorScheme: "light" });
    await expectRenderedMode(page, "light");
  });

  test("keeps shell, inbox, and ingest surfaces at WCAG AA across modes and viewports", async ({
    page,
  }, testInfo) => {
    test.slow();
    test.setTimeout(300_000);
    await bootstrapAndLogin(page, adminUser);

    for (const state of STATES) {
      for (const viewport of VIEWPORTS) {
        await applyState(page, state, viewport);
        for (const route of ["/workspace", "/ingest"]) {
          await page.goto(route);
          await page.waitForLoadState("networkidle");

          const results = await new AxeBuilder({ page })
            .withRules(["color-contrast"])
            .analyze();
          expect(
            results.violations,
            `${state.name} ${viewport.name} ${route} axe color-contrast`,
          ).toEqual([]);

          // Named regression: the wordmark ink on dark bone was 1.02:1.
          await expectContrast(
            page.locator(".app-shell .superscriber-logo-name-core"),
            `${state.name} ${viewport.name} ${route} wordmark core`,
          );
          await expectContrast(
            page.locator(".app-shell .superscriber-logo-name-prefix"),
            `${state.name} ${viewport.name} ${route} wordmark prefix`,
          );

          if (route === "/ingest") {
            // The 1.31:1 source-card regression pair.
            const cards = page.locator(".ingest-source-option");
            await expect(cards.first()).toBeVisible();
            const count = await cards.count();
            for (let i = 0; i < count; i += 1) {
              const card = cards.nth(i);
              const title = (await card.locator("span").first().textContent())
                ?.trim()
                .slice(0, 24);
              await expectContrast(
                card,
                `${state.name} ${viewport.name} ingest card "${title}"`,
                // Cards hold their own radio input; the visible text is the
                // label copy, so measure the text node carrier.
              );
              const detail = card.locator("small");
              if ((await detail.count()) > 0) {
                await expectContrast(
                  detail.first(),
                  `${state.name} ${viewport.name} ingest card "${title}" detail`,
                );
              }
            }
          }

          await evidenceScreenshot(
            page,
            testInfo,
            `${route.replace("/", "") || "workspace"}-${state.name}-${viewport.name}`,
          );
        }
      }
    }
  });
});
