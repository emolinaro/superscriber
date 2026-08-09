import { expect, test, type Page } from "@playwright/test";
import { adminUser, bootstrapAndLogin } from "./support/appliance";

async function waitForLocalFonts(page: Page) {
  await page.evaluate(() => document.fonts.ready);
  await expect
    .poll(() =>
      page.evaluate(() =>
        document.fonts.check('23.5px "Newsreader Variable"'),
      ),
    )
    .toBe(true);
}

async function authenticateWithoutVisitingWorkspace(page: Page) {
  const csrfResponse = await page.request.get("/api/auth/csrf");
  expect(csrfResponse.ok()).toBeTruthy();
  const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };
  const signInResponse = await page.request.post(
    "/api/auth/callback/credentials?json=true",
    {
      form: {
        csrfToken,
        email: adminUser.email,
        password: adminUser.password,
        callbackUrl: `${process.env.PLAYWRIGHT_BASE_URL || "http://localhost:3105"}/ingest`,
        json: "true",
      },
    },
  );
  expect(signInResponse.status()).toBeLessThan(400);
}

test.describe.serial("Superscriber editorial single-voice wordmark", () => {
  test("locks typography, geometry, colors, local loading, semantics, and responsive reflow", async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => {
      const brandShifts: number[] = [];
      const observer = new PerformanceObserver((list) => {
        for (const item of list.getEntries()) {
          const entry = item as PerformanceEntry & {
            hadRecentInput: boolean;
            sources?: Array<{ node?: Node }>;
            value: number;
          };
          const touchedBrand = entry.sources?.some(({ node }) =>
            node instanceof Element
              ? Boolean(node.closest(".app-shell__brand"))
              : false,
          );
          if (!entry.hadRecentInput && touchedBrand) brandShifts.push(entry.value);
        }
      });
      observer.observe({ type: "layout-shift", buffered: true });
      Object.defineProperty(window, "__superscriberBrandShifts", {
        value: brandShifts,
      });
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await bootstrapAndLogin(page, adminUser);
    await waitForLocalFonts(page);

    const brand = page.locator(".app-shell__brand");
    const logo = brand.locator(".superscriber-logo");
    const mark = logo.locator(".superscriber-logo-mark");
    const name = logo.locator(".superscriber-logo-name");
    const prefix = logo.locator(".superscriber-logo-name-prefix");
    const core = logo.locator(".superscriber-logo-name-core");
    const header = page.locator(".app-shell__header");

    await testInfo.attach("wordmark-desktop", {
      body: await header.screenshot(),
      contentType: "image/png",
    });

    await expect(brand).toHaveAttribute("href", "/workspace");
    await expect(brand).toHaveAccessibleName("Superscriber");
    await expect(name).toHaveAttribute("aria-label", "Superscriber");
    await expect(prefix).toHaveText("Super");
    await expect(core).toHaveText("scriber");
    await expect(mark).toHaveAttribute("aria-hidden", "true");

    const computed = await logo.evaluate((element) => {
      const pick = (selector: string) => {
        const node = element.querySelector(selector);
        if (!node) throw new Error(`Missing ${selector}`);
        const style = getComputedStyle(node);
        return {
          color: style.color,
          fill: style.fill,
          fontFamily: style.fontFamily,
          fontSize: style.fontSize,
          fontWeight: style.fontWeight,
          letterSpacing: style.letterSpacing,
          lineHeight: style.lineHeight,
          marginInlineStart: style.marginInlineStart,
          stroke: style.stroke,
          textTransform: style.textTransform,
          whiteSpace: style.whiteSpace,
        };
      };
      return {
        prefix: pick(".superscriber-logo-name-prefix"),
        core: pick(".superscriber-logo-name-core"),
        backing: pick(".superscriber-logo-mark-backing"),
        primary: pick(".superscriber-logo-ribbon-primary"),
        secondary: pick(".superscriber-logo-ribbon-secondary"),
        foldRight: pick(".superscriber-logo-fold-right"),
        foldLeft: pick(".superscriber-logo-fold-left"),
      };
    });

    expect(computed.prefix).toMatchObject({
      color: "rgba(20, 36, 33, 0.62)",
      fontFamily: '"Newsreader Variable", serif',
      fontSize: "23.5px",
      fontWeight: "360",
      textTransform: "none",
      whiteSpace: "nowrap",
    });
    expect(computed.core).toMatchObject({
      color: "rgb(17, 42, 40)",
      fontFamily: '"Newsreader Variable", serif',
      fontSize: "23.5px",
      fontWeight: "650",
    });
    expect(parseFloat(computed.prefix.letterSpacing)).toBeCloseTo(-0.8225, 3);
    expect(parseFloat(computed.core.letterSpacing)).toBeCloseTo(-0.8225, 3);
    expect(parseFloat(computed.core.marginInlineStart)).toBeCloseTo(-0.705, 3);
    expect(computed.backing).toMatchObject({
      fill: "rgba(255, 252, 246, 0.74)",
      stroke: "rgba(20, 36, 33, 0.08)",
    });
    expect(computed.primary.fill).toBe("rgb(23, 59, 56)");
    expect(computed.secondary.fill).toBe("rgb(40, 84, 79)");
    expect(computed.foldRight.fill).toBe("rgb(211, 107, 62)");
    expect(computed.foldLeft.fill).toBe("rgb(184, 92, 55)");

    const desktopGeometry = await page.evaluate(() => {
      const rect = (selector: string) => {
        const node = document.querySelector(selector);
        if (!node) throw new Error(`Missing ${selector}`);
        const box = node.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      };
      return {
        clientWidth: document.documentElement.clientWidth,
        scrollWidth: document.documentElement.scrollWidth,
        header: rect(".app-shell__header"),
        lockup: rect(".superscriber-logo-lockup"),
        mark: rect(".superscriber-logo-mark"),
        name: rect(".superscriber-logo-name"),
      };
    });

    expect(desktopGeometry.scrollWidth).toBe(desktopGeometry.clientWidth);
    expect(desktopGeometry.header.height).toBe(65);
    expect(desktopGeometry.mark).toMatchObject({ width: 48, height: 48 });
    expect(desktopGeometry.lockup.height).toBe(48);
    expect(desktopGeometry.name.height).toBeCloseTo(22.078, 2);

    const shellColors = await page.evaluate(() => {
      const headerStyle = getComputedStyle(document.querySelector(".app-shell__header")!);
      const linkStyle = getComputedStyle(document.querySelector(".app-shell__brand")!);
      return {
        bodyBackground: getComputedStyle(document.body).backgroundColor,
        bodyColor: getComputedStyle(document.body).color,
        headerBackground: headerStyle.backgroundColor,
        headerBorder: headerStyle.borderBottomColor,
        linkColor: linkStyle.color,
        focusToken: getComputedStyle(document.documentElement)
          .getPropertyValue("--color-focus")
          .trim(),
      };
    });
    expect(shellColors).toEqual({
      bodyBackground: "rgb(247, 243, 234)",
      bodyColor: "rgb(23, 36, 33)",
      headerBackground: "rgba(255, 252, 246, 0.96)",
      headerBorder: "rgb(216, 216, 207)",
      linkColor: "rgb(22, 61, 56)",
      focusToken: "#0b6f64",
    });

    const toneColors = await logo.evaluate((element) => {
      const probe = element.cloneNode(true) as HTMLElement;
      const descriptor = document.createElement("p");
      descriptor.className = "superscriber-logo-descriptor";
      descriptor.textContent = "Governed transcription appliance";
      probe.querySelector(".superscriber-logo-wordmark")?.append(descriptor);
      probe.style.position = "fixed";
      probe.style.left = "-10000px";
      document.body.append(probe);
      const style = (selector: string) =>
        getComputedStyle(probe.querySelector(selector) as Element);
      const lightDescriptor = style(".superscriber-logo-descriptor").color;
      probe.classList.remove("superscriber-logo-light");
      probe.classList.add("superscriber-logo-inverse");
      const inverse = {
        backing: style(".superscriber-logo-mark-backing").fill,
        backingLine: style(".superscriber-logo-mark-backing").stroke,
        primary: style(".superscriber-logo-ribbon-primary").fill,
        secondary: style(".superscriber-logo-ribbon-secondary").fill,
        foldRight: style(".superscriber-logo-fold-right").fill,
        foldLeft: style(".superscriber-logo-fold-left").fill,
        prefix: style(".superscriber-logo-name-prefix").color,
        core: style(".superscriber-logo-name-core").color,
        descriptor: style(".superscriber-logo-descriptor").color,
      };
      probe.remove();
      return { lightDescriptor, inverse };
    });
    expect(toneColors.lightDescriptor).toBe("rgba(20, 36, 33, 0.56)");
    expect(toneColors.inverse).toEqual({
      backing: "rgba(255, 250, 243, 0.08)",
      backingLine: "rgba(255, 255, 255, 0.1)",
      primary: "rgb(242, 247, 243)",
      secondary: "rgb(215, 231, 222)",
      foldRight: "rgb(223, 135, 92)",
      foldLeft: "rgb(201, 109, 74)",
      prefix: "rgba(238, 246, 242, 0.72)",
      core: "rgb(246, 251, 248)",
      descriptor: "rgba(238, 246, 242, 0.64)",
    });

    await brand.focus();
    await expect(brand).toBeFocused();
    expect(
      await brand.evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          color: style.outlineColor,
          offset: style.outlineOffset,
          style: style.outlineStyle,
          width: style.outlineWidth,
        };
      }),
    ).toEqual({ color: "rgb(11, 111, 100)", offset: "2px", style: "solid", width: "2px" });

    const network = await page.evaluate(() => ({
      externalFonts: performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((url) => /\.(woff2?|ttf|otf)(\?|$)/.test(url))
        .filter((url) => new URL(url).origin !== location.origin),
      newsreaderLoaded: document.fonts.check('23.5px "Newsreader Variable"'),
    }));
    expect(network).toEqual({ externalFonts: [], newsreaderLoaded: true });

    await page.setViewportSize({ width: 390, height: 844 });
    await waitForLocalFonts(page);
    await testInfo.attach("wordmark-narrow", {
      body: await page.locator(".app-shell__header").screenshot(),
      contentType: "image/png",
    });
    const narrow = await page.evaluate(() => ({
      clientWidth: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth,
      headerHeight: document.querySelector(".app-shell__header")!.getBoundingClientRect().height,
      lockup: document.querySelector(".superscriber-logo-lockup")!.getBoundingClientRect().toJSON(),
    }));
    expect(narrow.scrollWidth).toBe(narrow.clientWidth);
    expect(narrow.headerHeight).toBe(193);
    expect(narrow.lockup.x).toBe(16);
    expect(narrow.lockup.height).toBe(48);

    await page.setViewportSize({ width: 1024, height: 900 });
    await page.addStyleTag({ content: "html { zoom: 2; }" });
    const zoom = await page.evaluate(() => {
      const root = document.documentElement;
      const brandRect = document.querySelector(".app-shell__brand")!.getBoundingClientRect();
      const nameRect = document.querySelector(".superscriber-logo-name")!.getBoundingClientRect();
      const markRect = document.querySelector(".superscriber-logo-mark")!.getBoundingClientRect();
      return {
        clientWidth: root.clientWidth,
        brandLeft: brandRect.left,
        brandRight: brandRect.right,
        nameRight: nameRect.right,
        markBottom: markRect.bottom,
        nameBottom: nameRect.bottom,
        oneLine: Math.abs(markRect.top - nameRect.top) < 100,
      };
    });
    expect(zoom.brandLeft).toBeGreaterThanOrEqual(0);
    expect(zoom.brandRight).toBeLessThanOrEqual(zoom.clientWidth);
    expect(zoom.nameRight).toBeLessThanOrEqual(zoom.clientWidth);
    expect(zoom.oneLine).toBe(true);

    const shifts = await page.evaluate(
      () =>
        (window as Window & { __superscriberBrandShifts?: number[] })
          .__superscriberBrandShifts ?? [],
    );
    expect(shifts).toEqual([]);
  });

  test("keeps unvisited and visited link rendering distinct under the locked CSS rules", async ({
    browser,
  }, testInfo) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await authenticateWithoutVisitingWorkspace(page);
    await page.goto("/ingest");
    await waitForLocalFonts(page);

    const brand = page.locator(".app-shell__brand");
    const unvisited = await brand.screenshot();
    await testInfo.attach("wordmark-unvisited", {
      body: unvisited,
      contentType: "image/png",
    });

    const anchorRules = await page.evaluate(() =>
      [...document.styleSheets].flatMap((sheet) => {
        try {
          return [...sheet.cssRules]
            .filter((rule): rule is CSSStyleRule => rule instanceof CSSStyleRule)
            .filter((rule) => rule.selectorText === "a" || rule.selectorText === "a:visited")
            .map((rule) => ({ selector: rule.selectorText, color: rule.style.color }));
        } catch {
          return [];
        }
      }),
    );
    expect(anchorRules).toEqual(
      expect.arrayContaining([
        { selector: "a", color: "var(--color-teal-700)" },
        { selector: "a:visited", color: "var(--color-rust-600)" },
      ]),
    );

    await brand.click();
    await expect(page).toHaveURL(/\/workspace$/);
    await waitForLocalFonts(page);
    // Chromium's visited-link partitioning applies :visited only when the link
    // URL equals the current top-level URL, so the brand renders the rust
    // visited color on /workspace itself (matching the captain reference crop).
    const visited = await page.locator(".app-shell__brand").screenshot();
    await testInfo.attach("wordmark-visited", {
      body: visited,
      contentType: "image/png",
    });

    expect(unvisited.equals(visited)).toBe(false);
    await context.close();
  });
});
