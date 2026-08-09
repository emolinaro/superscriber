# Superscriber Editorial Single Voice Wordmark Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the captain-approved Direction B Superscriber wordmark as one locally loaded Newsreader voice while restoring the missing tracked logo stylesheet and preserving every existing color, mark, shell, accessibility, and responsive invariant.

**Architecture:** Add one focused brand stylesheet between the base and shell layers, leaving the logo and app-shell components unchanged. Lock its typography, geometry, color variables, markup contract, and browser behavior with focused Vitest and Playwright tests, then collect before/after evidence from an isolated clean container build before making one implementation commit.

**Tech Stack:** Next.js 16, React 19, CSS, local Fontsource Newsreader Variable 5.3.0, Vitest, Testing Library, Playwright, Docker appliance E2E, chrome-devtools-axi.

## Global Constraints

- The approved direction is **B - Editorial single voice**, with no additional notes. Do not reopen visual exploration or mix in Direction A or C.
- The whole visible name uses `var(--font-display)` / `"Newsreader Variable", serif` at one optical height. `Super` is sentence case at weight `360`; `scriber` stays lowercase at weight `650`.
- Small typography is exactly `23.5px`, `-0.035em` tracking, `-0.03em` inter-span spacing, and `0.94` line-height. Medium is `32px` / `-0.035em`; large is `52px` / `-0.04em`; large at the historical `760px` narrow breakpoint is `35.2px` for both spans.
- CSS `gap` cannot represent a negative value. Implement the approved `-0.03em` inter-span spacing as `margin-inline-start: -0.03em` on `.superscriber-logo-name-core`, with zero flex gap.
- Keep the small, medium, and large SVG marks exactly `48px`, `62px`, and `84px`; keep the small/default mark-to-wordmark gaps exactly `12px` and `14px`.
- Keep `src/components/brand/superscriber-logo.tsx` and `src/components/shell/app-shell.tsx` unchanged, including the SVG, `aria-hidden="true"`, `aria-label="Superscriber"`, visible span text, `/workspace` link, class hooks, and header placement.
- Keep product/header colors exactly: `#f7f3ea`, `#fffcf6`, `#172421`, `#163d38`, `#a64b2a`, `#0b6f64`, `rgba(255, 252, 246, 0.96)`, and `#d8d8cf`.
- Keep light logo colors exactly: `rgba(255, 252, 246, 0.74)`, `rgba(20, 36, 33, 0.08)`, `#173b38`, `#28544f`, `#d36b3e`, `#b85c37`, `rgba(20, 36, 33, 0.62)`, `#112a28`, and `rgba(20, 36, 33, 0.56)`.
- Keep inverse logo colors exactly: `rgba(255, 250, 243, 0.08)`, `rgba(255, 255, 255, 0.1)`, `#f2f7f3`, `#d7e7de`, `#df875c`, `#c96d4a`, `rgba(238, 246, 242, 0.72)`, `#f6fbf8`, and `rgba(238, 246, 242, 0.64)`.
- Keep global anchor thickness/offset exactly `1px` / `0.18em`, native unvisited/visited behavior, and the existing `2px` focus outline. Do not add a link-state override to the logo.
- Reuse the already bundled OFL-1.1 Newsreader variable font. Do not change `package.json`, `package-lock.json`, `app/layout.tsx`, any `@font-face`, or any network source.
- Preserve the 64px content row, 1px header rule, existing desktop and below-960px shell layouts, page gutters, navigation, account controls, one-line wordmark, and zero page-level overflow.
- Keep account-role and recording-lifecycle work entirely independent. Do not copy from or modify those branches or their files.
- Do not modify generated release metadata, `VERSION`, or `CHANGELOG.md`.
- Capture current end-user behavior first from this task worktree's own clean appliance image. Do not use the shared demo lane.
- Run all relevant focused/full validation and browser evidence before the single implementation commit. Do not merge.

---

## File Map

- Create `src/styles/brand.css`: complete tracked `.superscriber-logo*` light/inverse, geometry, descriptor, size, and Direction B typography contract.
- Modify `app/globals.css`: import `brand.css` after tokens/base and before shell layout.
- Create `src/styles/brand.test.ts`: exact static CSS, local-font, import-order, geometry, typography, and color regression contract.
- Create `src/components/brand/superscriber-logo.test.tsx`: exact split text, accessible label, hidden SVG, tone/size classes, and descriptor regression contract.
- Modify `src/components/shell/app-shell.test.tsx`: assert the brand remains one accessible `/workspace` link around the small logo.
- Create `e2e/wordmark.spec.ts`: computed-style, geometry, responsive, zoom, local-font/network, focus, accessible-name, inverse-probe, and visited/unvisited browser regression coverage.
- Produce ignored evidence under `.tmp/wordmark-evidence/`: baseline/final screenshots and JSON/text browser measurements. Do not commit this directory.

## Interfaces

