import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const STYLES_DIR = resolve(REPO_ROOT, "src/styles");
const GLOBALS_PATH = resolve(REPO_ROOT, "app/globals.css");

function readAllProductCss() {
  const globalCss = readFileSync(GLOBALS_PATH, "utf8");
  const styleCss = readdirSync(STYLES_DIR)
    .filter((entry) => entry.endsWith(".css"))
    .sort()
    .map((entry) => readFileSync(resolve(STYLES_DIR, entry), "utf8"))
    .join("\n");

  return `${globalCss}\n${styleCss}`;
}

describe("product css contract", () => {
  it("keeps every stylesheet structurally balanced", () => {
    for (const entry of readdirSync(STYLES_DIR).filter((file) =>
      file.endsWith(".css"),
    )) {
      const css = readFileSync(resolve(STYLES_DIR, entry), "utf8");
      const open = (css.match(/\{/g) ?? []).length;
      const close = (css.match(/\}/g) ?? []).length;
      expect(
        { file: entry, open, close },
        `${entry} has ${open} "{" but ${close} "}"`,
      ).toEqual({ file: entry, open: close, close });
    }
  });

  it("keeps the exact hardened tokens and bans legacy visual grammar", () => {
    const css = readAllProductCss();

    expect(css).toContain("--color-teal-700: #163d38");
    expect(css).toContain("--color-focus: #0b6f64");
    expect(css).toContain("--motion-fast: 120ms");
    expect(css).toContain("--motion-slow: 180ms");
    expect(css).toContain("--type-44: 44px");
    expect(css).not.toMatch(/waveform|annotation-rail|queue-card|gradient|backdrop-filter|legacy\.css/);
  });

  it("declares the appearance system: explicit dark tokens with system-mode parity", () => {
    const tokens = readFileSync(resolve(STYLES_DIR, "tokens.css"), "utf8");

    // Rendering contract: data-theme on <html> wins; without it the media
    // query follows the OS. Light stays the canonical default.
    expect(tokens).toContain("color-scheme: light dark");
    expect(tokens).toContain('[data-theme="dark"]');
    expect(tokens).toContain("@media (prefers-color-scheme: dark)");
    expect(tokens).toContain(
      ':root:not([data-theme="light"]):not([data-theme="dark"])',
    );

    // The same override arms both the explicit selector and the system
    // fallback: identical dark token sets in each.
    for (const token of [
      "--color-bone",
      "--color-paper",
      "--color-ink",
      "--color-muted",
      "--color-line",
      "--color-teal-700",
      "--color-focus",
      "--color-on-primary",
      "--color-on-danger",
      "--color-raised",
      "--color-selected",
    ]) {
      expect(tokens).toMatch(new RegExp(`:root\\s*\\{[^}]*${token}:`, "m"));
      const explicitBlock = tokens.match(/\[data-theme="dark"\]\s*\{([^}]*)\}/);
      expect(explicitBlock?.[1]).toContain(`${token}:`);
      const systemBlock = tokens.match(
        /@media \(prefers-color-scheme: dark\)[\s\S]*?:root:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\)\s*\{([^}]*)\}/,
      );
      expect(systemBlock?.[1]).toContain(`${token}:`);
    }
  });

  it("keeps filled controls on on-role text instead of hard-coded white", () => {
    const css = readAllProductCss();

    const primary = css.match(/\.button-primary\s*\{([^}]*)\}/);
    expect(primary?.[1]).toContain("color: var(--color-on-primary)");
    expect(css).not.toContain("color: #fff;");
  });

  it("keeps visited auth doors at their tab colors", () => {
    const auth = readFileSync(resolve(STYLES_DIR, "auth.css"), "utf8");
    const visited = auth.match(/\.auth-tabs__tab:visited\s*\{([^}]*)\}/);
    const selectedVisited = auth.match(
      /\.auth-tabs__tab\[data-selected="true"\]:visited\s*\{([^}]*)\}/,
    );

    expect(visited?.[1]).toContain("color: var(--color-teal-700)");
    expect(selectedVisited?.[1]).toContain("color: var(--color-on-primary)");
  });

  it("leaves no literal light fills that would glare or wash out in dark mode", () => {
    // brand.css is exempt: its light block anchors the mark's light backdrop
    // deliberately, and its dark retone carries the mode adaptation.
    const adaptiveCss = [
      "tokens.css",
      "base.css",
      "shell.css",
      "auth.css",
      "inbox.css",
      "ingest.css",
      "casefile.css",
      "administration.css",
      "responsive.css",
    ]
      .map((entry) => readFileSync(resolve(STYLES_DIR, entry), "utf8"))
      .join("\n");

    expect(adaptiveCss).not.toContain("#fff7f5");
    expect(adaptiveCss).not.toContain("rgba(255, 252, 246");
    expect(adaptiveCss).not.toContain("rgba(247, 243, 234");
    expect(adaptiveCss).not.toMatch(/background:\s*rgba\(255, 255, 255/);
  });

  it("retones the wordmark for dark with explicit and system selectors in parity", () => {
    const brand = readFileSync(resolve(STYLES_DIR, "brand.css"), "utf8");

    expect(brand).toContain('[data-theme="dark"] .superscriber-logo');
    expect(brand).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]*?:root:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\) \.superscriber-logo/,
    );
    expect(brand).toContain("--logo-wordmark");
  });

  it("keeps the account menu appearance picker styled", () => {
    const shell = readFileSync(resolve(STYLES_DIR, "shell.css"), "utf8");

    expect(shell).toContain(".account-menu__appearance");
    expect(shell).toContain(".account-menu__appearance-option");
  });

  it("pins the playback transport on both the desktop scrollport and the phone viewport", () => {
    // player-pinned-center: the playback surface and progress wave must never
    // scroll out of view on either surface.
    const casefile = readFileSync(resolve(STYLES_DIR, "casefile.css"), "utf8");
    const desktopTransport = casefile.match(
      /\.casefile-main\[data-revision="true"\] \.media-transport\s*\{([^}]*)\}/,
    );
    expect(desktopTransport?.[1]).toContain("position: sticky");
    expect(desktopTransport?.[1]).toContain("top: 0");
    const desktopScrollport = casefile.match(
      /\.casefile-main\[data-revision="true"\]\s*\{([^}]*)\}/,
    );
    expect(desktopScrollport?.[1]).toContain(
      "scroll-padding-block: var(--player-clearance",
    );

    const responsive = readFileSync(resolve(STYLES_DIR, "responsive.css"), "utf8");
    const windowScrollMedia = responsive.match(
      /@media \(max-width: 1099px\) \{([\s\S]*?)\n\}\n/,
    );
    expect(windowScrollMedia?.[1]).toContain("body:has(.casefile-page) .app-shell__header");
    expect(windowScrollMedia?.[1]).toContain("body:has(.casefile-page) .banner-emergency");
    const windowTransport = windowScrollMedia?.[1].match(/\.media-transport\s*\{([^}]*)\}/);
    expect(windowTransport?.[1]).toContain("position: sticky");
    expect(windowTransport?.[1]).toContain("top: 0");
    expect(windowScrollMedia?.[1]).toContain(
      "scroll-padding-top: var(--player-clearance",
    );
    const compactVideo = windowScrollMedia?.[1].match(
      /\.media-transport__controls video\s*\{([^}]*)\}/,
    );
    expect(compactVideo?.[1]).toContain("max-height: 42vh");
    expect(compactVideo?.[1]).toContain("object-fit: contain");
    // The case header must not double-park above the pinned transport on
    // window-scrolling surfaces.
    expect(windowScrollMedia?.[1]).toMatch(/\.case-header[\s,\{][^}]*position: static/);
    expect(windowScrollMedia?.[1]).toMatch(
      /\.media-transport__rail\s*\{[^}]*display: none/,
    );
    const compactRate = windowScrollMedia?.[1].match(
      /\.media-transport__rate-field\s*\{([^}]*)\}/,
    );
    expect(compactRate?.[1]).toContain("display: flex");
    expect(compactRate?.[1]).toContain("min-width: 0");

    const phoneMedia = responsive.match(
      /@media \(max-width: 767px\), \(max-height: 767px\) and \(pointer: coarse\) \{([\s\S]*?)\n\}/,
    );
    expect(phoneMedia?.[1]).toMatch(
      /\.media-transport__actions\s*\{[^}]*grid-template-columns: 1fr 1fr/,
    );
  });

  it("keeps the exact responsive, sticky, reduced-motion, and export rules", () => {
    const css = readAllProductCss();

    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: none !important");
    expect(css).toContain("transition-duration: 0.01ms !important");
    expect(css).toContain("scroll-behavior: auto !important");
    expect(css).toContain("min-height: var(--type-44)");
    expect(css).toContain("html, body {");
    expect(css).toContain("overflow-x: clip");
    expect(css).toContain("top: 64px");
    expect(css).toContain("top: 132px");
    expect(css).toContain("bottom: 0");
    expect(css).toContain("position: fixed");
    expect(css).toContain("@media (max-width: 389px)");
    expect(css).toContain("390px");
    expect(css).toContain("@media (min-width: 768px) and (max-width: 959px)");
    expect(css).toContain("@media (min-width: 960px) and (max-width: 1099px)");
    expect(css).toContain("@media (min-width: 1100px)");
    expect(css).toContain("grid-template-columns: minmax(0, 7fr) minmax(280px, 3fr)");
  });
});
