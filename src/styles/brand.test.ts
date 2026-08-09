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