- `src/styles/brand.css` consumes existing tokens `--font-display`, `--color-rust-600`, and the unchanged component class names.
- `app/globals.css` exposes the brand stylesheet to every application route before shell layout rules are applied.
- `SuperscriberLogo` continues to produce the existing class and DOM interface. No TypeScript signature or component output changes.
- `e2e/wordmark.spec.ts` consumes only existing `adminUser` and `bootstrapAndLogin` exports from `e2e/support/appliance.ts`; it does not add or modify shared helpers.
- The tests produce no runtime interface. They fail if family, weight, casing, tracking, spacing, geometry, overflow, accessible naming, local loading, or any locked color drifts.

---

### Task 1: Capture the clean-build regression and write failing contracts

**Files:**
- Create: `src/styles/brand.test.ts`
- Create: `src/components/brand/superscriber-logo.test.tsx`
- Modify: `src/components/shell/app-shell.test.tsx`
- Create: `e2e/wordmark.spec.ts`
- Evidence only: `.tmp/wordmark-evidence/before-*`

**Interfaces:**
- Consumes: current unchanged `SuperscriberLogo`, `AppShell`, product CSS files, and the existing appliance E2E helpers.
- Produces: failing tests that define the full approved contract before `brand.css` exists.

- [ ] **Step 1: Confirm isolation and preserve the pre-implementation tree**

Run:

```bash
pwd -P
git rev-parse --show-toplevel
git status --short --branch
git diff --exit-code 9f79227 -- \
  src app e2e package.json package-lock.json VERSION CHANGELOG.md
```

Expected: both paths are this disposable task worktree, the branch is `fm/superscriber-wordmark-editorial-single-voice`, and there are no product/test/package/release changes after the approved spec commit.

- [ ] **Step 2: Create the focused static brand contract test**

Create `src/styles/brand.test.ts`:

```ts
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const BRAND_PATH = resolve(REPO_ROOT, "src/styles/brand.css");
const BASE_PATH = resolve(REPO_ROOT, "src/styles/base.css");
const GLOBALS_PATH = resolve(REPO_ROOT, "app/globals.css");

function readBrandCss() {
  expect(existsSync(BRAND_PATH), "tracked brand stylesheet must exist").toBe(true);
  return existsSync(BRAND_PATH) ? readFileSync(BRAND_PATH, "utf8") : "";
}

function compact(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function rule(css: string, selector: string) {
  const start = css.indexOf(`${selector} {`);
  expect(start, `missing rule ${selector}`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf("{", start);
  const close = css.indexOf("}", open);
  expect(close, `unterminated rule ${selector}`).toBeGreaterThan(open);
  return compact(css.slice(open + 1, close));
}

function expectRule(css: string, selector: string, declarations: string[]) {
  const body = rule(css, selector);
  for (const declaration of declarations) {
    expect(body, `${selector} must contain ${declaration}`).toContain(compact(declaration));
  }
}

describe("Superscriber brand stylesheet", () => {
  it("is imported between base tokens and shell layout", () => {
    const imports = readFileSync(GLOBALS_PATH, "utf8")
      .split("\n")
      .filter((line) => line.startsWith("@import"));

    expect(imports.slice(0, 4)).toEqual([
      '@import "../src/styles/tokens.css";',
      '@import "../src/styles/base.css";',
      '@import "../src/styles/brand.css";',
      '@import "../src/styles/shell.css";',
    ]);
  });

  it("locks Direction B family, one-height sizing, weights, casing, and spacing", () => {
    const css = readBrandCss();

    expectRule(css, ".superscriber-logo-name", [
      "display: inline-flex;",
      "align-items: baseline;",
      "gap: 0;",
      "font-family: var(--font-display);",
      "font-size: 32px;",
      "letter-spacing: -0.035em;",
      "line-height: 0.94;",
      "text-transform: none;",
      "white-space: nowrap;",
    ]);
    expectRule(css, ".superscriber-logo-name-prefix", ["font-weight: 360;"]);
    expectRule(css, ".superscriber-logo-name-core", [
      "margin-inline-start: -0.03em;",
      "font-weight: 650;",
    ]);
    expectRule(css, ".superscriber-logo-sm .superscriber-logo-name", [
      "font-size: 23.5px;",
      "letter-spacing: -0.035em;",
    ]);
    expectRule(css, ".superscriber-logo-lg .superscriber-logo-name", [
      "font-size: 52px;",
      "letter-spacing: -0.04em;",
    ]);
    expectRule(css, "@media (max-width: 760px)", []);
    expect(css).toContain(".superscriber-logo-lg .superscriber-logo-name {\n    font-size: 35.2px;");
  });

  it("locks every non-typographic geometry value", () => {
    const css = readBrandCss();

    expectRule(css, ".superscriber-logo", ["display: inline-grid;", "gap: 10px;"]);
    expectRule(css, ".superscriber-logo-lockup", [
      "display: inline-flex;",
      "align-items: center;",
      "gap: 14px;",
    ]);
    expectRule(css, ".superscriber-logo-mark", [
      "width: 62px;",
      "height: 62px;",
      "flex: 0 0 auto;",
      "overflow: visible;",
      "filter: drop-shadow(0 8px 18px rgba(14, 31, 29, 0.12));",
    ]);
    expectRule(css, ".superscriber-logo-sm .superscriber-logo-lockup", ["gap: 12px;"]);
    expectRule(css, ".superscriber-logo-sm .superscriber-logo-mark", [
      "width: 48px;",
      "height: 48px;",
    ]);
    expectRule(css, ".superscriber-logo-md .superscriber-logo-mark", [
      "width: 62px;",
      "height: 62px;",
    ]);
    expectRule(css, ".superscriber-logo-lg .superscriber-logo-mark", [
      "width: 84px;",
      "height: 84px;",
    ]);
    expectRule(css, ".superscriber-logo-wordmark", ["display: grid;", "gap: 4px;"]);
    expect(css).toContain(
      ".superscriber-logo-lg .superscriber-logo-lockup {\n    align-items: flex-start;",
    );
  });

  it("locks every light and inverse logo color", () => {
    const css = readBrandCss();

    expectRule(css, ".superscriber-logo", [
      "--logo-backdrop: rgba(255, 252, 246, 0.74);",
      "--logo-backdrop-line: rgba(20, 36, 33, 0.08);",
      "--logo-primary: #173b38;",
      "--logo-secondary: #28544f;",
      "--logo-fold-right: #d36b3e;",
      "--logo-fold-left: #b85c37;",
      "--logo-prefix: rgba(20, 36, 33, 0.62);",
      "--logo-wordmark: #112a28;",
      "--logo-descriptor: rgba(20, 36, 33, 0.56);",
    ]);
    expectRule(css, ".superscriber-logo-inverse", [
      "--logo-backdrop: rgba(255, 250, 243, 0.08);",
      "--logo-backdrop-line: rgba(255, 255, 255, 0.1);",
      "--logo-primary: #f2f7f3;",
      "--logo-secondary: #d7e7de;",
      "--logo-fold-right: #df875c;",
      "--logo-fold-left: #c96d4a;",
      "--logo-prefix: rgba(238, 246, 242, 0.72);",
      "--logo-wordmark: #f6fbf8;",
      "--logo-descriptor: rgba(238, 246, 242, 0.64);",
    ]);
    expectRule(css, ".superscriber-logo-mark-backing", [
      "fill: var(--logo-backdrop);",
      "stroke: var(--logo-backdrop-line);",
      "stroke-width: 1;",
    ]);
    expectRule(css, ".superscriber-logo-name-prefix", ["color: var(--logo-prefix);"]);
    expectRule(css, ".superscriber-logo-name-core", ["color: var(--logo-wordmark);"]);
    expectRule(css, ".superscriber-logo-descriptor", ["color: var(--logo-descriptor);"]);
  });

  it("keeps native anchor colors, underline, and visited behavior unchanged", () => {
    const base = compact(readFileSync(BASE_PATH, "utf8"));

    expect(base).toContain(
      compact(`a {
        color: var(--color-teal-700);
        text-decoration-thickness: 1px;
        text-underline-offset: 0.18em;
      }`),
    );
    expect(base).toContain(compact(`a:visited { color: var(--color-rust-600); }`));
  });

  it("uses only the existing display token and introduces no font source or URL", () => {
    const css = readBrandCss();

    expect(css).not.toContain("@font-face");
    expect(css).not.toContain("url(");
    expect(css).not.toContain("Public Sans");
    expect(css).not.toContain("IBM Plex");
    expect(css).toContain("font-family: var(--font-display);");
  });
});
```

- [ ] **Step 3: Create the component markup regression test without changing the component**

Create `src/components/brand/superscriber-logo.test.tsx`:

```tsx
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SuperscriberLogo } from "./superscriber-logo";

afterEach(cleanup);

describe("SuperscriberLogo", () => {
  it("keeps one accessible name around the exact split visible word", () => {
    const { container } = render(<SuperscriberLogo size="sm" />);
    const root = container.querySelector(".superscriber-logo");
    const name = container.querySelector(".superscriber-logo-name");
    const prefix = container.querySelector(".superscriber-logo-name-prefix");
    const core = container.querySelector(".superscriber-logo-name-core");
    const mark = container.querySelector("svg.superscriber-logo-mark");

    expect(root).toHaveClass("superscriber-logo-light", "superscriber-logo-sm");
    expect(name).toHaveAttribute("aria-label", "Superscriber");
    expect(name).toHaveTextContent("Superscriber");
    expect(prefix).toHaveTextContent(/^Super$/);
    expect(core).toHaveTextContent(/^scriber$/);
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).toHaveAttribute("viewBox", "0 0 64 64");
  });

  it("keeps inverse, large, custom-class, SVG path, and descriptor hooks", () => {
    const { container } = render(
      <SuperscriberLogo
        className="review-fixture"
        showDescriptor
        size="lg"
        tone="inverse"
      />,
    );

    expect(container.firstElementChild).toHaveClass(
      "superscriber-logo",
      "superscriber-logo-inverse",
      "superscriber-logo-lg",
      "review-fixture",
    );
    expect(container.querySelectorAll("svg path")).toHaveLength(6);
    expect(screen.getByText("Governed transcription appliance")).toHaveClass(
      "superscriber-logo-descriptor",
    );
  });
});
```

- [ ] **Step 4: Extend the shell regression to lock the brand link semantics**

Add this test inside the existing `describe("AppShell", ...)` in `src/components/shell/app-shell.test.tsx`:

```tsx
  it("keeps Superscriber as one accessible workspace link around the small hidden mark", () => {
    const { container } = render(
      <AppShell principal={principal("admin")}>
        <div>Workspace body</div>
      </AppShell>,
    );

    const brand = screen.getByRole("link", { name: "Superscriber" });
    expect(brand).toHaveAttribute("href", "/workspace");
    expect(brand).toHaveClass("app-shell__brand");
    expect(brand.querySelector(".superscriber-logo")).toHaveClass("superscriber-logo-sm");
    expect(container.querySelector("svg.superscriber-logo-mark")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
  });
```

- [ ] **Step 5: Create the end-user browser contract before adding styles**

Create `e2e/wordmark.spec.ts`:

```ts
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
    expect(desktopGeometry.name.height).toBeCloseTo(23.08, 1);

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
      return {
        clientWidth: root.clientWidth,
        scrollWidth: root.scrollWidth,
        brandLeft: brandRect.left,
        brandRight: brandRect.right,
      };
    });
    expect(zoom.scrollWidth).toBe(zoom.clientWidth);
    expect(zoom.brandLeft).toBeGreaterThanOrEqual(0);
    expect(zoom.brandRight).toBeLessThanOrEqual(zoom.clientWidth);

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
    await page.goBack();
    await expect(page).toHaveURL(/\/ingest$/);
    await waitForLocalFonts(page);
    const visited = await page.locator(".app-shell__brand").screenshot();
    await testInfo.attach("wordmark-visited", {
      body: visited,
      contentType: "image/png",
    });

    expect(unvisited.equals(visited)).toBe(false);
    await context.close();
  });
});
```

- [ ] **Step 6: Run the focused unit tests and confirm the intended red state**

Run:

```bash
npx vitest run \
  src/styles/brand.test.ts \
  src/components/brand/superscriber-logo.test.tsx \
  src/components/shell/app-shell.test.tsx
```

Expected: `superscriber-logo.test.tsx` and the shell semantics pass; `brand.test.ts` fails because `src/styles/brand.css` and its import do not exist. This is the required test-first proof, not an implementation failure to bypass.

- [ ] **Step 7: Build and start the isolated pre-change appliance lane**

Run:

```bash
mkdir -p .tmp/wordmark-evidence/data
export SUPERSCRIBER_E2E_IMAGE=superscriber:wordmark-e2e
export SUPERSCRIBER_E2E_CONTAINER_NAME=superscriber-wordmark-e2e
export SUPERSCRIBER_E2E_PORT=3115
export SUPERSCRIBER_E2E_OIDC_PORT=4115
export SUPERSCRIBER_E2E_DATA_DIR="$PWD/.tmp/wordmark-evidence/data"
export PLAYWRIGHT_BASE_URL=http://localhost:3115
bash scripts/run-e2e-appliance.sh build
bash scripts/run-e2e-appliance.sh start
```

Expected: `http://localhost:3115/api/health` answers from the task-specific container. If either configured port is occupied, select another unused pair and use that same pair for every remaining command; do not stop an unrelated server.

- [ ] **Step 8: Run the focused browser test against the clean baseline and retain the failure artifacts**

Run:

```bash
if PLAYWRIGHT_BASE_URL=http://localhost:3115 \
  npx playwright test e2e/wordmark.spec.ts --reporter=list; then
  echo "Baseline unexpectedly passed before the brand stylesheet exists." >&2
  exit 1
else
  cp -R test-results .tmp/wordmark-evidence/before-playwright
fi
```

Expected: the test reaches the authenticated header and fails on missing logo typography/geometry CSS. Its `wordmark-desktop` attachment records the clean-task regression before product changes. The browser must not be the separate shared demo lane.

- [ ] **Step 9: Capture current desktop and narrow behavior with chrome-devtools-axi**

Open `http://localhost:3115`, complete first-run setup with the E2E admin credentials shown in `e2e/support/appliance.ts`, and sign in. Use the live refs returned by each `snapshot` for the named controls.

Run:

```bash
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi open http://localhost:3115
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi snapshot
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi open http://localhost:3115/workspace
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi emulate --viewport "1440x900x1"
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi screenshot .tmp/wordmark-evidence/before-desktop.png
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi eval "() => { const root=document.documentElement; const header=document.querySelector('.app-shell__header')?.getBoundingClientRect(); const logo=document.querySelector('.superscriber-logo')?.getBoundingClientRect(); const prefix=document.querySelector('.superscriber-logo-name-prefix'); const core=document.querySelector('.superscriber-logo-name-core'); return {clientWidth:root.clientWidth,scrollWidth:root.scrollWidth,header,logo,prefix:prefix?getComputedStyle(prefix):null,core:core?getComputedStyle(core):null}; }"
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi emulate --viewport "390x844x3,mobile,touch"
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi screenshot .tmp/wordmark-evidence/before-narrow.png
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi network
```

Save the `eval` result to `.tmp/wordmark-evidence/before-computed.txt` and the network result to `.tmp/wordmark-evidence/before-network.txt`. Expected: the screenshot and computed values expose the tracked-style drift rather than reconstructing or hiding it, and the baseline network list records that Newsreader is already a local application font resource before the wordmark styling changes.

---

### Task 2: Add the minimum tracked brand stylesheet

**Files:**
- Create: `src/styles/brand.css`
- Modify: `app/globals.css`
- Test: the files created in Task 1

**Interfaces:**
- Consumes: existing class hooks and `--font-display` token.
- Produces: complete reproducible light/inverse logo styling and Direction B typography on a clean build.

- [ ] **Step 1: Create the complete focused brand stylesheet**

Create `src/styles/brand.css` exactly as follows:

```css
.superscriber-logo {
  --logo-backdrop: rgba(255, 252, 246, 0.74);
  --logo-backdrop-line: rgba(20, 36, 33, 0.08);
  --logo-primary: #173b38;
  --logo-secondary: #28544f;
  --logo-fold-right: #d36b3e;
  --logo-fold-left: #b85c37;
  --logo-prefix: rgba(20, 36, 33, 0.62);
  --logo-wordmark: #112a28;
  --logo-descriptor: rgba(20, 36, 33, 0.56);
  display: inline-grid;
  gap: 10px;
}

.superscriber-logo-lockup {
  display: inline-flex;
  align-items: center;
  gap: 14px;
}

.superscriber-logo-mark {
  width: 62px;
  height: 62px;
  flex: 0 0 auto;
  overflow: visible;
  filter: drop-shadow(0 8px 18px rgba(14, 31, 29, 0.12));
}

.superscriber-logo-mark-backing {
  fill: var(--logo-backdrop);
  stroke: var(--logo-backdrop-line);
  stroke-width: 1;
}

.superscriber-logo-ribbon-primary {
  fill: var(--logo-primary);
}

.superscriber-logo-ribbon-secondary {
  fill: var(--logo-secondary);
}

.superscriber-logo-fold-right {
  fill: var(--logo-fold-right);
}

.superscriber-logo-fold-left {
  fill: var(--logo-fold-left);
}

.superscriber-logo-wordmark {
  display: grid;
  gap: 4px;
}

.superscriber-logo-name {
  display: inline-flex;
  align-items: baseline;
  gap: 0;
  font-family: var(--font-display);
  font-size: 32px;
  letter-spacing: -0.035em;
  line-height: 0.94;
  text-transform: none;
  white-space: nowrap;
}

.superscriber-logo-name-prefix {
  color: var(--logo-prefix);
  font-weight: 360;
}

.superscriber-logo-name-core {
  margin-inline-start: -0.03em;
  color: var(--logo-wordmark);
  font-weight: 650;
}

.superscriber-logo-descriptor {
  margin: 0;
  color: var(--logo-descriptor);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.18em;
  text-transform: uppercase;
}

.superscriber-logo-sm .superscriber-logo-lockup {
  gap: 12px;
}

.superscriber-logo-sm .superscriber-logo-mark {
  width: 48px;
  height: 48px;
}

.superscriber-logo-sm .superscriber-logo-name {
  font-size: 23.5px;
  letter-spacing: -0.035em;
}

.superscriber-logo-md .superscriber-logo-mark {
  width: 62px;
  height: 62px;
}

.superscriber-logo-lg .superscriber-logo-mark {
  width: 84px;
  height: 84px;
}

.superscriber-logo-lg .superscriber-logo-name {
  font-size: 52px;
  letter-spacing: -0.04em;
}

.superscriber-logo-lg .superscriber-logo-descriptor {
  font-size: 0.76rem;
}

.superscriber-logo-inverse {
  --logo-backdrop: rgba(255, 250, 243, 0.08);
  --logo-backdrop-line: rgba(255, 255, 255, 0.1);
  --logo-primary: #f2f7f3;
  --logo-secondary: #d7e7de;
  --logo-fold-right: #df875c;
  --logo-fold-left: #c96d4a;
  --logo-prefix: rgba(238, 246, 242, 0.72);
  --logo-wordmark: #f6fbf8;
  --logo-descriptor: rgba(238, 246, 242, 0.64);
}

@media (max-width: 760px) {
  .superscriber-logo-lg .superscriber-logo-lockup {
    align-items: flex-start;
  }

  .superscriber-logo-lg .superscriber-logo-name {
    font-size: 35.2px;
  }
}
```

Do not move these values into `tokens.css`: they are the component's established light/inverse contract, and the approved scope calls for one focused brand stylesheet.

- [ ] **Step 2: Import the brand layer without changing any other stylesheet order**

Change the first four lines of `app/globals.css` to:

```css
@import "../src/styles/tokens.css";
@import "../src/styles/base.css";
@import "../src/styles/brand.css";
@import "../src/styles/shell.css";
```

Keep every later import unchanged.

- [ ] **Step 3: Run focused unit/component tests and confirm green**

Run:

```bash
npx vitest run \
  src/styles/brand.test.ts \
  src/styles/styles.test.ts \
  src/components/brand/superscriber-logo.test.tsx \
  src/components/shell/app-shell.test.tsx
```

Expected: all tests pass. If exact CSS assertions disagree with the implementation, reconcile against the approved spec and historical values, never by weakening or deleting assertions.

- [ ] **Step 4: Rebuild the isolated image and run the focused browser suite**

Run:

```bash
export SUPERSCRIBER_E2E_IMAGE=superscriber:wordmark-e2e
export SUPERSCRIBER_E2E_CONTAINER_NAME=superscriber-wordmark-e2e
export SUPERSCRIBER_E2E_PORT=3115
export SUPERSCRIBER_E2E_OIDC_PORT=4115
export SUPERSCRIBER_E2E_DATA_DIR="$PWD/.tmp/wordmark-evidence/data"
export PLAYWRIGHT_BASE_URL=http://localhost:3115
bash scripts/run-e2e-appliance.sh stop
bash scripts/run-e2e-appliance.sh build
bash scripts/run-e2e-appliance.sh start
PLAYWRIGHT_BASE_URL=http://localhost:3115 \
  npx playwright test e2e/wordmark.spec.ts --reporter=list
```

Expected: both wordmark tests pass against a clean product image built from the task worktree. Keep the task-specific container running for Task 3 evidence.

---

### Task 3: Collect final browser evidence from the clean task build

**Files:**
- Evidence only: `.tmp/wordmark-evidence/after-*`
- No product file changes

**Interfaces:**
- Consumes: the rebuilt task-specific container and the exact browser selectors locked by tests.
- Produces: desktop/narrow/zoom screenshots and computed-style/network proof for implementation review.

- [ ] **Step 1: Capture desktop live-header and enlarged inspection evidence**

Use chrome-devtools-axi against `http://localhost:3115/workspace`, not port 3145 or another lane:

```bash
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi open http://localhost:3115/workspace
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi emulate --viewport "1440x900x1"
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi wait 500
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi screenshot .tmp/wordmark-evidence/after-desktop.png
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi eval "async () => { await document.fonts.ready; const root=document.documentElement; const header=document.querySelector('.app-shell__header'); const lockup=document.querySelector('.superscriber-logo-lockup'); const name=document.querySelector('.superscriber-logo-name'); const prefix=document.querySelector('.superscriber-logo-name-prefix'); const core=document.querySelector('.superscriber-logo-name-core'); const mark=document.querySelector('.superscriber-logo-mark'); const style=(node)=>node?getComputedStyle(node):null; return {fontStatus:document.fonts.status,newsreader:document.fonts.check('23.5px \\"Newsreader Variable\\"'),clientWidth:root.clientWidth,scrollWidth:root.scrollWidth,headerRect:header?.getBoundingClientRect(),lockupRect:lockup?.getBoundingClientRect(),nameRect:name?.getBoundingClientRect(),markRect:mark?.getBoundingClientRect(),prefix:style(prefix),core:style(core)}; }"
```

Save the result as `.tmp/wordmark-evidence/after-desktop-computed.txt`. Then use DevTools element inspection to capture the `.superscriber-logo-name` at 200 percent browser zoom as `.tmp/wordmark-evidence/after-enlarged.png`; this is inspection evidence only and does not modify product source.

Expected: live wordmark is approximately 121-122px by 23.08px with Newsreader 360/650, mark is 48px, header is 65px, and document overflow is zero. The one-pixel width difference from the exploration's 122.08px is acceptable only if the exact approved CSS computes correctly and results from browser font rasterization.

- [ ] **Step 2: Capture exact computed color proof**

Run:

```bash
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi eval "() => { const q=(s)=>document.querySelector(s); const css=(s)=>getComputedStyle(q(s)); const logo=q('.superscriber-logo'); const probe=logo.cloneNode(true); const descriptor=document.createElement('p'); descriptor.className='superscriber-logo-descriptor'; descriptor.textContent='Governed transcription appliance'; probe.querySelector('.superscriber-logo-wordmark').append(descriptor); probe.style.position='fixed'; probe.style.left='-10000px'; document.body.append(probe); const pc=(s)=>getComputedStyle(probe.querySelector(s)); const lightDescriptor=pc('.superscriber-logo-descriptor').color; probe.classList.remove('superscriber-logo-light'); probe.classList.add('superscriber-logo-inverse'); const result={body:{background:css('body').backgroundColor,color:css('body').color},header:{background:css('.app-shell__header').backgroundColor,border:css('.app-shell__header').borderBottomColor},link:{color:css('.app-shell__brand').color,decorationThickness:css('.app-shell__brand').textDecorationThickness,offset:css('.app-shell__brand').textUnderlineOffset},light:{backing:css('.superscriber-logo-mark-backing').fill,backingLine:css('.superscriber-logo-mark-backing').stroke,primary:css('.superscriber-logo-ribbon-primary').fill,secondary:css('.superscriber-logo-ribbon-secondary').fill,foldRight:css('.superscriber-logo-fold-right').fill,foldLeft:css('.superscriber-logo-fold-left').fill,prefix:css('.superscriber-logo-name-prefix').color,core:css('.superscriber-logo-name-core').color,descriptor:lightDescriptor},inverse:{backing:pc('.superscriber-logo-mark-backing').fill,backingLine:pc('.superscriber-logo-mark-backing').stroke,primary:pc('.superscriber-logo-ribbon-primary').fill,secondary:pc('.superscriber-logo-ribbon-secondary').fill,foldRight:pc('.superscriber-logo-fold-right').fill,foldLeft:pc('.superscriber-logo-fold-left').fill,prefix:pc('.superscriber-logo-name-prefix').color,core:pc('.superscriber-logo-name-core').color,descriptor:pc('.superscriber-logo-descriptor').color},focusToken:css(':root').getPropertyValue('--color-focus').trim()}; probe.remove(); return result; }"
```

Save the result to `.tmp/wordmark-evidence/after-colors.txt` and compare it line-by-line with the approved color tables. Expected: every computed value, including both descriptor tones, matches Task 1's Playwright expectations and no source token changed.

- [ ] **Step 3: Capture narrow responsive and 200 percent text-zoom proof**

Run:

```bash
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi emulate --viewport "390x844x3,mobile,touch"
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi screenshot .tmp/wordmark-evidence/after-narrow.png
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi eval "() => ({clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,header:document.querySelector('.app-shell__header')?.getBoundingClientRect(),lockup:document.querySelector('.superscriber-logo-lockup')?.getBoundingClientRect()})"
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi emulate --viewport "1024x900x1"
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi eval "() => { document.documentElement.style.zoom='2'; return {clientWidth:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,brand:document.querySelector('.app-shell__brand')?.getBoundingClientRect()}; }"
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi screenshot .tmp/wordmark-evidence/after-zoom-200.png
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi eval "() => { document.documentElement.style.zoom=''; return true; }"
```

Expected: 390px document overflow is zero, small lockup remains 48px tall, header responsive stack remains stable, and at 200 percent zoom the full brand stays within the effective viewport without clipping.

- [ ] **Step 4: Capture accessible name, keyboard focus, link states, and network proof**

Run `snapshot`, press Tab until the `Superscriber` link is focused using the returned accessibility refs, and capture `.tmp/wordmark-evidence/after-focus.png`. Confirm the snapshot exposes one link named `Superscriber`, `href=/workspace`, and no SVG name.

Run:

```bash
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi snapshot
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi network
/Users/molinaro/.cache/axi-tools/bin/chrome-devtools-axi eval "() => ({activeName:document.activeElement?.textContent?.trim(),activeHref:document.activeElement?.getAttribute('href'),focus:{color:getComputedStyle(document.activeElement).outlineColor,width:getComputedStyle(document.activeElement).outlineWidth,offset:getComputedStyle(document.activeElement).outlineOffset},fontResources:performance.getEntriesByType('resource').map(e=>e.name).filter(url=>/\\.(woff2?|ttf|otf)(\\?|$)/.test(url)),externalFontResources:performance.getEntriesByType('resource').map(e=>e.name).filter(url=>/\\.(woff2?|ttf|otf)(\\?|$)/.test(url)&&new URL(url).origin!==location.origin)})"
```

Save network and focus output as `.tmp/wordmark-evidence/after-network-focus.txt`. Compare the final local font resource basenames with `.tmp/wordmark-evidence/before-network.txt`: Newsreader must already be present in the baseline and no additional font basename may appear after implementation. Expected: focus is `rgb(11, 111, 100)`, `2px`, offset `2px`; all font resources are local app assets; external font resources are empty. Use the Playwright `wordmark-unvisited` and `wordmark-visited` attachments as the privacy-safe visual link-state proof, paired with the exact CSSOM rule assertions.

- [ ] **Step 5: Review evidence visually before validation**

Open all before/after screenshots. Reject clipping, wrong baseline, fallback font, two optical heights, crowding, unexpected underline color, changed mark color, header height movement, or narrow wrapping. Compare `before-*` only to demonstrate the tracked-style regression; compare all final colors to the historical/live locks in the approved spec, not to the broken clean-main fallback.

---

### Task 4: Run the full gate and make the single implementation commit

**Files:**
- Commit only: `src/styles/brand.css`, `app/globals.css`, `src/styles/brand.test.ts`, `src/components/brand/superscriber-logo.test.tsx`, `src/components/shell/app-shell.test.tsx`, `e2e/wordmark.spec.ts`
- Do not commit: `.tmp/wordmark-evidence/`, `.lavish/`, `test-results/`, `playwright-report/`

**Interfaces:**
- Consumes: the green focused tests and reviewed browser evidence.
- Produces: one validated implementation commit ready for Firstmate's no-mistakes phase.

- [ ] **Step 1: Prove scope and exact invariant files before broad validation**

Run:

```bash
git diff --check
git diff --name-only
git diff --exit-code -- \
  src/components/brand/superscriber-logo.tsx \
  src/components/shell/app-shell.tsx \
  src/styles/tokens.css \
  src/styles/base.css \
  src/styles/shell.css \
  src/styles/responsive.css \
  app/layout.tsx \
  package.json \
  package-lock.json \
  VERSION \
  CHANGELOG.md
```

Expected changed tracked paths are exactly the six files listed for this task. Every protected component, color/token, shell, font dependency, and release file diff is empty.

- [ ] **Step 2: Run focused and full unit/component validation**

Run:

```bash
npx vitest run \
  src/styles/brand.test.ts \
  src/styles/styles.test.ts \
  src/components/brand/superscriber-logo.test.tsx \
  src/components/shell/app-shell.test.tsx
npm test
```

Expected: all focused and full Vitest suites pass.

- [ ] **Step 3: Run type, production build, and worker validation**

The repository defines no formatter or linter script, so do not add an unapproved formatter/linter dependency. Use `git diff --check` as the whitespace gate and run:

```bash
npm run typecheck
npm run build
npm run worker:check
```

Expected: all commands exit zero, with no new warning or failure.

- [ ] **Step 4: Run focused browser validation once more against the task lane**

Run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3115 \
  npx playwright test e2e/wordmark.spec.ts --reporter=list
```

Expected: both focused wordmark browser tests pass from the clean rebuilt task image.

- [ ] **Step 5: Stop the focused lane and run the full host browser suite against it**

While the task container is still running, run:

```bash
PLAYWRIGHT_BASE_URL=http://localhost:3115 npm run e2e
```

Expected: the full Playwright suite passes against the clean task image. Then stop only the uniquely named task container:

```bash
export SUPERSCRIBER_E2E_CONTAINER_NAME=superscriber-wordmark-e2e
export SUPERSCRIBER_E2E_PORT=3115
export SUPERSCRIBER_E2E_OIDC_PORT=4115
bash scripts/run-e2e-appliance.sh stop
```

- [ ] **Step 6: Run the repository-level container appliance gate with isolated ports**

Run:

```bash
SUPERSCRIBER_E2E_IMAGE=superscriber:wordmark-full-e2e \
SUPERSCRIBER_E2E_CONTAINER_NAME=superscriber-wordmark-full-e2e \
SUPERSCRIBER_E2E_PORT=3116 \
SUPERSCRIBER_E2E_OIDC_PORT=4116 \
PLAYWRIGHT_BASE_URL=http://localhost:3116 \
  npm run e2e:container
```

Expected: the runner's foreign-server preflight passes and the complete container-backed E2E suite exits zero. If either port is occupied, use a free pair rather than stopping another lane.

- [ ] **Step 7: Run final repository and scope checks after all validation**

Run:

```bash
git diff --check
git status --short
git diff --stat
git diff --exit-code -- \
  package.json package-lock.json VERSION CHANGELOG.md \
  src/styles/tokens.css src/styles/base.css src/styles/shell.css src/styles/responsive.css \
  src/components/brand/superscriber-logo.tsx src/components/shell/app-shell.tsx app/layout.tsx
```

Expected: only the six approved implementation/test files are changed, all evidence remains ignored, and all protected files remain byte-identical.

- [ ] **Step 8: Commit the validated implementation once**

Run:

```bash
git add \
  src/styles/brand.css \
  app/globals.css \
  src/styles/brand.test.ts \
  src/components/brand/superscriber-logo.test.tsx \
  src/components/shell/app-shell.test.tsx \
  e2e/wordmark.spec.ts
git diff --cached --check
git diff --cached --name-only
git commit -m "feat: adopt editorial single-voice wordmark"
```

Expected: one implementation commit contains exactly the approved brand stylesheet/import and focused regression coverage. No agent co-author is added.

- [ ] **Step 9: Verify the committed branch and hand back to Firstmate**

Run:

```bash
git status --short --branch
git show --stat --oneline HEAD
```

Expected: the tracked worktree is clean and the implementation commit is on `fm/superscriber-wordmark-editorial-single-voice`. Append the required `done:` status so Firstmate can direct this same worker into no-mistakes. Do not push, open a pull request, merge, or start no-mistakes before that instruction.
